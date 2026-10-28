import AppKit
import SwiftUI

/// One block of a markdown document.
enum MarkdownBlock: Equatable {
    case heading(level: Int, text: String)
    case paragraph(String)
    case list([ListItem])
    case code(language: String, text: String)
    case quote(String)
    case table(header: [String], rows: [[String]])
    case rule

    struct ListItem: Equatable {
        let indent: Int
        /// "•" for bullets, "1." for numbered items.
        let marker: String
        let text: String
    }
}

/// A small markdown parser for chat replies: headings, lists (nested), fenced code, block quotes,
/// tables and rules. Inline styling (bold, italics, code spans, links) is left to
/// `AttributedString(markdown:)`. It tolerates half-streamed input: an unclosed code fence just
/// runs to the end of the text.
enum MarkdownParser {
    static func parse(_ source: String) -> [MarkdownBlock] {
        let lines = source.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []
        var i = 0

        func flushParagraph() {
            if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: "\n"))) }
            paragraph = []
        }

        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                flushParagraph()
                let fence = String(trimmed.prefix(3))
                let language = trimmed.dropFirst(3).trimmingCharacters(in: .whitespaces)
                var body: [String] = []
                i += 1
                while i < lines.count, !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix(fence) {
                    body.append(lines[i])
                    i += 1
                }
                i += 1 // the closing fence, if there is one
                blocks.append(.code(language: language, text: body.joined(separator: "\n")))
                continue
            }

            if trimmed.isEmpty {
                flushParagraph()
                i += 1
                continue
            }

            if let heading = headingMatch(trimmed) {
                flushParagraph()
                blocks.append(.heading(level: heading.level, text: heading.text))
                i += 1
                continue
            }

            if isRule(trimmed) {
                flushParagraph()
                blocks.append(.rule)
                i += 1
                continue
            }

            if trimmed.hasPrefix(">") {
                flushParagraph()
                var quoted: [String] = []
                while i < lines.count, lines[i].trimmingCharacters(in: .whitespaces).hasPrefix(">") {
                    var text = lines[i].trimmingCharacters(in: .whitespaces).dropFirst()
                    if text.hasPrefix(" ") { text = text.dropFirst() }
                    quoted.append(String(text))
                    i += 1
                }
                blocks.append(.quote(quoted.joined(separator: "\n")))
                continue
            }

            if trimmed.hasPrefix("|"), i + 1 < lines.count, isTableSeparator(lines[i + 1]) {
                flushParagraph()
                let header = cells(trimmed)
                var rows: [[String]] = []
                i += 2
                while i < lines.count, lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("|") {
                    rows.append(cells(lines[i]))
                    i += 1
                }
                blocks.append(.table(header: header, rows: rows))
                continue
            }

            if listItem(line) != nil {
                flushParagraph()
                var items: [MarkdownBlock.ListItem] = []
                while i < lines.count {
                    if let item = listItem(lines[i]) {
                        items.append(item)
                        i += 1
                    } else if !lines[i].trimmingCharacters(in: .whitespaces).isEmpty,
                              lines[i].hasPrefix("  "), !items.isEmpty, !isBlockStart(lines[i]) {
                        // A wrapped continuation line of the previous item.
                        let last = items.removeLast()
                        items.append(.init(indent: last.indent, marker: last.marker,
                                           text: last.text + "\n" + lines[i].trimmingCharacters(in: .whitespaces)))
                        i += 1
                    } else {
                        break
                    }
                }
                blocks.append(.list(items))
                continue
            }

            paragraph.append(line)
            i += 1
        }
        flushParagraph()
        return blocks
    }

    private static func headingMatch(_ line: String) -> (level: Int, text: String)? {
        guard line.hasPrefix("#") else { return nil }
        let hashes = line.prefix { $0 == "#" }
        guard (1...6).contains(hashes.count), line.dropFirst(hashes.count).first == " " else { return nil }
        return (hashes.count, line.dropFirst(hashes.count).trimmingCharacters(in: .whitespaces))
    }

    private static func isRule(_ line: String) -> Bool {
        let stripped = line.replacingOccurrences(of: " ", with: "")
        guard stripped.count >= 3, let first = stripped.first, "-*_".contains(first) else { return false }
        return stripped.allSatisfy { $0 == first }
    }

    private static func isTableSeparator(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.contains("-"), trimmed.contains("|") else { return false }
        return trimmed.allSatisfy { "|-: ".contains($0) }
    }

    private static func cells(_ line: String) -> [String] {
        var text = line.trimmingCharacters(in: .whitespaces)
        if text.hasPrefix("|") { text.removeFirst() }
        if text.hasSuffix("|") { text.removeLast() }
        return text.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
    }

    private static func isBlockStart(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        return trimmed.hasPrefix("```") || trimmed.hasPrefix("#") || trimmed.hasPrefix(">") || trimmed.hasPrefix("|")
    }

    private static func listItem(_ line: String) -> MarkdownBlock.ListItem? {
        let spaces = line.prefix { $0 == " " || $0 == "\t" }
        let indent = spaces.reduce(0) { $0 + ($1 == "\t" ? 4 : 1) } / 2
        let body = line.dropFirst(spaces.count)
        for bullet in ["- ", "* ", "+ "] where body.hasPrefix(bullet) {
            let text = String(body.dropFirst(2))
            if let checkbox = checkbox(text) { return .init(indent: indent, marker: checkbox.marker, text: checkbox.rest) }
            return .init(indent: indent, marker: "•", text: text)
        }
        let digits = body.prefix { $0.isNumber }
        if !digits.isEmpty, digits.count <= 3 {
            let rest = body.dropFirst(digits.count)
            if rest.hasPrefix(". ") || rest.hasPrefix(") ") {
                return .init(indent: indent, marker: "\(digits).", text: String(rest.dropFirst(2)))
            }
        }
        return nil
    }

    private static func checkbox(_ text: String) -> (marker: String, rest: String)? {
        if text.hasPrefix("[ ] ") { return ("☐", String(text.dropFirst(4))) }
        if text.hasPrefix("[x] ") || text.hasPrefix("[X] ") { return ("☑", String(text.dropFirst(4))) }
        return nil
    }
}

