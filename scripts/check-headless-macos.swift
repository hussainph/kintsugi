// Read-only verification: does not launch/activate an application or capture
// the owner's display. Only reports window/application metadata for this PID.
// swift scripts/check-headless-macos.swift <backend-pid>
import AppKit
import CoreGraphics
import Foundation
import Darwin

let pid = CommandLine.arguments.dropFirst().first.flatMap(Int32.init) ?? 0
guard pid > 0 && kill(pid, 0) == 0 else { fatalError("Supply a running headless backend PID") }
let windows = (CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] ?? [])
    .filter { ($0[kCGWindowOwnerPID as String] as? Int32) == pid }
let application = NSRunningApplication(processIdentifier: pid)
let regular = application?.activationPolicy == .regular
let focused = NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
print("pid=\(pid) nativeWindows=\(windows.count) regularDockApp=\(regular) frontmost=\(focused) registeredApp=\(application != nil)")
if !windows.isEmpty || regular || focused { exit(1) }
