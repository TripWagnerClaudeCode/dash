import { SymbolView } from 'expo-symbols';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Card, ConnectionLine, ErrorText, Muted, styles as ui } from '@/components/ui';
import { MaxContentWidth, Radius, Spacing } from '@/constants/theme';
import { useHub } from '@/lib/hub-context';
import { useTheme } from '@/hooks/use-theme';

/**
 * Start and stop lecture recording on the Mac. The Mac records and transcribes with its own microphone
 * and files notes to the class's Google Doc every 5 minutes; the phone is the remote.
 */
export default function LectureScreen() {
  const { client, state, ready, lecture } = useHub();
  const theme = useTheme();
  const [choice, setChoice] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const canControl = state === 'online' && !!lecture?.available;
  // Offline (or with the Mac gone) the snapshot is a saved copy: the recording may have stopped since, so the
  // timer doesn't keep counting.
  const live = canControl;
  const now = useNow(live && lecture?.state === 'recording');

  const recorder = lecture?.state ?? 'idle';
  const active = recorder !== 'idle';
  const courses = lecture?.courses ?? [];
  const selected = choice ?? lecture?.selected ?? courses[0]?.code;

  async function send(type: 'lecture.start' | 'lecture.stop') {
    setBusy(true);
    setError(undefined);
    try {
      await client.request(type, type === 'lecture.start' ? { course: selected } : {});
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const elapsed = lecture?.since ? Math.max(0, Math.floor((now - Date.parse(lecture.since)) / 1000)) : 0;

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: theme.background }}>
      <ScrollView contentContainerStyle={styles.page}>
        <View style={{ gap: 4 }}>
          <Text style={[styles.title, { color: theme.text }]}>Lecture</Text>
          {ready ? <ConnectionLine /> : null}
        </View>

        {state === 'online' && !lecture?.available ? (
          <Card title="Mac needed" icon="laptopcomputer">
            <Muted>Recording uses your Mac&apos;s microphone. Open Dash on the Mac and it shows up here.</Muted>
          </Card>
        ) : null}

        <Card title={active ? (recorder === 'recording' ? (live ? 'Recording' : 'Last seen recording') : recorder === 'starting' ? 'Starting…' : 'Finishing up…') : 'Class'}
              icon={active ? 'record.circle' : 'graduationcap'}>
          {active ? (
            <View style={{ gap: Spacing.s }}>
              <Text style={[ui.body, { color: theme.text, fontWeight: '600' }]}>
                {lecture?.course} · {lecture?.courseName}
              </Text>
              {recorder === 'recording' && live ? (
                <Text style={[styles.timer, { color: theme.red }]}>{clock(elapsed)}</Text>
              ) : recorder === 'recording' ? (
                <Muted>Last known: recording since {lecture?.since
                  ? new Date(lecture.since).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
                  : 'earlier'}. The live timer comes back once Dash can reach the Mac.</Muted>
              ) : null}
            </View>
          ) : courses.length === 0 ? (
            <Muted>{lecture?.available ? 'No classes set up on the Mac yet.' : 'Classes appear once the Mac is connected.'}</Muted>
          ) : (
            <View style={[styles.list, { borderColor: theme.separator }]}>
              {courses.map((course, index) => (
                <Pressable
                  key={course.code}
                  onPress={() => setChoice(course.code)}
                  style={[styles.row, index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.separator }]}>
                  <SymbolView name={course.code === selected ? 'largecircle.fill.circle' : 'circle'} size={18}
                              tintColor={course.code === selected ? theme.accent : theme.textSecondary} />
                  <Text style={[ui.body, { color: theme.text, flex: 1 }]} numberOfLines={1}>
                    {course.code} · {course.name}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
          <Pressable
            onPress={() => send(active ? 'lecture.stop' : 'lecture.start')}
            disabled={!canControl || busy || recorder === 'starting' || recorder === 'stopping' || (!active && !selected)}
            style={({ pressed }) => [styles.button, { backgroundColor: active ? theme.red : theme.accent,
              opacity: !canControl || busy || recorder === 'starting' || recorder === 'stopping' ? 0.4 : pressed ? 0.7 : 1 }]}>
            <SymbolView name={active ? 'stop.fill' : 'record.circle'} size={18} tintColor="#FFFFFF" />
            <Text style={styles.buttonText}>{active ? 'Stop and clean up notes' : 'Start recording'}</Text>
          </Pressable>
          {error ? <ErrorText>{error}</ErrorText> : null}
        </Card>

        {lecture?.log?.length ? (
          <Card title="Activity" icon="list.bullet.rectangle">
            {[...lecture.log].reverse().map((line, index) => (
              <View key={index} style={{ flexDirection: 'row', gap: Spacing.s }}>
                <Text style={[ui.caption, { color: theme.textSecondary }]}>
                  {new Date(line.time).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                </Text>
                <Text style={[ui.caption, { color: line.isError ? theme.orange : theme.text, flex: 1 }]}>{line.text}</Text>
              </View>
            ))}
          </Card>
        ) : null}
        <Muted style={{ fontSize: 13 }}>
          Every 5 minutes the new part of the lecture becomes notes in the class&apos;s Google Doc. Stopping rewrites the
          day&apos;s notes into one clean set and deletes the raw transcript.
        </Muted>
      </ScrollView>
    </SafeAreaView>
  );
}

/** The current time, ticking every second while `running`. */
function useNow(running: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

function clock(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(s).padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  page: { padding: Spacing.l, gap: Spacing.l, maxWidth: MaxContentWidth, width: '100%', alignSelf: 'center' },
  title: { fontSize: 34, fontWeight: '700' },
  list: { borderRadius: Radius.control, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.m, paddingHorizontal: Spacing.m, paddingVertical: 10 },
  timer: { fontSize: 40, fontWeight: '300', fontVariant: ['tabular-nums'] },
  button: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.s, borderRadius: Radius.card, paddingVertical: 14 },
  buttonText: { color: '#FFFFFF', fontSize: 17, fontWeight: '600' },
});
