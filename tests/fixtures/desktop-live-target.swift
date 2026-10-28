import AppKit
import CoreGraphics

final class TestView: NSView {
    override var acceptsFirstResponder: Bool { true }
    private func report(_ name: String) {
        print("{\"event\":\"\(name)\"}")
        fflush(stdout)
    }
    override func mouseDown(with event: NSEvent) { report("down") }
    override func mouseDragged(with event: NSEvent) { report("drag") }
    override func mouseUp(with event: NSEvent) { report("up") }
    override func flagsChanged(with event: NSEvent) {
        report(event.modifierFlags.contains(.command) ? "metaDown" : "metaUp")
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let screen = NSScreen.main?.frame ?? NSRect(x: 0, y: 0, width: 800, height: 600)
let rect = NSRect(x: screen.midX - 120, y: screen.midY - 80, width: 240, height: 160)
let window = NSWindow(contentRect: rect, styleMask: [.titled, .closable],
                      backing: .buffered, defer: false)
let view = TestView(frame: NSRect(x: 0, y: 0, width: rect.width, height: rect.height))
window.title = "Instar live input test"
window.contentView = view
window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
window.makeFirstResponder(view)
let bounds = CGDisplayBounds(CGMainDisplayID())
let x = (rect.midX - bounds.minX) / (bounds.width - 1)
let y = (bounds.maxY - rect.midY) / (bounds.height - 1)
print("{\"ready\":{\"x\":\(x),\"y\":\(y)}}")
fflush(stdout)
app.run()