/// Renders markdown as native SwiftUI blocks. Equatable, so a finished message isn't re-laid-out
/// while a newer one streams.
struct MarkdownView: View, Equatable {
    let text: String
    var fontSize: CGFloat = 13.5
    var tint: AnyShapeStyle = AnyShapeStyle(.primary)

    static func == (lhs: MarkdownView, rhs: MarkdownView) -> Bool {
        lhs.text == rhs.text && lhs.fontSize == rhs.fontSize
    }

    var body: some View {
        let blocks = MarkdownParser.parse(text)
        VStack(alignment: .leading, spacing: 9) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                view(for: block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
    }

    @ViewBuilder private func view(for block: MarkdownBlock) -> some View {
        switch block {
        case .heading(let level, let text):
            inline(text)
                .font(.system(size: heading(level), weight: .semibold))
                .padding(.top, level <= 2 ? 4 : 0)
        case .paragraph(let text):
            inline(text).font(.system(size: fontSize)).lineSpacing(2)
        case .list(let items):
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: 7) {
                        Text(item.marker)
                            .font(.system(size: fontSize, weight: item.marker == "•" ? .bold : .regular).monospacedDigit())
                            .foregroundStyle(.secondary)
                            .frame(minWidth: 14, alignment: .trailing)
                        inline(item.text).font(.system(size: fontSize)).lineSpacing(2)
                    }
                    .padding(.leading, CGFloat(item.indent) * 18)
                }
            }
        case .code(let language, let text):
            CodeBlock(language: language, text: text, fontSize: fontSize - 1)
        case .quote(let text):
            HStack(alignment: .top, spacing: 10) {
                RoundedRectangle(cornerRadius: 1.5).fill(.tertiary).frame(width: 3)
                inline(text).font(.system(size: fontSize)).foregroundStyle(.secondary).lineSpacing(2)
            }
            .fixedSize(horizontal: false, vertical: true)
        case .table(let header, let rows):
            MarkdownTable(header: header, rows: rows, fontSize: fontSize - 1)
        case .rule:
            Divider().padding(.vertical, 4)
        }
    }

    private func heading(_ level: Int) -> CGFloat {
        switch level {
        case 1: fontSize + 6
        case 2: fontSize + 3
        case 3: fontSize + 1
        default: fontSize
        }
    }

    private func inline(_ source: String) -> Text {
        Text(Self.attributed(source))
    }

    static func attributed(_ source: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: source, options: options)) ?? AttributedString(source)
    }
}

private struct CodeBlock: View {
    let language: String
    let text: String
    let fontSize: CGFloat
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language.isEmpty ? "code" : language)
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(.secondary)
                Spacer()
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(text, forType: .string)
                    copied = true
                    Task {
                        try? await Task.sleep(nanoseconds: 1_500_000_000)
                        copied = false
                    }
                } label: {
                    Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                        .font(.system(size: 10.5, weight: .medium))
                }
                .buttonStyle(.borderless)
                .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(.quaternary.opacity(0.5))

            ScrollView(.horizontal, showsIndicators: false) {
                Text(text.isEmpty ? " " : text)
                    .font(.system(size: fontSize, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(10)
                    .fixedSize(horizontal: true, vertical: true)
            }
        }
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.separator.opacity(0.6)))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

private struct MarkdownTable: View {
    let header: [String]
    let rows: [[String]]
    let fontSize: CGFloat

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 6) {
                GridRow {
                    ForEach(Array(header.enumerated()), id: \.offset) { _, cell in
                        Text(MarkdownView.attributed(cell)).font(.system(size: fontSize, weight: .semibold))
                    }
                }
                Divider().gridCellUnsizedAxes(.horizontal)
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    GridRow {
                        ForEach(0..<header.count, id: \.self) { column in
                            Text(MarkdownView.attributed(column < row.count ? row[column] : ""))
                                .font(.system(size: fontSize))
                        }
                    }
                }
            }
            .padding(10)
        }
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.separator.opacity(0.6)))
    }
}
