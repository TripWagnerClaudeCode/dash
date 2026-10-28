import { type Href, router } from 'expo-router';
import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import { useEffect, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Muted, styles as ui } from '@/components/ui';
import { MaxContentWidth, Radius, Spacing } from '@/constants/theme';
import { newChatID } from '@/lib/chats';
import { useHub } from '@/lib/hub-context';
import { useTheme } from '@/hooks/use-theme';

type Tool = { title: string; subtitle: string; icon: SymbolViewProps['name'] } & (
  | { skill: string; starter: string }
  | { url: string }
);

/** A link from the user's profile on the hub. `icon` is an SF Symbol name. */
type ProfileLink = { title: string; subtitle?: string; icon?: string; url: string };
/** `profile.get`: the user's own study apps and school links, from ~/.dash-shared/profile.json on the hub. */
type Profile = { name: string | null; links: ProfileLink[]; studyApps: ProfileLink[] };

/** The Mac's Study page (Console/Toolbox.swift), minus local files the phone can't open. */
const skills: Tool[] = [
  { title: 'Practice Exam', subtitle: 'Mock exam + answer key from your notes', icon: 'checklist', skill: 'practice-exam-builder', starter: 'Make me a practice exam for ' },
  { title: 'Essay Outliner', subtitle: 'Thesis and structure for a paper', icon: 'list.bullet.indent', skill: 'essay-outliner', starter: 'Help me outline ' },
  { title: 'Discussion Post', subtitle: 'Draft a discussion board post', icon: 'bubble.left.and.text.bubble.right', skill: 'discussion-post-writer', starter: 'Help me write a discussion post for ' },
  { title: 'Reading Digest', subtitle: 'Summarize an assigned reading', icon: 'book.pages', skill: 'reading-digest', starter: 'Digest this reading: ' },
  { title: 'Proofread', subtitle: 'Clarity and correctness pass', icon: 'text.magnifyingglass', skill: 'proofreader-clarity-editor', starter: 'Proofread this: ' },
  { title: 'Lit Synthesizer', subtitle: 'Pull sources into an argument', icon: 'books.vertical', skill: 'literature-synthesizer', starter: 'Synthesize these sources: ' },
  { title: 'Citations', subtitle: 'Format sources and citations', icon: 'quote.opening', skill: 'citation-source-formatter', starter: 'Format these citations: ' },
];

/** A profile link as a row. One without an icon gets a plain link symbol. */
function linkTool(link: ProfileLink): Tool {
  return { title: link.title, subtitle: link.subtitle ?? '', icon: (link.icon || 'link') as SymbolViewProps['name'], url: link.url };
}

export default function StudyScreen() {
  const { client, state } = useHub();
  const theme = useTheme();
  const [profile, setProfile] = useState<Profile>();

  useEffect(() => {
    if (state === 'online') client.request<Profile>('profile.get').then(setProfile).catch(() => {});
  }, [client, state]);

  const sections: { title: string; tools: Tool[] }[] = [
    { title: 'Study skills', tools: skills },
    { title: 'Study apps', tools: (profile?.studyApps ?? []).map(linkTool) },
    { title: 'School', tools: (profile?.links ?? []).map(linkTool) },
  ].filter((section) => section.tools.length);
  const noLinks = profile && !profile.links.length && !profile.studyApps.length;

  function open(tool: Tool) {
    if ('url' in tool) {
      Linking.openURL(tool.url);
    } else {
      // A new chat on the hub with the skill loaded and its starter in the message box.
      const query = `fresh=1&skill=${encodeURIComponent(tool.skill)}&draft=${encodeURIComponent(tool.starter)}`;
      router.push(`/chat/${newChatID()}?${query}` as Href);
    }
  }

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: theme.background }}>
      <ScrollView contentContainerStyle={styles.page}>
        <Text style={[styles.title, { color: theme.text }]}>Study</Text>
        {sections.map((section) => (
          <View key={section.title} style={{ gap: Spacing.s }}>
            <Text style={[ui.caption, { color: theme.textSecondary, fontWeight: '600' }]}>{section.title.toUpperCase()}</Text>
            <View style={[styles.list, { backgroundColor: theme.card }]}>
              {section.tools.map((tool, index) => {
                const needsHub = 'skill' in tool && state !== 'online';
                return (
                  <Pressable
                    key={tool.title}
                    onPress={() => open(tool)}
                    disabled={needsHub}
                    style={({ pressed }) => [styles.row, { opacity: needsHub ? 0.4 : pressed ? 0.6 : 1 },
                      index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.separator }]}>
                    <SymbolView name={tool.icon} size={20} tintColor={theme.accent} style={{ width: 26 }} />
                    <View style={{ flex: 1 }}>
                      <Text style={[ui.body, { color: theme.text }]}>{tool.title}</Text>
                      {!!tool.subtitle && <Text style={[ui.caption, { color: theme.textSecondary }]}>{tool.subtitle}</Text>}
                    </View>
                    <SymbolView name={'url' in tool ? 'arrow.up.right' : 'chevron.right'} size={13} tintColor={theme.textSecondary} />
                  </Pressable>
                );
              })}
            </View>
          </View>
        ))}
        <Muted style={{ fontSize: 13 }}>Skills open a chat on the Dash hub. Files they make go to Documents/Dash on both computers.</Muted>
        {noLinks && <Muted style={{ fontSize: 13 }}>Add school links and study apps in ~/.dash-shared/profile.json.</Muted>}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { padding: Spacing.l, gap: Spacing.l, maxWidth: MaxContentWidth, width: '100%', alignSelf: 'center' },
  title: { fontSize: 34, fontWeight: '700' },
  list: { borderRadius: Radius.card, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.m, paddingHorizontal: Spacing.l, paddingVertical: Spacing.m },
});
