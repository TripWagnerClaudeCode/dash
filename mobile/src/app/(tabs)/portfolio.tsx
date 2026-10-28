import { type Href, router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Line, Polyline } from 'react-native-svg';

import { Card, ConnectionLine, ErrorText, Muted, SmallButton, styles as ui } from '@/components/ui';
import { MaxContentWidth, Radius, Spacing } from '@/constants/theme';
import { ADVISOR_ID } from '@/lib/chats';
import type { HoldingJSON, PortfolioSnapshot, SeriesJSON } from '@/lib/hub';
import { useHub } from '@/lib/hub-context';
import { useTheme } from '@/hooks/use-theme';

const RANGES = [['1M', 31], ['3M', 92], ['YTD', 0], ['1Y', 366]] as const;

/**
 * The Robinhood portfolio, from the hub: live value and day change against SPY, today's holdings over
 * the past year next to SPY, returns by period, risk numbers, and holdings. Read-only; the hub can't
 * trade. Prices update every 15 s while this tab is open in market hours.
 */
export default function PortfolioScreen() {
  const { client, state, ready } = useHub();
  const theme = useTheme();
  const [portfolio, setPortfolio] = useState<PortfolioSnapshot>();
  const [range, setRange] = useState<(typeof RANGES)[number][0]>('1Y');
  const [refreshing, setRefreshing] = useState(false);
  const online = state === 'online';

  useEffect(() => client.on('portfolio', setPortfolio), [client]);

  // Watching while the tab is on screen makes the hub poll fast; leaving it slows polling down again.
  useFocusEffect(useCallback(() => {
    if (!online) return;
    client.request<PortfolioSnapshot>('portfolio.watch', { on: true }).then(setPortfolio).catch(() => {});
    return () => {
      client.request('portfolio.watch', { on: false }).catch(() => {});
    };
  }, [client, online]));

  async function refresh() {
    if (!online) return client.reconnectNow();
    setRefreshing(true);
    await client.request('portfolio.refresh').catch(() => {});
    setRefreshing(false);
  }

  const totals = useMemo(() => (portfolio ? summarize(portfolio) : undefined), [portfolio]);

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: theme.background }}>
      <ScrollView contentContainerStyle={styles.page} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}>
        <View style={{ gap: 4 }}>
          <Text style={[styles.title, { color: theme.text }]}>Portfolio</Text>
          {ready ? <ConnectionLine /> : null}
        </View>

        {portfolio && !portfolio.connected ? (
          <Card title="Robinhood" icon="link">
            <Muted>Connect Robinhood once from the Portfolio page in Dash on your Mac. After that it updates here too.</Muted>
          </Card>
        ) : null}
        {portfolio?.error ? <ErrorText>{portfolio.error}</ErrorText> : null}

        {portfolio?.connected && totals ? (
          <>
            <View style={{ gap: 2 }}>
              <Text style={[styles.value, { color: theme.text }]}>{money(totals.total)}</Text>
              <Text style={[ui.body, { color: tint(totals.dayChange, theme), fontWeight: '600' }]}>
                {signedMoney(totals.dayChange)} ({percent(totals.dayPercent)}) today
              </Text>
              <Muted style={{ fontSize: 13 }}>
                {portfolio.spyQuote ? `S&P 500 ${percent(portfolio.spyQuote.price / portfolio.spyQuote.previousClose - 1)} · ` : ''}
                {portfolio.session === 'regular' ? 'Market open' : portfolio.session === 'extended' ? 'Extended hours' : 'Market closed'}
                {portfolio.lastQuote ? ` · prices from ${new Date(portfolio.lastQuote).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : ''}
              </Muted>
            </View>

            <Card title="Holdings vs. S&P 500" icon="chart.line.uptrend.xyaxis"
                  action={<View style={{ flexDirection: 'row', gap: 4 }}>
                    {RANGES.map(([label]) => (
                      <Pressable key={label} onPress={() => setRange(label)} hitSlop={6}
                                 style={[styles.chip, { backgroundColor: range === label ? theme.field : 'transparent' }]}>
                        <Text style={[ui.caption, { color: range === label ? theme.text : theme.textSecondary, fontWeight: '600' }]}>{label}</Text>
                      </Pressable>
                    ))}
                  </View>}>
              <Chart mine={portfolio.lookback} spy={portfolio.spy} range={range} />
              <Muted style={{ fontSize: 12 }}>Today&apos;s holdings valued at past prices (not your actual account history).</Muted>
            </Card>

            <Card title="Returns" icon="percent">
              {(portfolio.stats.periods ?? []).map((period) => (
                <View key={period.label} style={styles.statRow}>
                  <Text style={[ui.body, { color: theme.text, width: 44 }]}>{period.label}</Text>
                  <Text style={[ui.body, { color: tint(period.portfolio, theme), flex: 1, fontVariant: ['tabular-nums'] }]}>{percent(period.portfolio)}</Text>
                  <Text style={[ui.caption, { color: theme.textSecondary, fontVariant: ['tabular-nums'] }]}>S&amp;P {percent(period.spy)}</Text>
                </View>
              ))}
            </Card>

            <Card title="Risk" icon="shield.lefthalf.filled">
              <Stat label="Unrealized gain" value={`${signedMoney(totals.unrealized)} (${percent(totals.cost > 0 ? totals.unrealized / totals.cost : null)})`} />
              <Stat label="Volatility (yearly)" value={`${percent(portfolio.stats.volatility, false)} · S&P ${percent(portfolio.stats.spyVolatility, false)}`} />
              <Stat label="Beta vs. S&P 500" value={portfolio.stats.beta?.toFixed(2) ?? '–'} />
              <Stat label="Worst drop (1 yr)" value={percent(portfolio.stats.maxDrawdown)} />
              <Stat label="Largest position" value={percent(portfolio.stats.top1, false)} />
              <Stat label="Acts like" value={portfolio.stats.effectiveCount ? `${portfolio.stats.effectiveCount.toFixed(1)} equal positions` : '–'} />
              {portfolio.stats.realizedYear !== undefined && portfolio.stats.realizedYear !== null ? (
                <Stat label="Realized (past year)" value={signedMoney(portfolio.stats.realizedYear)} />
              ) : null}
            </Card>

            <Card title={`Holdings (${portfolio.holdings.length})`} icon="list.bullet.rectangle">
              {portfolio.holdings.map((holding) => (
                <HoldingRow key={holding.symbol} holding={holding} total={totals.total}
                            risk={portfolio.stats.risk?.[holding.symbol]?.contribution} />
              ))}
            </Card>

            <Card title="Advisor" icon="person.crop.circle.badge.questionmark">
              <Muted>Talk it through with your risk-manager advisor. It can read Robinhood and the web, and never trades.</Muted>
              <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
                <SmallButton title="Open advisor" onPress={() => router.push(`/chat/${ADVISOR_ID}?advisor=1` as Href)} disabled={!online} />
              </View>
            </Card>
          </>
        ) : null}
        {!portfolio && online ? <Muted>Loading…</Muted> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <View style={styles.statRow}>
      <Text style={[ui.body, { color: theme.textSecondary, flex: 1 }]}>{label}</Text>
      <Text style={[ui.body, { color: theme.text, fontVariant: ['tabular-nums'] }]}>{value}</Text>
    </View>
  );
}

function HoldingRow({ holding, total, risk }: { holding: HoldingJSON; total: number; risk?: number }) {
  const theme = useTheme();
  const value = holding.quantity * holding.price;
  const cost = holding.quantity * holding.averageCost;
  const day = holding.previousClose > 0 ? holding.price / holding.previousClose - 1 : null;
  return (
    <View style={styles.holding}>
      <View style={{ flex: 1, gap: 1 }}>
        <Text style={[ui.body, { color: theme.text, fontWeight: '600' }]}>{holding.symbol}</Text>
        <Text style={[ui.caption, { color: theme.textSecondary }]}>
          {percent(total > 0 ? value / total : null, false)} of portfolio{risk !== undefined ? ` · ${percent(risk, false)} of risk` : ''}
        </Text>
      </View>
      <View style={{ alignItems: 'flex-end', gap: 1 }}>
        <Text style={[ui.body, { color: theme.text, fontVariant: ['tabular-nums'] }]}>{money(value)}</Text>
        <Text style={[ui.caption, { color: tint(day, theme), fontVariant: ['tabular-nums'] }]}>
          {percent(day)} today · {percent(cost > 0 ? value / cost - 1 : null)} total
        </Text>
      </View>
    </View>
  );
}

/** Both lines start at 100 at the start of the range, so they compare directly. */
function Chart({ mine, spy, range }: { mine: SeriesJSON; spy: SeriesJSON; range: string }) {
  const theme = useTheme();
  const { width: screen } = useWindowDimensions();
  const width = Math.min(screen, MaxContentWidth) - Spacing.l * 4;
  const height = 160;
  const [now] = useState(() => Date.now());
  const start = range === 'YTD' ? new Date(new Date(now).getFullYear(), 0, 1).getTime()
    : now - (RANGES.find(([label]) => label === range)?.[1] ?? 366) * 86_400_000;
  const lines = [indexed(mine, start), indexed(spy, start)];
  const all = lines.flat().map((point) => point[1]);
  if (lines[0].length < 2) return <Muted>Not enough history yet.</Muted>;
  const min = Math.min(...all);
  const max = Math.max(...all);
  const first = lines[0][0][0];
  const last = Math.max(...lines.map((line) => line.at(-1)?.[0] ?? first));
  const x = (t: number) => ((t - first) / Math.max(last - first, 1)) * width;
  const y = (v: number) => height - ((v - min) / Math.max(max - min, 1e-9)) * height;
  const points = (line: [number, number][]) => line.map(([t, v]) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const mineUp = (lines[0].at(-1)?.[1] ?? 100) >= 100;
  return (
    <View style={{ gap: Spacing.s }}>
      <Svg width={width} height={height}>
        <Line x1={0} x2={width} y1={y(100)} y2={y(100)} stroke={theme.separator} strokeDasharray="3 4" />
        <Polyline points={points(lines[1])} fill="none" stroke={theme.textSecondary} strokeWidth={1.5} />
        <Polyline points={points(lines[0])} fill="none" stroke={mineUp ? theme.green : theme.red} strokeWidth={2.5} />
      </Svg>
      <View style={{ flexDirection: 'row', gap: Spacing.l }}>
        <Legend color={mineUp ? theme.green : theme.red} label={`Your holdings ${percent((lines[0].at(-1)?.[1] ?? 100) / 100 - 1)}`} />
        <Legend color={theme.textSecondary} label={`S&P 500 ${percent((lines[1].at(-1)?.[1] ?? 100) / 100 - 1)}`} />
      </View>
    </View>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <View style={{ width: 12, height: 3, borderRadius: 2, backgroundColor: color }} />
      <Text style={[ui.caption, { color: theme.textSecondary }]}>{label}</Text>
    </View>
  );
}

function indexed(series: SeriesJSON, start: number): [number, number][] {
  const points = series.dates.map((date, i): [number, number] => [Date.parse(date), series.values[i]]).filter(([t]) => t >= start);
  const base = points[0]?.[1];
  return base ? points.map(([t, v]) => [t, (v / base) * 100]) : [];
}

function summarize(portfolio: PortfolioSnapshot) {
  const equity = portfolio.holdings.reduce((sum, h) => sum + h.quantity * h.price, 0);
  const total = equity + portfolio.otherValue;
  const dayChange = portfolio.holdings.reduce((sum, h) => sum + h.quantity * (h.price - h.previousClose), 0);
  const cost = portfolio.holdings.reduce((sum, h) => sum + h.quantity * h.averageCost, 0);
  const start = total - dayChange;
  return { total, dayChange, dayPercent: start > 0 ? dayChange / start : null, unrealized: equity - cost, cost };
}

function money(value: number) {
  return value.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: value >= 1000 ? 0 : 2 });
}

function signedMoney(value: number) {
  return `${value >= 0 ? '+' : '−'}${money(Math.abs(value))}`;
}

function percent(value: number | null | undefined, signed = true) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '–';
  const text = `${Math.abs(value * 100).toFixed(Math.abs(value) < 0.1 ? 2 : 1)}%`;
  return signed ? `${value >= 0 ? '+' : '−'}${text}` : text;
}

function tint(value: number | null | undefined, theme: ReturnType<typeof useTheme>) {
  if (value === null || value === undefined || value === 0) return theme.textSecondary;
  return value > 0 ? theme.green : theme.red;
}

const styles = StyleSheet.create({
  page: { padding: Spacing.l, gap: Spacing.l, maxWidth: MaxContentWidth, width: '100%', alignSelf: 'center' },
  title: { fontSize: 34, fontWeight: '700' },
  value: { fontSize: 40, fontWeight: '700', fontVariant: ['tabular-nums'] },
  chip: { borderRadius: Radius.control, paddingHorizontal: 7, paddingVertical: 2 },
  statRow: { flexDirection: 'row', alignItems: 'baseline', gap: Spacing.s },
  holding: { flexDirection: 'row', alignItems: 'center', gap: Spacing.m, paddingVertical: 4 },
});
