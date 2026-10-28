/**
 * Portfolio statistics, ported line for line from Analytics.swift, so the hub's numbers match what
 * Mac Dash computed before. Dates are trading days as milliseconds (local midnight on the hub, Eastern).
 */

/** A dated value series (portfolio value or a price), oldest first. */
export class Series {
  dates: number[];
  values: number[];

  constructor(dates: number[] = [], values: number[] = []) {
    this.dates = dates;
    this.values = values;
  }

  get isEmpty() {
    return this.values.length < 2;
  }

  /** Day-over-day returns. */
  get returns(): number[] {
    return this.values.slice(1).map((value, index) => (this.values[index] === 0 ? 0 : value / this.values[index] - 1));
  }

  /** The part of the series from `start` on. */
  since(start: number): Series {
    let first = this.dates.findIndex((date) => date >= start);
    if (first < 0) first = this.dates.length;
    return new Series(this.dates.slice(first), this.values.slice(first));
  }

  get totalReturn(): number | undefined {
    const first = this.values[0];
    const last = this.values.at(-1);
    if (first === undefined || last === undefined || first === 0 || this.values.length < 2) return undefined;
    return last / first - 1;
  }

  toJSON() {
    return { dates: this.dates.map((date) => new Date(date).toISOString()), values: this.values };
  }
}

/** Annualized standard deviation of daily returns. */
export function volatility(returns: number[]): number | undefined {
  if (returns.length <= 2) return undefined;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.map((r) => (r - mean) ** 2).reduce((a, b) => a + b, 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252);
}

/** Sensitivity to the benchmark: cov(p, m) / var(m) over matching days. */
export function beta(portfolio: number[], market: number[]): number | undefined {
  const n = Math.min(portfolio.length, market.length);
  if (n <= 2) return undefined;
  const p = portfolio.slice(-n);
  const m = market.slice(-n);
  const pm = p.reduce((a, b) => a + b, 0) / n;
  const mm = m.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let varM = 0;
  for (let i = 0; i < n; i++) {
    cov += (p[i] - pm) * (m[i] - mm);
    varM += (m[i] - mm) ** 2;
  }
  return varM === 0 ? undefined : cov / varM;
}

/** Largest peak-to-trough fall, and how far the latest value is below its peak (both ≤ 0). */
export function drawdowns(values: number[]): { max: number; current: number } | undefined {
  if (values.length <= 1) return undefined;
  let peak = values[0];
  let worst = 0;
  for (const value of values) {
    peak = Math.max(peak, value);
    if (peak > 0) worst = Math.min(worst, value / peak - 1);
  }
  return { max: worst, current: peak > 0 ? values.at(-1)! / peak - 1 : 0 };
}

/** Best and worst single days. */
export function extremes(series: Series): { best: [number, number]; worst: [number, number] } | undefined {
  const returns = series.returns;
  if (!returns.length) return undefined;
  let best = 0;
  let worst = 0;
  returns.forEach((value, index) => {
    if (value > returns[best]) best = index;
    if (value < returns[worst]) worst = index;
  });
  return { best: [series.dates[best + 1], returns[best]], worst: [series.dates[worst + 1], returns[worst]] };
}

/**
 * Concentration: weight of the largest holding, the top five, and the "effective number of
 * positions" (1 / Herfindahl index), which is how many equal-sized holdings this acts like.
 */
export function concentration(weights: number[]): { top1: number; top5: number; effectiveCount: number } | undefined {
  const sorted = [...weights].sort((a, b) => b - a);
  if (!sorted.length) return undefined;
  const hhi = sorted.reduce((sum, w) => sum + w * w, 0);
  return { top1: sorted[0], top5: sorted.slice(0, 5).reduce((a, b) => a + b, 0), effectiveCount: hhi > 0 ? 1 / hhi : 0 };
}

export type Risk = { contribution: number; volatility?: number; beta?: number };

/**
 * Each holding's contribution to portfolio variance, RC_i = w_i (Σw)_i / wᵀΣw, from daily returns
 * over the dates every holding (and SPY) traded. Holdings with under 60 shared days of history are
 * left out rather than distorting the rest.
 */
export function riskContributions(weights: Record<string, number>, closes: Record<string, Series>, benchmark?: Series): Record<string, Risk> {
  const lookup: Record<string, Map<number, number>> = {};
  for (const [symbol, series] of Object.entries(closes)) {
    if (weights[symbol] !== undefined) lookup[symbol] = new Map(series.dates.map((date, i) => [date, series.values[i]]));
  }
  const recent = new Set(Object.values(closes).flatMap((series) => series.dates.slice(-253)));
  const usable = Object.keys(lookup).filter((symbol) => [...recent].filter((date) => lookup[symbol].has(date)).length >= 61).sort();
  if (usable.length <= 1) return {};
  const dates = [...recent].filter((date) => usable.every((symbol) => lookup[symbol].has(date))).sort((a, b) => a - b);
  if (dates.length < 61) return {};

  const returnsOf = (prices: number[]) => prices.slice(1).map((price, i) => (prices[i] === 0 ? 0 : price / prices[i] - 1));
  const r = usable.map((symbol) => returnsOf(dates.map((date) => lookup[symbol].get(date)!)));
  const n = usable.length;
  const t = r[0].length;
  const means = r.map((row) => row.reduce((a, b) => a + b, 0) / t);
  const cov = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let sum = 0;
      for (let k = 0; k < t; k++) sum += (r[i][k] - means[i]) * (r[j][k] - means[j]);
      cov[i][j] = cov[j][i] = sum / (t - 1);
    }
  }
  const total = usable.reduce((sum, symbol) => sum + weights[symbol], 0);
  const w = usable.map((symbol) => weights[symbol] / Math.max(total, 1e-9));
  const sigmaW = w.map((_, i) => w.reduce((sum, wj, j) => sum + cov[i][j] * wj, 0));
  const variance = w.reduce((sum, wi, i) => sum + wi * sigmaW[i], 0);
  if (variance <= 0) return {};

  let market: number[] | undefined;
  if (benchmark) {
    const prices = new Map(benchmark.dates.map((date, i) => [date, benchmark.values[i]]));
    if (dates.every((date) => prices.has(date))) market = returnsOf(dates.map((date) => prices.get(date)!));
  }
  const result: Record<string, Risk> = {};
  usable.forEach((symbol, i) => {
    result[symbol] = { contribution: (w[i] * sigmaW[i]) / variance, volatility: volatility(r[i]),
                       beta: market ? beta(r[i], market) : undefined };
  });
  return result;
}

/**
 * Today's holdings valued at each past close: what the current portfolio would have done, ignoring
 * past trades and deposits. A holding with no bar yet on a date uses its first close.
 */
export function holdingsLookback(quantities: Record<string, number>, closes: Record<string, Series>): Series {
  const dates = [...new Set(Object.values(closes).flatMap((series) => series.dates))].sort((a, b) => a - b);
  if (!dates.length) return new Series();
  const lookup: Record<string, Map<number, number>> = {};
  const last: Record<string, number> = {};
  for (const [symbol, series] of Object.entries(closes)) {
    lookup[symbol] = new Map(series.dates.map((date, i) => [date, series.values[i]]));
    last[symbol] = series.values[0] ?? 0;
  }
  const values = dates.map((date) => {
    let total = 0;
    for (const [symbol, quantity] of Object.entries(quantities)) {
      const close = lookup[symbol]?.get(date);
      if (close !== undefined) last[symbol] = close;
      total += quantity * (last[symbol] ?? 0);
    }
    return total;
  });
  return new Series(dates, values);
}
