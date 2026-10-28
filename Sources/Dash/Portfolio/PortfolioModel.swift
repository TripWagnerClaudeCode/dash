import AppKit
import Combine
import SwiftUI

struct Holding: Identifiable {
    let symbol: String
    var quantity: Double
    var averageCost: Double
    var price: Double
    var previousClose: Double
    var sector: String?
    var id: String { symbol }

    var value: Double { quantity * price }
    var costBasis: Double { quantity * averageCost }
    var unrealized: Double { value - costBasis }
    var unrealizedPercent: Double? { costBasis > 0 ? unrealized / costBasis : nil }
    var dayChange: Double { quantity * (price - previousClose) }
    var dayPercent: Double? { previousClose > 0 ? price / previousClose - 1 : nil }
}

/// Portfolio statistics shown on the page and handed to the AI review.
struct PortfolioStats {
    struct Period: Identifiable {
        let label: String
        let portfolio: Double?
        let spy: Double?
        var id: String { label }
        var vsSPY: Double? { portfolio.flatMap { p in spy.map { p - $0 } } }
    }

    var periods: [Period] = []
    var volatility: Double?
    var spyVolatility: Double?
    var beta: Double?
    var maxDrawdown: Double?
    var currentDrawdown: Double?
    var best: (Date, Double)?
    var worst: (Date, Double)?
    var top1: Double?
    var top5: Double?
    var effectiveCount: Double?
    var sectors: [(name: String, weight: Double)] = []
    var realizedYear: Double?
    var realizedYearRate: Double?
    /// Per holding: share of portfolio variance, own volatility and beta.
    var risk: [String: Analytics.Risk] = [:]
}

/// Live Robinhood portfolio. Positions refresh every few minutes, prices every 15 s while the
/// market is open and the console is on screen, and nothing runs otherwise. All of it goes
/// straight to Robinhood (no Claude), and every statistic is computed here.
@MainActor
final class PortfolioModel: ObservableObject {
    enum Session { case regular, extended, closed }

    @Published private(set) var isConnected: Bool
    @Published private(set) var isConnecting = false
    @Published private(set) var holdings: [Holding] = []
    /// Cash, options, crypto and other non-stock value, from the last positions refresh.
    @Published private(set) var otherValue: Double = 0
    @Published private(set) var cash: Double = 0
    @Published private(set) var buyingPower: Double = 0
    @Published private(set) var lastQuote: Date?
    @Published private(set) var error: String?
    @Published private(set) var stats = PortfolioStats()
    /// Today's holdings valued over the past year, and SPY, for the chart.
    @Published private(set) var lookback = Series(dates: [], values: [])
    @Published private(set) var spy = Series(dates: [], values: [])
    /// Actual recorded portfolio values (Dash logs these as it runs).
    @Published private(set) var recorded = Series(dates: [], values: [])
    @Published private(set) var session: Session = .closed
    /// SPY's live price and previous close, the benchmark for today's move.
    @Published private(set) var spyQuote: (price: Double, previousClose: Double)?
    var spyDayPercent: Double? {
        spyQuote.flatMap { $0.previousClose > 0 ? $0.price / $0.previousClose - 1 : nil }
    }
    let advisor = AdvisorConversation()
    /// Which half of the Portfolio page is showing.
    @Published var showAdvisor = false

    let client = RobinhoodClient()
    private var accounts: [String] = []
    private var positionsAt: Date?
    private var historyDay: String?
    private var closes: [String: Series] = [:]
    private var loop: Task<Void, Never>?
    private var visible = false
    /// Requests sent, for checking that polling stops when hidden.
    private(set) var requestCount = 0
    /// Once paired with the Dash hub, the hub holds the Robinhood connection, polls, and computes
    /// everything; this shows its snapshots. Unpaired, everything runs here as before.
    private(set) var hub: HubClient?
    private var hubWatch: AnyCancellable?
    var usesHub: Bool { hub?.isPaired == true }

    static let directory = Personal.supportDir.appendingPathComponent("portfolio", isDirectory: true)
    static let logURL = directory.appendingPathComponent("history.jsonl")

    init() {
        isConnected = client.isConnected
        try? FileManager.default.createDirectory(at: Self.directory, withIntermediateDirectories: true)
        recorded = Self.readLog()
    }

    // MARK: Totals

