import { useEffect, useState } from 'react';

import type { ChatLive, ChatMeta, HubClient, Turn } from '@/lib/hub';

export type ChatView = {
  meta?: ChatMeta;
  turns: Turn[];
  status: ChatLive['status'];
  stopping: boolean;
  notice: string | null;
  approvals: ChatLive['approvals'];
  queue: ChatLive['queue'];
  /** False until the hub has sent the whole chat (a brand-new chat counts as loaded). */
  loaded: boolean;
};

const empty: ChatView = { turns: [], status: 'idle', stopping: false, notice: null, approvals: [], queue: [], loaded: false };

/** The Portfolio advisor's chat on the hub (hub/src/chats.ts ADVISOR_ID). */
export const ADVISOR_ID = '00000000-0000-4000-8000-0000000000AD';

/** Chat ids are UUIDs in capitals, like the Mac makes them, so ids compare as plain strings. */
export function newChatID(): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('').toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${'89AB'[Math.floor(Math.random() * 4)]}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * One chat, live: the whole transcript once (`chat.open`), then `chat` events that carry the last two
 * turns and the state, merged the way Mac Dash does it. A chat the hub doesn't know yet is a new one.
 */
export function useChat(client: HubClient, id: string, online: boolean, known: boolean): ChatView {
  // Kept per chat id, so switching chats shows the new one's state, never the last one's.
  const [entry, setEntry] = useState<{ id: string; view: ChatView }>();

  useEffect(() => {
    let current: ChatView = { ...empty, loaded: !known };
    const apply = (live: ChatLive) => {
      if (live.id !== id) return;
      let turns = current.turns;
      if (live.turns) {
        turns = live.turns;
      } else {
        const keep = live.count - live.tail.length;
        if (keep < 0 || keep > turns.length) {
          // Missed something (the phone was asleep): fetch the whole chat again.
          client.request<ChatLive>('chat.open', { chat: id }).then(apply).catch(() => {});
          return;
        }
        turns = [...turns.slice(0, keep), ...live.tail];
      }
      current = { meta: live.meta, turns, status: live.status, stopping: live.stopping, notice: live.notice,
                  approvals: live.approvals, queue: live.queue, loaded: true };
      setEntry({ id, view: current });
    };
    const stop = client.on('chat', apply);
    if (online && known) {
      // A chat the hub doesn't have (the advisor before its first session) just starts empty.
      client.request<ChatLive>('chat.open', { chat: id }).then(apply)
        .catch(() => setEntry({ id, view: { ...empty, loaded: true } }));
    }
    return stop;
  }, [client, id, online, known]);

  return entry?.id === id ? entry.view : { ...empty, loaded: !known };
}

/** The history list, newest first. */
export function useChatList(client: HubClient, online: boolean): ChatMeta[] {
  const [chats, setChats] = useState<ChatMeta[]>([]);
  useEffect(() => {
    const stop = client.on('chats', (data) => setChats(data.chats));
    if (online) client.request<{ chats: ChatMeta[] }>('chat.list').then((data) => setChats(data.chats)).catch(() => {});
    return stop;
  }, [client, online]);
  return chats;
}

/** "Checking calendar" rather than "mcp__jarvis__calendar_get" (Tools.label in the Mac app). */
export function toolLabel(name: string): string {
  const short = name.replace('mcp__jarvis__', '');
  const labels: Record<string, string> = {
    calendar_get: 'Checking calendar', calendar_create: 'Add calendar event', calendar_delete: 'Delete calendar event',
    email_read: 'Reading inbox', email_send: 'Send email', email_delete: 'Delete email', weather_get: 'Checking weather',
    web_search: 'Searching the web', file_read: 'Reading a file', Read: 'Reading a file', file_write: 'Write file',
    Write: 'Write file', Edit: 'Edit file', Glob: 'Looking through files', Grep: 'Looking through files',
    docs_read_section: 'Reading lecture notes', docs_append_notes: 'Add to lecture notes',
    docs_replace_section: 'Replace lecture notes', WebSearch: 'Searching the web', WebFetch: 'Reading a web page',
    Bash: 'Run command', Task: 'Subagent',
  };
  return labels[short] ?? short;
}

const fieldOrder = ['to', 'subject', 'body', 'title', 'start', 'end', 'description', 'command', 'file_path', 'path',
                    'course_code', 'date', 'content', 'old_string', 'new_string', 'text'];

/** An approval's arguments in a readable order (Tools.fields in the Mac app). */
export function approvalFields(input: Record<string, unknown>): [string, string][] {
  const rank = (key: string) => (fieldOrder.includes(key) ? fieldOrder.indexOf(key) : 99);
  return Object.entries(input)
    .map(([key, value]): [string, string] => [key, typeof value === 'string' ? value : JSON.stringify(value, null, 2)])
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]));
}
