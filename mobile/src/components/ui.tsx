import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type TextStyle } from 'react-native';

import { Radius, Spacing } from '@/constants/theme';
import { useHub } from '@/lib/hub-context';
import { useTheme } from '@/hooks/use-theme';

/** A titled card, like the Mac's `Card`. */
export function Card({ title, icon, action, children }: {
  title: string;
  icon: SymbolViewProps['name'];
  action?: ReactNode;
  children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: theme.card }]}>
      <View style={styles.cardHeader}>
        <SymbolView name={icon} size={15} tintColor={theme.textSecondary} />
        <Text style={[styles.cardTitle, { color: theme.textSecondary }]}>{title.toUpperCase()}</Text>
        <View style={{ flex: 1 }} />
        {action}
      </View>
      {children}
    </View>
  );
}

export function SmallButton({ title, onPress, disabled, busy }: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      hitSlop={8}
      style={({ pressed }) => [styles.smallButton, { backgroundColor: theme.field, opacity: disabled ? 0.4 : pressed ? 0.6 : 1 }]}>
      {busy ? <ActivityIndicator size="small" /> : <Text style={[styles.smallButtonText, { color: theme.accent }]}>{title}</Text>}
    </Pressable>
  );
}

export function Muted({ children, style }: { children: ReactNode; style?: TextStyle }) {
  const theme = useTheme();
  return <Text style={[styles.body, { color: theme.textSecondary }, style]}>{children}</Text>;
}

export function ErrorText({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return <Text style={[styles.body, { color: theme.red }]}>{children}</Text>;
}

/** "Live", "Connecting…" or why the hub can't be reached, under the page title. */
export function ConnectionLine() {
  const { state, problem, mac, savedAt } = useHub();
  const theme = useTheme();
  const saved = savedAt
    ? ` Showing what Dash had at ${new Date(savedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}.`
    : '';
  const [color, text] =
    state === 'online' ? [theme.green, `Live from ${mac ?? 'Dash'}`]
    : state === 'connecting' ? [theme.orange, 'Connecting to Dash…']
    : state === 'offline' ? [theme.red, (problem ?? "Can't reach Dash.") + saved]
    : [theme.textSecondary, 'Not paired with Dash'];
  return (
    <View style={styles.connection}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[styles.caption, { color: theme.textSecondary, flex: 1 }]} numberOfLines={3}>{text}</Text>
    </View>
  );
}

/**
 * Enough markdown for the brief and chats: headings, bullets, numbered lists, fenced code blocks,
 * **bold**, *italic* and `code`. Tables show as their plain text.
 */
export function Markdown({ text }: { text: string }) {
  const theme = useTheme();
  // Group fenced code blocks into one item each; everything else stays a line.
  const blocks: (string | { code: string })[] = [];
  let code: string[] | undefined;
  for (const line of text.trim().split('\n')) {
    if (line.trim().startsWith('```')) {
      if (code) {
        blocks.push({ code: code.join('\n') });
        code = undefined;
      } else {
        code = [];
      }
    } else if (code) {
      code.push(line);
    } else {
      blocks.push(line);
    }
  }
  if (code) blocks.push({ code: code.join('\n') });
  return (
    <View style={{ gap: 6 }}>
      {blocks.map((line, index) => {
        if (typeof line !== 'string') {
          return (
            <View key={index} style={[styles.codeBlock, { backgroundColor: theme.field }]}>
              <Text selectable style={[styles.code, { color: theme.text }]}>{line.code}</Text>
            </View>
          );
        }
        const trimmed = line.trim();
        if (!trimmed) return null;
        const heading = trimmed.match(/^#{1,6}\s+(.*)$/);
        if (heading) {
          return <Text key={index} style={[styles.heading, { color: theme.text }]}>{inline(heading[1])}</Text>;
        }
        const bullet = trimmed.match(/^([-*•]|\d+\.)\s+(.*)$/);
        if (bullet) {
          const marker = /\d/.test(bullet[1]) ? bullet[1] : '•';
          return (
            <View key={index} style={{ flexDirection: 'row', gap: 8, paddingLeft: 4 }}>
              <Text style={[styles.body, { color: theme.textSecondary }]}>{marker}</Text>
              <Text style={[styles.body, { color: theme.text, flex: 1 }]}>{inline(bullet[2])}</Text>
            </View>
          );
        }
        return <Text key={index} style={[styles.body, { color: theme.text }]}>{inline(trimmed)}</Text>;
      })}
    </View>
  );
}

function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g).map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return <Text key={index} style={styles.code}>{part.slice(1, -1)}</Text>;
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <Text key={index} style={{ fontWeight: '600' }}>{part.slice(2, -2)}</Text>;
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      return <Text key={index} style={{ fontStyle: 'italic' }}>{part.slice(1, -1)}</Text>;
    }
    return part;
  });
}

export const styles = StyleSheet.create({
  card: { borderRadius: Radius.card, padding: Spacing.l, gap: Spacing.m },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: Spacing.s, minHeight: 24 },
  cardTitle: { fontSize: 12, fontWeight: '600', letterSpacing: 0.4 },
  smallButton: { borderRadius: Radius.control, paddingHorizontal: Spacing.m, paddingVertical: 5, minWidth: 60, alignItems: 'center' },
  smallButtonText: { fontSize: 14, fontWeight: '600' },
  body: { fontSize: 16, lineHeight: 22 },
  heading: { fontSize: 17, fontWeight: '700', marginTop: 4 },
  caption: { fontSize: 13 },
  connection: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  code: { fontFamily: 'Menlo', fontSize: 13 },
  codeBlock: { borderRadius: Radius.control, padding: Spacing.s },
});
