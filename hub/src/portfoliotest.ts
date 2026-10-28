/**
 * `npm run portfoliotest`: Portfolio with a fake Robinhood (made-up holdings, no network): the read-only
 * rules, the advisor relay's refusals, merging positions across accounts, quotes, a year of history,
 * the statistics, and reading Mac Dash's recorded-value log.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const data = mkdtempSync(join(tmpdir(), 'dash-portfolio-test-'));
process.env.DASH_DATA = data;
process.env.TZ ??= 'America/New_York';

// A day of Mac Dash's log: Swift's JSONEncoder writes dates as seconds since 2001-01-01.
mkdirSync(join(data, 'portfolio'), { recursive: true });
const swiftNow = Date.now() / 1000 - 978_307_200;
writeFileSync(join(data, 'portfolio/history.jsonl'), `{"time":${swiftNow - 7200},"total":41000}\n{"time":${swiftNow - 3600},"total":41250.5}\n`);

const { isReadOnly } = await import('./portfolio/robinhood.ts');
const { RobinhoodRelay } = await import('./portfolio/relay.ts');
const { Portfolio, marketSession } = await import('./portfolio/portfolio.ts');

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `: ${detail}`}`);
  if (!ok) failures += 1;
}

// Read-only rules.
check('reads are allowed', isReadOnly('get_equity_quotes') && isReadOnly('get_portfolio'));
check('orders are refused', !isReadOnly('place_equity_order') && !isReadOnly('cancel_order') && !isReadOnly('get_orders')
      && !isReadOnly('get_order_approvals') && !isReadOnly('GET_EQUITY_QUOTES'));

// A fake Robinhood: two accounts, overlapping AAPL, a year of rising closes.
const days = 260;
const bars = (start: number, step: number) => Array.from({ length: days }, (_, i) => {
  const date = new Date(Date.now() - (days - i) * 86_400_000);
  const wobble = Math.sin(i / 7) * start * 0.02;
  return { begins_at: `${date.toISOString().slice(0, 10)}T00:00:00Z`, close_price: String(start + step * i + wobble) };
});
const calls: string[] = [];
const accountsRead: string[] = [];
/** Positions bought after the day's history was fetched. */
const boughtToday: { symbol: string; quantity: string; average_buy_price: string }[] = [];
const fake = {
  isConnected: true,
  disconnect() {},
  async readToolDefinitions() {
    return [{ name: 'get_portfolio', inputSchema: {} }];
  },
  async call(tool: string, args: Record<string, any> = {}) {
    calls.push(tool);
    if (args.account_number) accountsRead.push(args.account_number);
    const reply = (value: unknown) => JSON.stringify({ data: value });
    switch (tool) {
      case 'get_accounts': return reply({ accounts: [{ account_number: 'A1' }, { account_number: 'A2' }, { account_number: 'OLD', deactivated: true }] });
      case 'get_portfolio': return reply(args.account_number === 'A1'
        ? { total_value: '10500', equity_value: '10000', cash: '500', buying_power: { buying_power: '500' } }
        : { total_value: '6000', equity_value: '6000', cash: '0', buying_power: { buying_power: '0' } });
      case 'get_equity_positions': return reply({ positions: args.account_number === 'A1'
        ? [{ symbol: 'AAPL', quantity: '10', average_buy_price: '150' }, { symbol: 'MSFT', quantity: '5', average_buy_price: '300' }]
        : [{ symbol: 'AAPL', quantity: '10', average_buy_price: '170' }, { symbol: 'ZERO', quantity: '0', average_buy_price: '1' }, ...boughtToday] });
      case 'get_equity_quotes': return reply({ results: (args.symbols as string[]).map((symbol) => ({ quote: {
        symbol, last_trade_price: { AAPL: '200', MSFT: '400', SPY: '600', NEW: '1000' }[symbol] ?? '1',
        previous_close: { AAPL: '198', MSFT: '404', SPY: '597', NEW: '990' }[symbol] ?? '1',
      } })) });
      case 'get_equity_historicals': return reply({ results: (args.symbols as string[]).map((symbol) => ({
        symbol, bars: bars({ AAPL: 150, MSFT: 300, SPY: 450 }[symbol] ?? 1, { AAPL: 0.2, MSFT: 0.35, SPY: 0.5 }[symbol] ?? 0),
      })) });
      case 'get_equity_fundamentals': return reply({ results: [{ symbol: 'AAPL', sector: 'Technology' }, { symbol: 'MSFT', sector: 'Miscellaneous' }] });
      case 'get_realized_pnl': return reply({ total_returns: args.account_number === 'A1' ? '120' : '30', total_rate_of_return: '0.05' });
      default: throw new Error(`unexpected ${tool}`);
    }
  },
};

