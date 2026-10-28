import Foundation

/// A dated value series (portfolio value or a price), oldest first.
struct Series {
    var dates: [Date]
    var values: [Double]

    var isEmpty: Bool { values.count < 2 }

    /// Day-over-day returns.
    var returns: [Double] {
        guard values.count > 1 else { return [] }
        return zip(values.dropFirst(), values).map { $1 == 0 ? 0 : $0 / $1 - 1 }
    }

    /// The part of the series from `start` on.
    func since(_ start: Date) -> Series {
        let first = dates.firstIndex { $0 >= start } ?? dates.count
        return Series(dates: Array(dates[first...]), values: Array(values[first...]))
    }

    /// Scaled so the first point is 100, for comparing against a benchmark.
    var indexed: Series {
        guard let first = values.first, first != 0 else { return self }
        return Series(dates: dates, values: values.map { $0 / first * 100 })
    }

    var totalReturn: Double? {
        guard let first = values.first, let last = values.last, first != 0, values.count > 1 else { return nil }
        return last / first - 1
    }
}

/// Portfolio statistics, all computed locally from positions and daily closes.
enum Analytics {
    /// Annualized standard deviation of daily returns.
    static func volatility(_ returns: [Double]) -> Double? {
        guard returns.count > 2 else { return nil }
        let mean = returns.reduce(0, +) / Double(returns.count)
        let variance = returns.map { ($0 - mean) * ($0 - mean) }.reduce(0, +) / Double(returns.count - 1)
        return variance.squareRoot() * 252.0.squareRoot()
    }

    /// Sensitivity to the benchmark: cov(p, m) / var(m) over matching days.
    static func beta(_ portfolio: [Double], market: [Double]) -> Double? {
        let n = min(portfolio.count, market.count)
        guard n > 2 else { return nil }
        let p = Array(portfolio.suffix(n)), m = Array(market.suffix(n))
        let pm = p.reduce(0, +) / Double(n), mm = m.reduce(0, +) / Double(n)
        var cov = 0.0, varM = 0.0
        for i in 0..<n {
            cov += (p[i] - pm) * (m[i] - mm)
            varM += (m[i] - mm) * (m[i] - mm)
        }
        return varM == 0 ? nil : cov / varM
    }

    /// Largest peak-to-trough fall, and how far the latest value is below its peak (both ≤ 0).
    static func drawdowns(_ values: [Double]) -> (max: Double, current: Double)? {
        guard values.count > 1 else { return nil }
        var peak = values[0], worst = 0.0
        for value in values {
            peak = max(peak, value)
            if peak > 0 { worst = min(worst, value / peak - 1) }
        }
        let current = peak > 0 ? values.last! / peak - 1 : 0
        return (worst, current)
    }

    /// Best and worst single days.
    static func extremes(_ series: Series) -> (best: (Date, Double), worst: (Date, Double))? {
        let returns = series.returns
        guard let best = returns.indices.max(by: { returns[$0] < returns[$1] }),
              let worst = returns.indices.min(by: { returns[$0] < returns[$1] })
        else { return nil }
        return ((series.dates[best + 1], returns[best]), (series.dates[worst + 1], returns[worst]))
    }

    /// Concentration: weight of the largest holding, the top five, and the "effective number
    /// of positions" (1 / Herfindahl index), which is how many equal-sized holdings this acts like.
    static func concentration(_ weights: [Double]) -> (top1: Double, top5: Double, effectiveCount: Double)? {
        let sorted = weights.sorted(by: >)
        guard !sorted.isEmpty else { return nil }
        let hhi = sorted.map { $0 * $0 }.reduce(0, +)
        return (sorted[0], sorted.prefix(5).reduce(0, +), hhi > 0 ? 1 / hhi : 0)
    }

    struct Risk {
        /// Share of total portfolio variance from this holding (sums to 1 across holdings).
        var contribution: Double
        var volatility: Double?
        var beta: Double?
    }

    /// Each holding's contribution to portfolio variance, RC_i = w_i (Σw)_i / wᵀΣw, from daily
    /// returns over the dates every holding (and SPY) traded. Holdings with under 60 shared days
    /// of history are left out rather than distorting the rest.
    static func riskContributions(weights: [String: Double], closes: [String: Series], benchmark: Series?) -> [String: Risk] {
        var lookup: [String: [Date: Double]] = [:]
        for (symbol, series) in closes where weights[symbol] != nil {
            lookup[symbol] = Dictionary(zip(series.dates, series.values), uniquingKeysWith: { $1 })
        }
        let recent = Set(closes.values.flatMap { $0.dates.suffix(253) })
        let usable = lookup.filter { _, prices in recent.filter { prices[$0] != nil }.count >= 61 }.map(\.key).sorted()
        guard usable.count > 1 else { return [:] }
        let dates = recent.filter { date in usable.allSatisfy { lookup[$0]?[date] != nil } }.sorted()
        guard dates.count >= 61 else { return [:] }

        func returns(_ prices: [Double]) -> [Double] { zip(prices.dropFirst(), prices).map { $1 == 0 ? 0 : $0 / $1 - 1 } }
        let r = usable.map { symbol in returns(dates.map { lookup[symbol]![$0]! }) }
        let n = usable.count, t = r[0].count
        let means = r.map { $0.reduce(0, +) / Double(t) }
        var cov = Array(repeating: Array(repeating: 0.0, count: n), count: n)
        for i in 0..<n {
            for j in i..<n {
                var sum = 0.0
                for k in 0..<t { sum += (r[i][k] - means[i]) * (r[j][k] - means[j]) }
                cov[i][j] = sum / Double(t - 1)
                cov[j][i] = cov[i][j]
            }
        }
        let total = usable.reduce(0) { $0 + weights[$1]! }
        let w = usable.map { weights[$0]! / max(total, 1e-9) }
        let sigmaW = (0..<n).map { i in (0..<n).reduce(0) { $0 + cov[i][$1] * w[$1] } }
        let variance = (0..<n).reduce(0) { $0 + w[$1] * sigmaW[$1] }
        guard variance > 0 else { return [:] }

        var market: [Double]?
        if let benchmark {
            let prices = Dictionary(zip(benchmark.dates, benchmark.values), uniquingKeysWith: { $1 })
            if dates.allSatisfy({ prices[$0] != nil }) { market = returns(dates.map { prices[$0]! }) }
        }
        var result: [String: Risk] = [:]
        for (i, symbol) in usable.enumerated() {
            result[symbol] = Risk(contribution: w[i] * sigmaW[i] / variance,
                                  volatility: volatility(r[i]),
                                  beta: market.flatMap { beta(r[i], market: $0) })
        }
        return result
    }

    /// Today's holdings valued at each past close: what the current portfolio would have done,
    /// ignoring past trades and deposits. A holding with no bar yet on a date uses its first close.
    static func holdingsLookback(quantities: [String: Double], closes: [String: Series]) -> Series {
        let dates = Set(closes.values.flatMap(\.dates)).sorted()
        guard !dates.isEmpty else { return Series(dates: [], values: []) }
        var lookup: [String: [Date: Double]] = [:]
        for (symbol, series) in closes {
            lookup[symbol] = Dictionary(zip(series.dates, series.values), uniquingKeysWith: { $1 })
        }
        var last: [String: Double] = closes.mapValues { $0.values.first ?? 0 }
        var values: [Double] = []
        for date in dates {
            var total = 0.0
            for (symbol, quantity) in quantities {
                if let close = lookup[symbol]?[date] { last[symbol] = close }
                total += quantity * (last[symbol] ?? 0)
            }
            values.append(total)
        }
        return Series(dates: dates, values: values)
    }
}
