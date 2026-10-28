import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Card, ErrorText, Muted } from '@/components/ui';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useHub } from '@/lib/hub-context';
import { useTheme } from '@/hooks/use-theme';

type MemorySnapshot = {
  core: string;
  self: string;
  threads: string;
  remember: string;
  journal: { day: string; text: string }[];
};

/**
 * What Dash remembers (hub/src/memory.ts): who the user is right now, follow-ups, "remember…" lines and the
 * nightly journal. Long-press a line to make Dash forget it.
 */
export default function MemoryScreen() {
  const { client, state } = useHub();
  const theme = useTheme();
  const [memory, setMemory] = useState<MemorySnapshot>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [openDay, setOpenDay] = useState<string>();

  const load = useCallback(() => {
    if (state !== 'online') {
      setError("Dash isn't connected, so its memory can't be loaded right now.");
      return;
    }
    setLoading(true);
    client.request<MemorySnapshot>('memory.get')
      .then((result) => { setMemory(result); setError(undefined); })
      .catch((failure: Error) => setError(failure.message))
      .finally(() => setLoading(false));
  }, [client, state]);

  useEffect(load, [load]);

  function forget(file: string, line: string, day?: string) {
    Alert.alert('Forget this?', line.replace(/^- (\[[ x]\] )?/, ''), [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Forget', style: 'destructive',
        onPress: () => client.request<MemorySnapshot>('memory.forget', { file, line, ...(day ? { day } : {}) })
          .then(setMemory).catch((failure: Error) => setError(failure.message)),
      },
    ]);
  }

  return (
    <SafeAreaView edges={[]} style={{ flex: 1, backgroundColor: theme.background }}>
      <ScrollView contentContainerStyle={styles.page} refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}>
        <Muted>
          Conversations are summarized when they go quiet, and each night the day becomes a journal entry and this
          page is updated. Long-press a line to make Dash forget it. Off-the-record chats are never remembered.
        </Muted>
        {error ? <ErrorText>{error}</ErrorText> : null}
        {!memory && loading ? <ActivityIndicator /> : null}
        {memory ? (
          <>
            <Card title="Right now" icon="person.crop.circle">
              <Lines text={memory.core} empty="Nothing yet. This fills in after the first night." onForget={(line) => forget('core', line)} />
            </Card>
            <Card title="Dash, in his own words" icon="sparkles">
              <Lines text={memory.self ?? ''} empty="Dash fills this in as you two get to know each other." onForget={(line) => forget('self', line)} />
            </Card>
            <Card title="Follow-ups" icon="arrowshape.turn.up.forward">
              <Lines text={memory.threads} empty="Nothing to follow up on." onForget={(line) => forget('threads', line)} />
            </Card>
            <Card title="Asked to remember" icon="pin">
              <Lines text={memory.remember} empty={'Say "remember…" in a chat to add something here.'} onForget={(line) => forget('remember', line)} />
            </Card>
            <Card title="Journal" icon="book.closed">
              {memory.journal.length === 0 ? <Muted>The first entry appears the morning after you use Dash.</Muted> : null}
              {memory.journal.map((entry) => (
                <View key={entry.day} style={{ gap: Spacing.xs }}>
                  <Pressable onPress={() => setOpenDay(openDay === entry.day ? undefined : entry.day)} hitSlop={6}>
                    <Text style={[styles.day, { color: theme.text }]}>{openDay === entry.day ? '▾' : '▸'} {dayTitle(entry.day)}</Text>
                  </Pressable>
                  {openDay === entry.day
                    ? <Lines text={entry.text} empty="" onForget={(line) => forget('journal', line, entry.day)} />
                    : null}
                </View>
              ))}
            </Card>
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function Lines({ text, empty, onForget }: { text: string; empty: string; onForget: (line: string) => void }) {
  const theme = useTheme();
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('# ') && !line.startsWith('<!--'));
  if (!lines.some((line) => !line.startsWith('## ')) && empty) return <Muted>{empty}</Muted>;
  return (
    <View style={{ gap: Spacing.xs }}>
      {lines.map((line, index) => line.startsWith('## ') ? (
        <Text key={index} style={[styles.heading, { color: theme.textSecondary }]}>{line.slice(3)}</Text>
      ) : (
        <Pressable key={index} onLongPress={() => onForget(line)}>
          <Text style={[styles.line, { color: line.startsWith('- [x] ') ? theme.textSecondary : theme.text }]}>{display(line)}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function display(line: string) {
  if (line.startsWith('- [ ] ')) return `○ ${line.slice(6)}`;
  if (line.startsWith('- [x] ')) return `✓ ${line.slice(6)}`;
  if (line.startsWith('- ')) return `• ${line.slice(2)}`;
  return line;
}

function dayTitle(day: string) {
  const date = new Date(`${day}T12:00:00`);
  return Number.isNaN(date.getTime()) ? day : date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

const styles = StyleSheet.create({
  page: { padding: Spacing.l, gap: Spacing.l, width: '100%', maxWidth: MaxContentWidth, alignSelf: 'center' },
  heading: { fontSize: 13, fontWeight: '600', marginTop: Spacing.xs },
  line: { fontSize: 15, lineHeight: 21 },
  day: { fontSize: 15, fontWeight: '600' },
});
