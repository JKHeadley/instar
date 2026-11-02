// Instar's local macOS desktop host. It has no listener or network authority:
// the target agent owns grant checks and starts this process only for a live
// operator session. Frame bytes leave solely through stdout; nothing is saved.
import AppKit
import ApplicationServices
import Carbon.HIToolbox
import CoreGraphics
import CoreImage
import CoreMedia
import CoreVideo
import CryptoKit
import Darwin
import Foundation
import IOKit
import IOKit.pwr_mgt
import ScreenCaptureKit
import VideoToolbox

@available(macOS 14.0, *)
private final class LatestScreenFrame: NSObject, SCStreamOutput, SCStreamDelegate {
    private let lock = NSLock()
    private var latest: CVPixelBuffer?
    private var generation: UInt64 = 0
    private var stopped = false

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                of outputType: SCStreamOutputType) {
        guard outputType == .screen, sampleBuffer.isValid else { return }
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
            as? [[SCStreamFrameInfo: Any]],
           let raw = attachments.first?[.status] as? Int,
           let status = SCFrameStatus(rawValue: raw) {
            if status == .blank || status == .stopped || status == .suspended {
                lock.lock()
                stopped = true
                latest = nil
                lock.unlock()
                return
            }
            if status != .complete && status != .started { return }
        }
        guard let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        lock.lock()
        latest = buffer
        generation &+= 1
        lock.unlock()
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        lock.lock()
        stopped = true
        latest = nil
        lock.unlock()
    }

    func takeLatest() -> (CVPixelBuffer?, UInt64, Bool) {
        lock.lock()
        defer { lock.unlock() }
        return (latest, generation, stopped)
    }

    /// ScreenCaptureKit may start and then deliver nothing at the shield.
    func waitForFirstFrame() async -> Bool {
        for _ in 0..<100 {
            let (buffer, _, stopped) = takeLatest()
            if buffer != nil { return true }
            if stopped { return false }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return false
    }
}

@available(macOS 14.0, *)
private enum H264Error: Error { case unavailable, frameTooLarge }

@available(macOS 14.0, *)
private final class DesktopH264Encoder {
    private let session: VTCompressionSession
    private let lock = NSLock()
    private var completed: (Data, Bool)?
    private var completion = DispatchSemaphore(value: 0)
    private var nextTime: Int64 = 0

    init(width: Int, height: Int) throws {
        var created: VTCompressionSession?
        let specification: CFDictionary = [
            kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: true
        ] as CFDictionary
        let status = VTCompressionSessionCreate(allocator: kCFAllocatorDefault,
            width: Int32(width), height: Int32(height), codecType: kCMVideoCodecType_H264,
            encoderSpecification: specification, imageBufferAttributes: nil,
            compressedDataAllocator: nil, outputCallback: { _, source, status, _, sample in
                guard let source else { return }
                // Each encode owns its callback reference. A delayed callback
                // from an old capture helper cannot complete a newer encoder.
                let encoder = Unmanaged<DesktopH264Encoder>.fromOpaque(source).takeRetainedValue()
                guard status == noErr, let sample else { return }
                encoder.receive(sample)
            }, refcon: nil, compressionSessionOut: &created)
        guard status == noErr, let created else { throw H264Error.unavailable }
        session = created
        guard VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime,
                                   value: kCFBooleanTrue) == noErr,
              VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AllowFrameReordering,
                                   value: kCFBooleanFalse) == noErr,
              VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ProfileLevel,
                                   value: kVTProfileLevel_H264_Baseline_4_0) == noErr,
              VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameInterval,
                                   value: 60 as CFNumber) == noErr,
              VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate,
                                   value: 5_000_000 as CFNumber) == noErr,
              VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ExpectedFrameRate,
                                   value: 15 as CFNumber) == noErr else { throw H264Error.unavailable }
        guard VTCompressionSessionPrepareToEncodeFrames(session) == noErr else {
            throw H264Error.unavailable
        }
    }

    deinit {
        VTCompressionSessionInvalidate(session)
    }

    func encode(_ pixels: CVPixelBuffer, forceKeyframe: Bool) throws -> (Data, Bool) {
        lock.lock()
        completed = nil
        completion = DispatchSemaphore(value: 0)
        let wait = completion
        lock.unlock()
        let options: CFDictionary? = forceKeyframe
            ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil
        let time = CMTime(value: nextTime, timescale: 15)
        nextTime += 1
        let status = VTCompressionSessionEncodeFrame(session, imageBuffer: pixels,
            presentationTimeStamp: time, duration: CMTime(value: 1, timescale: 15),
            frameProperties: options, sourceFrameRefcon: Unmanaged.passRetained(self).toOpaque(),
            infoFlagsOut: nil)
        guard status == noErr, wait.wait(timeout: .now() + 2) == .success else {
            throw H264Error.unavailable
        }
        lock.lock()
        let result = completed
        lock.unlock()
        guard let result, result.0.count <= 1_250_000 else { throw H264Error.frameTooLarge }
        return result
    }

    private func receive(_ sample: CMSampleBuffer) {
        guard let block = CMSampleBufferGetDataBuffer(sample) else { return }
        let length = CMBlockBufferGetDataLength(block)
        guard length > 4, length <= 1_250_000 else { return }
        var avcc = Data(count: length)
        let status = avcc.withUnsafeMutableBytes { bytes in
            CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length,
                                       destination: bytes.baseAddress!)
        }
        guard status == noErr else { return }
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false)
        guard let first = (attachments as? [[CFString: Any]])?.first else { return }
        let keyframe = (first[kCMSampleAttachmentKey_NotSync] as? Bool) != true
        var annexB = Data()
        let startCode = Data([0, 0, 0, 1])
        if keyframe, let format = CMSampleBufferGetFormatDescription(sample) {
            for index in 0..<2 {
                var pointer: UnsafePointer<UInt8>?
                var size = 0
                var count = 0
                var headerLength: Int32 = 0
                guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format,
                    parameterSetIndex: index, parameterSetPointerOut: &pointer,
                    parameterSetSizeOut: &size, parameterSetCountOut: &count,
                    nalUnitHeaderLengthOut: &headerLength) == noErr,
                    let pointer, size > 0 else { return }
                annexB.append(startCode)
                annexB.append(pointer, count: size)
            }
        }
        var offset = 0
        while offset + 4 <= avcc.count {
            let size = avcc[offset..<offset+4].reduce(0) { ($0 << 8) | Int($1) }
            offset += 4
            guard size > 0, offset + size <= avcc.count else { return }
            annexB.append(startCode)
            annexB.append(avcc[offset..<offset+size])
            offset += size
        }
        guard offset == avcc.count, annexB.count <= 1_250_000 else { return }
        lock.lock()
        completed = (annexB, keyframe)
        let wait = completion
        lock.unlock()
        wait.signal()
    }
}

