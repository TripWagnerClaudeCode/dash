import { router, Stack, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useRef, useState } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
  type ScrollViewInstance,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Card, ErrorText, Markdown, Muted, SmallButton, styles as ui } from '@/components/ui';
import { MaxContentWidth, Radius, Spacing } from '@/constants/theme';
import { ADVISOR_ID, approvalFields, toolLabel, useChat } from '@/lib/chats';
import type { Approval, ToolCall, Turn } from '@/lib/hub';
import { useHub } from '@/lib/hub-context';
import { useTheme } from '@/hooks/use-theme';

/**
 * One chat, running on the hub: Claude streams in, tool calls show as steps, and anything that changes
 * something waits for Approve or Deny here (or on the Mac, whichever is first). Messages sent while
 * Claude is answering are queued.
 */
export default function ChatScreen() {
  const params = useLocalSearchParams<{ id: string; fresh?: string; skill?: string; draft?: string; checkin?: string }>();
  const id = String(params.id);
  const { client, state } = useHub();
  const online = state === 'online';
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  // A chat started with the pencil isn't on the hub until its first message.
  const [known] = useState(params.fresh !== '1');
  const chat = useChat(client, id, online, known);
  const [draft, setDraft] = useState(params.draft ?? '');
  const [error, setError] = useState<string>();
  const scroll = useRef<ScrollViewInstance>(null);
  const pinned = useRef(true);
  const busy = chat.status !== 'idle';
  // Before the first message the chat isn't on the hub yet, so off-the-record is kept here and sent with it.
  const [pendingOffRecord, setPendingOffRecord] = useState(false);
  const offRecord = chat.meta ? !!chat.meta.offRecord : pendingOffRecord;

  function toggleOffRecord() {
    if (!chat.meta) setPendingOffRecord(!pendingOffRecord);
    else call('chat.settings', { settings: { offRecord: !offRecord } });
  }

  function call(type: string, params: Record<string, unknown> = {}) {
    setError(undefined);
    return client.request(type, { chat: id, ...params }).catch((failure: Error) => setError(failure.message));
  }

  function send() {
    const text = draft.trim();
    if (!text) return;
    if (!online) {
      setError("Dash isn't connected, so this can't be sent yet. Your message is still in the box.");
      return;
    }
    setDraft('');
    pinned.current = true;
    // A new chat opened from Study takes its skill with the first message.
    const settings: Record<string, unknown> = {};
    if (!chat.meta) {
      if (params.skill) settings.skillName = params.skill;
      if (params.checkin === '1') settings.kind = 'checkin';
      if (pendingOffRecord) settings.offRecord = true;
    }
    call('chat.send', { text, settings }).then((result) => {
      if (result === undefined) setDraft(text);
    });
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: theme.background }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={insets.top + 44}>
      <Stack.Screen options={{
        title: id === ADVISOR_ID ? 'Portfolio advisor' : chat.meta?.title ?? 'New chat',
        headerBackTitle: id === ADVISOR_ID ? 'Portfolio' : 'Chats',
        // The advisor keeps one conversation; "New session" forgets it (the investor profile stays).
        headerRight: id === ADVISOR_ID && chat.turns.length && !busy
          ? () => <Pressable hitSlop={8} onPress={() => client.request('advisor.reset').then(() => router.back()).catch(() => {})}>
              <Text style={{ color: theme.accent, fontSize: 17 }}>New session</Text>
            </Pressable>
          : id === ADVISOR_ID ? undefined
          : () => <Pressable hitSlop={8} onPress={toggleOffRecord} accessibilityLabel={offRecord ? 'On the record' : 'Off the record'}>
              <SymbolView name={offRecord ? 'eye.slash.fill' : 'eye'} size={20} tintColor={offRecord ? theme.orange : theme.accent} />
            </Pressable>,
      }} />
      <ScrollView
        ref={scroll}
        contentContainerStyle={styles.page}
        keyboardDismissMode="interactive"
        onScroll={(event) => {
          const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
          pinned.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 80;
        }}
        scrollEventThrottle={100}
        onContentSizeChange={() => {
          if (pinned.current) scroll.current?.scrollToEnd({ animated: false });
        }}>
        {!chat.loaded ? <ActivityIndicator style={{ marginTop: Spacing.xl }} /> : null}
        {chat.loaded && chat.turns.length === 0 ? (
          <View style={{ gap: Spacing.s, marginTop: Spacing.xl }}>
            <Text style={[styles.empty, { color: theme.text }]}>
              {id === ADVISOR_ID ? 'Your portfolio advisor' : params.skill ? `${params.skill} is loaded`
                : params.checkin === '1' ? "How'd today go?" : 'What can I help with?'}
            </Text>
            <Muted>
              This is a full Claude Code session on the Dash hub, with your calendar, Gmail and files. Anything that
              changes something asks you first.
            </Muted>
          </View>
        ) : null}
        {offRecord ? <Muted style={{ color: theme.orange }}>Off the record: Dash won't remember this chat.</Muted> : null}
        {chat.notice ? <Muted style={{ color: theme.orange }}>{chat.notice}</Muted> : null}
        {chat.turns.map((turn, index) => (
          <TurnView key={turn.id} turn={turn} live={busy && index === chat.turns.length - 1} />
        ))}
        {chat.approvals.map((approval) => (
          <ApprovalCard
            key={approval.id}
            approval={approval}
            decide={(allow, always) => call('chat.decide', { request: approval.id, allow, always })}
          />
        ))}
      </ScrollView>

      <View style={[styles.composer, { backgroundColor: theme.card, borderTopColor: theme.separator, paddingBottom: Math.max(insets.bottom, Spacing.s) }]}>
        {chat.queue.map((message) => (
          <View key={message.id} style={styles.queued}>
            <SymbolView name="clock" size={12} tintColor={theme.textSecondary} />
            <Text style={[ui.caption, { color: theme.textSecondary, flex: 1 }]} numberOfLines={1}>{message.text || '(attachments)'}</Text>
            <Pressable hitSlop={8} onPress={() => call('chat.unqueue', { queued: message.id })}>
              <SymbolView name="xmark" size={12} tintColor={theme.textSecondary} />
            </Pressable>
          </View>
        ))}
        {error ? <ErrorText>{error}</ErrorText> : null}
        <View style={styles.inputRow}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={busy ? 'Type to queue a follow-up…' : 'Ask Dash anything…'}
            placeholderTextColor={theme.textSecondary}
            multiline
            style={[styles.input, { color: theme.text, backgroundColor: theme.field }]}
          />
          {busy && !draft.trim() ? (
            <Pressable onPress={() => call('chat.stop')} hitSlop={8} disabled={chat.stopping}>
              <SymbolView name={chat.stopping ? 'hourglass.circle.fill' : 'stop.circle.fill'} size={32} tintColor={theme.text} />
            </Pressable>
          ) : (
            <Pressable onPress={send} hitSlop={8} disabled={!draft.trim()}>
              <SymbolView name="arrow.up.circle.fill" size={32} tintColor={draft.trim() ? theme.accent : theme.textSecondary} />
            </Pressable>
          )}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

function TurnView({ turn, live }: { turn: Turn; live: boolean }) {
  const theme = useTheme();
  if (turn.role === 'user') {
    return (
      <View style={[styles.userBubble, { backgroundColor: theme.accent }]}>
        {turn.attachments.length ? (
          <Text style={[ui.caption, { color: '#FFFFFFCC' }]}>📎 {turn.attachments.join(', ')}</Text>
        ) : null}
        {turn.text ? <Text selectable style={[ui.body, { color: '#FFFFFF' }]}>{turn.text}</Text> : null}
      </View>
    );
  }
  return (
    <View style={{ gap: Spacing.s }}>
      {turn.tools.map((call) => <ToolRow key={call.id} call={call} />)}
      {turn.text ? (
        turn.isError ? <ErrorText>{turn.text}</ErrorText> : <Markdown text={turn.text} />
      ) : live ? (
        <ActivityIndicator style={{ alignSelf: 'flex-start' }} />
      ) : null}
      {turn.stopped ? <Muted style={{ fontSize: 13 }}>Stopped</Muted> : null}
    </View>
  );
}

/** One tool call as a step; tap to see what it returned. */
function ToolRow({ call }: { call: ToolCall }) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  return (
    <Pressable onPress={() => setOpen(!open)} style={[styles.tool, { backgroundColor: theme.field }]}>
      <View style={styles.toolHeader}>
        {call.done ? (
          <SymbolView name={call.failed ? 'xmark.circle' : 'checkmark.circle'} size={14}
                      tintColor={call.failed ? theme.red : theme.textSecondary} />
        ) : (
          <ActivityIndicator size="small" />
        )}
        <Text style={[ui.caption, { color: theme.text, fontWeight: '600' }]}>{toolLabel(call.name)}</Text>
        <Text style={[ui.caption, { color: theme.textSecondary, flex: 1 }]} numberOfLines={1}>{call.summary}</Text>
      </View>
      {open && call.output ? (
        <Text selectable style={[ui.code, { color: theme.textSecondary, fontSize: 12 }]}>{call.output.slice(0, 3000)}</Text>
      ) : null}
    </Pressable>
  );
}

function ApprovalCard({ approval, decide }: { approval: Approval; decide: (allow: boolean, always?: boolean) => void }) {
  const theme = useTheme();
  return (
    <Card title={toolLabel(approval.toolName)} icon="hand.raised">
      <View style={{ gap: Spacing.s }}>
        {approvalFields(approval.input).map(([key, value]) => (
          <View key={key} style={{ gap: 2 }}>
            <Text style={[ui.caption, { color: theme.textSecondary }]}>{key.replace(/_/g, ' ')}</Text>
            <Text selectable style={[key === 'command' || key.endsWith('string') ? ui.code : ui.body, { color: theme.text }]}>
              {value.length > 2000 ? `${value.slice(0, 2000)}…` : value}
            </Text>
          </View>
        ))}
      </View>
      <View style={styles.decisions}>
        <SmallButton title="Deny" onPress={() => decide(false)} />
        {approval.canAlways ? <SmallButton title="Always allow" onPress={() => decide(true, true)} /> : null}
        <SmallButton title="Approve" onPress={() => decide(true)} />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  page: { padding: Spacing.l, gap: Spacing.l, maxWidth: MaxContentWidth, width: '100%', alignSelf: 'center' },
  empty: { fontSize: 22, fontWeight: '700' },
  userBubble: { alignSelf: 'flex-end', maxWidth: '85%', borderRadius: 18, paddingHorizontal: Spacing.m, paddingVertical: Spacing.s, gap: 2 },
  tool: { borderRadius: Radius.control, paddingHorizontal: Spacing.m, paddingVertical: Spacing.s, gap: Spacing.s },
  toolHeader: { flexDirection: 'row', alignItems: 'center', gap: Spacing.s },
  decisions: { flexDirection: 'row', justifyContent: 'flex-end', gap: Spacing.s },
  composer: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: Spacing.m, paddingTop: Spacing.s, gap: Spacing.s },
  queued: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: Spacing.s },
  input: { flex: 1, borderRadius: 18, paddingHorizontal: Spacing.m, paddingTop: 9, paddingBottom: 9, fontSize: 16, maxHeight: 140 },
});
