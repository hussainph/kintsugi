// kintsugi-vision: reads one picture with Apple's Vision framework, on this
// Mac (part of macOS, nothing to download). The Rust side
// (`kintsugi_ingest::image::VisionReader`) runs it as a child process, so a
// malformed image that crashes or hangs a decoder can be killed without
// taking the app down.
//
//   kintsugi-vision <image>
//
// stdout: {"width":1170,"height":2532,"lines":["…"],
//          "labels":[{"label":"ceramic","confidence":0.82}]}
// Exit codes: 0 done, 2 usage, 3 unsupported (macOS older than 12, or the
// build stub), 5 the file is not a readable image. Nothing is printed on
// stdout unless the exit code is 0, and stderr carries no recognised text.
//
// Lines come from VNRecognizeTextRequest (accurate, with language
// correction), top to bottom. Labels come from VNClassifyImageRequest; the
// Rust side keeps the confident ones. Both are machine-made and labelled so
// wherever they are shown.

import Foundation
import ImageIO
import Vision

struct Label: Encodable {
    let label: String
    let confidence: Double
}

struct Output: Encodable {
    let width: Int
    let height: Int
    let lines: [String]
    let labels: [Label]
}

func fail(_ code: Int32, _ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(code)
}

@main
struct Main {
    static func main() {
        let args = Array(CommandLine.arguments.dropFirst())
        guard args.count == 1 else { fail(2, "usage: kintsugi-vision <image>") }
        guard #available(macOS 12.0, *) else { fail(3, "image reading needs macOS 12 or later") }
        let url = URL(fileURLWithPath: args[0])
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
            let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else { fail(5, "not a readable image") }

        let text = VNRecognizeTextRequest()
        text.recognitionLevel = .accurate
        text.usesLanguageCorrection = true
        text.automaticallyDetectsLanguage = true
        let classify = VNClassifyImageRequest()
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        do {
            try handler.perform([text, classify])
        } catch {
            fail(5, "could not read the image")
        }
        var lines: [String] = []
        var chars = 0
        let observations = (text.results ?? []).sorted { a, b in
            // Vision's origin is bottom-left: higher first, then left to right.
            abs(a.boundingBox.midY - b.boundingBox.midY) > 0.01
                ? a.boundingBox.midY > b.boundingBox.midY : a.boundingBox.minX < b.boundingBox.minX
        }
        for observation in observations {
            guard let best = observation.topCandidates(1).first, chars < 100_000 else { continue }
            let line = best.string.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.isEmpty { continue }
            chars += line.count
            lines.append(String(line.prefix(2_000)))
        }
        let labels = (classify.results ?? [])
            .filter { $0.confidence >= 0.1 }
            .sorted { $0.confidence > $1.confidence }
            .prefix(20)
            .map { Label(label: String($0.identifier.prefix(100)), confidence: (Double($0.confidence) * 1000).rounded() / 1000) }
        let output = Output(width: image.width, height: image.height, lines: lines, labels: Array(labels))
        guard let data = try? JSONEncoder().encode(output) else { fail(5, "could not encode the result") }
        FileHandle.standardOutput.write(data)
        exit(0)
    }
}