@available(macOS 14.0, *)
@main
struct InstarDesktopHost {
    // This state belongs to the one grant-owned input-stream process. Its pipe
    // closing ends the process; the controller then posts release events.
    private static var heldButton: String? = nil
    private static var heldKeys = Set<String>()
    private static let keyCodes: [String: CGKeyCode] = [
        "Meta": 55, "Control": 59, "Alt": 58, "Shift": 56,
        "Enter": 36, "Tab": 48, "Escape": 53, "Backspace": 51,
        "Delete": 117, "Space": 49, "ArrowLeft": 123, "ArrowRight": 124,
        "ArrowDown": 125, "ArrowUp": 126,
        // Mac keyboards have no Insert key; Help sits in its place on extended keyboards.
        "Home": 115, "End": 119, "PageUp": 116, "PageDown": 121, "Insert": 114,
        "F1": 122, "F2": 120, "F3": 99, "F4": 118, "F5": 96, "F6": 97,
        "F7": 98, "F8": 100, "F9": 101, "F10": 109, "F11": 103, "F12": 111,
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
        "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
        "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29,
        "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
    ]
    /// macOS checks Screen Recording and Accessibility against the "responsible"
    /// process, which a child inherits: on a Mac whose agents share one tmux
    /// server that is whichever Node started tmux, so a grant depends on boot
    /// order. Re-executing in place with responsibility disclaimed makes this
    /// binary its own permission client. The pid is unchanged, so the parent's
    /// SIGKILL still stops input and capture immediately. Failure exits rather
    /// than falling through, so the caller can never mistake which identity ran.
    private static func adoptOwnIdentity() {
        guard getenv("INSTAR_DESKTOP_OWN_IDENTITY") != nil,
              getenv("INSTAR_DESKTOP_IDENTITY_ADOPTED") == nil else { return }
        typealias Disclaim = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32
        guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_spawnattrs_setdisclaim") else { exit(71) }
        let disclaim = unsafeBitCast(symbol, to: Disclaim.self)
        var size: UInt32 = 4096
        var path = [CChar](repeating: 0, count: Int(size))
        guard _NSGetExecutablePath(&path, &size) == 0 else { exit(71) }
        var attr: posix_spawnattr_t?
        guard posix_spawnattr_init(&attr) == 0,
              posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETEXEC)) == 0,
              disclaim(&attr, 1) == 0 else { exit(71) }
        setenv("INSTAR_DESKTOP_IDENTITY_ADOPTED", "1", 1)
        let argv: [UnsafeMutablePointer<CChar>?] = CommandLine.arguments.map { strdup($0) } + [nil]
        _ = posix_spawn(nil, path, nil, &attr, argv, environ)
        exit(71)
    }
    private static func mouseButton(_ name: String) -> CGMouseButton {
        name == "right" ? .right : name == "middle" ? .center : .left
    }
    private static func mouseType(_ name: String, down: Bool) -> CGEventType {
        switch name {
        case "right": return down ? .rightMouseDown : .rightMouseUp
        case "middle": return down ? .otherMouseDown : .otherMouseUp
        default: return down ? .leftMouseDown : .leftMouseUp
        }
    }
    private static func validButton(_ name: String) -> Bool {
        name == "left" || name == "right" || name == "middle"
    }
    static func main() async {
        let verb = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
        guard CommandLine.arguments.count == 2 || (CommandLine.arguments.count == 4 && verb == "relock-guard") else {
            fputs("usage: instar-desktop-host probe|request-permission|capture|capture-stream|capture-stream-h264|cursor|input|input-stream|release|indicator|state-op|relock-guard <root> <key>\n", stderr)
            exit(64)
        }
        adoptOwnIdentity()
        switch CommandLine.arguments[1] {
        case "request-permission":
            // Registers this binary in Privacy & Security and shows macOS's own
            // prompts on the Mac. Granting stays a person's action there.
            guard getenv("INSTAR_DESKTOP_IDENTITY_ADOPTED") != nil else { exit(64) }
            let screen = CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess()
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            let input = AXIsProcessTrustedWithOptions(options)
            print("{\"screenPermission\":\(screen),\"inputPermission\":\(input)}")
        case "probe":
            let screen = CGPreflightScreenCaptureAccess()
            let input = AXIsProcessTrusted()
            let displays = CGGetActiveDisplayListCount()
            let state = CGSessionCopyCurrentDictionary() as? [String: Any]
            let onConsole = state?[kCGSessionOnConsoleKey as String] as? Bool ?? false
            let loginDone = state?[kCGSessionLoginDoneKey as String] as? Bool ?? false
            let screenLocked = state?["CGSSessionScreenIsLocked"] as? Bool ?? false
            let session = state != nil && onConsole && loginDone && !screenLocked
            var report: [String: Any] = ["screenPermission": screen, "inputPermission": input,
                "displayCount": Int(displays), "sessionActive": session, "consoleSessionPresent": state != nil,
                "onConsole": onConsole, "loginDone": loginDone, "screenLocked": screenLocked,
                "osMajor": ProcessInfo.processInfo.operatingSystemVersion.majorVersion]
            // Read-only additions for the lock reading. Grant authority stays in Node.
            if lockedFeatureOn { report["lockInputs"] = lockInputs(state) }
            guard let line = try? JSONSerialization.data(withJSONObject: report) else { exit(69) }
            FileHandle.standardOutput.write(line)
            FileHandle.standardOutput.write(Data([0x0a]))
        case "indicator":
            guard activeSession() else { exit(69) }
            let wakeAssertion = lockedFeatureOn ? holdDisplayAwake() : nil
            defer { if let wakeAssertion { IOPMAssertionRelease(wakeAssertion) } }
            // The indicator owns the physical host's controller lock for its
            // whole lifetime. A second Instar process under this user cannot
            // start another grant on the same Mac.
            let lockPath = "/tmp/instar-desktop-\(geteuid()).lock"
            let lockFd = open(lockPath, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, mode_t(0o600))
            guard lockFd >= 0, flock(lockFd, LOCK_EX | LOCK_NB) == 0 else { exit(73) }
            defer { close(lockFd) }
            let app = NSApplication.shared
            app.setActivationPolicy(.accessory)
            let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
            item.button?.title = "● Instar remote control"
            item.button?.toolTip = "Remote control of this Mac is active"
            // One chime at the start of a grant at the shield. A signal, not prevention.
            if lockedFeatureOn, getenv("INSTAR_DESKTOP_LOCKED_CHIME") != nil,
               (CGSessionCopyCurrentDictionary() as? [String: Any])?["CGSSessionScreenIsLocked"] as? Bool == true { NSSound.beep() }
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
                // The browser draws one low-latency cursor locally. Embedding
                // the host cursor in delayed JPEG frames makes two pointers.
                configuration.showsCursor = false
                let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
                let bitmap = NSBitmapImageRep(cgImage: image)
                var jpeg: Data?
                for quality in [0.8, 0.7, 0.6, 0.5, 0.35] {
                    if let encoded = bitmap.representation(using: .jpeg, properties: [.compressionFactor: quality]),
                       encoded.count <= 1_250_000 {
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
        case "capture-stream":
            do {
                try await captureStream()
            } catch {
                fputs("capture stream unavailable: \(error)\n", stderr)
                exit(69)
            }
        case "capture-stream-h264":
            do {
                try await captureH264Stream()
            } catch {
                fputs("H264 stream unavailable: \(error)\n", stderr)
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
            let data = FileHandle.standardInput.readDataToEndOfFile()
            guard data.count <= 512,
                  let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let buttons = raw["buttons"] as? [String],
                  let keys = raw["keys"] as? [String],
                  buttons.count <= 3, keys.count <= keyCodes.count,
                  buttons.allSatisfy({ validButton($0) }),
                  keys.allSatisfy({ keyCodes[$0] != nil }) else { exit(69) }
            if !buttons.isEmpty || !keys.isEmpty {
                // A failed OS preflight is not proof that a held remote
                // control was released. Keep the Node barrier failed closed.
                guard activeSession(), AXIsProcessTrusted() else { exit(69) }
                let point = CGEvent(source: nil)?.location ?? CGPoint.zero
                for button in buttons {
                    guard let event = CGEvent(mouseEventSource: nil, mouseType: mouseType(button, down: false),
                                              mouseCursorPosition: point, mouseButton: mouseButton(button)) else { exit(69) }
                    event.post(tap: .cghidEventTap)
                }
                for key in keys {
                    guard let keyCode = keyCodes[key] else { continue }
                    guard let event = CGEvent(keyboardEventSource: nil, virtualKey: keyCode,
                                              keyDown: false) else { exit(69) }
                    if ["Meta", "Control", "Alt", "Shift"].contains(key) { event.type = .flagsChanged }
                    event.flags = []
                    event.post(tap: .cghidEventTap)
                }
            }
            print("{\"ok\":true}")
        case "input":
            do {
                try performInput(FileHandle.standardInput.readDataToEndOfFile())
                print("{\"ok\":true}")
            } catch {
                fputs("input unavailable: \(error)\n", stderr)
                exit(69)
            }
        case "input-stream":
            defer { releaseHeldInput() }
            if lockedFeatureOn { prepareSecretChannel() }
            let commands = InputCommandQueue()
            commands.start()
            while let line = commands.next() {
                do {
                    try performInput(Data(line.utf8), abort: commands)
                    commands.clearAbort()
                    print("{\"ok\":true}")
                    fflush(stdout)
                } catch HostError.refused(let reason) {
                    commands.clearAbort()
                    print("{\"refused\":\"\(reason)\"}")
                    fflush(stdout)
                } catch {
                    fputs("input unavailable: \(error)\n", stderr)
                    releaseHeldInput()
                    exit(69)
                }
            }
        case "state-op":
            let data = FileHandle.standardInput.readDataToEndOfFile()
            guard data.count <= 8_192, let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let root = raw["root"] as? String, let reply = LockedStore.perform(root: root, op: raw),
                  let line = try? JSONSerialization.data(withJSONObject: reply) else { exit(69) }
            FileHandle.standardOutput.write(line)
        case "relock-guard":
            runRelockGuard(root: CommandLine.arguments[2], key: CommandLine.arguments[3])
        default:
            fputs("unknown desktop-host command\n", stderr)
            exit(64)
        }
    }

    private static func releaseHeldInput() {
        guard activeSession(), AXIsProcessTrusted() else { return }
        if let button = heldButton {
            let point = CGEvent(source: nil)?.location ?? CGPoint.zero
            CGEvent(mouseEventSource: nil, mouseType: mouseType(button, down: false),
                    mouseCursorPosition: point, mouseButton: mouseButton(button))?.post(tap: .cghidEventTap)
        }
        heldButton = nil
        for key in heldKeys {
            if let code = keyCodes[key] {
                if let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) {
                    if ["Meta", "Control", "Alt", "Shift"].contains(key) { event.type = .flagsChanged }
                    event.post(tap: .cghidEventTap)
                }
            }
        }
        heldKeys.removeAll()
    }

    private static func modifierFlags(_ keys: Set<String>) -> CGEventFlags {
        var flags: CGEventFlags = []
        if keys.contains("Meta") { flags.insert(.maskCommand) }
        if keys.contains("Control") { flags.insert(.maskControl) }
        if keys.contains("Alt") { flags.insert(.maskAlternate) }
        if keys.contains("Shift") { flags.insert(.maskShift) }
        return flags
    }

    private static func performInput(_ data: Data, abort: InputCommandQueue? = nil) throws {
        guard activeSession() else { throw HostError.sessionUnavailable }
        guard AXIsProcessTrusted() else { throw HostError.inputPermissionMissing }
        guard data.count > 0, data.count <= 4_096,
              let raw = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let kind = raw["kind"] as? String else {
            throw HostError.invalidInput
        }
        if kind == "secretType" {
            guard lockedFeatureOn, let abort else { throw HostError.refused("not-available") }
            try secretType(raw, abort: abort)
            return
        }
        try refuseWhileLocked(kind: kind, raw: raw)
        switch kind {
        case "keyDown", "keyUp":
            guard let key = raw["key"] as? String, let code = keyCodes[key] else { throw HostError.invalidInput }
            var next = heldKeys
            if kind == "keyDown" {
                guard !next.contains(key) else { throw HostError.invalidInput }
                next.insert(key)
            } else {
                guard next.contains(key) else { throw HostError.invalidInput }
                next.remove(key)
            }
            guard let event = CGEvent(keyboardEventSource: nil, virtualKey: code,
                                      keyDown: kind == "keyDown") else { throw HostError.inputUnavailable }
            if ["Meta", "Control", "Alt", "Shift"].contains(key) { event.type = .flagsChanged }
            event.flags = modifierFlags(next)
            event.post(tap: .cghidEventTap)
            heldKeys = next
        case "scroll":
            guard let dx = raw["dx"] as? Double, let dy = raw["dy"] as? Double,
                  dx.isFinite, dy.isFinite, abs(dx) <= 1_000, abs(dy) <= 1_000,
                  let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel,
                                      wheelCount: 2, wheel1: Int32((-dy).rounded()),
                                      wheel2: Int32((-dx).rounded()), wheel3: 0) else {
                throw HostError.invalidInput
            }
            event.flags = modifierFlags(heldKeys)
            event.post(tap: .cghidEventTap)
        case "move", "click", "buttonDown", "buttonUp":
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
                let dragType: CGEventType = heldButton == "left" ? .leftMouseDragged
                    : heldButton == "right" ? .rightMouseDragged
                    : heldButton == "middle" ? .otherMouseDragged : .mouseMoved
                let dragButton = mouseButton(heldButton ?? "left")
                guard let event = CGEvent(mouseEventSource: nil, mouseType: dragType,
                                          mouseCursorPosition: point, mouseButton: dragButton) else {
                    throw HostError.inputUnavailable
                }
                event.flags = modifierFlags(heldKeys)
                event.post(tap: .cghidEventTap)
            } else {
                let button = raw["button"] as? String ?? "left"
                guard validButton(button) else { throw HostError.invalidInput }
                // Refuse a second down or an unmatched up. A malformed command
                // must not silently change the host's held-button state.
                if kind == "buttonDown" && heldButton != nil { throw HostError.invalidInput }
                if kind == "buttonUp" && heldButton != button { throw HostError.invalidInput }
                if kind == "click" && heldButton != nil { throw HostError.invalidInput }
                let count = kind == "click" ? (raw["count"] as? Int ?? 1) : 1
                guard count >= 1, count <= 3 else { throw HostError.invalidInput }
                // A double click is press/release pairs whose click state counts
                // up, which is how macOS tells apps the clicks belong together.
                for state in 1...count {
                    if kind != "buttonUp" {
                        guard let down = CGEvent(mouseEventSource: nil, mouseType: mouseType(button, down: true),
                                                 mouseCursorPosition: point, mouseButton: mouseButton(button)) else {
                            throw HostError.inputUnavailable
                        }
                        down.setIntegerValueField(.mouseEventClickState, value: Int64(state))
                        down.flags = modifierFlags(heldKeys)
                        down.post(tap: .cghidEventTap)
                        if kind == "buttonDown" { heldButton = button }
                    }
                    if kind != "buttonDown" {
                        guard let up = CGEvent(mouseEventSource: nil, mouseType: mouseType(button, down: false),
                                               mouseCursorPosition: point, mouseButton: mouseButton(button)) else {
                            throw HostError.inputUnavailable
                        }
                        up.setIntegerValueField(.mouseEventClickState, value: Int64(state))
                        up.flags = modifierFlags(heldKeys)
                        up.post(tap: .cghidEventTap)
                        heldButton = nil
                    }
                }
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
    }

    private static func captureStream() async throws {
        guard activeSession() else { throw HostError.sessionUnavailable }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) else {
            throw HostError.noMainDisplay
        }
        let scale = min(1.0, min(1920.0 / Double(display.width), 1080.0 / Double(display.height)))
        let configuration = SCStreamConfiguration()
        configuration.width = max(1, Int((Double(display.width) * scale).rounded()))
        configuration.height = max(1, Int((Double(display.height) * scale).rounded()))
        configuration.showsCursor = false
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 60)
        configuration.queueDepth = 3
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let frames = LatestScreenFrame()
        let stream = SCStream(filter: filter, configuration: configuration, delegate: frames)
        try stream.addStreamOutput(frames, type: .screen,
                                   sampleHandlerQueue: DispatchQueue(label: "instar.desktop.frames"))
        var fallback: ShieldDisplayStream?
        do {
            try await stream.startCapture()
            if lockedFeatureOn, !(await frames.waitForFirstFrame()) { fallback = try ShieldDisplayStream(width: configuration.width, height: configuration.height) }
        } catch where lockedFeatureOn {
            fallback = try ShieldDisplayStream(width: configuration.width, height: configuration.height)
        }
        defer { fallback?.stop(); Task { try? await stream.stopCapture() } }
        let context = CIContext(options: [.useSoftwareRenderer: false])
        var lastSentGeneration: UInt64 = 0
        while true {
            let command = FileHandle.standardInput.readData(ofLength: 1)
            if command.isEmpty { return }
            guard command == Data([0x6e]), activeSession() else { throw HostError.sessionUnavailable }
            var pixelBuffer: CVPixelBuffer?
            var currentGeneration: UInt64 = 0
            for _ in 0..<200 {
                let (latest, generation, stopped) = fallback?.takeLatest() ?? frames.takeLatest()
                if stopped { throw HostError.sessionUnavailable }
                if let latest { pixelBuffer = latest; currentGeneration = generation; break }
                try await Task.sleep(for: .milliseconds(10))
            }
            guard let pixelBuffer else { throw HostError.inputUnavailable }
            if currentGeneration == lastSentGeneration {
                FileHandle.standardOutput.write(Data(repeating: 0, count: 4))
                continue
            }
            let image = CIImage(cvPixelBuffer: pixelBuffer)
            guard let cgImage = context.createCGImage(image, from: image.extent) else {
                throw HostError.inputUnavailable
            }
            let bitmap = NSBitmapImageRep(cgImage: cgImage)
            var jpeg: Data?
            for quality in [0.8, 0.7, 0.6, 0.5, 0.35] {
                if let encoded = bitmap.representation(using: .jpeg, properties: [.compressionFactor: quality]),
                   encoded.count <= 1_250_000 {
                    jpeg = encoded
                    break
                }
            }
            guard let jpeg else { throw HostError.frameTooLarge }
            var length = UInt32(jpeg.count).bigEndian
            let header = withUnsafeBytes(of: &length) { Data($0) }
            FileHandle.standardOutput.write(header)
            FileHandle.standardOutput.write(jpeg)
            lastSentGeneration = currentGeneration
        }
    }

    private static func captureH264Stream() async throws {
        guard activeSession() else { throw HostError.sessionUnavailable }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) else {
            throw HostError.noMainDisplay
        }
        let scale = min(1.0, min(1920.0 / Double(display.width), 1080.0 / Double(display.height)))
        let width = max(2, Int((Double(display.width) * scale).rounded()) & ~1)
        let height = max(2, Int((Double(display.height) * scale).rounded()) & ~1)
        let configuration = SCStreamConfiguration()
        configuration.width = width
        configuration.height = height
        configuration.showsCursor = false
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 60)
        configuration.queueDepth = 3
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let frames = LatestScreenFrame()
        let stream = SCStream(filter: filter, configuration: configuration, delegate: frames)
        try stream.addStreamOutput(frames, type: .screen,
                                   sampleHandlerQueue: DispatchQueue(label: "instar.desktop.h264.frames"))
        let encoder = try DesktopH264Encoder(width: width, height: height)
        var fallback: ShieldDisplayStream?
        do {
            try await stream.startCapture()
            if lockedFeatureOn, !(await frames.waitForFirstFrame()) { fallback = try ShieldDisplayStream(width: width, height: height) }
        } catch where lockedFeatureOn {
            fallback = try ShieldDisplayStream(width: width, height: height)
        }
        defer { fallback?.stop(); Task { try? await stream.stopCapture() } }
        var lastSentGeneration: UInt64 = 0
        var forceNext = true
        while true {
            let command = FileHandle.standardInput.readData(ofLength: 1)
            if command.isEmpty { return }
            guard (command == Data([0x6e]) || command == Data([0x6b])), activeSession() else {
                throw HostError.sessionUnavailable
            }
            if command == Data([0x6b]) { forceNext = true }
            var pixelBuffer: CVPixelBuffer?
            var currentGeneration: UInt64 = 0
            for _ in 0..<200 {
                let (latest, generation, stopped) = fallback?.takeLatest() ?? frames.takeLatest()
                if stopped { throw HostError.sessionUnavailable }
                if let latest { pixelBuffer = latest; currentGeneration = generation; break }
                try await Task.sleep(for: .milliseconds(10))
            }
            guard let pixelBuffer else { throw HostError.inputUnavailable }
            if currentGeneration == lastSentGeneration && !forceNext {
                FileHandle.standardOutput.write(Data(repeating: 0, count: 4))
                continue
            }
            let (annexB, keyframe) = try encoder.encode(pixelBuffer, forceKeyframe: forceNext)
            guard annexB.count + 5 <= 1_250_000 else { throw HostError.frameTooLarge }
            var payload = Data([keyframe ? 1 : 0,
                                UInt8((width >> 8) & 0xff), UInt8(width & 0xff),
                                UInt8((height >> 8) & 0xff), UInt8(height & 0xff)])
            payload.append(annexB)
            var length = UInt32(payload.count).bigEndian
            FileHandle.standardOutput.write(withUnsafeBytes(of: &length) { Data($0) })
            FileHandle.standardOutput.write(payload)
            lastSentGeneration = currentGeneration
            forceNext = !keyframe && forceNext
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
        // Set per spawn only while this Mac's locked-screen feature is on, so
        // with it off every verb refuses at the shield exactly as before.
        if lockedFeatureOn { return onConsole && loginDone }
        return onConsole && loginDone && (state["CGSSessionScreenIsLocked"] as? Bool) != true
    }

    enum HostError: Error {
        case noMainDisplay
        case sessionUnavailable
        case frameTooLarge
        case inputPermissionMissing
        case inputUnavailable
        case invalidInput
        case refused(String)
    }
}