    var equityValue: Double { holdings.reduce(0) { $0 + $1.value } }
    var totalValue: Double { equityValue + otherValue }
    var dayChange: Double { holdings.reduce(0) { $0 + $1.dayChange } }
    var dayPercent: Double? {
        let start = totalValue - dayChange
        return start > 0 ? dayChange / start : nil
    }
    var unrealized: Double { holdings.reduce(0) { $0 + $1.unrealized } }
    var costBasis: Double { holdings.reduce(0) { $0 + $1.costBasis } }

    func weight(_ holding: Holding) -> Double { totalValue > 0 ? holding.value / totalValue : 0 }

    /// Share of today's portfolio move that came from this holding.
    func contribution(_ holding: Holding) -> Double? {
        let start = totalValue - dayChange
        return start > 0 ? holding.dayChange / start : nil
    }

    // MARK: Connection

    func connect() {
        guard !isConnecting else { return }
        isConnecting = true
        error = nil
        if usesHub { return connectThroughHub() }
        Task {
            do {
                try await client.connect()
                isConnected = true
                positionsAt = nil
                if visible { startLoop() }
            } catch {
                self.error = error.localizedDescription
            }
            isConnecting = false
        }
    }

    func disconnect() {
        if usesHub {
            Task { _ = try? await hub?.request("portfolio.disconnect") }
            return
        }
        loop?.cancel()
        loop = nil
        client.disconnect()
        isConnected = false
        holdings = []
    }

    // MARK: Polling

    /// The console tells the model when it's on screen; polling only runs then.
    func setVisible(_ visible: Bool) {
        guard visible != self.visible else { return }
        self.visible = visible
        if usesHub { return watchOnHub() }
        if visible && isConnected { startLoop() } else { loop?.cancel(); loop = nil }
    }

    func refreshNow() {
        if usesHub {
            Task { _ = try? await hub?.request("portfolio.refresh") }
            return
        }
        positionsAt = nil
        historyDay = nil
        if isConnected { startLoop() }
    }

    private func startLoop() {
        loop?.cancel()
        loop = Task {
            while !Task.isCancelled {
                session = Self.marketSession()
                do {
                    if positionsAt.map({ Date().timeIntervalSince($0) > 300 }) ?? true {
                        try await refreshPositions()
                    }
                    try await refreshQuotes()
                    if historyDay != LectureController.dayString(Date()) { try await refreshHistory() }
                    error = nil
                } catch is CancellationError {
                    return
                } catch RobinhoodError.auth(let message) {
                    error = message
                    isConnected = client.isConnected
                    return
                } catch {
                    self.error = error.localizedDescription
                }
                let pause: UInt64 = switch session {
                case .regular: 15
                case .extended: 60
                case .closed: 300
                }
                try? await Task.sleep(nanoseconds: pause * 1_000_000_000)
            }
        }
    }

