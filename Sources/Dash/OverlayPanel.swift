import AppKit
import SwiftUI

/// A borderless floating panel. It can take keyboard focus (for the chat field) without
/// activating Dash, so clicking it doesn't pull your homework window to the back.
/// Drag it by the header, resize it from the bottom-right grip; its frame is remembered.
final class OverlayPanel: NSPanel {
    static let minSize = NSSize(width: 300, height: 96)
    private static let autosaveName = "DashOverlayFrame"

    /// Called for Esc. Defaults to hiding the panel.
    var onCancel: (() -> Void)?

    init<Content: View>(rootView: Content) {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 440, height: 300),
                   styleMask: [.nonactivatingPanel, .borderless, .resizable],
                   backing: .buffered, defer: false)
        isFloatingPanel = true
        // Above the Dock (window level 20), so the panel can be dragged over it instead of behind it.
        level = .statusBar
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        hidesOnDeactivate = false
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        appearance = NSAppearance(named: .vibrantDark)
        minSize = Self.minSize

        let hosting = FirstClickHostingView(rootView: rootView)
        hosting.sizingOptions = []
        contentView = hosting

        if !setFrameUsingName(Self.autosaveName) { resetPosition() }
        setFrameAutosaveName(Self.autosaveName)
    }

    /// Default spot: bottom-right of the main screen, clear of the Dock.
    func resetPosition() {
        guard let visible = NSScreen.main?.visibleFrame else { return }
        let size = NSSize(width: 440, height: 300)
        setFrame(NSRect(x: visible.maxX - size.width - 24, y: visible.minY + 24,
                        width: size.width, height: size.height), display: true)
    }

    /// Snaps the panel across the Dock: full screen width, anchored to the bottom edge, covering the
    /// Dock's strip. The frame is remembered like any other position.
    func snapOverDock() {
        guard let screen = screen ?? NSScreen.main else { return }
        let dock = screen.visibleFrame.minY - screen.frame.minY
        let height = max(dock, 110)
        setFrame(NSRect(x: screen.frame.minX, y: screen.frame.minY, width: screen.frame.width, height: height),
                 display: true)
    }

    /// A borderless panel is otherwise pushed back out of the Dock's strip when dragged there.
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    override func cancelOperation(_ sender: Any?) {
        if let onCancel { onCancel() } else { orderOut(nil) }
    }

    /// The panel has no menu bar of its own, so route the standard editing shortcuts by hand.
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
           let key = event.charactersIgnoringModifiers {
            let action: Selector? = switch key {
            case "x": #selector(NSText.cut(_:))
            case "c": #selector(NSText.copy(_:))
            case "v": #selector(NSText.paste(_:))
            case "a": #selector(NSText.selectAll(_:))
            case "z": Selector(("undo:"))
            default: nil
            }
            if let action, NSApp.sendAction(action, to: nil, from: self) { return true }
        }
        return super.performKeyEquivalent(with: event)
    }
}

/// Buttons respond to the first click even while the panel isn't key.
final class FirstClickHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// An area that moves the window when dragged. Used behind the header.
struct WindowDragArea: NSViewRepresentable {
    final class DragView: NSView {
        override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
        override func mouseDown(with event: NSEvent) { window?.performDrag(with: event) }
    }

    func makeNSView(context: Context) -> DragView { DragView() }
    func updateNSView(_ nsView: DragView, context: Context) {}
}

/// A small grip in the bottom-right corner. Dragging it resizes the panel while the
/// top-left corner stays put.
struct ResizeGrip: NSViewRepresentable {
    final class GripView: NSView {
        private var startMouse: NSPoint = .zero
        private var startFrame: NSRect = .zero

        override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

        override func mouseDown(with event: NSEvent) {
            startMouse = NSEvent.mouseLocation
            startFrame = window?.frame ?? .zero
        }

        override func mouseDragged(with event: NSEvent) {
            guard let window else { return }
            let mouse = NSEvent.mouseLocation
            var frame = startFrame
            frame.size.width = max(OverlayPanel.minSize.width, startFrame.width + mouse.x - startMouse.x)
            frame.size.height = max(OverlayPanel.minSize.height, startFrame.height - (mouse.y - startMouse.y))
            frame.origin.y = startFrame.maxY - frame.height
            window.setFrame(frame, display: true)
        }

        override func resetCursorRects() {
            if #available(macOS 15.0, *) {
                addCursorRect(bounds, cursor: .frameResize(position: .bottomRight, directions: .all))
            } else {
                addCursorRect(bounds, cursor: .crosshair)
            }
        }

        override func draw(_ dirtyRect: NSRect) {
            NSColor.white.withAlphaComponent(0.35).setStroke()
            let path = NSBezierPath()
            path.lineWidth = 1.2
            path.lineCapStyle = .round
            for inset in [3.0, 7.0] {
                // Diagonal strokes hugging the bottom-right corner (unflipped: y grows upward).
                path.move(to: NSPoint(x: bounds.maxX - 3, y: bounds.minY + 3 + (bounds.height - 3 - inset)))
                path.line(to: NSPoint(x: bounds.maxX - 3 - (bounds.width - 3 - inset), y: bounds.minY + 3))
            }
            path.stroke()
        }
    }

    func makeNSView(context: Context) -> GripView { GripView() }
    func updateNSView(_ nsView: GripView, context: Context) {}
}