// MARK: - Locked screen (docs/specs/desktop-locked-screen.md)
//
// Everything below is reached only when Node sets INSTAR_DESKTOP_LOCKED for this
// spawn, or through the state-op and relock-guard verbs, which Node starts only
// while the feature is on. Grant authority stays in Node. This file owns one
// thing Node cannot: state that must survive Node, under a kernel lock.

/// The display fallback when ScreenCaptureKit gives no frames at the shield.
/// Unavailable when compiling for macOS 15 or later, which is why every build
/// pins its deployment target to 13.
@available(macOS 14.0, *)
private final class ShieldDisplayStream {
    private let lock = NSLock()
    private var latest: CVPixelBuffer?
    private var generation: UInt64 = 0
    private var stream: CGDisplayStream?
    private let queue = DispatchQueue(label: "instar.desktop.shield")

    init(width: Int, height: Int) throws {
        guard let created = CGDisplayStream(dispatchQueueDisplay: CGMainDisplayID(),
            outputWidth: width, outputHeight: height, pixelFormat: Int32(kCVPixelFormatType_32BGRA),
            properties: [CGDisplayStream.showCursor: false] as CFDictionary, queue: queue,
            handler: { [weak self] status, _, surface, _ in
                guard status == .frameComplete, let surface, let self else { return }
                var buffer: Unmanaged<CVPixelBuffer>?
                CVPixelBufferCreateWithIOSurface(kCFAllocatorDefault, surface, nil, &buffer)
                self.lock.lock()
                self.latest = buffer?.takeRetainedValue()
                self.generation &+= 1
                self.lock.unlock()
            }), created.start() == .success else { throw InstarDesktopHost.HostError.sessionUnavailable }
        stream = created
    }

