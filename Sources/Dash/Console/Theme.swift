import SwiftUI

/// Spacing, corner radii and text styles shared by every console page, so cards, page titles and
/// margins line up from one page to the next.
enum DS {
    enum Space {
        static let xs: CGFloat = 4
        static let s: CGFloat = 8
        static let m: CGFloat = 12
        static let l: CGFloat = 16
        static let xl: CGFloat = 24
    }

    enum Radius {
        static let control: CGFloat = 8
        static let card: CGFloat = 12
    }

    /// The width every scrolling page's content is held to, and the margin around it.
    static let pageWidth: CGFloat = 980
    static let pagePadding: CGFloat = 22
    /// The conversation column (Chat, Lens) is narrower: long lines are hard to read.
    static let chatWidth: CGFloat = 780
}

extension Font {
    /// Page titles: Today, Lecture notes, Study.
    static let pageTitle = Font.system(size: 22, weight: .semibold)
    /// The small uppercase-style label above a group of tiles.
    static let sectionLabel = Font.system(size: 11, weight: .semibold)
    /// Card headers.
    static let cardTitle = Font.system(size: 12, weight: .semibold)
    /// Secondary lines under a title.
    static let caption = Font.system(size: 11.5)
}

extension View {
    /// The one card look: a secondary-background rounded rectangle with a hairline border. `tint`
    /// colors it for warnings (the approval card).
    func cardSurface(radius: CGFloat = DS.Radius.card, tint: Color? = nil, hovering: Bool = false) -> some View {
        background(tint.map { AnyShapeStyle($0.opacity(0.08)) }
                   ?? AnyShapeStyle(.background.secondary.opacity(hovering ? 1 : 0.85)),
                   in: RoundedRectangle(cornerRadius: radius))
            .overlay(RoundedRectangle(cornerRadius: radius)
                .strokeBorder(tint.map { $0.opacity(0.35) } ?? Color(nsColor: .separatorColor).opacity(0.6)))
    }

    /// Margin and maximum width for a scrolling page's content, centered in the window.
    func pageContainer(width: CGFloat = DS.pageWidth) -> some View {
        padding(DS.pagePadding)
            .frame(maxWidth: width, alignment: .leading)
            .frame(maxWidth: .infinity)
    }
}

/// A page's title with an optional line under it.
struct PageTitle: View {
    let title: String
    var subtitle: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.pageTitle)
            if let subtitle {
                Text(subtitle)
                    .font(.system(size: 12.5)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}
