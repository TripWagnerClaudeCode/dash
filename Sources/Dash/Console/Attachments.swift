import AppKit
import UniformTypeIdentifiers

/// A file or image waiting to go out with the next chat message.
struct ChatAttachment: Identifiable {
    enum Kind { case image, pdf, file }

    let id = UUID()
    let name: String
    let kind: Kind
    /// Where the file lives, when it came from disk. Pasted images have no URL.
    let url: URL?
    /// JPEG bytes (images only), already downscaled.
    let jpeg: Data?
    let thumbnail: NSImage?

    /// Longest edge sent to Claude; larger images are downscaled by the API anyway.
    private static let maxEdge: CGFloat = 1568
    private static let maxPDFBytes = 20_000_000

    static func from(url: URL) -> ChatAttachment? {
        let type = UTType(filenameExtension: url.pathExtension)
        if type?.conforms(to: .image) == true, let image = NSImage(contentsOf: url) {
            return from(image: image, name: url.lastPathComponent, url: url)
        }
        if type?.conforms(to: .pdf) == true {
            return ChatAttachment(name: url.lastPathComponent, kind: .pdf, url: url, jpeg: nil,
                                  thumbnail: NSWorkspace.shared.icon(forFile: url.path))
        }
        return ChatAttachment(name: url.lastPathComponent, kind: .file, url: url, jpeg: nil,
                              thumbnail: NSWorkspace.shared.icon(forFile: url.path))
    }

    static func from(image: NSImage, name: String = "Pasted image", url: URL? = nil) -> ChatAttachment? {
        guard let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
        let width = CGFloat(cg.width), height = CGFloat(cg.height)
        let shrink = min(1, maxEdge / max(width, height))
        let size = CGSize(width: (width * shrink).rounded(), height: (height * shrink).rounded())
        guard let context = CGContext(data: nil, width: Int(size.width), height: Int(size.height),
                                      bitsPerComponent: 8, bytesPerRow: 0,
                                      space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
        else { return nil }
        // JPEG has no transparency; flatten onto white.
        context.setFillColor(NSColor.white.cgColor)
        context.fill(CGRect(origin: .zero, size: size))
        context.interpolationQuality = .high
        context.draw(cg, in: CGRect(origin: .zero, size: size))
        guard let scaled = context.makeImage(),
              let jpeg = NSBitmapImageRep(cgImage: scaled)
                .representation(using: .jpeg, properties: [.compressionFactor: 0.85])
        else { return nil }
        return ChatAttachment(name: name, kind: .image, url: url, jpeg: jpeg,
                              thumbnail: NSImage(cgImage: scaled, size: NSSize(width: size.width, height: size.height)))
    }

    /// Content blocks for the stream-json message. Images and PDFs travel inline; any other file
    /// is mentioned by path for Claude to Read (so it also needs to be somewhere Claude may read).
    var blocks: [[String: Any]] {
        switch kind {
        case .image:
            guard let jpeg else { return [] }
            return [["type": "image",
                     "source": ["type": "base64", "media_type": "image/jpeg", "data": jpeg.base64EncodedString()]]]
        case .pdf:
            guard let url, let data = try? Data(contentsOf: url), data.count <= Self.maxPDFBytes else {
                return [["type": "text", "text": "[Attached PDF too large to send inline: \(url?.path ?? name)]"]]
            }
            return [["type": "document",
                     "source": ["type": "base64", "media_type": "application/pdf", "data": data.base64EncodedString()],
                     "title": name]]
        case .file:
            return [["type": "text", "text": "[Attached file: \(url?.path ?? name)]"]]
        }
    }
}

extension NSPasteboard {
    /// Files and images on the pasteboard, as attachments. Used for paste and drag-and-drop.
    func chatAttachments() -> [ChatAttachment] {
        if let urls = readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL],
           !urls.isEmpty {
            return urls.compactMap(ChatAttachment.from(url:))
        }
        if let images = readObjects(forClasses: [NSImage.self]) as? [NSImage], !images.isEmpty {
            return images.compactMap { ChatAttachment.from(image: $0) }
        }
        return []
    }
}