    func takeLatest() -> (CVPixelBuffer?, UInt64, Bool) {
        lock.lock()
        defer { lock.unlock() }
        return (latest, generation, false)
    }

    func stop() { _ = stream?.stop(); stream = nil }
}

/// Reads commands on their own thread, so Stop reaches a 20 s password send
/// between characters instead of waiting for it to finish.
final class InputCommandQueue {
    private let lock = NSCondition()
    private var lines: [String] = []
    private var closed = false
    private var aborted = false

    func start() {
        Thread.detachNewThread { [self] in
            while let line = readLine(strippingNewline: true) {
                lock.lock()
                if line == "{\"kind\":\"abort\"}" { aborted = true } else { lines.append(line) }
                lock.signal()
                lock.unlock()
            }
            lock.lock()
            closed = true
            aborted = true
            lock.signal()
            lock.unlock()
        }
    }

    func next() -> String? {
        lock.lock()
        defer { lock.unlock() }
        while lines.isEmpty && !closed { lock.wait() }
        return lines.isEmpty ? nil : lines.removeFirst()
    }

    /// Cleared only after a command finishes, so a Stop read before its send
    /// started still reaches it.
    func clearAbort() {
        lock.lock()
        defer { lock.unlock() }
        if !closed { aborted = false }
    }

    var wasAborted: Bool {
        lock.lock()
        defer { lock.unlock() }
        return aborted
    }
}

@available(macOS 14.0, *)
/// Per-Mac state shared by every agent's helper. One kernel lock, so Node and
/// the guard cannot both decide; Node only ever reaches it through a short-lived
/// state-op process, so a suspended Node can never hold the lock.
enum LockedStore {
    static func path(_ root: String, _ name: String) -> String { root + "/" + name }

