import { type FSWatcher, readFileSync, renameSync, watch, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';

import { log } from './log.ts';
import { paths } from './paths.ts';

const HEADER = '# To-do\n\n';

/**
 * The user's own to-do list (ported from ToDoList.swift): a markdown checklist of "- [ ] item" lines that
 * the apps and chats all edit. Adding appends one line and removing deletes one line, on top of the file
 * as it is now, so anything else in it (notes, headings, items checked off by hand) stays put.
 */
export class ToDoList {
  items: string[] = [];
  private lastText?: string;
  private listeners = new Set<() => void>();
  private watcher?: FSWatcher;
  private readonly file: string;

  constructor(file = paths.todo) {
    this.file = file;
    this.reload();
  }

  onChange(listener: () => void) {
    this.listeners.add(listener);
  }

  /** Watches the folder rather than the file: saving by rename replaces the file, which a file watch would lose. */
  watch() {
    const name = basename(this.file);
    this.watcher = watch(dirname(this.file), (_event, changed) => {
      if (!changed || changed === name) this.reload();
    });
  }

  stop() {
    this.watcher?.close();
  }

  reload() {
    let text = '';
    try {
      text = readFileSync(this.file, 'utf8');
    } catch {}
    if (text === this.lastText) return;
    this.lastText = text;
    this.items = parse(text);
    this.listeners.forEach((listener) => listener());
  }

  add(text: string) {
    const trimmed = text.trim().replace(/\s*\n\s*/g, ' ');
    if (!trimmed) return;
    this.change((lines) => {
      // Before any trailing blank lines, so the new item sits with the others.
      let end = lines.length;
      while (end > 0 && !lines[end - 1].trim()) end -= 1;
      return [...lines.slice(0, end), `- [ ] ${trimmed}`, ...lines.slice(end)];
    });
  }

  /** Removes the first unchecked line with this text (checking off and deleting are the same thing here). */
  remove(text: string) {
    this.change((lines) => {
      const index = lines.findIndex((line) => itemText(line) === text);
      return index < 0 ? lines : lines.toSpliced(index, 1);
    });
  }

  /** The list as plain lines for the daily brief. */
  get summary() {
    return this.items.length ? this.items.map((item) => `- ${item}`).join('\n') : '(empty)';
  }

  /** Edits the file's lines as they are now (a new file starts with the "# To-do" heading). */
  private change(edit: (lines: string[]) => string[]) {
    this.reload();
    const current = this.lastText?.trim() ? this.lastText : HEADER;
    const lines = current.replace(/\n$/, '').split('\n');
    const text = `${edit(lines).join('\n')}\n`;
    const items = parse(text);
    try {
      const temp = `${this.file}.tmp`;
      writeFileSync(temp, text);
      renameSync(temp, this.file);
    } catch (error) {
      log(`todo save failed: ${(error as Error).message}`);
      return;
    }
    this.lastText = text;
    this.items = items;
    this.listeners.forEach((listener) => listener());
  }
}

/** The text of every unchecked "- [ ] …" line. Lines checked by hand ("- [x]") count as done. */
function parse(text: string): string[] {
  return text.split('\n').flatMap((line) => {
    const item = itemText(line);
    return item ? [item] : [];
  });
}

function itemText(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('- [ ] ')) return undefined;
  return trimmed.slice(6).trim() || undefined;
}
