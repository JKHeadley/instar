// Instar's local macOS desktop host. It has no listener or network authority:
// the target agent owns grant checks and starts this process only for a live
// operator session. Frame bytes leave solely through stdout; nothing is saved.
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ScreenCaptureKit

@available(macOS 14.0, *)
@main
struct InstarDesktopHost {
    static func main() async {
        guard CommandLine.arguments.count == 2 else {
            fputs("usage: instar-desktop-host probe|capture|cursor|input|release|indicator\n", stderr)
            exit(64)
        }
        switch CommandLine.arguments[1] {
        case "probe":
            let screen = CGPreflightScreenCaptureAccess()
            let input = AXIsProcessTrusted()
            let displays = CGGetActiveDisplayListCount()
            let session = activeSession()
            print("{\"screenPermission\":\(screen),\"inputPermission\":\(input),\"displayCount\":\(displays),\"sessionActive\":\(session)}")
        case "indicator":
            guard activeSession() else { exit(69) }
            let app = NSApplication.shared
            app.setActivationPolicy(.accessory)
            let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
            item.button?.title = "● Instar remote control"
            item.button?.toolTip = "Remote control of this Mac is active"
            print("{\"ready\":true}")
            fflush(stdout)
            DispatchQueue.global().async {
                _ = FileHandle.standardInput.readDataToEndOfFile()
                exit(0)
            }
            app.run()
            _ = item
        case "capture":
            do {
                guard activeSession() else { throw HostError.sessionUnavailable }
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
                guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) else {
                    throw HostError.noMainDisplay
                }
                let filter = SCContentFilter(display: display, excludingWindows: [])
                let configuration = SCStreamConfiguration()
                configuration.width = min(display.width, 1920)
                configuration.height = min(display.height, 1080)
                configuration.showsCursor = true
                let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
                let bitmap = NSBitmapImageRep(cgImage: image)
                var jpeg: Data?
                for quality in [0.65, 0.5, 0.35, 0.2] {
                    if let encoded = bitmap.representation(using: .jpeg, properties: [.compressionFactor: quality]),
                       encoded.count <= 600_000 {
                        jpeg = encoded
                        break
                    }
                }
                guard let jpeg else {
                    throw HostError.frameTooLarge
                }
                FileHandle.standardOutput.write(jpeg)
            } catch {
                fputs("capture unavailable: \(error)\n", stderr)
                exit(69)
            }
        case "cursor":
            guard activeSession(), let point = CGEvent(source: nil)?.location else { exit(69) }
            let bounds = CGDisplayBounds(CGMainDisplayID())
            guard bounds.width > 0, bounds.height > 0 else { exit(69) }
            let x = (point.x - bounds.minX) / (bounds.width - 1)
            let y = (point.y - bounds.minY) / (bounds.height - 1)
            print("{\"x\":\(x),\"y\":\(y)}")
        case "release":
            if activeSession() && AXIsProcessTrusted() {
                let point = CGEvent(source: nil)?.location ?? CGPoint.zero
                for button in [CGMouseButton.left, CGMouseButton.right] {
                    let kind: CGEventType = button == .left ? .leftMouseUp : .rightMouseUp
                    CGEvent(mouseEventSource: nil, mouseType: kind,
                            mouseCursorPosition: point, mouseButton: button)?.post(tap: .cghidEventTap)
                }
                for keyCode in [CGKeyCode(0), 54, 55, 56, 58, 59, 60, 61, 62, 63] {
                    CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false)?.post(tap: .cghidEventTap)
                }
            }
            print("{\"ok\":true}")
        case "input":
            do {
                guard activeSession() else { throw HostError.sessionUnavailable }
                guard AXIsProcessTrusted() else { throw HostError.inputPermissionMissing }
                let data = FileHandle.standardInput.readDataToEndOfFile()
                guard data.count > 0, data.count <= 4_096,
                      let raw = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let kind = raw["kind"] as? String else {
                    throw HostError.invalidInput
                }
                switch kind {
                case "move", "click":
                    guard let x = raw["x"] as? Double, let y = raw["y"] as? Double,
                          x.isFinite, y.isFinite, x >= 0, x <= 1, y >= 0, y <= 1 else {
                        throw HostError.invalidInput
                    }
                    let bounds = CGDisplayBounds(CGMainDisplayID())
                    guard bounds.width > 0, bounds.height > 0 else { throw HostError.noMainDisplay }
                    // CGEvent expects desktop points, not backing pixels. Pixel
                    // coordinates overshoot on Retina displays and displays whose
                    // origin is not (0, 0).
                    let point = CGPoint(x: bounds.minX + x * (bounds.width - 1),
                                        y: bounds.minY + y * (bounds.height - 1))
                    if kind == "move" {
                        guard let event = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved,
                                                  mouseCursorPosition: point, mouseButton: .left) else {
                            throw HostError.inputUnavailable
                        }
                        event.post(tap: .cghidEventTap)
                    } else {
                        let button = raw["button"] as? String ?? "left"
                        guard button == "left" || button == "right" else { throw HostError.invalidInput }
                        let mouseButton: CGMouseButton = button == "left" ? .left : .right
                        let downType: CGEventType = button == "left" ? .leftMouseDown : .rightMouseDown
                        let upType: CGEventType = button == "left" ? .leftMouseUp : .rightMouseUp
                        guard let down = CGEvent(mouseEventSource: nil, mouseType: downType,
                                                 mouseCursorPosition: point, mouseButton: mouseButton),
                              let up = CGEvent(mouseEventSource: nil, mouseType: upType,
                                               mouseCursorPosition: point, mouseButton: mouseButton) else {
                            throw HostError.inputUnavailable
                        }
                        // Every click releases in the same operation; a process
                        // crash cannot leave a button held across a session stop.
                        down.post(tap: .cghidEventTap)
                        up.post(tap: .cghidEventTap)
                    }
                case "type":
                    guard let text = raw["text"] as? String, !text.isEmpty,
                          text.utf16.count <= 1_024, !text.contains("\0") else {
                        throw HostError.invalidInput
                    }
                    for scalar in text.unicodeScalars {
                        guard activeSession() else { throw HostError.sessionUnavailable }
                        let units = Array(String(scalar).utf16)
                        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
                              let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else {
                            throw HostError.inputUnavailable
                        }
                        down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
                        up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
                        down.post(tap: .cghidEventTap)
                        up.post(tap: .cghidEventTap)
                    }
                default:
                    throw HostError.invalidInput
                }
                print("{\"ok\":true}")
            } catch {
                fputs("input unavailable: \(error)\n", stderr)
                exit(69)
            }
        default:
            fputs("unknown desktop-host command\n", stderr)
            exit(64)
        }
    }

    private static func CGGetActiveDisplayListCount() -> UInt32 {
        var count: UInt32 = 0
        let result = CGGetActiveDisplayList(0, nil, &count)
        return result == .success ? count : 0
    }

    private static func activeSession() -> Bool {
        guard let state = CGSessionCopyCurrentDictionary() as? [String: Any],
              let onConsole = state[kCGSessionOnConsoleKey as String] as? Bool,
              let loginDone = state[kCGSessionLoginDoneKey as String] as? Bool else {
            return false
        }
        return onConsole && loginDone && (state["CGSSessionScreenIsLocked"] as? Bool) != true
    }

    enum HostError: Error {
        case noMainDisplay
        case sessionUnavailable
        case frameTooLarge
        case inputPermissionMissing
        case inputUnavailable
        case invalidInput
    }
}
