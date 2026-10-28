import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { log } from '../log.ts';
import { DATA } from '../paths.ts';
import { now as clockText, TIME_ZONE } from '../personal.ts';
import * as analytics from './analytics.ts';
import { Series } from './analytics.ts';
import { RobinhoodError, type RobinhoodClient } from './robinhood.ts';

type Holding = { symbol: string; quantity: number; averageCost: number; price: number; previousClose: number; sector?: string };
type MarketSession = 'regular' | 'extended' | 'closed';

const dir = join(DATA, 'portfolio');
/** The same file Mac Dash kept: one {"time", "total"} line per 15 minutes, time in Swift's reference-date seconds. */
const logFile = join(dir, 'history.jsonl');
const SWIFT_EPOCH = 978_307_200;

/**
 * Live Robinhood portfolio (ported from PortfolioModel.swift). While someone has Portfolio open, prices
 * refresh every 15 s in market hours; otherwise every 15 minutes, so the recorded value history keeps
 * growing even with no app open. All of it goes straight to Robinhood (no Claude), and every statistic
 * is computed here.
 */
export class Portfolio {
  error?: string;
  session: MarketSession = 'closed';
  holdings: Holding[] = [];
  otherValue = 0;
  cash = 0;
  buyingPower = 0;
  lastQuote?: Date;
  spyQuote?: { price: number; previousClose: number };
  stats: Record<string, any> = {};
  lookback = new Series();
  spy = new Series();
  recorded = new Series();

  private readonly client: RobinhoodClient;
  private accounts: string[] = [];
  private positionsAt?: number;
  private historyDay?: string;
  private closes: Record<string, Series> = {};
  private watchers = 0;
  private timer?: NodeJS.Timeout;
  private running = false;
  /** Asked to run again while a tick was in progress (someone opened Portfolio); runs right after it. */
  private again = false;
  private listeners = new Set<() => void>();

  constructor(client: RobinhoodClient) {
    this.client = client;
    mkdirSync(dir, { recursive: true });
    this.recorded = readLog();
  }

  onChange(listener: () => void) {
    this.listeners.add(listener);
  }

  private changed() {
    this.listeners.forEach((listener) => listener());
  }

  get connected() {
    return this.client.isConnected;
  }

  /** Starts the loop; called at launch and after connecting. */
  start() {
    if (this.client.isConnected) this.schedule(0);
  }

  /** An app opened or closed Portfolio. Watching speeds polling up; the first watcher refreshes at once. */
  watch(on: boolean) {
    this.watchers = Math.max(0, this.watchers + (on ? 1 : -1));
    if (on && this.watchers === 1) this.schedule(0);
  }

  refreshNow() {
    this.positionsAt = undefined;
    this.historyDay = undefined;
    this.schedule(0);
  }

  disconnect() {
    clearTimeout(this.timer);
    this.client.disconnect();
    this.holdings = [];
    this.accounts = [];
    this.changed();
  }

