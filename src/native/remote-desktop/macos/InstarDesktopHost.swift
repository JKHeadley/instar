// Instar's local macOS desktop host. It has no listener or network authority:
// the target agent owns grant checks and starts this process only for a live
// operator session. Frame bytes leave solely through stdout; nothing is saved.
import AppKit
import ApplicationServices
import CoreGraphics
import CoreImage
import CoreMedia
import CoreVideo
import Darwin
import Foundation
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
        "a": 0, "c": 8, "v": 9, "x": 7, "z": 6,
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

    static func main() async {
        guard CommandLine.arguments.count == 2 else {
            fputs("usage: instar-desktop-host probe|request-permission|capture|capture-stream|capture-stream-h264|cursor|input|input-stream|release|indicator\n", stderr)
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
            print("{\"screenPermission\":\(screen),\"inputPermission\":\(input),\"displayCount\":\(displays),\"sessionActive\":\(session),\"consoleSessionPresent\":\(state != nil),\"onConsole\":\(onConsole),\"loginDone\":\(loginDone),\"screenLocked\":\(screenLocked)}")
        case "indicator":
            guard activeSession() else { exit(69) }
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
                  buttons.count <= 2, keys.count <= keyCodes.count,
                  buttons.allSatisfy({ $0 == "left" || $0 == "right" }),
                  keys.allSatisfy({ keyCodes[$0] != nil }) else { exit(69) }
            if !buttons.isEmpty || !keys.isEmpty {
                // A failed OS preflight is not proof that a held remote
                // control was released. Keep the Node barrier failed closed.
                guard activeSession(), AXIsProcessTrusted() else { exit(69) }
                let point = CGEvent(source: nil)?.location ?? CGPoint.zero
                for button in buttons {
                    let mouseButton: CGMouseButton = button == "left" ? .left : .right
                    let kind: CGEventType = button == "left" ? .leftMouseUp : .rightMouseUp
                    guard let event = CGEvent(mouseEventSource: nil, mouseType: kind,
                                              mouseCursorPosition: point, mouseButton: mouseButton) else { exit(69) }
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
            while let line = readLine(strippingNewline: true) {
                do {
                    try performInput(Data(line.utf8))
                    print("{\"ok\":true}")
                    fflush(stdout)
                } catch {
                    fputs("input unavailable: \(error)\n", stderr)
                    releaseHeldInput()
                    exit(69)
                }
            }
        default:
            fputs("unknown desktop-host command\n", stderr)
            exit(64)
        }
    }

    private static func releaseHeldInput() {
        guard activeSession(), AXIsProcessTrusted() else { return }
        if let button = heldButton {
            let point = CGEvent(source: nil)?.location ?? CGPoint.zero
            let mouseButton: CGMouseButton = button == "right" ? .right : .left
            let type: CGEventType = button == "right" ? .rightMouseUp : .leftMouseUp
            CGEvent(mouseEventSource: nil, mouseType: type,
                    mouseCursorPosition: point, mouseButton: mouseButton)?.post(tap: .cghidEventTap)
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

    private static func performInput(_ data: Data) throws {
        guard activeSession() else { throw HostError.sessionUnavailable }
        guard AXIsProcessTrusted() else { throw HostError.inputPermissionMissing }
        guard data.count > 0, data.count <= 4_096,
              let raw = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let kind = raw["kind"] as? String else {
            throw HostError.invalidInput
        }
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
                    : heldButton == "right" ? .rightMouseDragged : .mouseMoved
                let dragButton: CGMouseButton = heldButton == "right" ? .right : .left
                guard let event = CGEvent(mouseEventSource: nil, mouseType: dragType,
                                          mouseCursorPosition: point, mouseButton: dragButton) else {
                    throw HostError.inputUnavailable
                }
                event.flags = modifierFlags(heldKeys)
                event.post(tap: .cghidEventTap)
            } else {
                let button = raw["button"] as? String ?? "left"
                guard button == "left" || button == "right" else { throw HostError.invalidInput }
                // Refuse a second down or an unmatched up. A malformed command
                // must not silently change the host's held-button state.
                if kind == "buttonDown" && heldButton != nil { throw HostError.invalidInput }
                if kind == "buttonUp" && heldButton != button { throw HostError.invalidInput }
                let mouseButton: CGMouseButton = button == "left" ? .left : .right
                let downType: CGEventType = button == "left" ? .leftMouseDown : .rightMouseDown
                let upType: CGEventType = button == "left" ? .leftMouseUp : .rightMouseUp
                if kind == "click" && heldButton != nil { throw HostError.invalidInput }
                let up = kind == "buttonDown" ? nil : CGEvent(mouseEventSource: nil, mouseType: upType,
                    mouseCursorPosition: point, mouseButton: mouseButton)
                if kind != "buttonDown" && up == nil { throw HostError.inputUnavailable }
                if kind != "buttonUp" {
                    guard let down = CGEvent(mouseEventSource: nil, mouseType: downType,
                                             mouseCursorPosition: point, mouseButton: mouseButton) else {
                        throw HostError.inputUnavailable
                    }
                    down.flags = modifierFlags(heldKeys)
                    down.post(tap: .cghidEventTap)
                    if kind == "buttonDown" { heldButton = button }
                }
                if let up {
                    up.flags = modifierFlags(heldKeys)
                    up.post(tap: .cghidEventTap)
                    heldButton = nil
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
        try await stream.startCapture()
        defer { Task { try? await stream.stopCapture() } }
        let context = CIContext(options: [.useSoftwareRenderer: false])
        var lastSentGeneration: UInt64 = 0
        while true {
            let command = FileHandle.standardInput.readData(ofLength: 1)
            if command.isEmpty { return }
            guard command == Data([0x6e]), activeSession() else { throw HostError.sessionUnavailable }
            var pixelBuffer: CVPixelBuffer?
            var currentGeneration: UInt64 = 0
            for _ in 0..<200 {
                let (latest, generation, stopped) = frames.takeLatest()
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
        try await stream.startCapture()
        defer { Task { try? await stream.stopCapture() } }
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
                let (latest, generation, stopped) = frames.takeLatest()
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
