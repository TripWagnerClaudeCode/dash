import { type Href, router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Card, ConnectionLine, ErrorText, Markdown, Muted, SmallButton, styles as ui } from '@/components/ui';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import type { CalendarEvent, Deadline, Load } from '@/lib/hub';
import { useHub } from '@/lib/hub-context';
import { useTheme } from '@/hooks/use-theme';

export default function TodayScreen() {
  const { ready, state, today, client, problem, health } = useHub();
  const theme = useTheme();
  const [refreshing, setRefreshing] = useState(false);

  // Ask the hub for fresh data whenever the phone signs in (it refreshes only if it's been 10 minutes).
  useEffect(() => {
    if (state === 'online') client.request('today.get').catch(() => {});
  }, [state, client]);

  async function refresh() {
    if (state !== 'online') {
      client.reconnectNow();
      return;
    }
    setRefreshing(true);
    await client.request('today.refresh').catch(() => {});
    setRefreshing(false);
  }

  const weather = today?.weather.state === 'loaded' ? today.weather.value : undefined;

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: theme.background }}>
      <ScrollView
        contentContainerStyle={styles.page}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
        keyboardShouldPersistTaps="handled">
        <View style={{ gap: 4 }}>
          <Text style={[styles.date, { color: theme.textSecondary }]}>
            {new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text style={[styles.title, { color: theme.text, flex: 1 }]}>Today</Text>
            <Pressable onPress={() => router.push('/settings' as Href)} hitSlop={10} accessibilityLabel="Settings">
              <SymbolView name="gear" size={24} tintColor={theme.accent} />
            </Pressable>
          </View>
          {weather ? (
            <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
              <SymbolView name="cloud.sun" size={16} tintColor={theme.textSecondary} />
              <Muted style={{ flex: 1 }}>{weather}</Muted>
            </View>
          ) : null}
          {ready ? <ConnectionLine /> : null}
        </View>

        {ready && state === 'unpaired' ? (
          <Card title="Connect to Dash" icon="laptopcomputer.and.iphone">
            <Muted>
              Open Dash on your Mac, go to Settings › Pair a Phone, and scan the code it shows.
            </Muted>
            {problem ? <ErrorText>{problem}</ErrorText> : null}
            <SmallButton title="Pair" onPress={() => router.push('/pair')} />
          </Card>
        ) : null}

        {health?.problems.length ? (
          <Card title="Needs attention" icon="exclamationmark.triangle">
            {health.problems.map((item) => <Text key={item.key} style={[ui.body, { color: theme.orange }]}>{item.text}</Text>)}
          </Card>
        ) : null}

        {today || state === 'online' ? (
          <>
            <BriefCard />
            <DeadlinesCard />
            <ToDoCard />
            <CalendarCard events={today?.events} />
            <InboxCard />
            <UsageCard />
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function BriefCard() {
  const { today, client, state } = useHub();
  const [error, setError] = useState<string>();
  const brief = today?.brief;
  const hasText = !!brief?.text;

  function generate() {
    setError(undefined);
    client.request('today.brief').catch((failure: Error) => setError(failure.message));
  }

  return (
    <Card
      title="Daily brief"
      icon="sparkles"
      action={
        <SmallButton
          title={hasText ? 'Rewrite' : 'Brief me'}
          onPress={generate}
          busy={brief?.busy}
          disabled={state !== 'online' || !brief?.canBrief}
        />
      }>
      {hasText ? (
        brief!.isError ? <ErrorText>{brief!.text}</ErrorText> : <Markdown text={brief!.text} />
      ) : (
        <Muted>Your week at a glance, written from your calendar, to-dos, weather, and inbox.</Muted>
      )}
      {error ? <ErrorText>{error}</ErrorText> : null}
    </Card>
  );
}

/**
 * Exams and due dates Dash tracks (from the calendar, new syllabi and chats); these drive the phone's
 * reminders. Tap one for Done / Remove; dates from a syllabus ask for a Confirm first.
 */
function DeadlinesCard() {
  const { deadlines, client, state } = useHub();
  const theme = useTheme();
  const [error, setError] = useState<string>();
  const items = deadlines?.items ?? [];
  const shown = items.slice(0, 8);

  function change(type: string, item: Deadline) {
    setError(undefined);
    client.request(type, { item: item.id }).catch((failure: Error) => setError(failure.message));
  }

  function actions(item: Deadline) {
    if (state !== 'online') return;
    const name = `${item.course ? `${item.course} ` : ''}${item.title}`;
    Alert.alert(name, `${item.exam ? 'Exam' : 'Due'} ${dueText(item.due)}`, [
      ...(item.confirmed ? [] : [{ text: 'Confirm', onPress: () => change('deadlines.confirm', item) }]),
      ...(item.confirmed && !item.exam ? [{ text: 'Done', onPress: () => change('deadlines.done', item) }] : []),
      { text: 'Remove', style: 'destructive' as const, onPress: () => change('deadlines.dismiss', item) },
      { text: 'Cancel', style: 'cancel' as const },
    ]);
  }

  return (
    <Card title="Deadlines" icon="alarm">
      {items.length === 0 ? <Muted>Nothing due. Dash picks up exams and due dates from your calendar, new syllabi and your chats.</Muted> : null}
      {shown.map((item) => {
        const soon = Date.parse(item.due) - Date.now() < 36 * 3_600_000;
        return (
          <Pressable key={item.id} onPress={() => actions(item)} style={styles.deadlineRow}>
            <Text style={[ui.caption, styles.deadlineWhen, { color: soon ? theme.orange : theme.textSecondary }]}>{dueText(item.due)}</Text>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={[ui.body, { color: theme.text }]}>
                {item.exam ? 'Exam: ' : ''}{item.course ? `${item.course} · ` : ''}{item.title}
              </Text>
              {!item.confirmed ? <Muted style={{ fontSize: 13 }}>From the {item.source ?? 'syllabus'}. Tap to confirm.</Muted> : null}
            </View>
          </Pressable>
        );
      })}
      {items.length > shown.length ? <Muted>and {items.length - shown.length} more</Muted> : null}
      {error ? <ErrorText>{error}</ErrorText> : null}
    </Card>
  );
}

/** "Today 11:59 PM", "Tomorrow 9:40 AM", "Fri 12:00 PM", "Nov 18". */
function dueText(due: string) {
  const date = new Date(due);
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const days = Math.round((new Date(date).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86_400_000);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  if (days > 1 && days < 6) return `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Checking an item crosses it out for a moment (tap again to keep it), then removes it on both devices. */
function ToDoCard() {
  const { todo, client, state } = useHub();
  const theme = useTheme();
  const [draft, setDraft] = useState('');
  const [checking, setChecking] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const online = state === 'online';

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  function add() {
    const text = draft.trim();
    if (!text) return;
    setError(undefined);
    client
      .request('todo.add', { text })
      .then(() => setDraft(''))
      .catch((failure: Error) => setError(failure.message));
  }

  function toggle(text: string) {
    const timer = timers.current.get(text);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(text);
      setChecking((items) => items.filter((item) => item !== text));
      return;
    }
    setChecking((items) => [...items, text]);
    timers.current.set(
      text,
      setTimeout(() => {
        timers.current.delete(text);
        client
          .request('todo.remove', { text })
          .catch((failure: Error) => setError(failure.message))
          .finally(() => setChecking((items) => items.filter((item) => item !== text)));
      }, 1500),
    );
  }

  const items = todo?.items ?? [];
  return (
    <Card title="To-do" icon="checklist">
      {items.length === 0 ? <Muted>Nothing on your list.</Muted> : null}
      {items.map((text, index) => {
        const checked = checking.includes(text);
        return (
          <Pressable key={`${index}-${text}`} onPress={() => toggle(text)} disabled={!online} style={styles.todoRow}>
            <SymbolView
              name={checked ? 'checkmark.circle.fill' : 'circle'}
              size={22}
              tintColor={checked ? theme.green : theme.textSecondary}
            />
            <Text
              style={[
                ui.body,
                { color: checked ? theme.textSecondary : theme.text, flex: 1 },
                checked && { textDecorationLine: 'line-through' },
              ]}>
              {text}
            </Text>
          </Pressable>
        );
      })}
      <TextInput
        value={draft}
        onChangeText={setDraft}
        onSubmitEditing={add}
        submitBehavior="submit"
        returnKeyType="done"
        editable={online}
        placeholder={online ? 'Add a to-do' : 'Connect to Dash to edit'}
        placeholderTextColor={theme.textSecondary}
        style={[ui.body, styles.input, { backgroundColor: theme.field, color: theme.text }]}
      />
      {error ? <ErrorText>{error}</ErrorText> : null}
    </Card>
  );
}

function CalendarCard({ events }: { events?: Load<CalendarEvent[]> }) {
  const theme = useTheme();
  const days = groupByDay(events?.state === 'loaded' ? events.value : []);
  return (
    <Card title="Next 7 days" icon="calendar">
      <LoadState load={events} empty={days.length === 0 ? 'Nothing on your calendar this week.' : undefined} />
      {days.map(({ label, items }) => (
        <View key={label} style={{ gap: 6 }}>
          <Text style={[styles.dayLabel, { color: theme.textSecondary }]}>{label}</Text>
          {items.map((event) => (
            <View key={event.id} style={styles.eventRow}>
              <Text style={[ui.caption, styles.eventTime, { color: theme.textSecondary }]}>
                {event.allDay ? 'All day' : time(event.start)}
              </Text>
              <View style={{ flex: 1 }}>
                <Text style={[ui.body, { color: theme.text }]}>{event.title}</Text>
                {event.place ? <Text style={[ui.caption, { color: theme.textSecondary }]}>{event.place}</Text> : null}
              </View>
            </View>
          ))}
        </View>
      ))}
    </Card>
  );
}

function InboxCard() {
  const { today } = useHub();
  const theme = useTheme();
  const inbox = today?.inbox;
  const mail = inbox?.state === 'loaded' ? inbox.value : [];
  return (
    <Card title="Inbox" icon="tray">
      <LoadState load={inbox} empty={mail.length === 0 ? 'No recent mail.' : undefined} />
      {mail.map((item) => (
        <View key={item.id}>
          <Text style={[ui.body, { color: theme.text, fontWeight: '600' }]} numberOfLines={1}>{item.from}</Text>
          <Text style={[ui.caption, { color: theme.textSecondary }]} numberOfLines={2}>{item.subject}</Text>
        </View>
      ))}
    </Card>
  );
}

/** How much of the Claude subscription is used (the same numbers as Today on the Mac). */
function UsageCard() {
  const { usage } = useHub();
  const theme = useTheme();
  // When the card appeared; good enough for "resets in 2h" (it updates as new numbers arrive).
  const [now] = useState(() => Date.now());
  if (!usage?.session && !usage?.week) return null;
  const rows: [string, { utilization: number; resetsAt: string } | undefined][] = [['5-hour session', usage.session], ['This week', usage.week]];
  return (
    <Card title="Claude usage" icon="gauge.with.dots.needle.33percent">
      {rows.map(([label, window]) => {
        if (!window) return null;
        const reset = Date.parse(window.resetsAt);
        const used = reset <= now ? 0 : Math.min(Math.max(window.utilization, 0), 1);
        const color = used >= 0.9 ? theme.red : used >= 0.7 ? theme.orange : theme.green;
        return (
          <View key={label} style={{ gap: 4 }}>
            <View style={{ flexDirection: 'row' }}>
              <Text style={[ui.body, { color: theme.text, flex: 1 }]}>{label}</Text>
              <Text style={[ui.body, { color: theme.textSecondary, fontVariant: ['tabular-nums'] }]}>{Math.round(used * 100)}%</Text>
            </View>
            <View style={{ height: 6, borderRadius: 3, backgroundColor: theme.field, overflow: 'hidden' }}>
              <View style={{ width: `${used * 100}%`, height: 6, backgroundColor: color }} />
            </View>
            <Text style={[ui.caption, { color: theme.textSecondary }]}>Resets {countdown(reset, now)}</Text>
          </View>
        );
      })}
      {usage.limited ? <ErrorText>Claude says this request was over the limit.</ErrorText> : null}
    </Card>
  );
}

/** "in 2h 14m", "in 3d 4h". */
function countdown(when: number, now: number) {
  const minutes = Math.max(0, Math.round((when - now) / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days) return `in ${days}d ${hours}h`;
  if (hours) return `in ${hours}h ${minutes % 60}m`;
  return `in ${minutes}m`;
}

function LoadState<T>({ load, empty }: { load?: Load<T>; empty?: string }) {
  if (!load || load.state === 'loading' || load.state === 'idle') return <Muted>Loading…</Muted>;
  if (load.state === 'failed') return <ErrorText>{load.error}</ErrorText>;
  return empty ? <Muted>{empty}</Muted> : null;
}

function time(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function groupByDay(events: CalendarEvent[]) {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const groups = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    const day = new Date(event.start);
    day.setHours(0, 0, 0, 0);
    const offset = Math.round((day.getTime() - startOfToday.getTime()) / 86_400_000);
    const label =
      offset <= 0 ? 'Today'
      : offset === 1 ? 'Tomorrow'
      : day.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
    groups.set(label, [...(groups.get(label) ?? []), event]);
  }
  return [...groups].map(([label, items]) => ({ label, items }));
}

const styles = StyleSheet.create({
  deadlineRow: { flexDirection: 'row', gap: Spacing.m, alignItems: 'flex-start', paddingVertical: 2 },
  deadlineWhen: { width: 92, paddingTop: 2 },
  page: { padding: Spacing.l, gap: Spacing.l, width: '100%', maxWidth: MaxContentWidth, alignSelf: 'center' },
  date: { fontSize: 13, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.4 },
  title: { fontSize: 34, fontWeight: '700' },
  todoRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.m, paddingVertical: 2 },
  input: { borderRadius: 8, paddingHorizontal: Spacing.m, paddingVertical: Spacing.s },
  dayLabel: { fontSize: 13, fontWeight: '600' },
  eventRow: { flexDirection: 'row', gap: Spacing.m },
  eventTime: { width: 64, paddingTop: 3 },
});
