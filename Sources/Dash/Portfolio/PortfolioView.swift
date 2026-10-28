import AppKit
import Charts
import SwiftUI

/// Chart colors: the dataviz reference palette's first two categorical slots, stepped per mode.
enum ChartColor {
    static let portfolio = dynamic(light: 0x2a78d6, dark: 0x3987e5)
    static let benchmark = dynamic(light: 0xeb6834, dark: 0xd95926)

    private static func dynamic(light: Int, dark: Int) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let hex = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
            return NSColor(srgbRed: CGFloat(hex >> 16 & 0xff) / 255, green: CGFloat(hex >> 8 & 0xff) / 255,
                           blue: CGFloat(hex & 0xff) / 255, alpha: 1)
        })
    }
}

enum Format {
    static func money(_ value: Double, cents: Bool = true) -> String {
        value.formatted(.currency(code: "USD").precision(.fractionLength(cents ? 2 : 0)))
    }

    static func signedMoney(_ value: Double) -> String {
        (value >= 0 ? "+" : "−") + money(abs(value))
    }

    static func percent(_ value: Double?, signed: Bool = true, digits: Int = 2) -> String {
        guard let value else { return "—" }
        let body = String(format: "%.\(digits)f%%", abs(value) * 100)
        return signed ? (value >= 0 ? "+" : "−") + body : body
    }

    /// Gains and losses also carry a sign and an arrow, never color alone.
    static func tint(_ value: Double?) -> Color {
        guard let value, value != 0 else { return .secondary }
        return value > 0 ? .green : .red
    }
}

struct PortfolioPage: View {
    @EnvironmentObject var portfolio: PortfolioModel
    /// Lets `--preview … portfolio-bottom` screenshot the lower half.
    nonisolated(unsafe) static var previewScrollToBottom = false
    /// Previews never start a real advisor session.
    nonisolated(unsafe) static var isPreview = false

    var body: some View {
        if portfolio.isConnected {
            VStack(spacing: 0) {
                Picker("View", selection: $portfolio.showAdvisor) {
                    Text("Overview").tag(false)
                    Text("Advisor").tag(true)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(width: 220)
                .padding(.top, 12)
                if portfolio.showAdvisor { AdvisorView() } else { overview }
            }
        } else {
            ScrollView { ConnectCard().pageContainer() }
        }
    }

    private var overview: some View {
        ScrollViewReader { proxy in
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                if let error = portfolio.error {
                    Text(error).font(.system(size: 12)).foregroundStyle(.orange)
                }
                if portfolio.holdings.isEmpty {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.small)
                        Text("Loading your portfolio…").foregroundStyle(.secondary)
                    }
                } else {
                    PerformanceCard()
                    KPIRow()
                    AdvisorCard()
                    HoldingsCard()
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 320), spacing: 14, alignment: .top)],
                              alignment: .leading, spacing: 14) {
                        AllocationCard()
                        DaysCard()
                    }
                }
                Color.clear.frame(height: 0).id("bottom")
            }
            .pageContainer()
        }
        .onChange(of: portfolio.lookback.values.count) {
            if Self.previewScrollToBottom { proxy.scrollTo("bottom", anchor: .bottom) }
        }
        }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Portfolio").font(.system(size: 13, weight: .semibold)).foregroundStyle(.secondary)
                Text(Format.money(portfolio.totalValue))
                    .font(.system(size: 34, weight: .semibold).monospacedDigit())
                    .contentTransition(.numericText())
                    .animation(.default, value: portfolio.totalValue)
                HStack(spacing: 6) {
                    Image(systemName: portfolio.dayChange >= 0 ? "arrow.up.right" : "arrow.down.right")
                    Text("\(Format.signedMoney(portfolio.dayChange)) (\(Format.percent(portfolio.dayPercent))) today")
                }
                .font(.system(size: 14, weight: .medium).monospacedDigit())
                .foregroundStyle(Format.tint(portfolio.dayChange))
                if let spy = portfolio.spyDayPercent {
                    Text("S&P 500 (SPY) \(Format.percent(spy)) today")
                        .font(.system(size: 12)).foregroundStyle(.secondary)
                }
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 6) {
                LiveBadge()
                HStack(spacing: 8) {
                    Button { portfolio.refreshNow() } label: { Image(systemName: "arrow.clockwise") }
                        .help("Refresh positions and history")
                    Menu {
                        Button("Disconnect Robinhood", role: .destructive) { portfolio.disconnect() }
                    } label: { Image(systemName: "ellipsis.circle") }
                        .menuIndicator(.hidden)
                        .fixedSize()
                }
                .buttonStyle(.borderless)
            }
        }
    }
}

