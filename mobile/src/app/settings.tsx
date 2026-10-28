import { router } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Card, ConnectionLine, Muted, SmallButton } from '@/components/ui';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useHub } from '@/lib/hub-context';
import { useTheme } from '@/hooks/use-theme';

export default function SettingsScreen() {
  const { state, mac, unpair } = useHub();
  const theme = useTheme();

  function confirmUnpair() {
    Alert.alert('Unpair this phone?', 'You can pair it again from Dash › Settings on the Mac.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Unpair', style: 'destructive', onPress: () => unpair() },
    ]);
  }

  return (
    <SafeAreaView edges={[]} style={{ flex: 1, backgroundColor: theme.background }}>
      <ScrollView contentContainerStyle={styles.page}>
        <Card title="Dash hub" icon="server.rack">
          <ConnectionLine />
          {state === 'unpaired' ? (
            <SmallButton title="Pair" onPress={() => router.push('/pair')} />
          ) : (
            <View style={{ gap: Spacing.s }}>
              <Muted>
                Paired with {mac ?? 'the Dash hub'}. The hub runs on your Windows PC and the phone reaches it over
                Tailscale, so Dash works with your Mac closed. To remove this phone, use Dash › Settings › Phone on the Mac.
              </Muted>
              <SmallButton title="Unpair" onPress={confirmUnpair} />
            </View>
          )}
        </Card>
        {state !== 'unpaired' ? <NotificationsCard /> : null}
        {state !== 'unpaired' ? (
          <Card title="Memory" icon="brain">
            <Muted>What Dash remembers about you, from your chats, the lens and lectures. You can remove anything.</Muted>
            <SmallButton title="What Dash remembers" onPress={() => router.push('/memory')} />
          </Card>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * Pushes come through the free ntfy app (Expo Go can't receive Dash's own), subscribed to the hub's
 * ntfy server over Tailscale. This shows what to type in and sends a test.
 */
function NotificationsCard() {
  const { client, state } = useHub();
  const theme = useTheme();
  const [setup, setSetup] = useState<{ server: string; topic: string }>();
  const [message, setMessage] = useState<string>();

  useEffect(() => {
    if (state === 'online') client.request<{ server: string; topic: string }>('notify.setup').then(setSetup).catch(() => {});
  }, [client, state]);

  function test() {
    setMessage(undefined);
    client.request('notify.test').then(() => setMessage('Sent. It should show up in a few seconds.'))
      .catch((failure: Error) => setMessage(failure.message));
  }

  return (
    <Card title="Notifications" icon="bell.badge">
      {setup?.topic ? (
        <View style={{ gap: Spacing.s }}>
          <Muted>
            Dash sends reminders, the morning brief and the evening check-in through the free ntfy app. In ntfy:
            Settings › Default server, enter the server below; then + to subscribe to the topic. Keep Tailscale on.
          </Muted>
          <Text selectable style={[styles.code, { color: theme.text, backgroundColor: theme.field }]}>{setup.server}</Text>
          <Text selectable style={[styles.code, { color: theme.text, backgroundColor: theme.field }]}>{setup.topic}</Text>
          <SmallButton title="Copy topic" onPress={() => Clipboard.setStringAsync(setup.topic)} />
          <SmallButton title="Send a test" onPress={test} />
        </View>
      ) : (
        <Muted>Notifications aren't set up on the Dash hub yet.</Muted>
      )}
      {message ? <Muted>{message}</Muted> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  code: { fontFamily: 'Menlo', fontSize: 13, padding: Spacing.s, borderRadius: 8 },
  page: { padding: Spacing.l, gap: Spacing.l, width: '100%', maxWidth: MaxContentWidth, alignSelf: 'center' },
  title: { fontSize: 34, fontWeight: '700' },
});
