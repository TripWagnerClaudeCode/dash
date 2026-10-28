import AppKit
import SwiftUI

enum ComposerKey { case up, down, enter, tab, escape }

/// A multi-line text field for the chat composer: Return sends, Shift-Return (or Option-Return)
/// adds a line, and pasted or dropped files and images become attachments. SwiftUI's TextField
/// can't tell those Return keys apart or see non-text paste.
struct ComposerTextView: NSViewRepresentable {
    @Binding var text: String
    @Binding var height: CGFloat
    var focusToken: Int = 0
    var onSubmit: () -> Void
    var onAttach: ([ChatAttachment]) -> Void
    /// Keys the surrounding view may want first (the / skill picker). Return true if handled.
    var onKey: (ComposerKey) -> Bool = { _ in false }

    private static let font = NSFont.systemFont(ofSize: 13.5)
    private static let minHeight: CGFloat = 22
    private static let maxHeight: CGFloat = 200

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.scrollerStyle = .overlay

        let textView = AttachableTextView()
        textView.delegate = context.coordinator
        textView.isRichText = false
        textView.allowsUndo = true
        textView.font = Self.font
        textView.textColor = .labelColor
        textView.drawsBackground = false
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.textContainerInset = NSSize(width: 0, height: 2)
        textView.textContainer?.lineFragmentPadding = 0
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = true
        textView.onAttach = { context.coordinator.parent.onAttach($0) }
        scroll.documentView = textView
        context.coordinator.textView = textView
        DispatchQueue.main.async { textView.window?.makeFirstResponder(textView) }
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let textView = context.coordinator.textView else { return }
        if textView.string != text { textView.string = text }
        if context.coordinator.lastFocusToken != focusToken {
            context.coordinator.lastFocusToken = focusToken
            DispatchQueue.main.async { textView.window?.makeFirstResponder(textView) }
        }
        context.coordinator.updateHeight()
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ComposerTextView
        weak var textView: NSTextView?
        var lastFocusToken: Int

        init(_ parent: ComposerTextView) {
            self.parent = parent
            lastFocusToken = parent.focusToken
        }

        func textDidChange(_ notification: Notification) {
            guard let textView else { return }
            parent.text = textView.string
            updateHeight()
        }

        func updateHeight() {
            guard let textView, let layout = textView.layoutManager, let container = textView.textContainer else { return }
            layout.ensureLayout(for: container)
            let used = layout.usedRect(for: container).height + textView.textContainerInset.height * 2
            let height = min(max(used.rounded(.up), ComposerTextView.minHeight), ComposerTextView.maxHeight)
            if abs(parent.height - height) > 0.5 {
                DispatchQueue.main.async { self.parent.height = height }
            }
        }

        func textView(_ textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            switch selector {
            case #selector(NSResponder.insertNewline(_:)):
                if parent.onKey(.enter) { return true }
                let flags = NSApp.currentEvent?.modifierFlags ?? []
                if flags.contains(.shift) || flags.contains(.option) {
                    textView.insertNewlineIgnoringFieldEditor(nil)
                } else {
                    parent.onSubmit()
                }
                return true
            case #selector(NSResponder.moveUp(_:)): return parent.onKey(.up)
            case #selector(NSResponder.moveDown(_:)): return parent.onKey(.down)
            case #selector(NSResponder.insertTab(_:)): return parent.onKey(.tab)
            case #selector(NSResponder.cancelOperation(_:)): return parent.onKey(.escape)
            default: return false
            }
        }
    }
}

/// NSTextView that hands pasted/dropped files and images to the composer instead of inserting
/// their file paths as text.
final class AttachableTextView: NSTextView {
    var onAttach: (([ChatAttachment]) -> Void)?

    override func paste(_ sender: Any?) {
        let board = NSPasteboard.general
        // Plain text pastes normally. Copied files, or an image with no text, become attachments.
        let hasText = board.string(forType: .string) != nil
        let hasFiles = board.canReadObject(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true])
        if hasFiles || (!hasText && board.canReadObject(forClasses: [NSImage.self])) {
            let attachments = board.chatAttachments()
            if !attachments.isEmpty {
                onAttach?(attachments)
                return
            }
        }
        super.paste(sender)
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let attachments = sender.draggingPasteboard.chatAttachments()
        if !attachments.isEmpty {
            onAttach?(attachments)
            return true
        }
        return super.performDragOperation(sender)
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        sender.draggingPasteboard.canReadObject(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true])
            ? .copy : super.draggingEntered(sender)
    }
}