private struct LiveBadge: View {
    @EnvironmentObject var portfolio: PortfolioModel

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            HStack(spacing: 6) {
                Circle()
                    .fill(portfolio.session == .regular ? Color.green : portfolio.session == .extended ? .yellow : .secondary)
                    .frame(width: 7, height: 7)
                Text(label(now: context.date)).monospacedDigit()
            }
            .font(.system(size: 11.5, weight: .medium))
            .foregroundStyle(.secondary)
        }
    }

    private func label(now: Date) -> String {
        let age = portfolio.lastQuote.map { max(0, Int(now.timeIntervalSince($0))) }
        let ago = age.map { $0 < 60 ? "\($0)s ago" : "\($0 / 60)m ago" } ?? "—"
        switch portfolio.session {
        case .regular: return "Live · \(ago)"
        case .extended: return "Extended hours · \(ago)"
        case .closed: return "Market closed · \(ago)"
        }
    }
}

// MARK: Performance chart

private struct PerformanceCard: View {
    @EnvironmentObject var portfolio: PortfolioModel
    @State private var range = "YTD"
    @State private var hovered: Date?

    private struct Point: Identifiable {
        let series: String
        let date: Date
        let value: Double
        var id: String { "\(series)\(date.timeIntervalSince1970)" }
    }

