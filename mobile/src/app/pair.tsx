import { CameraView, useCameraPermissions } from 'expo-camera';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Card, ErrorText, Muted, SmallButton, styles as ui } from '@/components/ui';
import { Radius, Spacing } from '@/constants/theme';
import { useHub } from '@/lib/hub-context';
import { useTheme } from '@/hooks/use-theme';

/**
 * Scans the code from Dash › Settings › Pair a Phone on the Mac: {"v":1,"url":"wss://….ts.net","code":"123456"}.
 * The address and code can also be typed in.
 */
export default function PairScreen() {
  const { pair } = useHub();
  const theme = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const [url, setUrl] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // The camera reports the same code many times a second; only the first one counts.
  const scanned = useRef(false);

  async function submit(address: string, pairingCode: string) {
    setBusy(true);
    setError(undefined);
    try {
      await pair(address, pairingCode);
      if (router.canGoBack()) router.back();
      else router.replace('/');
    } catch (failure) {
      setError((failure as Error).message);
      scanned.current = false;
    } finally {
      setBusy(false);
    }
  }

  function onScan(data: string) {
    if (scanned.current || busy) return;
    try {
      const payload = JSON.parse(data);
      if (typeof payload.url !== 'string' || typeof payload.code !== 'string') throw new Error();
      scanned.current = true;
      setUrl(payload.url);
      setCode(payload.code);
      submit(payload.url, payload.code);
    } catch {
      setError("That QR code isn't from Dash.");
    }
  }

  const canScan = Platform.OS !== 'web';
  return (
    <ScrollView contentContainerStyle={styles.page} style={{ backgroundColor: theme.background }} keyboardShouldPersistTaps="handled">
      {canScan ? (
        <Card title="Scan" icon="qrcode.viewfinder">
          {!permission ? null : permission.granted ? (
            <View style={styles.cameraFrame}>
              <CameraView
                style={StyleSheet.absoluteFill}
                barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                onBarcodeScanned={({ data }) => onScan(data)}
              />
            </View>
          ) : (
            <>
              <Muted>Dash needs the camera to scan the pairing code on your Mac.</Muted>
              <SmallButton title="Allow Camera" onPress={requestPermission} />
            </>
          )}
          <Muted>On the Mac: Dash › Settings › Pair a Phone.</Muted>
        </Card>
      ) : null}

      <Card title="Or type it in" icon="keyboard">
        <TextInput
          value={url}
          onChangeText={setUrl}
          placeholder="wss://your-mac.tailnet.ts.net"
          placeholderTextColor={theme.textSecondary}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          style={[ui.body, styles.input, { backgroundColor: theme.field, color: theme.text }]}
        />
        <TextInput
          value={code}
          onChangeText={setCode}
          placeholder="6-digit code"
          placeholderTextColor={theme.textSecondary}
          keyboardType="number-pad"
          maxLength={6}
          style={[ui.body, styles.input, { backgroundColor: theme.field, color: theme.text }]}
        />
        <SmallButton title="Pair" onPress={() => submit(url, code)} disabled={!url.trim() || code.trim().length !== 6} busy={busy} />
      </Card>

      {busy ? (
        <View style={{ flexDirection: 'row', gap: Spacing.s, alignItems: 'center' }}>
          <ActivityIndicator />
          <Text style={{ color: theme.textSecondary }}>Pairing…</Text>
        </View>
      ) : null}
      {error ? <ErrorText>{error}</ErrorText> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: Spacing.l, gap: Spacing.l },
  cameraFrame: { height: 260, borderRadius: Radius.card, overflow: 'hidden' },
  input: { borderRadius: Radius.control, paddingHorizontal: Spacing.m, paddingVertical: Spacing.s },
});