    private func call(_ tool: String, _ arguments: [String: Any] = [:]) async throws -> [String: Any] {
        requestCount += 1
        let text = try await client.call(tool, arguments)
        guard let json = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] else {
            throw RobinhoodError.failed(text.hasPrefix("ERROR") ? text : "Unexpected reply from \(tool).")
        }
        return json["data"] as? [String: Any] ?? [:]
    }

    /// Accounts, balances, and positions (merged across accounts by symbol).
    private func refreshPositions() async throws {
        if accounts.isEmpty {
            let list = try await call("get_accounts")["accounts"] as? [[String: Any]] ?? []
            accounts = list.filter { $0["deactivated"] as? Bool != true }.compactMap { $0["account_number"] as? String }
        }
        var merged: [String: Holding] = [:]
        var other = 0.0, cash = 0.0, buyingPower = 0.0
        for account in accounts {
            let portfolio = try await call("get_portfolio", ["account_number": account])
            let total = Self.number(portfolio["total_value"]), equity = Self.number(portfolio["equity_value"])
            other += total - equity
            cash += Self.number(portfolio["cash"])
            buyingPower += Self.number((portfolio["buying_power"] as? [String: Any])?["buying_power"])

            var cursor: String?
            repeat {
                var arguments: [String: Any] = ["account_number": account]
                if let cursor { arguments["cursor"] = cursor }
                let page = try await call("get_equity_positions", arguments)
                for position in page["positions"] as? [[String: Any]] ?? [] {
                    guard let symbol = position["symbol"] as? String else { continue }
                    let quantity = Self.number(position["quantity"])
                    guard quantity > 0 else { continue }
                    let cost = Self.number(position["average_buy_price"])
                    if var existing = merged[symbol] {
                        let combined = existing.quantity + quantity
                        existing.averageCost = (existing.costBasis + quantity * cost) / combined
                        existing.quantity = combined
                        merged[symbol] = existing
                    } else {
                        let old = holdings.first { $0.symbol == symbol }
                        merged[symbol] = Holding(symbol: symbol, quantity: quantity, averageCost: cost,
                                                 price: old?.price ?? cost, previousClose: old?.previousClose ?? cost,
                                                 sector: old?.sector)
                    }
                }
                cursor = page["next"] as? String
            } while cursor != nil
        }
        holdings = merged.values.sorted { $0.value > $1.value }
        otherValue = other
        self.cash = cash
        self.buyingPower = buyingPower
        positionsAt = Date()
    }

    /// Live prices, 20 symbols per request.
    private func refreshQuotes() async throws {
        let symbols = holdings.map(\.symbol) + (holdings.contains { $0.symbol == "SPY" } ? [] : ["SPY"])
        guard symbols.count > 1 else { return }
        for batch in stride(from: 0, to: symbols.count, by: 20).map({ Array(symbols[$0..<min($0 + 20, symbols.count)]) }) {
            let results = try await call("get_equity_quotes", ["symbols": batch])["results"] as? [[String: Any]] ?? []
            for result in results {
                guard let quote = result["quote"] as? [String: Any], let symbol = quote["symbol"] as? String else { continue }
                // Outside regular hours the latest extended-hours trade is the live price.
                let extended = session == .extended ? Self.number(quote["last_non_reg_trade_price"]) : 0
                let price = extended > 0 ? extended : Self.number(quote["last_trade_price"])
                let previous = Self.number(quote["previous_close"])
                if symbol == "SPY", price > 0 { spyQuote = (price, previous) }
                guard let index = holdings.firstIndex(where: { $0.symbol == symbol }) else { continue }
                if price > 0 { holdings[index].price = price }
                if previous > 0 { holdings[index].previousClose = previous }
            }
        }
        lastQuote = Date()
        logValue()
        computeStats()
    }

    /// A year of daily closes for every holding and SPY, plus sectors and realized P&L. Once a day.
    private func refreshHistory() async throws {
        let start = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-372 * 86400))
        let symbols = holdings.map(\.symbol) + ["SPY"]
        var closes: [String: Series] = [:]
        for batch in stride(from: 0, to: symbols.count, by: 10).map({ Array(symbols[$0..<min($0 + 10, symbols.count)]) }) {
            let results = try await call("get_equity_historicals", ["symbols": batch, "interval": "day",
                                                                    "start_time": start])["results"] as? [[String: Any]] ?? []
            for result in results {
                guard let symbol = result["symbol"] as? String else { continue }
                let bars = result["bars"] as? [[String: Any]] ?? []
                let points = bars.compactMap { bar -> (Date, Double)? in
                    // Daily bars are labeled "2026-10-12T00:00:00Z"; the date part is the trading day.
                    guard let begins = bar["begins_at"] as? String,
                          let date = Self.day.date(from: String(begins.prefix(10))) else { return nil }
                    let close = Self.number(bar["close_price"])
                    return close > 0 ? (date, close) : nil
                }
                closes[symbol] = Series(dates: points.map(\.0), values: points.map(\.1))
            }
        }
        self.closes = closes

        var sectors: [String: String] = [:]
        for batch in stride(from: 0, to: holdings.count, by: 10).map({ Array(holdings[$0..<min($0 + 10, holdings.count)]) }) {
            let data = try await call("get_equity_fundamentals", ["symbols": batch.map(\.symbol)])
            for entry in data["results"] as? [[String: Any]] ?? [] {
                if let symbol = entry["symbol"] as? String, let sector = entry["sector"] as? String { sectors[symbol] = sector }
            }
        }
        for index in holdings.indices { holdings[index].sector = sectors[holdings[index].symbol] }

        // Realized gains are optional; an account without trades just has none.
        var realized = 0.0, rates: [Double] = []
        for account in accounts {
            if let data = try? await call("get_realized_pnl", ["account_number": account, "span": "year"]) {
                realized += Self.number(data["total_returns"])
                if let rate = Double(data["total_rate_of_return"] as? String ?? "") { rates.append(rate) }
            }
        }
        stats.realizedYear = realized
        stats.realizedYearRate = rates.count == 1 ? rates[0] : nil

        historyDay = LectureController.dayString(Date())
        computeStats()
    }

    // MARK: Statistics

    private func computeStats() {
        let quantities = Dictionary(holdings.map { ($0.symbol, $0.quantity) }, uniquingKeysWith: +)
        let held = closes.filter { quantities[$0.key] != nil }
        var lookback = Analytics.holdingsLookback(quantities: quantities, closes: held)
        // Today's live value as the latest point.
        if !lookback.isEmpty, let last = lookback.dates.last, !Calendar.current.isDateInToday(last) {
            lookback.dates.append(Calendar.current.startOfDay(for: Date()))
            lookback.values.append(equityValue)
        }
        var spy = closes["SPY"] ?? Series(dates: [], values: [])
        if let spyLast = spy.dates.last, !Calendar.current.isDateInToday(spyLast),
           let live = livePrice("SPY") {
            spy.dates.append(Calendar.current.startOfDay(for: Date()))
            spy.values.append(live)
        }
        self.lookback = lookback
        self.spy = spy

        var stats = self.stats
        let calendar = Calendar.current
        let now = Date()
        let ranges: [(String, Date)] = [
            ("1W", now.addingTimeInterval(-7 * 86400)), ("1M", calendar.date(byAdding: .month, value: -1, to: now)!),
            ("3M", calendar.date(byAdding: .month, value: -3, to: now)!),
            ("YTD", calendar.date(from: calendar.dateComponents([.year], from: now))!),
            ("1Y", calendar.date(byAdding: .year, value: -1, to: now)!),
        ]
        stats.periods = ranges.map { label, start in
            .init(label: label, portfolio: lookback.since(start).totalReturn, spy: spy.since(start).totalReturn)
        }
        // Match portfolio and SPY returns by date for beta.
        let spyByDate = Dictionary(zip(spy.dates, spy.values), uniquingKeysWith: { $1 })
        let common = lookback.dates.indices.filter { spyByDate[lookback.dates[$0]] != nil }
        let p = Series(dates: common.map { lookback.dates[$0] }, values: common.map { lookback.values[$0] })
        let m = Series(dates: p.dates, values: p.dates.map { spyByDate[$0]! })
        stats.volatility = Analytics.volatility(lookback.returns)
        stats.spyVolatility = Analytics.volatility(spy.returns)
        stats.beta = Analytics.beta(p.returns, market: m.returns)
        let drawdowns = Analytics.drawdowns(lookback.values)
        stats.maxDrawdown = drawdowns?.max
        stats.currentDrawdown = drawdowns?.current
        let extremes = Analytics.extremes(lookback)
        stats.best = extremes?.best
        stats.worst = extremes?.worst

        let weights = holdings.map(weight)
        let concentration = Analytics.concentration(weights)
        stats.top1 = concentration?.top1
        stats.top5 = concentration?.top5
        stats.effectiveCount = concentration?.effectiveCount
        var sectorWeights: [String: Double] = [:]
        for holding in holdings { sectorWeights[Self.sectorName(holding.sector), default: 0] += weight(holding) }
        if otherValue > 0, totalValue > 0 { sectorWeights["Cash & other", default: 0] += otherValue / totalValue }
        stats.sectors = sectorWeights.map { ($0.key, $0.value) }.sorted { $0.weight > $1.weight }
        let values = Dictionary(holdings.map { ($0.symbol, $0.value) }, uniquingKeysWith: +)
        stats.risk = Analytics.riskContributions(weights: values, closes: held, benchmark: closes["SPY"])
        self.stats = stats
    }

    private func livePrice(_ symbol: String) -> Double? {
        symbol == "SPY" ? spyQuote?.price : holdings.first { $0.symbol == symbol }?.price
    }

    // MARK: Recorded history

    private struct LogEntry: Codable {
        let time: Date
        let total: Double
    }

    /// Appends the live total at most every 15 minutes, so the real value history grows over time.
    private func logValue() {
        guard totalValue > 0 else { return }
        if let last = recorded.dates.last, Date().timeIntervalSince(last) < 900 { return }
        let entry = LogEntry(time: Date(), total: totalValue)
        guard var line = try? JSONEncoder().encode(entry) else { return }
        line.append(0x0A)
        if let handle = try? FileHandle(forWritingTo: Self.logURL) {
            handle.seekToEndOfFile()
            handle.write(line)
            try? handle.close()
        } else {
            try? line.write(to: Self.logURL)
        }
        recorded.dates.append(entry.time)
        recorded.values.append(entry.total)
    }

    private static func readLog() -> Series {
        guard let text = try? String(contentsOf: logURL, encoding: .utf8) else { return Series(dates: [], values: []) }
        let entries = text.split(separator: "\n").compactMap { try? JSONDecoder().decode(LogEntry.self, from: Data($0.utf8)) }
        return Series(dates: entries.map(\.time), values: entries.map(\.total))
    }

    // MARK: Helpers

    /// Robinhood files most ETFs and funds under "Miscellaneous".
    static func sectorName(_ sector: String?) -> String {
        switch sector {
        case nil: "Other"
        case "Miscellaneous": "Funds & ETFs"
        case let name?: name
        }
    }

    /// Regular session 9:30–4:00 ET on weekdays; extended 4:00–9:30 and 4:00–8:00 PM.
    static func marketSession(at date: Date = Date()) -> Session {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York")!
        let parts = calendar.dateComponents([.weekday, .hour, .minute], from: date)
        guard let weekday = parts.weekday, (2...6).contains(weekday) else { return .closed }
        let minutes = (parts.hour ?? 0) * 60 + (parts.minute ?? 0)
        switch minutes {
        case 570..<960: return .regular
        case 240..<570, 960..<1200: return .extended
        default: return .closed
        }
    }

    /// Trading days as local midnight, matching `Calendar.current.startOfDay`.
    private static let day: DateFormatter = {
        let format = DateFormatter()
        format.dateFormat = "yyyy-MM-dd"
        format.locale = Locale(identifier: "en_US_POSIX")
        return format
    }()

    static func number(_ value: Any?) -> Double {
        if let number = value as? NSNumber { return number.doubleValue }
        if let string = value as? String { return Double(string) ?? 0 }
        return 0
    }

    // MARK: AI review

    /// Compact JSON of everything computed, for the AI review.
    func reviewData() -> String {
        func pct(_ value: Double?) -> Any { value.map { (($0 * 10000).rounded() / 100) } ?? NSNull() }
        let data: [String: Any] = [
            "as_of": Personal.now,
            "total_value": totalValue.rounded(), "stocks_value": equityValue.rounded(), "cash_and_other": otherValue.rounded(),
            "day_change": dayChange.rounded(), "day_change_pct": pct(dayPercent),
            "unrealized_gain": unrealized.rounded(), "unrealized_pct": pct(costBasis > 0 ? unrealized / costBasis : nil),
            "realized_gain_past_year": stats.realizedYear.map { $0.rounded() } ?? NSNull(),
            "returns_pct_current_holdings_vs_spy": stats.periods.map {
                ["period": $0.label, "portfolio": pct($0.portfolio), "spy": pct($0.spy)]
            },
            "annual_volatility_pct": pct(stats.volatility), "spy_volatility_pct": pct(stats.spyVolatility),
            "beta_vs_spy": stats.beta.map { ($0 * 100).rounded() / 100 } ?? NSNull(),
            "max_drawdown_pct": pct(stats.maxDrawdown), "current_drawdown_pct": pct(stats.currentDrawdown),
            "largest_position_pct": pct(stats.top1), "top5_pct": pct(stats.top5),
            "effective_number_of_positions": stats.effectiveCount.map { ($0 * 10).rounded() / 10 } ?? NSNull(),
            "sectors_pct": stats.sectors.map { ["sector": $0.name, "weight": pct($0.weight)] },
            "holdings": holdings.map {
                ["symbol": $0.symbol, "weight_pct": pct(weight($0)), "unrealized_pct": pct($0.unrealizedPercent),
                 "day_pct": pct($0.dayPercent), "sector": Self.sectorName($0.sector),
                 "risk_contribution_pct": pct(stats.risk[$0.symbol]?.contribution),
                 "volatility_pct": pct(stats.risk[$0.symbol]?.volatility),
                 "beta": stats.risk[$0.symbol]?.beta.map { ($0 * 100).rounded() / 100 } ?? NSNull()] as [String: Any]
            },
        ]
        let json = (try? JSONSerialization.data(withJSONObject: data, options: [.sortedKeys])) ?? Data()
        return String(decoding: json, as: UTF8.self)
    }

    // MARK: Advisor

    private lazy var relay = RobinhoodRelay(client: client)

    /// Sends a message to the advisor, starting its read-only Robinhood relay first if needed.
    /// The first message of each session carries a snapshot of everything computed here.
    func askAdvisor(_ text: String, hidden: Bool = false) {
        guard !advisor.isBusy, isConnected else { return }
        // On the hub the advisor has its own relay and adds the numbers to a new session itself.
        if usesHub { return advisor.hubSend(text) }
        Task {
            do {
                advisor.relay = try await relay.start()
            } catch {
                advisor.notice = "Couldn't start the Robinhood relay: \(error.localizedDescription)"
                return
            }
            let snapshot = advisor.claude == nil
                ? "<portfolio_snapshot source=\"Dash, computed from Robinhood\">\n\(reviewData())\n</portfolio_snapshot>\n\n"
                : ""
            advisor.send([["type": "text", "text": snapshot + text]],
                         display: .init(role: .user, text: hidden ? "" : text), effort: "medium")
        }
    }
}