    var body: some View {
        Card(title: "Performance vs. S&P 500", icon: "chart.xyaxis.line") {
            Picker("Range", selection: $range) {
                ForEach(["1M", "3M", "YTD", "1Y"], id: \.self) { Text($0).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 200)
        } content: {
            let mine = portfolio.lookback.since(start).indexed
            let spy = portfolio.spy.since(start).indexed
            if mine.isEmpty {
                Text("Loading a year of prices…").font(.system(size: 12)).foregroundStyle(.secondary)
            } else {
                legend(mine: mine, spy: spy)
                chart(points(mine, "Your holdings") + points(spy, "S&P 500 (SPY)"), mine: mine, spy: spy)
                    .frame(height: 230)
                Text("Your current holdings valued at past prices, so past trades and deposits aren't included. Both lines start at 100.")
                    .font(.system(size: 11)).foregroundStyle(.tertiary)
            }
        }
    }

    private var start: Date {
        let calendar = Calendar.current, now = Date()
        return switch range {
        case "1M": calendar.date(byAdding: .month, value: -1, to: now)!
        case "3M": calendar.date(byAdding: .month, value: -3, to: now)!
        case "1Y": calendar.date(byAdding: .year, value: -1, to: now)!
        default: calendar.date(from: calendar.dateComponents([.year], from: now))!
        }
    }

    private func points(_ series: Series, _ name: String) -> [Point] {
        zip(series.dates, series.values).map { Point(series: name, date: $0, value: $1) }
    }

    /// Legend with each line's return over the range, so the lines are named by text, not just color.
    private func legend(mine: Series, spy: Series) -> some View {
        HStack(spacing: 18) {
            entry("Your holdings", ChartColor.portfolio, mine.totalReturn)
            entry("S&P 500 (SPY)", ChartColor.benchmark, spy.totalReturn)
            if let gap = mine.totalReturn.flatMap({ m in spy.totalReturn.map { m - $0 } }) {
                Text("\(gap >= 0 ? "Ahead of" : "Behind") the market by \(Format.percent(gap, signed: false))")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func entry(_ name: String, _ color: Color, _ value: Double?) -> some View {
        HStack(spacing: 6) {
            Capsule().fill(color).frame(width: 14, height: 3)
            Text(name).foregroundStyle(.secondary)
            Text(Format.percent(value)).fontWeight(.semibold).monospacedDigit()
        }
        .font(.system(size: 12))
    }

    private func chart(_ points: [Point], mine: Series, spy: Series) -> some View {
        Chart {
            ForEach(points) { point in
                LineMark(x: .value("Date", point.date), y: .value("Value", point.value))
                    .foregroundStyle(by: .value("Series", point.series))
                    .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                    .interpolationMethod(.monotone)
            }
            RuleMark(y: .value("Start", 100))
                .foregroundStyle(.secondary.opacity(0.4))
                .lineStyle(StrokeStyle(lineWidth: 1))
            if let hovered {
                RuleMark(x: .value("Date", hovered))
                    .foregroundStyle(.secondary.opacity(0.5))
                    .lineStyle(StrokeStyle(lineWidth: 1))
                    .annotation(position: .top, overflowResolution: .init(x: .fit(to: .chart), y: .disabled)) {
                        tooltip(hovered, mine: mine, spy: spy)
                    }
                ForEach(points.filter { Calendar.current.isDate($0.date, inSameDayAs: hovered) }) { point in
                    PointMark(x: .value("Date", point.date), y: .value("Value", point.value))
                        .foregroundStyle(by: .value("Series", point.series))
                        .symbolSize(70)
                }
            }
        }
        .chartForegroundStyleScale(["Your holdings": ChartColor.portfolio, "S&P 500 (SPY)": ChartColor.benchmark])
        .chartLegend(.hidden)
        .chartYScale(domain: .automatic(includesZero: false))
        .chartYAxis {
            AxisMarks(position: .leading) { _ in
                AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5)).foregroundStyle(.quaternary)
                AxisValueLabel()
            }
        }
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 6)) { _ in
                AxisValueLabel(format: .dateTime.month(.abbreviated).day())
            }
        }
        .chartOverlay { proxy in
            GeometryReader { geometry in
                Rectangle().fill(.clear).contentShape(Rectangle())
                    .onContinuousHover { phase in
                        switch phase {
                        case .active(let location):
                            guard let frame = proxy.plotFrame else { return }
                            let x = location.x - geometry[frame].origin.x
                            if let date: Date = proxy.value(atX: x) { hovered = nearest(date, in: mine.dates) }
                        case .ended:
                            hovered = nil
                        }
                    }
            }
        }
    }

    private func nearest(_ date: Date, in dates: [Date]) -> Date? {
        dates.min { abs($0.timeIntervalSince(date)) < abs($1.timeIntervalSince(date)) }
    }

    private func tooltip(_ date: Date, mine: Series, spy: Series) -> some View {
        func value(_ series: Series) -> Double? {
            series.dates.firstIndex { Calendar.current.isDate($0, inSameDayAs: date) }.map { series.values[$0] - 100 }.map { $0 / 100 }
        }
        return VStack(alignment: .leading, spacing: 3) {
            Text(date.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day().year()))
                .font(.system(size: 11, weight: .semibold))
            entry("Yours", ChartColor.portfolio, value(mine))
            entry("SPY", ChartColor.benchmark, value(spy))
        }
        .padding(8)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.separator))
    }
}

// MARK: KPIs

private struct KPIRow: View {
    @EnvironmentObject var portfolio: PortfolioModel

