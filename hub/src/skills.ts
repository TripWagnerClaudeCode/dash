import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { paths } from './paths.ts';

export type Skill = { name: string; directory: string; instructions: string };

/** A skill's folder name: letters, digits, dots, dashes and underscores, never a path. */
export function isSkillName(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) && !name.includes('..');
}

/** A Claude Code skill from ~/.claude/skills (synced from the Mac), as Personal.swift's `Skill.load`. */
export function loadSkill(name: string): Skill | undefined {
  if (!isSkillName(name)) return undefined;
  const directory = join(paths.skills, name);
  try {
    return { name, directory, instructions: readFileSync(join(directory, 'SKILL.md'), 'utf8') };
  } catch {
    return undefined;
  }
}

/** Every skill with the first line of its `description:`, for the / picker. */
export function listSkills(): { name: string; description: string }[] {
  if (!existsSync(paths.skills)) return [];
  return readdirSync(paths.skills).sort().flatMap((name) => {
    try {
      return [{ name, description: description(readFileSync(join(paths.skills, name, 'SKILL.md'), 'utf8')) }];
    } catch {
      return [];
    }
  });
}

function description(text: string) {
  if (!text.startsWith('---')) return '';
  const end = text.indexOf('\n---', 3);
  if (end < 0) return '';
  const line = text.slice(3, end).split('\n').find((candidate) => candidate.startsWith('description:'));
  return line ? line.slice('description:'.length).trim().replace(/^[\s"'>|]+|[\s"'>|]+$/g, '') : '';
}