  private schedule(delay: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), delay);
  }

  private async tick() {
    if (!this.client.isConnected) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    this.again = false;
    this.session = marketSession();
    try {
      if (!this.positionsAt || Date.now() - this.positionsAt > (this.watchers > 0 ? 300_000 : 1_800_000)) await this.refreshPositions();
      await this.refreshQuotes();
      if (this.historyDay !== dayString(new Date())) await this.refreshHistory();
      this.error = undefined;
    } catch (error) {
      this.error = (error as Error).message;
      if (error instanceof RobinhoodError && error.auth) {
        log(`portfolio stopped: ${this.error}`);
        this.running = false;
        this.changed();
        return;
      }
    }
    this.running = false;
    this.changed();
    if (this.again) return this.schedule(0);
    // Whether anyone is watching *now*, not when this tick started.
    const seconds = this.watchers > 0 ? { regular: 15, extended: 60, closed: 300 }[this.session]
                                      : { regular: 900, extended: 1800, closed: 3600 }[this.session];
    this.schedule(seconds * 1000);
  }

  private async call(tool: string, args: Record<string, unknown> = {}): Promise<any> {
    const text = await this.client.call(tool, args);
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new RobinhoodError(text.startsWith('ERROR') ? text : `Unexpected reply from ${tool}.`);
    }
    return json.data ?? {};
  }

  /** Accounts, balances, and positions (merged across accounts by symbol). */
  private async refreshPositions() {
    if (!this.accounts.length) {
      const list = (await this.call('get_accounts')).accounts ?? [];
      this.accounts = list.filter((account: any) => account.deactivated !== true).map((account: any) => account.account_number).filter(Boolean);
    }
    const merged = new Map<string, Holding>();
    let other = 0;
    let cash = 0;
    let buyingPower = 0;
    for (const account of this.accounts) {
      const portfolio = await this.call('get_portfolio', { account_number: account });
      other += number(portfolio.total_value) - number(portfolio.equity_value);
      cash += number(portfolio.cash);
      buyingPower += number(portfolio.buying_power?.buying_power);
      let cursor: string | undefined;
      do {
        const page = await this.call('get_equity_positions', { account_number: account, ...(cursor ? { cursor } : {}) });
        for (const position of page.positions ?? []) {
          const symbol = position.symbol;
          const quantity = number(position.quantity);
          if (!symbol || quantity <= 0) continue;
          const cost = number(position.average_buy_price);
          const existing = merged.get(symbol);
          if (existing) {
            const combined = existing.quantity + quantity;
            existing.averageCost = (existing.quantity * existing.averageCost + quantity * cost) / combined;
            existing.quantity = combined;
          } else {
            const old = this.holdings.find((holding) => holding.symbol === symbol);
            merged.set(symbol, { symbol, quantity, averageCost: cost, price: old?.price ?? cost,
                                 previousClose: old?.previousClose ?? cost, sector: old?.sector });
          }
        }
        cursor = page.next ?? undefined;
      } while (cursor);
    }
    this.holdings = [...merged.values()].sort((a, b) => b.quantity * b.price - a.quantity * a.price);
    this.otherValue = other;
    this.cash = cash;
    this.buyingPower = buyingPower;
    this.positionsAt = Date.now();
  }

  /** Live prices, 20 symbols per request. */
  private async refreshQuotes() {
    const symbols = this.holdings.map((holding) => holding.symbol);
    if (!symbols.includes('SPY')) symbols.push('SPY');
    if (symbols.length <= 1) return;
    for (const batch of chunks(symbols, 20)) {
      const results = (await this.call('get_equity_quotes', { symbols: batch })).results ?? [];
      for (const result of results) {
        const quote = result.quote;
        if (!quote?.symbol) continue;
        // Outside regular hours the latest extended-hours trade is the live price.
        const extended = this.session === 'extended' ? number(quote.last_non_reg_trade_price) : 0;
        const price = extended > 0 ? extended : number(quote.last_trade_price);
        const previous = number(quote.previous_close);
        if (quote.symbol === 'SPY' && price > 0) this.spyQuote = { price, previousClose: previous };
        const holding = this.holdings.find((candidate) => candidate.symbol === quote.symbol);
        if (!holding) continue;
        if (price > 0) holding.price = price;
        if (previous > 0) holding.previousClose = previous;
      }
    }
    this.lastQuote = new Date();
    this.logValue();
    this.computeStats();
  }

  /** A year of daily closes for every holding and SPY, plus sectors and realized P&L. Once a day. */
  private async refreshHistory() {
    const start = new Date(Date.now() - 372 * 86_400_000).toISOString();
    const symbols = [...this.holdings.map((holding) => holding.symbol), 'SPY'];
    const closes: Record<string, Series> = {};
    for (const batch of chunks(symbols, 10)) {
      const results = (await this.call('get_equity_historicals', { symbols: batch, interval: 'day', start_time: start })).results ?? [];
      for (const result of results) {
        if (!result.symbol) continue;
        const points = (result.bars ?? []).flatMap((bar: any) => {
          // Daily bars are labeled "2026-10-12T00:00:00Z"; the date part is the trading day.
          const day = typeof bar.begins_at === 'string' ? localDay(bar.begins_at.slice(0, 10)) : undefined;
          const close = number(bar.close_price);
          return day !== undefined && close > 0 ? [[day, close]] : [];
        });
        closes[result.symbol] = new Series(points.map((p: number[]) => p[0]), points.map((p: number[]) => p[1]));
      }
    }
    this.closes = closes;

    const sectors: Record<string, string> = {};
    for (const batch of chunks(this.holdings.map((holding) => holding.symbol), 10)) {
      for (const entry of (await this.call('get_equity_fundamentals', { symbols: batch })).results ?? []) {
        if (entry.symbol && entry.sector) sectors[entry.symbol] = entry.sector;
      }
    }
    for (const holding of this.holdings) holding.sector = sectors[holding.symbol];

    // Realized gains are optional; an account without trades just has none.
    let realized = 0;
    const rates: number[] = [];
    for (const account of this.accounts) {
      try {
        const data = await this.call('get_realized_pnl', { account_number: account, span: 'year' });
        realized += number(data.total_returns);
        const rate = Number.parseFloat(data.total_rate_of_return);
        if (Number.isFinite(rate)) rates.push(rate);
      } catch {}
    }
    this.stats.realizedYear = realized;
    this.stats.realizedYearRate = rates.length === 1 ? rates[0] : null;
    this.historyDay = dayString(new Date());
    this.computeStats();
  }

  // Totals

  get equityValue() {
    return this.holdings.reduce((sum, holding) => sum + holding.quantity * holding.price, 0);
  }

  get totalValue() {
    return this.equityValue + this.otherValue;
  }

  private weight(holding: Holding) {
    return this.totalValue > 0 ? (holding.quantity * holding.price) / this.totalValue : 0;
  }

  private computeStats() {
    const quantities: Record<string, number> = {};
    for (const holding of this.holdings) quantities[holding.symbol] = (quantities[holding.symbol] ?? 0) + holding.quantity;
    const held = Object.fromEntries(Object.entries(this.closes).filter(([symbol]) => quantities[symbol] !== undefined));
    const today = startOfToday();
    const lookback = analytics.holdingsLookback(quantities, held);
    // Today's live value as the latest point, counting only the holdings the past points count. History is
    // fetched once a day, so a stock bought since then has no closes yet; adding it only today would look
    // like a jump in value and inflate every return, the volatility and beta.
    if (!lookback.isEmpty && lookback.dates.at(-1)! < today) {
      lookback.dates.push(today);
      lookback.values.push(this.holdings.filter((holding) => held[holding.symbol]?.values.length)
        .reduce((sum, holding) => sum + holding.quantity * holding.price, 0));
    }
    const spySource = this.closes.SPY ?? new Series();
    const spy = new Series([...spySource.dates], [...spySource.values]);
    if (spy.dates.length && spy.dates.at(-1)! < today && this.spyQuote) {
      spy.dates.push(today);
      spy.values.push(this.spyQuote.price);
    }
    this.lookback = lookback;
    this.spy = spy;

    const now = new Date();
    const monthsAgo = (months: number) => new Date(now.getFullYear(), now.getMonth() - months, now.getDate(), now.getHours(), now.getMinutes()).getTime();
    const ranges: [string, number][] = [
      ['1W', now.getTime() - 7 * 86_400_000], ['1M', monthsAgo(1)], ['3M', monthsAgo(3)],
      ['YTD', new Date(now.getFullYear(), 0, 1).getTime()], ['1Y', monthsAgo(12)],
    ];
    const stats = this.stats;
    stats.periods = ranges.map(([label, start]) => ({ label, portfolio: lookback.since(start).totalReturn ?? null,
                                                      spy: spy.since(start).totalReturn ?? null }));
    // Match portfolio and SPY returns by date for beta.
    const spyByDate = new Map(spy.dates.map((date, i) => [date, spy.values[i]]));
    const common = lookback.dates.map((date, i) => [date, lookback.values[i]]).filter(([date]) => spyByDate.has(date));
    const p = new Series(common.map(([date]) => date), common.map(([, value]) => value));
    const m = new Series(p.dates, p.dates.map((date) => spyByDate.get(date)!));
    stats.volatility = analytics.volatility(lookback.returns) ?? null;
    stats.spyVolatility = analytics.volatility(spy.returns) ?? null;
    stats.beta = analytics.beta(p.returns, m.returns) ?? null;
    const drawdowns = analytics.drawdowns(lookback.values);
    stats.maxDrawdown = drawdowns?.max ?? null;
    stats.currentDrawdown = drawdowns?.current ?? null;
    const extremes = analytics.extremes(lookback);
    stats.best = extremes ? { date: new Date(extremes.best[0]).toISOString(), value: extremes.best[1] } : null;
    stats.worst = extremes ? { date: new Date(extremes.worst[0]).toISOString(), value: extremes.worst[1] } : null;
    const concentration = analytics.concentration(this.holdings.map((holding) => this.weight(holding)));
    stats.top1 = concentration?.top1 ?? null;
    stats.top5 = concentration?.top5 ?? null;
    stats.effectiveCount = concentration?.effectiveCount ?? null;
    const sectorWeights = new Map<string, number>();
    for (const holding of this.holdings) {
      const name = sectorName(holding.sector);
      sectorWeights.set(name, (sectorWeights.get(name) ?? 0) + this.weight(holding));
    }
    if (this.otherValue > 0 && this.totalValue > 0) {
      sectorWeights.set('Cash & other', (sectorWeights.get('Cash & other') ?? 0) + this.otherValue / this.totalValue);
    }
    stats.sectors = [...sectorWeights].map(([name, weight]) => ({ name, weight })).sort((a, b) => b.weight - a.weight);
    const values: Record<string, number> = {};
    for (const holding of this.holdings) values[holding.symbol] = (values[holding.symbol] ?? 0) + holding.quantity * holding.price;
    stats.risk = analytics.riskContributions(values, held, this.closes.SPY);
  }

  /** Appends the live total at most every 15 minutes, so the real value history grows over time. */
  private logValue() {
    const total = this.totalValue;
    if (total <= 0) return;
    const last = this.recorded.dates.at(-1);
    if (last && Date.now() - last < 900_000) return;
    const time = Date.now();
    try {
      appendFileSync(logFile, `${JSON.stringify({ time: time / 1000 - SWIFT_EPOCH, total })}\n`);
    } catch {}
    this.recorded.dates.push(time);
    this.recorded.values.push(total);
  }

  /** Everything the apps show. They compute totals and weights from the holdings, as before. */
  snapshot() {
    return {
      connected: this.client.isConnected, error: this.error ?? null, session: this.session,
      lastQuote: this.lastQuote?.toISOString() ?? null, holdings: this.holdings, otherValue: this.otherValue,
      cash: this.cash, buyingPower: this.buyingPower, spyQuote: this.spyQuote ?? null, stats: this.stats,
      lookback: this.lookback, spy: this.spy, recorded: this.recorded,
    };
  }

  /** Compact JSON of everything computed, for the advisor's first message (PortfolioModel.reviewData). */
  reviewData(): string {
    const pct = (value?: number | null) => (value === undefined || value === null ? null : Math.round(value * 10000) / 100);
    const dayChange = this.holdings.reduce((sum, h) => sum + h.quantity * (h.price - h.previousClose), 0);
    const start = this.totalValue - dayChange;
    const cost = this.holdings.reduce((sum, h) => sum + h.quantity * h.averageCost, 0);
    const unrealized = this.equityValue - cost;
    const s = this.stats;
    return JSON.stringify({
      as_of: clockText(), total_value: Math.round(this.totalValue), stocks_value: Math.round(this.equityValue),
      cash_and_other: Math.round(this.otherValue), day_change: Math.round(dayChange), day_change_pct: pct(start > 0 ? dayChange / start : null),
      unrealized_gain: Math.round(unrealized), unrealized_pct: pct(cost > 0 ? unrealized / cost : null),
      realized_gain_past_year: s.realizedYear === undefined ? null : Math.round(s.realizedYear),
      returns_pct_current_holdings_vs_spy: (s.periods ?? []).map((period: any) => ({ period: period.label, portfolio: pct(period.portfolio), spy: pct(period.spy) })),
      annual_volatility_pct: pct(s.volatility), spy_volatility_pct: pct(s.spyVolatility),
      beta_vs_spy: s.beta === null || s.beta === undefined ? null : Math.round(s.beta * 100) / 100,
      max_drawdown_pct: pct(s.maxDrawdown), current_drawdown_pct: pct(s.currentDrawdown),
      largest_position_pct: pct(s.top1), top5_pct: pct(s.top5),
      effective_number_of_positions: s.effectiveCount === null || s.effectiveCount === undefined ? null : Math.round(s.effectiveCount * 10) / 10,
      sectors_pct: (s.sectors ?? []).map((sector: any) => ({ sector: sector.name, weight: pct(sector.weight) })),
      holdings: this.holdings.map((h) => {
        const risk = s.risk?.[h.symbol];
        const cost = h.quantity * h.averageCost;
        return { symbol: h.symbol, weight_pct: pct(this.weight(h)), unrealized_pct: pct(cost > 0 ? (h.quantity * h.price - cost) / cost : null),
                 day_pct: pct(h.previousClose > 0 ? h.price / h.previousClose - 1 : null), sector: sectorName(h.sector),
                 risk_contribution_pct: pct(risk?.contribution), volatility_pct: pct(risk?.volatility),
                 beta: risk?.beta === undefined ? null : Math.round(risk.beta * 100) / 100 };
      }),
    });
  }
}