// MARK: The hub

extension PortfolioModel {
    func useHub(_ hub: HubClient) {
        self.hub = hub
        hub.on("portfolio") { [weak self] snapshot in self?.applyHub(snapshot) }
        advisor.useHub(hub)
        hubWatch = hub.$state.sink { [weak self] state in
            guard state == .online else { return }
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.watchOnHub() } }
        }
    }

    /// Tells the hub whether Portfolio is on screen here (it polls fast while anyone is watching).
    private func watchOnHub() {
        guard let hub, hub.isOnline else { return }
        let on = visible
        Task {
            if let snapshot = try? await hub.request("portfolio.watch", ["on": on]) { applyHub(snapshot) }
        }
    }

    /// Robinhood's sign-in opens in this Mac's browser and redirects to 127.0.0.1:47823 here; the hub
    /// made the request (it keeps the login), so the redirect is passed on to it.
    private func connectThroughHub() {
        guard let hub else { return }
        Task {
            defer { isConnecting = false }
            do {
                let start = try await hub.request("portfolio.connect")
                guard let address = start["url"] as? String, let url = URL(string: address) else {
                    throw RobinhoodError.auth("The hub didn't send a sign-in page.")
                }
                let callback = LoopbackCallback(port: RobinhoodClient.callbackPort)
                try callback.start()
                NSWorkspace.shared.open(url)
                let query = try await callback.wait(timeout: 300)
                _ = try await hub.request("portfolio.callback", ["query": query])
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    /// Shows the hub's snapshot (hub/src/portfolio/portfolio.ts `snapshot()`) in this model's types.
    func applyHub(_ data: [String: Any]) {
        guard usesHub else { return }
        isConnected = data["connected"] as? Bool ?? false
        error = data["error"] as? String
        session = switch data["session"] as? String {
        case "regular": .regular
        case "extended": .extended
        default: .closed
        }
        lastQuote = HubClient.date(data["lastQuote"])
        holdings = (data["holdings"] as? [[String: Any]] ?? []).compactMap { entry in
            guard let symbol = entry["symbol"] as? String else { return nil }
            return Holding(symbol: symbol, quantity: Self.number(entry["quantity"]), averageCost: Self.number(entry["averageCost"]),
                           price: Self.number(entry["price"]), previousClose: Self.number(entry["previousClose"]),
                           sector: entry["sector"] as? String)
        }
        otherValue = Self.number(data["otherValue"])
        cash = Self.number(data["cash"])
        buyingPower = Self.number(data["buyingPower"])
        spyQuote = (data["spyQuote"] as? [String: Any]).map { (Self.number($0["price"]), Self.number($0["previousClose"])) }
        lookback = Self.series(data["lookback"])
        spy = Self.series(data["spy"])
        recorded = Self.series(data["recorded"])

        let s = data["stats"] as? [String: Any] ?? [:]
        func value(_ key: String) -> Double? { (s[key] as? NSNumber)?.doubleValue }
        func dated(_ key: String) -> (Date, Double)? {
            guard let entry = s[key] as? [String: Any], let date = HubClient.date(entry["date"]),
                  let number = (entry["value"] as? NSNumber)?.doubleValue else { return nil }
            return (date, number)
        }
        var stats = PortfolioStats()
        stats.periods = (s["periods"] as? [[String: Any]] ?? []).map {
            .init(label: $0["label"] as? String ?? "", portfolio: ($0["portfolio"] as? NSNumber)?.doubleValue,
                  spy: ($0["spy"] as? NSNumber)?.doubleValue)
        }
        stats.volatility = value("volatility")
        stats.spyVolatility = value("spyVolatility")
        stats.beta = value("beta")
        stats.maxDrawdown = value("maxDrawdown")
        stats.currentDrawdown = value("currentDrawdown")
        stats.best = dated("best")
        stats.worst = dated("worst")
        stats.top1 = value("top1")
        stats.top5 = value("top5")
        stats.effectiveCount = value("effectiveCount")
        stats.sectors = (s["sectors"] as? [[String: Any]] ?? []).map { ($0["name"] as? String ?? "Other", Self.number($0["weight"])) }
        stats.realizedYear = value("realizedYear")
        stats.realizedYearRate = value("realizedYearRate")
        for (symbol, entry) in s["risk"] as? [String: [String: Any]] ?? [:] {
            stats.risk[symbol] = .init(contribution: Self.number(entry["contribution"]),
                                       volatility: (entry["volatility"] as? NSNumber)?.doubleValue,
                                       beta: (entry["beta"] as? NSNumber)?.doubleValue)
        }
        self.stats = stats
    }

    private static func series(_ value: Any?) -> Series {
        let entry = value as? [String: Any] ?? [:]
        let dates = (entry["dates"] as? [String] ?? []).compactMap { HubClient.date($0) }
        let values = (entry["values"] as? [Any] ?? []).map { number($0) }
        guard dates.count == values.count else { return Series(dates: [], values: []) }
        return Series(dates: dates, values: values)
    }
}

/// The portfolio chat: a senior risk manager and analyst with Robinhood's read-only tools (via
/// Dash's relay), web research for cross-checking, and the investor profile as permanent memory.
@MainActor
final class AdvisorConversation: Conversation {
    /// The relay's `--mcp-config` entry, set before the first message.
    var relay: [String: Any]?
    /// Once paired with the Dash hub, the advisor runs there as a chat with a fixed id (hub/src/chats.ts
    /// ADVISOR_ID), so it's the same conversation on the phone; this shows it and passes on what the user does.
    private(set) var hub: HubClient?
    private var hubWatch: AnyCancellable?
    static let hubID = "00000000-0000-4000-8000-0000000000AD"
    var usesHub: Bool { hub?.isPaired == true }

    func useHub(_ hub: HubClient) {
        self.hub = hub
        hub.on("chat") { [weak self] data in
            guard let self, self.usesHub, (data["id"] as? String) == Self.hubID else { return }
            if self.applyHubTurns(data) { self.applyHubState(data) } else { self.reopen() }
        }
        hubWatch = hub.$state.sink { [weak self] state in
            guard state == .online else { return }
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.reopen() } }
        }
    }

    /// Fetches the whole advisor conversation; none yet means a fresh session.
    private func reopen() {
        guard let hub, hub.isOnline else { return }
        Task {
            do {
                let data = try await hub.request("chat.open", ["chat": Self.hubID])
                applyHubTurns(data)
                applyHubState(data)
            } catch let error as HubClient.HubError where error.fromHub {
                turns = []
                status = .idle
            } catch {}
        }
    }

    func hubSend(_ text: String) {
        guard let hub, hub.isOnline else {
            notice = hub?.offlineMessage ?? "The Dash hub is offline."
            return
        }
        hubCall("chat.send", ["text": text])
    }

    private func hubCall(_ type: String, _ params: [String: Any] = [:]) {
        guard let hub else { return }
        var params = params
        params["chat"] = Self.hubID
        Task {
            do {
                _ = try await hub.request(type, params)
            } catch {
                notice = error.localizedDescription
            }
        }
    }

    override func stop() {
        if usesHub { return hubCall("chat.stop") }
        super.stop()
    }

    override func decide(_ approval: Approval, allow: Bool, always: Bool = false) {
        guard usesHub else { return super.decide(approval, allow: allow, always: always) }
        approvals.removeAll { $0.id == approval.id }
        hubCall("chat.decide", ["request": approval.request.id, "allow": allow, "always": always])
    }

    /// "New session": the hub forgets the conversation; the investor profile stays.
    override func clear() {
        guard usesHub else { return super.clear() }
        guard !isBusy, let hub else { return }
        turns = []
        notice = nil
        Task { _ = try? await hub.request("advisor.reset") }
    }

    override func makeClaude(effort: String) throws -> ClaudeSession {
        guard let relay else { throw RobinhoodError.notConnected }
        _ = Personal.investorProfile()  // make sure the file exists before Claude reads it
        let system = Prompts.advisor + "\n\n" + """
        <about_me>
        \(Personal.aboutMe())
        </about_me>

        <investor_profile path="\(Personal.investorProfileURL.path)">
        \(Personal.investorProfile())
        </investor_profile>

        Right now it is \(Personal.now).
        """
        let robinhoodTools = RobinhoodClient.readTools.sorted().map { "mcp__robinhood__\($0)" }
        let profile = ClaudeProfile(tools: ["Read", "Edit", "Write", "WebSearch", "WebFetch"],
                                    allowedTools: robinhoodTools + ["Read", "WebSearch", "WebFetch"],
                                    addDirs: [Personal.supportDir.path],
                                    mcpServers: ["robinhood": relay])
        return try ClaudeSession(model: model, effort: effort, system: system, profile: profile)
    }

    /// Edits to the investor profile are saved without a card; that's the advisor's memory.
    override func autoApproves(_ request: PermissionRequest) -> Bool {
        guard ["Edit", "Write"].contains(request.toolName), let path = request.input["file_path"] as? String else { return false }
        return URL(fileURLWithPath: path).standardizedFileURL.path == Personal.investorProfileURL.standardizedFileURL.path
    }
}