    var body: some View {
        let stats = portfolio.stats
        let oneYear = stats.periods.first { $0.label == "1Y" }
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 170), spacing: 12, alignment: .top)], spacing: 12) {
            tile("Unrealized gain", Format.signedMoney(portfolio.unrealized),
                 detail: "\(Format.percent(portfolio.costBasis > 0 ? portfolio.unrealized / portfolio.costBasis : nil)) on cost",
                 tint: Format.tint(portfolio.unrealized))
            tile("1-year vs. SPY", Format.percent(oneYear?.vsSPY),
                 detail: "Yours \(Format.percent(oneYear?.portfolio)) · SPY \(Format.percent(oneYear?.spy))",
                 tint: Format.tint(oneYear?.vsSPY))
            tile("Realized, past year", stats.realizedYear.map(Format.signedMoney) ?? "—",
                 detail: "Gains locked in by selling", tint: Format.tint(stats.realizedYear))
            tile("Volatility", Format.percent(stats.volatility, signed: false, digits: 1),
                 detail: "Annualized · SPY \(Format.percent(stats.spyVolatility, signed: false, digits: 1))")
            tile("Beta", stats.beta.map { String(format: "%.2f", $0) } ?? "—",
                 detail: stats.beta.map { "Moves ~\(String(format: "%.1f", $0))× the market" } ?? "")
            tile("Max drawdown", Format.percent(stats.maxDrawdown, digits: 1),
                 detail: "Now \(Format.percent(stats.currentDrawdown, digits: 1)) from peak")
        }
    }

    private func tile(_ title: String, _ value: String, detail: String, tint: Color = .primary) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.system(size: 11.5, weight: .medium)).foregroundStyle(.secondary)
            Text(value).font(.system(size: 20, weight: .semibold).monospacedDigit()).foregroundStyle(tint)
            Text(detail).font(.system(size: 11)).foregroundStyle(.tertiary).lineLimit(2)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardSurface(radius: 10)
    }
}

// MARK: Holdings

private struct HoldingsCard: View {
    @EnvironmentObject var portfolio: PortfolioModel
    @State private var sort = Column.value
    @State private var ascending = false

    enum Column: String, CaseIterable {
        case symbol = "Symbol", price = "Price", day = "Today", value = "Value", weight = "Weight"
        case gain = "Gain", gainPercent = "Gain %", contribution = "Day impact", risk = "Risk share"
    }

    var body: some View {
        Card(title: "Holdings (\(portfolio.holdings.count))", icon: "list.bullet.rectangle") {
            VStack(spacing: 0) {
                row(header: true, nil)
                Divider()
                ForEach(sorted) { holding in
                    row(header: false, holding)
                    Divider().opacity(0.4)
                }
            }
        }
    }

    /// Columns in the order they drop out as the window narrows: the last ones go first.
    private static let priority: [Column] = [.symbol, .value, .day, .gain, .price, .weight,
                                             .gainPercent, .contribution, .risk]

    private var sorted: [Holding] {
        let key: (Holding) -> Double = switch sort {
        case .symbol: { _ in 0 }
        case .price: { $0.price }
        case .day: { $0.dayPercent ?? 0 }
        case .value, .weight: { $0.value }
        case .gain: { $0.unrealized }
        case .gainPercent: { $0.unrealizedPercent ?? 0 }
        case .contribution: { $0.dayChange }
        case .risk: { portfolio.stats.risk[$0.symbol]?.contribution ?? 0 }
        }
        if sort == .symbol {
            return portfolio.holdings.sorted { ascending ? $0.symbol < $1.symbol : $0.symbol > $1.symbol }
        }
        return portfolio.holdings.sorted { ascending ? key($0) < key($1) : key($0) > key($1) }
    }

    /// Fixed widths for the number columns; Symbol's is its minimum, and it takes whatever is left over.
    private static let widths: [Column: CGFloat] = [.symbol: 100, .price: 76, .day: 66, .value: 88, .weight: 112,
                                                    .gain: 84, .gainPercent: 64, .contribution: 76, .risk: 72]