/** Robinhood files most ETFs and funds under "Miscellaneous". */
function sectorName(sector?: string) {
  if (!sector) return 'Other';
  return sector === 'Miscellaneous' ? 'Funds & ETFs' : sector;
}

/** Regular session 9:30–4:00 ET on weekdays; extended 4:00–9:30 and 4:00–8:00 PM. */
export function marketSession(date = new Date()): MarketSession {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false })
    .formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  if (['Sat', 'Sun'].includes(get('weekday'))) return 'closed';
  const minutes = (Number(get('hour')) % 24) * 60 + Number(get('minute'));
  if (minutes >= 570 && minutes < 960) return 'regular';
  if ((minutes >= 240 && minutes < 570) || (minutes >= 960 && minutes < 1200)) return 'extended';
  return 'closed';
}

function readLog(): Series {
  try {
    const entries = readFileSync(logFile, 'utf8').split('\n').flatMap((line) => {
      try {
        const entry = JSON.parse(line);
        return typeof entry.time === 'number' && typeof entry.total === 'number' ? [entry] : [];
      } catch {
        return [];
      }
    });
    return new Series(entries.map((entry) => (entry.time + SWIFT_EPOCH) * 1000), entries.map((entry) => entry.total));
  } catch {
    return new Series();
  }
}

function number(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function chunks<T>(items: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, i * size + size));
}

/** "2026-10-12" as local midnight (the hub runs on Eastern time). */
function localDay(text: string): number | undefined {
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime() : undefined;
}

function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function dayString(date: Date) {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
}
