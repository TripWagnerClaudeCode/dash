import { type Href, router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ConnectionLine, Muted, styles as ui } from '@/components/ui';
import { MaxContentWidth, Radius, Spacing } from '@/constants/theme';
import { newChatID, useChatList } from '@/lib/chats';
import { useHub } from '@/lib/hub-context';
import { useTheme } from '@/hooks/use-theme';

/** Chat history from the hub, newest first. The same chats as the Chat page on the Mac. */
export default function ChatsScreen() {
  const { client, state, ready } = useHub();
  const theme = useTheme();
  const online = state === 'online';
  const chats = useChatList(client, online);
  const [refreshing, setRefreshing] = useState(false);

  async function refresh() {
    if (!online) {
      client.reconnectNow();
      return;
    }
    setRefreshing(true);
    await client.request('chat.list').catch(() => {});
    setRefreshing(false);
  }

  function confirmDelete(id: string, title: string) {
    Alert.alert('Delete this chat?', title, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => client.request('chat.delete', { chat: id }).catch(() => {}) },
    ]);
  }

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: theme.background }}>
      <ScrollView contentContainerStyle={styles.page} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}>
        <View style={styles.header}>
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={[styles.title, { color: theme.text }]}>Chat</Text>
            {ready ? <ConnectionLine /> : null}
          </View>
          <Pressable
            onPress={() => router.push(`/chat/${newChatID()}?fresh=1` as Href)}
            disabled={!online}
            hitSlop={10}
            style={({ pressed }) => ({ opacity: !online ? 0.4 : pressed ? 0.6 : 1 })}>
            <SymbolView name="square.and.pencil" size={26} tintColor={theme.accent} />
          </Pressable>
        </View>
        {chats.length === 0 ? (
          <Muted>{online ? 'No chats yet. Tap the pencil to start one.' : 'Chats show up here once Dash is connected.'}</Muted>
        ) : (
          <View style={[styles.list, { backgroundColor: theme.card }]}>
            {chats.map((meta, index) => (
              <Pressable
                key={meta.id}
                onPress={() => router.push(`/chat/${meta.id}` as Href)}
                onLongPress={() => confirmDelete(meta.id, meta.title)}
                style={({ pressed }) => [styles.row, { opacity: pressed ? 0.6 : 1 },
                  index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.separator }]}>
                <Text style={[ui.body, { color: theme.text, flex: 1 }]} numberOfLines={1}>{meta.title}</Text>
                <Text style={[ui.caption, { color: theme.textSecondary }]}>{ago(meta.updatedAt)}</Text>
                <SymbolView name="chevron.right" size={13} tintColor={theme.textSecondary} />
              </Pressable>
            ))}
          </View>
        )}
        {chats.length > 0 ? <Muted style={{ fontSize: 13 }}>Touch and hold a chat to delete it.</Muted> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

/** "5m", "3h", "Oct 24". */
function ago(iso: string) {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${Math.max(minutes, 1)}m`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)}h`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const styles = StyleSheet.create({
  page: { padding: Spacing.l, gap: Spacing.l, maxWidth: MaxContentWidth, width: '100%', alignSelf: 'center' },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.m },
  title: { fontSize: 34, fontWeight: '700' },
  list: { borderRadius: Radius.card, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.s, paddingHorizontal: Spacing.l, paddingVertical: Spacing.m },
});