extension PortfolioModel {
    /// Made-up data for `Dash --preview … portfolio-sample`, so the page's layout can be checked
    /// without a Robinhood connection or anyone's real holdings.
    func loadPreviewSample() {
        isConnected = true
        holdings = [
            Holding(symbol: "NVDA", quantity: 42, averageCost: 88, price: 131.4, previousClose: 128.9, sector: "Technology"),
            Holding(symbol: "MSFT", quantity: 18.5, averageCost: 301, price: 421.7, previousClose: 424.1, sector: "Technology"),
            Holding(symbol: "VTI", quantity: 60, averageCost: 210, price: 288.2, previousClose: 287.0, sector: "ETF"),
            Holding(symbol: "XOM", quantity: 75, averageCost: 98, price: 112.6, previousClose: 111.8, sector: "Energy"),
            Holding(symbol: "JPM", quantity: 30, averageCost: 150, price: 224.3, previousClose: 222.0, sector: "Financials"),
            Holding(symbol: "BRK.B", quantity: 12, averageCost: 330, price: 455.9, previousClose: 453.1, sector: "Financials"),
        ]
        otherValue = 1830
        let now = Date()
        var dates: [Date] = []
        var values: [Double] = []
        for day in 0..<250 {
            let offset = Double(249 - day) * 86_400
            dates.append(now.addingTimeInterval(-offset))
            let trend: Double = 41_000 + Double(day) * 55
            let wobble: Double = sin(Double(day) / 9) * 900
            values.append(trend + wobble)
        }
        lookback = Series(dates: dates, values: values)
        spy = Series(dates: dates, values: values.map { $0 * 0.93 })
        spyQuote = (price: 580, previousClose: 578.6)
        var s = PortfolioStats()
        s.periods = [.init(label: "1M", portfolio: 0.021, spy: 0.014), .init(label: "3M", portfolio: 0.063, spy: 0.041),
                     .init(label: "6M", portfolio: 0.118, spy: 0.092), .init(label: "1Y", portfolio: 0.274, spy: 0.211)]
        s.volatility = 0.182
        s.spyVolatility = 0.141
        s.beta = 1.21
        s.maxDrawdown = -0.142
        s.currentDrawdown = -0.021
        s.best = (now.addingTimeInterval(-40 * 86_400), 0.041)
        s.worst = (now.addingTimeInterval(-90 * 86_400), -0.038)
        s.top1 = 0.33
        s.top5 = 0.86
        s.effectiveCount = 4.8
        s.sectors = [("Technology", 0.42), ("Financials", 0.22), ("ETF", 0.2), ("Energy", 0.16)]
        s.risk = ["NVDA": .init(contribution: 0.38, volatility: 0.45, beta: 1.7), "MSFT": .init(contribution: 0.21, volatility: 0.24, beta: 1.1),
                  "VTI": .init(contribution: 0.16, volatility: 0.15, beta: 1.0), "XOM": .init(contribution: 0.09, volatility: 0.22, beta: 0.7),
                  "JPM": .init(contribution: 0.1, volatility: 0.21, beta: 1.0), "BRK.B": .init(contribution: 0.06, volatility: 0.14, beta: 0.8)]
        s.realizedYear = 1240
        stats = s
    }
}