    private static func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

    static func withLock<T>(root: String, _ body: (inout [String: Any]) -> T) -> T? {
        guard mkdir(root, 0o700) == 0 || errno == EEXIST else { return nil }
        let fd = open(path(root, "state.lock"), O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, mode_t(0o600))
        guard fd >= 0 else { return nil }
        defer { close(fd) }
        guard flock(fd, LOCK_EX) == 0 else { return nil }
        let file = path(root, "locked-state.json")
        var state: [String: Any] = [:]
        if let data = FileManager.default.contents(atPath: file) {
            // Never rewrite what cannot be read: that would erase relock duties.
            guard let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
            state = parsed
        }
        let result = body(&state)
        guard let data = try? JSONSerialization.data(withJSONObject: state) else { return nil }
        let temporary = file + ".\(getpid()).tmp"
        guard FileManager.default.createFile(atPath: temporary, contents: data, attributes: [.posixPermissions: 0o600]),
              rename(temporary, file) == 0 else { return nil }
        return result
    }

    /// A read writes nothing, so a full disk cannot look like a lost marker.
    /// Nil means unreadable; a missing file is an empty store.
    static func readOnly(root: String) -> [String: Any]? {
        let fd = open(path(root, "state.lock"), O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        if fd >= 0 { flock(fd, LOCK_SH) }
        defer { if fd >= 0 { close(fd) } }
        guard let data = FileManager.default.contents(atPath: path(root, "locked-state.json")) else { return [:] }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    static func marker(_ state: [String: Any], _ key: String) -> [String: Any]? {
        (state["markers"] as? [String: Any])?[key] as? [String: Any]
    }

    static func setMarker(_ state: inout [String: Any], _ key: String, _ value: [String: Any]) {
        var markers = state["markers"] as? [String: Any] ?? [:]
        markers[key] = value
        state["markers"] = markers
    }

    private static func today() -> String {
        let format = DateFormatter()
        format.dateFormat = "yyyy-MM-dd"
        return format.string(from: Date())
    }

    static func currentAttempts(_ state: [String: Any]) -> [String: Any] {
        let attempts = state["attempts"] as? [String: Any] ?? [:]
        return attempts["day"] as? String == today() ? attempts : ["day": today(), "count": 0, "perRequest": [String: Any]()]
    }

    /// Reserves one attempt before the first character, or names why not.
    static func reserve(state: inout [String: Any], key: String, requestId: String, now: Int64,
                        heartbeatAgeMs: Int64?) -> String? {
        guard var entry = marker(state, key), entry["state"] as? String == "owed" else { return "relock-not-owed" }
        if entry["relockNow"] as? Bool == true { return "relocking" }
        guard let age = heartbeatAgeMs, age < 15_000 else { return "guard-not-alive" }
        if state["dirty"] != nil { return "field-dirty" }
        if state["disabled"] as? Bool == true { return "disabled" }
        var attempts = currentAttempts(state)
        var perRequest = attempts["perRequest"] as? [String: Any] ?? [:]
        let mine = perRequest[requestId] as? Int ?? 0
        let count = attempts["count"] as? Int ?? 0
        if mine >= 3 { return "attempts-per-request" }
        if count >= 6 { return "attempts-per-day" }
        perRequest[requestId] = mine + 1
        attempts["perRequest"] = perRequest
        attempts["count"] = count + 1
        state["attempts"] = attempts
        state["dirty"] = ["at": now, "loginSession": sessionUUID() ?? ""]
        entry["typistPid"] = Int(getpid())
        entry["typistStart"] = processInfo(getpid())?.start ?? ""
        setMarker(&state, key, entry)
        return nil
    }

    static func heartbeatAge(root: String, key: String) -> Int64? {
        var info = stat()
        guard stat(path(root, "hb-\(key)"), &info) == 0 else { return nil }
        return nowMs() - Int64(info.st_mtimespec.tv_sec) * 1000
    }

    /// Node's whole view of this state. Every change passes through here.
    static func perform(root: String, op: [String: Any]) -> [String: Any]? {
        guard let name = op["op"] as? String else { return nil }
        let key = op["key"] as? String ?? ""
        if name == "process-start" {
            guard let pid = op["pid"] as? Int else { return ["start": ""] }
            return ["start": processInfo(pid_t(pid))?.start ?? ""]
        }
        if name == "kill-recorded" {
            guard let pid = op["pid"] as? Int, let start = op["start"] as? String else { return ["gone": true] }
            return ["gone": InstarDesktopHost.killRecorded(pid: pid_t(pid), start: start)]
        }
        if name == "read" {
            guard let state = readOnly(root: root) else { return nil }
            return ["state": state, "attempts": currentAttempts(state),
                    "bootSession": bootUUID() ?? "", "loginSession": sessionUUID() ?? ""]
        }
        return withLock(root: root) { state -> [String: Any] in
            switch name {
            case "marker-create":
                if let existing = marker(state, key) { return ["marker": existing, "created": false] }
                // A blank session would later read as someone else, cancelling the duty.
                guard bootUUID() != nil, sessionUUID() != nil else { return ["error": "session-unreadable"] }
                var entry = op["marker"] as? [String: Any] ?? [:]
                entry["state"] = "owed"
                entry["relockNow"] = false
                entry["createdAt"] = nowMs()
                entry["bootSession"] = bootUUID() ?? ""
                entry["loginSession"] = sessionUUID() ?? ""
                setMarker(&state, key, entry)
                pruneOld(&state)
                return ["marker": entry, "created": true]
            case "relock-now":
                guard var entry = marker(state, key) else { return ["found": false] }
                if !isTerminal(entry["state"] as? String) { entry["relockNow"] = true; setMarker(&state, key, entry) }
                return ["found": true, "state": entry["state"] ?? ""]
            case "leave-unlocked":
                guard var entry = marker(state, key), entry["state"] as? String == "owed" else {
                    return ["ok": false, "state": marker(state, key)?["state"] ?? ""]
                }
                entry["state"] = "left-unlocked"
                setMarker(&state, key, entry)
                return ["ok": true]
            case "set-guard":
                guard var entry = marker(state, key) else { return ["found": false] }
                entry["guardPid"] = op["pid"]
                entry["guardStart"] = op["start"]
                entry["guardReplacements"] = op["replacements"]
                setMarker(&state, key, entry)
                return ["found": true]
            case "close":
                guard var entry = marker(state, key), !isTerminal(entry["state"] as? String)
                    || entry["state"] as? String == "relock-failed" else { return ["ok": false] }
                entry["state"] = op["to"] as? String ?? "closed-not-applicable"
                if let gone = op["producerGone"] as? Bool { entry["producerGone"] = gone }
                setMarker(&state, key, entry)
                return ["ok": true]
            case "set-producer-gone":
                guard var entry = marker(state, key) else { return ["ok": false] }
                entry["producerGone"] = true
                setMarker(&state, key, entry)
                return ["ok": true]
            case "mark-reported":
                guard var entry = marker(state, key) else { return ["ok": false] }
                entry["reported"] = true
                setMarker(&state, key, entry)
                return ["ok": true]
            case "refund":
                var attempts = currentAttempts(state)
                var perRequest = attempts["perRequest"] as? [String: Any] ?? [:]
                let id = op["requestId"] as? String ?? ""
                perRequest[id] = max(0, (perRequest[id] as? Int ?? 0) - 1)
                attempts["perRequest"] = perRequest
                attempts["count"] = max(0, (attempts["count"] as? Int ?? 0) - 1)
                state["attempts"] = attempts
                return ["ok": true]
            case "clear-dirty":
                state["dirty"] = nil
                return ["ok": true]
            case "set-disabled":
                state["disabled"] = op["disabled"] as? Bool ?? true
                return ["ok": true]
            default:
                return ["error": "unknown-op"]
            }
        }
    }

    /// Keeps the store small: finished duties older than a week carry nothing.
    private static func pruneOld(_ state: inout [String: Any]) {
        guard var markers = state["markers"] as? [String: Any] else { return }
        let cutoff = nowMs() - 7 * 24 * 3_600_000
        for (key, value) in markers {
            guard let entry = value as? [String: Any], isTerminal(entry["state"] as? String),
                  entry["state"] as? String != "relock-failed" || entry["reported"] as? Bool == true,
                  ((entry["createdAt"] as? NSNumber)?.int64Value ?? 0) < cutoff else { continue }
            markers[key] = nil
        }
        state["markers"] = markers
    }

    static func isTerminal(_ state: String?) -> Bool {
        ["relocked", "relock-failed", "left-unlocked", "closed-not-applicable"].contains(state ?? "")
    }

    static func bootUUID() -> String? {
        var size = 0
        guard sysctlbyname("kern.bootsessionuuid", nil, &size, nil, 0) == 0, size > 0 else { return nil }
        var bytes = [CChar](repeating: 0, count: size)
        guard sysctlbyname("kern.bootsessionuuid", &bytes, &size, nil, 0) == 0 else { return nil }
        return String(cString: bytes)
    }

    static func sessionUUID() -> String? {
        (CGSessionCopyCurrentDictionary() as? [String: Any])?["CGSSessionUniqueSessionUUID"] as? String
    }

    static func processInfo(_ pid: pid_t) -> (start: String, zombie: Bool)? {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var name: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        guard sysctl(&name, 4, &info, &size, nil, 0) == 0, size > 0 else { return nil }
        let start = info.kp_proc.p_un.__p_starttime
        return ("\(start.tv_sec).\(start.tv_usec)", info.kp_proc.p_stat == 5)
    }
}

@available(macOS 14.0, *)
extension InstarDesktopHost {
    private static let lockWatchSeconds = 120
    private static var sealKey: P256.KeyAgreement.PrivateKey?
    private static var seenSecretSequences = Set<Int>()
    private static var layoutKeys: [Unicode.Scalar: (CGKeyCode, CGEventFlags)] = [:]

    static var lockedFeatureOn: Bool { getenv("INSTAR_DESKTOP_LOCKED") != nil }
    private static var lockedRoot: String {
        getenv("INSTAR_DESKTOP_LOCKED_ROOT").map { String(cString: $0) } ?? ""
    }

    /// One definition, used by every path that kills and confirms: no such
    /// process, or a different start time, or a zombie, which can do nothing and
    /// which a suspended parent can never reap.
    static func processGone(pid: pid_t, start: String) -> Bool {
        guard let info = LockedStore.processInfo(pid) else { return true }
        return info.start != start || info.zombie
    }

    static func killRecorded(pid: pid_t, start: String) -> Bool {
        guard pid > 1, !start.isEmpty else { return true }
        if processGone(pid: pid, start: start) { return true }
        kill(pid, SIGKILL)
        for _ in 0..<50 {
            if processGone(pid: pid, start: start) { return true }
            usleep(100_000)
        }
        return false
    }

    fileprivate static func holdDisplayAwake() -> IOPMAssertionID? {
        var assertion: IOPMAssertionID = 0
        var id: IOPMAssertionID = 0
        _ = IOPMAssertionDeclareUserActivity("Instar remote control" as CFString, kIOPMUserActiveLocal, &id)
        let status = IOPMAssertionCreateWithName(kIOPMAssertPreventUserIdleDisplaySleep as CFString,
            IOPMAssertionLevel(kIOPMAssertionLevelOn), "Instar remote control" as CFString, &assertion)
        return status == kIOReturnSuccess ? assertion : nil
    }

    private static func consoleUserName() -> String? {
        var uid: uid_t = 0
        guard let name = SCDynamicStoreCopyConsoleUserName(&uid) else { return nil }
        return name
    }

    private static func SCDynamicStoreCopyConsoleUserName(_ uid: inout uid_t) -> String? {
        var info = stat()
        guard stat("/dev/console", &info) == 0, let owner = getpwuid(info.st_uid) else { return nil }
        uid = info.st_uid
        return String(cString: owner.pointee.pw_name)
    }

    static func shieldWindowPresent() -> Bool {
        guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else { return false }
        let display = CGDisplayBounds(CGMainDisplayID())
        return windows.contains { window in
            guard window[kCGWindowOwnerName as String] as? String == "loginwindow",
                  let layer = window[kCGWindowLayer as String] as? Int,
                  let raw = window[kCGWindowBounds as String] as? [String: CGFloat],
                  let bounds = CGRect(dictionaryRepresentation: raw as CFDictionary) else { return false }
            return layer >= Int(CGWindowLevelForKey(.screenSaverWindow))
                && bounds.width >= display.width && bounds.height >= display.height
        }
    }

    /// `loginwindow`, `other`, `none` or `unreadable`.
    static func secureInputOwner() -> String {
        let root = IORegistryEntryFromPath(kIOMainPortDefault, "IOService:/IOResources/IOConsoleUsers")
        defer { IOObjectRelease(root) }
        guard root != 0, let users = IORegistryEntryCreateCFProperty(root, "IOConsoleUsers" as CFString,
            kCFAllocatorDefault, 0)?.takeRetainedValue() as? [[String: Any]] else { return "unreadable" }
        guard let pid = users.compactMap({ $0["kCGSSessionSecureInputPID"] as? Int32 }).first(where: { $0 > 0 }) else { return "none" }
        var name = [CChar](repeating: 0, count: 256)
        guard proc_name(pid, &name, 256) > 0 else { return "unreadable" }
        return String(cString: name) == "loginwindow" ? "loginwindow" : "other"
    }

    fileprivate static func lockInputs(_ state: [String: Any]?) -> [String: Any] {
        var online: UInt32 = 0
        _ = CGGetOnlineDisplayList(0, nil, &online)
        var report: [String: Any] = ["shieldWindow": shieldWindowPresent(),
            "secureInputOwner": secureInputOwner(),
            "displayAsleep": CGDisplayIsAsleep(CGMainDisplayID()) != 0,
            "screensaver": NSWorkspace.shared.runningApplications.contains { $0.bundleIdentifier == "com.apple.ScreenSaver.Engine" },
            "onlineDisplays": Int(online), "thisUser": String(cString: getpwuid(getuid()).pointee.pw_name),
            "osMajor": ProcessInfo.processInfo.operatingSystemVersion.majorVersion,
            "sampledAtMs": Int64(Date().timeIntervalSince1970 * 1000)]
        var uid: uid_t = 0
        if let user = SCDynamicStoreCopyConsoleUserName(&uid) { report["consoleUser"] = user }
        if let boot = LockedStore.bootUUID() { report["bootSession"] = boot }
        if let session = state?["CGSSessionUniqueSessionUUID"] as? String { report["loginSession"] = session }
        return report
    }

    /// Any of these means the allowlist applies. Secure input alone counts only
    /// when loginwindow holds it, so a password field in an ordinary app on an
    /// unlocked Mac changes nothing.
    private static func allowlistApplies() -> Bool {
        guard lockedFeatureOn else { return false }
        let state = CGSessionCopyCurrentDictionary() as? [String: Any]
        if state?["CGSSessionScreenIsLocked"] as? Bool == true || shieldWindowPresent() { return true }
        let owner = secureInputOwner()
        return owner == "loginwindow" || owner == "unreadable"
    }

    private static func refusedActions() -> Set<String> {
        guard let raw = getenv("INSTAR_DESKTOP_LOCKED_REFUSE") else { return [] }
        return Set(String(cString: raw).split(separator: ",").map(String.init))
    }

    private static func fieldDirty() -> Bool {
        guard !lockedRoot.isEmpty else { return false }
        return LockedStore.withLock(root: lockedRoot) { $0["dirty"] != nil } ?? true
    }

    fileprivate static func refuseWhileLocked(kind: String, raw: [String: Any]) throws {
        // Releasing what this helper really holds is never refused, in any state.
        if kind == "keyUp", let key = raw["key"] as? String, heldKeys.contains(key) { return }
        if kind == "buttonUp", let button = raw["button"] as? String, heldButton == button { return }
        guard allowlistApplies() else { return }
        let refused = refusedActions()
        switch kind {
        case "move": return
        case "click", "buttonDown":
            if refused.contains("click") { throw HostError.refused("not-at-the-lock-screen") }
            if fieldDirty() { throw HostError.refused("field-dirty") }
        case "keyDown", "keyUp":
            guard let key = raw["key"] as? String,
                  ["Enter", "Tab", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].contains(key),
                  !refused.contains(key) else { throw HostError.refused("not-at-the-lock-screen") }
            if key == "Enter" && fieldDirty() { throw HostError.refused("field-dirty") }
        default:
            throw HostError.refused("not-at-the-lock-screen")
        }
    }

    fileprivate static func prepareSecretChannel() {
        recoverDirtyField()
        let key = P256.KeyAgreement.PrivateKey()
        sealKey = key
        print("{\"sealKey\":\"\(key.publicKey.x963Representation.base64EncodedString())\"}")
        fflush(stdout)
        layoutKeys = buildLayoutKeys()
    }

    /// A killed helper cannot send Escape or release a modifier, so the next one
    /// does that first. Escape only while the shield is confirmed.
    private static func recoverDirtyField() {
        guard fieldDirty() else { return }
        releaseAllModifiers()
        clearFieldIfShield()
    }

    private static func clearFieldIfShield() {
        guard shieldWindowPresent(), secureInputOwner() == "loginwindow" else { return }
        postKey(53, flags: [], down: true)
        postKey(53, flags: [], down: false)
        _ = LockedStore.withLock(root: lockedRoot) { $0["dirty"] = nil }
    }

    private static func postKey(_ code: CGKeyCode, flags: CGEventFlags, down: Bool) {
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down) else { return }
        event.flags = flags
        event.post(tap: .cghidEventTap)
    }

    static func releaseAllModifiers() {
        for name in ["Meta", "Control", "Alt", "Shift"] {
            guard let code = keyCodes[name], let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else { continue }
            event.type = .flagsChanged
            event.flags = []
            event.post(tap: .cghidEventTap)
        }
    }

    /// The inverse of the active layout, so a password types the same characters
    /// on any keyboard. Control characters and dead keys are left out.
    private static func buildLayoutKeys() -> [Unicode.Scalar: (CGKeyCode, CGEventFlags)] {
        guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
              let property = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return [:] }
        let data = Unmanaged<CFData>.fromOpaque(property).takeUnretainedValue() as Data
        var result: [Unicode.Scalar: (CGKeyCode, CGEventFlags)] = [:]
        let modifiers: [(UInt32, CGEventFlags)] = [(0, []), (UInt32(shiftKey >> 8), .maskShift),
            (UInt32(optionKey >> 8), .maskAlternate), (UInt32((shiftKey | optionKey) >> 8), [.maskShift, .maskAlternate])]
        data.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) in
            guard let layout = bytes.bindMemory(to: UCKeyboardLayout.self).baseAddress else { return }
            for (state, flags) in modifiers {
                for code in UInt16(0)..<128 {
                    var dead: UInt32 = 0
                    var length = 0
                    var chars = [UniChar](repeating: 0, count: 4)
                    let status = UCKeyTranslate(layout, code, UInt16(kUCKeyActionDown), state, UInt32(LMGetKbdType()),
                        OptionBits(kUCKeyTranslateNoDeadKeysBit), &dead, 4, &length, &chars)
                    guard status == noErr, length == 1, let scalar = Unicode.Scalar(chars[0]),
                          scalar.value >= 0x20, result[scalar] == nil else { continue }
                    result[scalar] = (CGKeyCode(code), flags)
                }
            }
        }
        return result
    }

    private static func secureTargetHolds() -> Bool {
        (CGSessionCopyCurrentDictionary() as? [String: Any])?["CGSSessionScreenIsLocked"] as? Bool == true
            && shieldWindowPresent() && secureInputOwner() == "loginwindow"
    }

    /// Sealed bytes in, keystrokes out. Plaintext exists only here: never in
    /// Node, logs, disk or durable state. Its limit is stated in the spec:
    /// the check and the posted event are not atomic.
    fileprivate static func secretType(_ raw: [String: Any], abort: InputCommandQueue) throws {
        guard let key = sealKey, let requestId = raw["requestId"] as? String,
              let markerKey = raw["key"] as? String, let sequence = raw["seq"] as? Int,
              let ephemeralText = raw["ephemeral"] as? String, let ivText = raw["iv"] as? String,
              let cipherText = raw["ct"] as? String,
              let ephemeral = Data(base64Encoded: ephemeralText), let iv = Data(base64Encoded: ivText),
              let sealed = Data(base64Encoded: cipherText), sealed.count > 16 else { throw HostError.invalidInput }
        guard !seenSecretSequences.contains(sequence) else { throw HostError.refused("repeat") }
        seenSecretSequences.insert(sequence)
        var plain: Data
        do {
            let shared = try key.sharedSecretFromKeyAgreement(with: P256.KeyAgreement.PublicKey(x963Representation: ephemeral))
            let info = Data("instar-desktop-secret-v1:\(requestId):\(key.publicKey.x963Representation.base64EncodedString())".utf8)
            let symmetric = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: Data(), sharedInfo: info, outputByteCount: 32)
            let box = try AES.GCM.SealedBox(combined: iv + sealed)
            let aad = Data("[\"instar-desktop-secret-v1\",\"\(requestId)\",\(sequence)]".utf8)
            plain = try AES.GCM.open(box, using: symmetric, authenticating: aad)
        } catch { throw HostError.refused("seal-stale") }
        defer { plain.resetBytes(in: 0..<plain.count) }
        let text = String(decoding: plain, as: UTF8.self)
        let scalars = Array(text.unicodeScalars)
        guard !scalars.isEmpty, scalars.count <= 256 else { throw HostError.refused("too-long") }
        // Refused before reservation, so a character this layout cannot make
        // never spends an attempt.
        guard scalars.allSatisfy({ layoutKeys[$0] != nil }) else { throw HostError.refused("character-not-typable") }
        guard secureTargetHolds() else { throw HostError.refused("shield-not-confirmed") }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let age = LockedStore.heartbeatAge(root: lockedRoot, key: markerKey)
        guard let refusal = LockedStore.withLock(root: lockedRoot, { state in
            LockedStore.reserve(state: &state, key: markerKey, requestId: requestId, now: now, heartbeatAgeMs: age)
        }) as String?? else { throw HostError.refused("state-unavailable") }
        if let refusal { throw HostError.refused(refusal) }
        releaseAllModifiers()
        for scalar in scalars {
            guard !abort.wasAborted, secureTargetHolds(), let (code, flags) = layoutKeys[scalar] else {
                abandonField()
                throw HostError.refused("aborted")
            }
            postKey(code, flags: flags, down: true)
            postKey(code, flags: flags, down: false)
            usleep(8_000)
        }
        guard !abort.wasAborted, secureTargetHolds() else {
            abandonField()
            throw HostError.refused("aborted")
        }
        // The relock path and the grant-end rule both read this time.
        _ = LockedStore.withLock(root: lockedRoot) { state in
            if var entry = LockedStore.marker(state, markerKey) {
                entry["enterPendingAt"] = Int64(Date().timeIntervalSince1970 * 1000)
                LockedStore.setMarker(&state, markerKey, entry)
            }
        }
        postKey(36, flags: [], down: true)
        postKey(36, flags: [], down: false)
        // Only after Enter: a kill before it leaves a full password in the field.
        _ = LockedStore.withLock(root: lockedRoot) { $0["dirty"] = nil }
    }

    private static func abandonField() {
        releaseAllModifiers()
        clearFieldIfShield()
    }

    // MARK: Relock guard

    private enum Sample { case locked, open, unreadable }

    private static func flagSample() -> Sample {
        guard let state = CGSessionCopyCurrentDictionary() as? [String: Any] else { return .unreadable }
        return state["CGSSessionScreenIsLocked"] as? Bool == true ? .locked : .open
    }

    /// `nil` means a positive difference: someone else is there, so no lock call.
    /// `false` means unreadable, which is not a difference: retry.
    private static func stillOurSession(_ entry: [String: Any]) -> Bool? {
        guard let boot = LockedStore.bootUUID(), let session = LockedStore.sessionUUID() else { return false }
        if boot != entry["bootSession"] as? String || session != entry["loginSession"] as? String { return nil }
        guard let state = CGSessionCopyCurrentDictionary() as? [String: Any],
              let onConsole = state[kCGSessionOnConsoleKey as String] as? Bool else { return false }
        return onConsole ? true : nil
    }

    private static func lockNow() -> Bool {
        typealias Immediate = @convention(c) () -> Void
        if let handle = dlopen("/System/Library/PrivateFrameworks/login.framework/Versions/Current/login", RTLD_NOW),
           let symbol = dlsym(handle, "SACLockScreenImmediate") {
            unsafeBitCast(symbol, to: Immediate.self)()
            return true
        }
        guard let (code, _) = buildLayoutKeys()[Unicode.Scalar("q")] else { return false }
        let flags: CGEventFlags = [.maskCommand, .maskControl]
        postKey(code, flags: flags, down: true)
        postKey(code, flags: flags, down: false)
        return true
    }

    private static func transition(root: String, key: String, from: Set<String>, to: String,
                                   extra: [String: Any] = [:]) -> Bool {
        guard let moved = LockedStore.withLock(root: root, { state -> Bool in
            guard var entry = LockedStore.marker(state, key), from.contains(entry["state"] as? String ?? ""),
                  entry["guardPid"] as? Int == Int(getpid()) else { return false }
            entry["state"] = to
            entry["guardAt"] = Int64(Date().timeIntervalSince1970 * 1000)
            for (name, value) in extra { entry[name] = value }
            LockedStore.setMarker(&state, key, entry)
            return true
        }) else { emergencyLock(root: root, key: key) }
        return moved
    }

    /// Nil means the marker is really gone. An unreadable store is not that.
    private static func readMarker(root: String, key: String) -> [String: Any]? {
        guard let state = LockedStore.readOnly(root: root) else { emergencyLock(root: root, key: key) }
        return LockedStore.marker(state, key)
    }

    /// The store cannot be trusted, so this guard no longer knows the duty's
    /// state. An unknown duty on an open Mac means lock it. Node finds the file
    /// and tells the owner, since the store cannot carry `relock-failed`.
    private static func emergencyLock(root: String, key: String) -> Never {
        for _ in 0..<5 {
            guard let state = CGSessionCopyCurrentDictionary() as? [String: Any],
                  state[kCGSessionOnConsoleKey as String] as? Bool == true else { sleep(1); continue }
            if state["CGSSessionScreenIsLocked"] as? Bool == true { break }
            _ = lockNow()
            sleep(1)
        }
        FileManager.default.createFile(atPath: LockedStore.path(root, "failed-\(key)"), contents: Data(),
                                       attributes: [.posixPermissions: 0o600])
        exit(0)
    }

    private static func beat(root: String, key: String) {
        let file = LockedStore.path(root, "hb-\(key)")
        FileManager.default.createFile(atPath: file, contents: Data(), attributes: [.posixPermissions: 0o600])
        utimes(file, nil) // An empty rewrite need not move the time, and Node reads the time.
    }

    private static func leaseAgeMs(root: String, key: String) -> Int64? {
        var info = stat()
        guard stat(LockedStore.path(root, "lease-\(key)"), &info) == 0 else { return nil }
        return Int64(Date().timeIntervalSince1970 * 1000) - Int64(info.st_mtimespec.tv_sec) * 1000
    }

    /// Runs detached from Node: Node dying, hanging or restarting cannot stop
    /// it. It holds no authority except to lock this Mac for this one duty.
    fileprivate static func runRelockGuard(root: String, key: String) -> Never {
        let me = Int(getpid())
        _ = LockedStore.withLock(root: root) { state in
            guard var entry = LockedStore.marker(state, key) else { return }
            entry["guardPid"] = me
            entry["guardStart"] = LockedStore.processInfo(getpid())?.start ?? ""
            LockedStore.setMarker(&state, key, entry)
        }
        DispatchQueue.global().async {
            while true { beat(root: root, key: key); sleep(1) }
        }
        beat(root: root, key: key)
        while true {
            guard let entry = readMarker(root: root, key: key), !LockedStore.isTerminal(entry["state"] as? String) else { exit(0) }
            let status = entry["state"] as? String
            if status == "executing" || status == "watching" { runDuty(root: root, key: key) }
            let now = Int64(Date().timeIntervalSince1970 * 1000)
            let deadline = entry["deadlineMs"] as? Int64 ?? (entry["deadlineMs"] as? NSNumber)?.int64Value ?? 0
            let window = (entry["resumeWindowMs"] as? NSNumber)?.int64Value ?? 30_000
            let lease = leaseAgeMs(root: root, key: key)
            if entry["relockNow"] as? Bool == true || now >= deadline || lease == nil || lease! > window {
                runDuty(root: root, key: key)
            }
            sleep(1)
        }
    }

    /// Stops the typist, locks, then watches. Never returns.
    private static func runDuty(root: String, key: String) -> Never {
        _ = LockedStore.perform(root: root, op: ["op": "relock-now", "key": key])
        guard let entry = readMarker(root: root, key: key) else { exit(0) }
        if LockedStore.isTerminal(entry["state"] as? String) { exit(0) }
        let typist = (entry["typistPid"] as? Int).map { pid_t($0) }
        let typistStart = entry["typistStart"] as? String ?? ""
        var typistGone = typist == nil
        for _ in 0..<3 where !typistGone {
            typistGone = killRecorded(pid: typist!, start: typistStart)
        }
        if !typistGone {
            _ = transition(root: root, key: key, from: ["owed", "executing", "watching"], to: "relock-failed",
                           extra: ["producerGone": false])
            exit(0)
        }
        releaseAllModifiers()
        if entry["state"] as? String != "watching",
           !transition(root: root, key: key, from: ["owed", "executing"], to: "executing") { exit(0) }
        if entry["state"] as? String != "watching" {
            var locked = false
            for _ in 0..<3 where !locked {
                guard let current = readMarker(root: root, key: key), current["state"] as? String == "executing" else { exit(0) }
                guard let ours = stillOurSession(current) else {
                    _ = transition(root: root, key: key, from: ["executing"], to: "closed-not-applicable")
                    exit(0)
                }
                switch flagSample() {
                case .locked: locked = true
                case .unreadable: sleep(1)
                case .open:
                    if ours { _ = lockNow() }
                    sleep(1)
                    locked = flagSample() == .locked
                }
            }
            guard locked else {
                _ = transition(root: root, key: key, from: ["executing"], to: "relock-failed", extra: ["producerGone": true])
                exit(0)
            }
            let start = Int64(Date().timeIntervalSince1970 * 1000)
            guard transition(root: root, key: key, from: ["executing"], to: "watching", extra: ["watchStart": start]) else { exit(0) }
        }
        watch(root: root, key: key)
    }

    private static func watch(root: String, key: String) -> Never {
        guard let entry = readMarker(root: root, key: key) else { exit(0) }
        let start = (entry["watchStart"] as? NSNumber)?.int64Value ?? Int64(Date().timeIntervalSince1970 * 1000)
        let end = start + Int64(lockWatchSeconds) * 1000
        var relocks = 0
        while Int64(Date().timeIntervalSince1970 * 1000) < end {
            guard let current = readMarker(root: root, key: key), current["state"] as? String == "watching" else { exit(0) }
            if flagSample() == .open {
                guard let ours = stillOurSession(current) else {
                    _ = transition(root: root, key: key, from: ["watching"], to: "closed-not-applicable")
                    exit(0)
                }
                guard ours else { sleep(1); continue }
                relocks += 1
                if relocks > 3 {
                    _ = transition(root: root, key: key, from: ["watching"], to: "relock-failed", extra: ["producerGone": true])
                    exit(0)
                }
                _ = lockNow()
            }
            sleep(1)
        }
        for _ in 0..<3 {
            switch flagSample() {
            case .locked:
                _ = transition(root: root, key: key, from: ["watching"], to: "relocked")
                exit(0)
            case .open:
                if let current = readMarker(root: root, key: key), stillOurSession(current) == nil {
                    _ = transition(root: root, key: key, from: ["watching"], to: "closed-not-applicable")
                    exit(0)
                }
                sleep(1)
            case .unreadable: sleep(1)
            }
        }
        _ = transition(root: root, key: key, from: ["watching"], to: "relock-failed", extra: ["producerGone": true])
        exit(0)
    }
}