    @ViewBuilder
    private func row(header: Bool, _ holding: Holding?) -> some View {
        ColumnRow(spacing: 8) {
            ForEach(Column.allCases, id: \.self) { column in
                Group {
                    if header {
                        Button {
                            if sort == column { ascending.toggle() } else { sort = column; ascending = column == .symbol }
                        } label: {
                            HStack(spacing: 2) {
                                Text(column.rawValue)
                                if sort == column { Image(systemName: ascending ? "chevron.up" : "chevron.down").font(.system(size: 8)) }
                            }
                        }
                        .buttonStyle(.plain)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.secondary)
                    } else if let holding {
                        cell(column, holding)
                    }
                }
                .frame(maxWidth: .infinity, alignment: column == .symbol || column == .weight ? .leading : .trailing)
                .column(width: Self.widths[column]!, priority: Self.priority.firstIndex(of: column) ?? 99,
                        flexible: column == .symbol)
            }
        }
        .padding(.vertical, header ? 6 : 7)
        .clipped()
    }

    @ViewBuilder
    private func cell(_ column: Column, _ holding: Holding) -> some View {
        let font = Font.system(size: 12.5).monospacedDigit()
        switch column {
        case .symbol:
            VStack(alignment: .leading, spacing: 1) {
                Text(holding.symbol).font(.system(size: 12.5, weight: .semibold))
                Text("\(holding.quantity.formatted(.number.precision(.fractionLength(0...4)))) sh")
                    .font(.system(size: 10.5)).foregroundStyle(.tertiary)
            }
        case .price: Text(Format.money(holding.price)).font(font)
        case .day: Text(Format.percent(holding.dayPercent)).font(font).foregroundStyle(Format.tint(holding.dayPercent))
        case .value: Text(Format.money(holding.value)).font(font)
        case .weight:
            HStack(spacing: 6) {
                // Scaled to the largest holding, so the biggest bar is full width.
                GeometryReader { proxy in
                    Capsule().fill(ChartColor.portfolio)
                        .frame(width: max(3, proxy.size.width * min(1, portfolio.weight(holding) / max(portfolio.stats.top1 ?? 1, 0.01))))
                }
                .frame(width: 60, height: 5)
                Text(Format.percent(portfolio.weight(holding), signed: false, digits: 1)).font(font)
            }
        case .gain: Text(Format.signedMoney(holding.unrealized)).font(font).foregroundStyle(Format.tint(holding.unrealized))
        case .gainPercent:
            Text(Format.percent(holding.unrealizedPercent, digits: 1)).font(font).foregroundStyle(Format.tint(holding.unrealizedPercent))
        case .contribution:
            Text(Format.percent(portfolio.contribution(holding))).font(font).foregroundStyle(Format.tint(holding.dayChange))
        case .risk:
            // Share of portfolio variance; bold when it's well above the holding's weight.
            let share = portfolio.stats.risk[holding.symbol]?.contribution
            Text(Format.percent(share, signed: false, digits: 1)).font(font)
                .fontWeight(share.map { $0 > portfolio.weight(holding) * 1.5 } == true ? .bold : .regular)
                .help("Share of the portfolio's day-to-day variance from this holding (weight \(Format.percent(portfolio.weight(holding), signed: false, digits: 1)))")
        }
    }
}

// MARK: Allocation & days

private struct AllocationCard: View {
    @EnvironmentObject var portfolio: PortfolioModel

    var body: some View {
        let stats = portfolio.stats
        Card(title: "Allocation", icon: "chart.bar.xaxis") {
            VStack(alignment: .leading, spacing: 10) {
                if let top1 = stats.top1, let top5 = stats.top5, let effective = stats.effectiveCount {
                    Text("Largest holding **\(Format.percent(top1, signed: false, digits: 1))** · top 5 **\(Format.percent(top5, signed: false, digits: 1))** · acts like **\(String(format: "%.1f", effective))** equal-sized positions")
                        .font(.system(size: 12)).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                ForEach(stats.sectors.prefix(8), id: \.name) { sector in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            Text(sector.name).font(.system(size: 12))
                            Spacer()
                            Text(Format.percent(sector.weight, signed: false, digits: 1))
                                .font(.system(size: 12).monospacedDigit()).foregroundStyle(.secondary)
                        }
                        GeometryReader { proxy in
                            RoundedRectangle(cornerRadius: 2)
                                .fill(ChartColor.portfolio)
                                .frame(width: max(4, proxy.size.width * sector.weight))
                        }
                        .frame(height: 6)
                    }
                }
            }
        }
    }
}