// The relay: refuses strangers and order tools, lists only reads, forwards reads.
const relay = new RobinhoodRelay(fake as any);
const entry = await relay.start() as { url: string; headers: { Authorization: string } };
const rpc = (body: unknown, auth = entry.headers.Authorization) =>
  fetch(entry.url, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
check('the relay refuses a request without its secret', (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'Bearer nope')).status === 401);
const order = await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'place_equity_order', arguments: {} } })).json();
check('the relay refuses order tools', order.result?.isError === true && !calls.includes('place_equity_order'));
const read = await (await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_portfolio', arguments: { account_number: 'A1' } } })).json();
check('the relay forwards reads', read.result?.content?.[0]?.text.includes('10500'));
relay.stop();

// The model, refreshed once.
const portfolio = new Portfolio(fake as any);
portfolio.watch(true);
const deadline = Date.now() + 10_000;
while (!portfolio.stats.risk && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
const snapshot = JSON.parse(JSON.stringify(portfolio.snapshot()));
const aapl = snapshot.holdings.find((holding: any) => holding.symbol === 'AAPL');
check('merges a symbol held in two accounts', aapl?.quantity === 20 && Math.abs(aapl.averageCost - 160) < 1e-9, JSON.stringify(aapl));
check('skips empty positions and closed accounts', !snapshot.holdings.some((h: any) => h.symbol === 'ZERO') && !accountsRead.includes('OLD'));
check('cash and other value come from account totals', snapshot.otherValue === 500 && snapshot.cash === 500);
check('live prices and SPY', aapl?.price === 200 && snapshot.spyQuote?.price === 600);
check('sectors, with Miscellaneous shown as funds', snapshot.stats.sectors.some((s: any) => s.name === 'Funds & ETFs') && aapl?.sector === 'Technology');
check('a year of history for the chart', snapshot.lookback.values.length > 200 && snapshot.spy.values.length > 200);
const year = snapshot.stats.periods.find((p: any) => p.label === '1Y');
check('period returns against SPY', typeof year?.portfolio === 'number' && typeof year?.spy === 'number' && year.portfolio > 0, JSON.stringify(year));
check('volatility, beta and drawdown', snapshot.stats.volatility > 0 && snapshot.stats.beta !== null && snapshot.stats.maxDrawdown <= 0);
const risk = snapshot.stats.risk;
const shares = Object.values(risk).reduce((sum: number, r: any) => sum + r.contribution, 0);
check('risk contributions add up to 100%', Math.abs(shares - 1) < 1e-6, JSON.stringify(risk));
check('realized gains summed across accounts', snapshot.stats.realizedYear === 150);
check("reads Mac Dash's recorded values", snapshot.recorded.values[0] === 41000 && snapshot.recorded.values[1] === 41250.5
      && Math.abs(Date.parse(snapshot.recorded.dates[0]) - (Date.now() - 7_200_000)) < 5000, JSON.stringify(snapshot.recorded.dates[0]));
const review = JSON.parse(portfolio.reviewData());
check('the advisor snapshot has every holding', review.holdings.length === 2 && review.total_value > 0);
check('only read tools were called', calls.every((tool) => isReadOnly(tool)));
check('market hours: a Saturday is closed', marketSession(new Date('2026-10-31T15:00:00Z')) === 'closed'
      && marketSession(new Date('2026-10-27T15:00:00Z')) === 'regular');

// Buying a new stock today: positions refresh, the day's history doesn't, so the new stock has no past
// closes yet. It must not show up as a jump in today's value.
const periodsBefore = JSON.stringify(portfolio.stats.periods);
const volatilityBefore = portfolio.stats.volatility;
const betaBefore = portfolio.stats.beta;
boughtToday.push({ symbol: 'NEW', quantity: '50', average_buy_price: '1000' });
(portfolio as any).positionsAt = undefined;
portfolio.watch(false);
portfolio.watch(true);
const boughtBy = Date.now() + 10_000;
while (!portfolio.holdings.some((holding) => holding.symbol === 'NEW' && holding.price === 1000) && Date.now() < boughtBy) {
  await new Promise((resolve) => setTimeout(resolve, 50));
}
await new Promise((resolve) => setTimeout(resolve, 100));
check('a stock bought today shows in the holdings', portfolio.holdings.some((holding) => holding.symbol === 'NEW' && holding.price === 1000));
check("a stock bought today doesn't move past returns, volatility or beta", JSON.stringify(portfolio.stats.periods) === periodsBefore
      && portfolio.stats.volatility === volatilityBefore && portfolio.stats.beta === betaBefore,
      `${periodsBefore} → ${JSON.stringify(portfolio.stats.periods)}`);
check('the new stock still counts toward weights', JSON.parse(portfolio.reviewData()).holdings.some((h: any) => h.symbol === 'NEW' && h.weight_pct > 50));
boughtToday.length = 0;
portfolio.watch(false);
portfolio.disconnect();

// Signing in again after an expired token, against a fake Robinhood (no network).
const { RobinhoodClient } = await import('./portfolio/robinhood.ts');
const secrets = join(data, 'secrets');
mkdirSync(secrets, { recursive: true });
writeFileSync(join(secrets, 'robinhood-client.json'), JSON.stringify({ id: 'test-client' }));
let tokenMode: 'ok' | 'network' | 'refused' = 'ok';
let renewals = 0;
let issued = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  const address = String(url);
  if (address.includes('/oauth2/token/')) {
    renewals += 1;
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (tokenMode === 'network') throw new TypeError('fetch failed');
    if (tokenMode === 'refused') return new Response('{"error":"invalid_grant"}', { status: 400 });
    issued += 1;
    return new Response(JSON.stringify({ access_token: `fresh-${issued}`, refresh_token: `r-${issued}`, expires_in: 3600 }), { status: 200 });
  }
  const auth = String((init?.headers as Record<string, string>)?.Authorization ?? '');
  if (!auth.startsWith('Bearer fresh-')) return new Response('', { status: 401 });
  const message = JSON.parse(String(init?.body));
  if (message.id === undefined) return new Response('', { status: 202 });
  const result = message.method === 'initialize' ? { protocolVersion: '2025-06-18' } : { content: [{ type: 'text', text: '{"data":{"accounts":[]}}' }] };
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }),
                      { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 'session-1' } });
}) as typeof fetch;
const expired = () => writeFileSync(join(secrets, 'robinhood.json'), JSON.stringify({ access: 'stale', refresh: 'r-0' }));

