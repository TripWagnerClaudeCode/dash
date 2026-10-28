import AppKit
import ScreenCaptureKit

struct Capture {
    let jpeg: Data
    let thumbnail: NSImage
    let appName: String
    let windowTitle: String
}

enum CaptureError: LocalizedError {
    case noPermission
    case noWindow
    case encodeFailed

    var errorDescription: String? {
        switch self {
        case .noPermission: "Dash needs Screen Recording permission."
        case .noWindow: "Couldn't find a window to capture. Click into the window you want help with, then press ⌥A."
        case .encodeFailed: "Couldn't encode the screenshot."
        }
    }
}

enum ScreenCapture {
    /// Longest edge sent to Claude. Larger images are downscaled by the API anyway.
    private static let maxEdge: CGFloat = 1568

    /// Captures the frontmost normal window belonging to `app`.
    static func frontWindow(of app: NSRunningApplication) async throws -> Capture {
        guard CGPreflightScreenCaptureAccess() else {
            CGRequestScreenCaptureAccess()
            throw CaptureError.noPermission
        }

        // CGWindowList is ordered front-to-back, so the first match is the window the user sees on top.
        let pid = app.processIdentifier
        let infos = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements],
                                               kCGNullWindowID) as? [[String: Any]] ?? []
        let entry = infos.first { info in
            guard (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
                  (info[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
                  let bounds = info[kCGWindowBounds as String] as? [String: CGFloat]
            else { return false }
            return (bounds["Width"] ?? 0) > 120 && (bounds["Height"] ?? 0) > 120
        }
        guard let entry, let windowID = (entry[kCGWindowNumber as String] as? NSNumber)?.uint32Value else {
            throw CaptureError.noWindow
        }

        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        guard let window = content.windows.first(where: { $0.windowID == windowID }) else {
            throw CaptureError.noWindow
        }

        let filter = SCContentFilter(desktopIndependentWindow: window)
        let scale = CGFloat(filter.pointPixelScale)
        let pixelW = window.frame.width * scale
        let pixelH = window.frame.height * scale
        let shrink = min(1, maxEdge / max(pixelW, pixelH))

        let config = SCStreamConfiguration()
        config.width = Int(pixelW * shrink)
        config.height = Int(pixelH * shrink)
        config.showsCursor = false

        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        let rep = NSBitmapImageRep(cgImage: image)
        guard let jpeg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.85]) else {
            throw CaptureError.encodeFailed
        }

        return Capture(jpeg: jpeg,
                       thumbnail: NSImage(cgImage: image, size: NSSize(width: image.width, height: image.height)),
                       appName: app.localizedName ?? "Unknown app",
                       windowTitle: window.title ?? "")
    }
}