private struct DaysCard: View {
    @EnvironmentObject var portfolio: PortfolioModel

    @ViewBuilder private func periodNumbers(_ period: PortfolioStats.Period) -> some View {
        Text(period.label).font(.system(size: 12, weight: .semibold)).frame(width: 36, alignment: .leading)
        Text(Format.percent(period.portfolio)).foregroundStyle(Format.tint(period.portfolio))
            .frame(minWidth: 62, alignment: .trailing)
        Text("SPY \(Format.percent(period.spy))").foregroundStyle(.secondary)
            .frame(minWidth: 80, alignment: .trailing)
    }

    var body: some View {
        let stats = portfolio.stats
        Card(title: "Past year", icon: "calendar") {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(stats.periods) { period in
                    let verdict = Text(period.vsSPY.map { ($0 >= 0 ? "ahead " : "behind ") + Format.percent($0, signed: false) } ?? "")
                        .foregroundStyle(Format.tint(period.vsSPY))
                    ViewThatFits(in: .horizontal) {
                        HStack {
                            periodNumbers(period)
                            Spacer(minLength: 8)
                            verdict
                        }
                        VStack(alignment: .leading, spacing: 2) {
                            HStack { periodNumbers(period) }
                            verdict
                        }
                    }
                    .font(.system(size: 12).monospacedDigit())
                }
                Divider()
                if let best = stats.best, let worst = stats.worst {
                    Text("Best day **\(Format.percent(best.1))** on \(best.0.formatted(.dateTime.month(.abbreviated).day())) · worst **\(Format.percent(worst.1))** on \(worst.0.formatted(.dateTime.month(.abbreviated).day()))")
                        .font(.system(size: 12)).foregroundStyle(.secondary)
                }
            }
        }
    }
}

// MARK: AI review & connect

/// On the overview: the way into the advisor chat.
private struct AdvisorCard: View {
    @EnvironmentObject var portfolio: PortfolioModel

