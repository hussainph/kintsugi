// kintsugi-transcribe: on-device transcription of one audio file with Apple's
// SpeechAnalyzer / SpeechTranscriber (macOS 26+). The Rust side
// (`kintsugi_ingest::transcribe::SpeechAnalyzerTranscriber`) runs it as a
// child process, so a crash in the speech stack never takes the app down.
//
//   kintsugi-transcribe <audio file> [--locale en-US] [--install-assets]
//
// stdout: {"locale":"en_US","segments":[{"start":0.0,"end":2.4,"text":"…"}]}
// Exit codes: 0 done, 2 usage, 3 unsupported (OS too old or locale not
// supported), 4 the speech model for this locale is not installed and
// --install-assets was not given, 5 the audio could not be read or
// transcribed. Nothing is printed on stdout unless the exit code is 0, and
// stderr carries no transcript text.
//
// --install-assets lets macOS download the locale's speech model through
// AssetInventory (shared with other apps, managed and updated by the
// system). The app passes it only after the person agreed.

import AVFoundation
import Foundation
import Speech

struct Segment: Encodable {
    let start: Double
    let end: Double
    let text: String
}

struct Output: Encodable {
    let locale: String
    let segments: [Segment]
}

func fail(_ code: Int32, _ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(code)
}

func seconds(_ time: CMTime) -> Double {
    let value = CMTimeGetSeconds(time)
    return value.isFinite ? max(0, value) : 0
}

@available(macOS 26.0, *)
func transcribe(path: String, localeId: String, installAssets: Bool) async -> Never {
    guard SpeechTranscriber.isAvailable else { fail(3, "speech transcription is not available on this Mac") }
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: localeId)) else {
        fail(3, "locale is not supported")
    }
    let transcriber = SpeechTranscriber(
        locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [.audioTimeRange])
    let modules: [any SpeechModule] = [transcriber]
    let installed = await SpeechTranscriber.installedLocales.contains {
        $0.identifier(.bcp47) == locale.identifier(.bcp47)
    }
    if !installed {
        guard installAssets else { fail(4, "speech model is not installed") }
        do {
            if let request = try await AssetInventory.assetInstallationRequest(supporting: modules) {
                try await request.downloadAndInstall()
            }
        } catch {
            fail(4, "speech model could not be installed")
        }
    }
    let file: AVAudioFile
    do {
        file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
    } catch {
        fail(5, "audio could not be read")
    }
    let analyzer = SpeechAnalyzer(modules: modules)
    let collector = Task { () throws -> [Segment] in
        var segments: [Segment] = []
        for try await result in transcriber.results where result.isFinal {
            let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
            if text.isEmpty { continue }
            segments.append(
                Segment(
                    start: seconds(result.range.start),
                    end: seconds(CMTimeRangeGetEnd(result.range)),
                    text: text))
        }
        return segments
    }
    do {
        if let last = try await analyzer.analyzeSequence(from: file) {
            try await analyzer.finalizeAndFinish(through: last)
        } else {
            await analyzer.cancelAndFinishNow()
        }
        let segments = try await collector.value
        let encoder = JSONEncoder()
        let data = try encoder.encode(Output(locale: locale.identifier, segments: segments))
        FileHandle.standardOutput.write(data)
        exit(0)
    } catch {
        collector.cancel()
        fail(5, "transcription failed")
    }
}

@main
struct Main {
    static func main() async {
        var args = Array(CommandLine.arguments.dropFirst())
        var localeId = "en-US"
        var installAssets = false
        var path: String?
        while !args.isEmpty {
            let arg = args.removeFirst()
            switch arg {
            case "--locale":
                guard !args.isEmpty else { fail(2, "--locale needs a value") }
                localeId = args.removeFirst()
            case "--install-assets":
                installAssets = true
            case "--version":
                print("kintsugi-transcribe 1")
                exit(0)
            default:
                guard path == nil, !arg.hasPrefix("--") else { fail(2, "usage: kintsugi-transcribe <audio> [--locale id] [--install-assets]") }
                path = arg
            }
        }
        guard let path else { fail(2, "usage: kintsugi-transcribe <audio> [--locale id] [--install-assets]") }
        if #available(macOS 26.0, *) {
            await transcribe(path: path, localeId: localeId, installAssets: installAssets)
        } else {
            fail(3, "speech transcription needs macOS 26 or later")
        }
    }
}