expired();
let rh = new RobinhoodClient();
const afterRestart = await rh.call('get_accounts').then(() => true, (error) => error.message);
check('renews an expired token found by the first handshake after a restart', afterRestart === true && renewals === 1, String(afterRestart));

expired();
renewals = 0;
rh = new RobinhoodClient();
const both = await Promise.all([rh.call('get_accounts'), rh.call('get_portfolio', { account_number: 'A1' })]).then(() => true, (error) => error.message);
check('two requests hitting an expired token share one renewal', both === true && renewals === 1, `${both} renewals=${renewals}`);

expired();
tokenMode = 'network';
rh = new RobinhoodClient();
const offline = await rh.call('get_accounts').then(() => undefined, (error) => error);
check('a network failure while renewing keeps the sign-in', offline && !offline.auth && rh.isConnected
      && existsSync(join(secrets, 'robinhood.json')), offline?.message);

tokenMode = 'refused';
const refused = await rh.call('get_accounts').then(() => undefined, (error) => error);
check('Robinhood refusing the renewal signs out', refused?.auth === true && !rh.isConnected && !existsSync(join(secrets, 'robinhood.json')),
      refused?.message);
globalThis.fetch = realFetch;

// Opening Portfolio while a slow background check runs gets fast polling straight after it.
let quoteCalls = 0;
const slow = { ...fake, async call(tool: string, args: Record<string, any> = {}) {
  if (tool === 'get_equity_quotes') {
    quoteCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return fake.call(tool, args);
} };
const background = new Portfolio(slow as any);
background.start();
await new Promise((resolve) => setTimeout(resolve, 100));
background.watch(true);
await new Promise((resolve) => setTimeout(resolve, 2000));
check('a watcher arriving mid-check gets a refresh right after it', quoteCalls >= 2, `quote calls: ${quoteCalls}`);
background.watch(false);
background.disconnect();

rmSync(data, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : '\nAll portfolio checks passed');
process.exit(failures ? 1 : 0);