    var body: some View {
        Card(title: "Advisor", icon: "person.crop.circle.badge.checkmark") {
            HStack(spacing: 8) {
                Button("Review my portfolio") {
                    portfolio.showAdvisor = true
                    portfolio.askAdvisor(AdvisorView.reviewPrompt)
                }
                .disabled(portfolio.advisor.isBusy || portfolio.stats.periods.allSatisfy { $0.portfolio == nil })
                Button("Open chat") { portfolio.showAdvisor = true }
            }
            .controlSize(.small)
        } content: {
            Text(Personal.hasInvestorProfile
                 ? "Talk your portfolio through with a senior risk analyst: what's driving your risk and returns, what to change for your goals, and new ideas to research. It reads Robinhood but can't trade."
                 : "Start with a short goals conversation. The advisor saves your investor profile and uses it in every session after.")
                .font(.system(size: 12.5)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// The advisor chat.
struct AdvisorView: View {
    @EnvironmentObject var portfolio: PortfolioModel
    @State private var draft = ""

    static let reviewPrompt = "Give me a full review of my portfolio against my goals: what's driving its risk and returns, what's working, what isn't, and the changes you'd prioritize."

    var body: some View {
        AdvisorChat(advisor: portfolio.advisor, draft: $draft)
            .onAppear(perform: startFirstSession)
    }

    /// With no investor profile yet, the advisor opens with the goals conversation.
    private func startFirstSession() {
        guard !PortfolioPage.isPreview, portfolio.advisor.turns.isEmpty, !portfolio.advisor.isBusy,
              !Personal.hasInvestorProfile else { return }
        portfolio.askAdvisor("Let's start our first session. I haven't set up my investor profile yet.", hidden: true)
    }
}

private struct AdvisorChat: View {
    @ObservedObject var advisor: AdvisorConversation
    @EnvironmentObject var portfolio: PortfolioModel
    @Binding var draft: String

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Label("Senior risk analyst · 3–5 yr horizon · reads Robinhood, never trades", systemImage: "shield.lefthalf.filled")
                    .font(.system(size: 11.5)).foregroundStyle(.secondary)
                Spacer()
                // Paired, the profile the advisor reads and keeps lives on the hub, which has no way to
                // hand it over yet; the copy on this Mac is stale, and edits to it would never reach the advisor.
                Button { NSWorkspace.shared.open(Personal.investorProfileURL) } label: {
                    Label("Investor profile", systemImage: "person.text.rectangle")
                }
                .disabled(portfolio.usesHub)
                .help(portfolio.usesHub
                      ? "Your profile is kept on the Dash hub now. Ask the advisor here to show it or change it."
                      : "Your goals, limits, and decisions, which the advisor keeps up to date")
                Button { advisor.clear() } label: { Label("New session", systemImage: "square.and.pencil") }
                    .disabled(advisor.isBusy || advisor.turns.isEmpty)
            }
            .buttonStyle(.borderless)
            .font(.system(size: 12))
            .padding(.horizontal, 18)
            .padding(.vertical, 10)

            ConversationScroll(conversation: advisor) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Talk your portfolio through").font(.system(size: 16, weight: .semibold))
                    Text("Ask what's driving your risk, how to get closer to your goals, or for new ideas to research. Every number comes with its source, and anything that would trigger taxes or heavy trading gets your OK first. Dash can't place trades, so you make every move in Robinhood.")
                        .font(.system(size: 13)).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.top, 24)
            }

            if advisor.turns.isEmpty {
                FlowRow(spacing: 6) {
                    starter("Review my portfolio", AdvisorView.reviewPrompt)
                    starter("What's driving my risk?", "Break down the drivers of my portfolio's variance and tell me which ones are intentional bets vs. accidental risk.")
                    starter("Find diversifiers", "Find a few stocks or ETFs that would diversify my portfolio and improve its risk-adjusted return. Verify the key numbers.")
                    starter("Revisit my goals", "Let's revisit my investor goals and update my profile.")
                }
                .frame(maxWidth: DS.chatWidth, alignment: .leading)
                .padding(.horizontal, 18)
                .padding(.bottom, 8)
            }
            Composer(placeholder: "Talk it through…", draft: $draft, isBusy: advisor.isBusy,
                     send: { portfolio.askAdvisor(draft); draft = "" },
                     stop: { advisor.stop() })
        }
    }

    private func starter(_ title: String, _ prompt: String) -> some View {
        Button(title) { portfolio.askAdvisor(prompt) }
            .buttonStyle(.bordered)
            .controlSize(.small)
    }
}

private struct ConnectCard: View {
    @EnvironmentObject var portfolio: PortfolioModel

    var body: some View {
        Card(title: "Connect Robinhood", icon: "link") {
            VStack(alignment: .leading, spacing: 10) {
                Text("Dash connects to Robinhood's official agent server and only reads: positions, balances, prices, and history. It never places, changes, or cancels orders. Those tools are blocked in Dash's code.")
                    .font(.system(size: 12.5)).fixedSize(horizontal: false, vertical: true)
                Text("Signing in may ask you to open a separate Agentic account. You can leave it empty, since Dash doesn't trade.")
                    .font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                HStack {
                    Button(portfolio.isConnecting ? "Waiting for sign-in…" : "Connect Robinhood") { portfolio.connect() }
                        .buttonStyle(.borderedProminent)
                        .disabled(portfolio.isConnecting)
                    if let error = portfolio.error { Text(error).font(.system(size: 12)).foregroundStyle(.orange) }
                }
            }
        }
    }
}
