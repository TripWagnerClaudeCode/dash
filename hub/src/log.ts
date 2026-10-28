import { appendFileSync, renameSync, statSync } from 'node:fs';

import { paths } from './paths.ts';

const MAX_BYTES = 2_000_000;

/** One line to hub.log (rotated at 2 MB) and to stderr, which systemd keeps in the journal. */
export function log(message: string) {
  const line = `${new Date().toISOString()} ${message}\n`;
  process.stderr.write(line);
  try {
    if ((statSync(paths.log, { throwIfNoEntry: false })?.size ?? 0) > MAX_BYTES) renameSync(paths.log, `${paths.log}.1`);
    appendFileSync(paths.log, line);
  } catch {
    // Logging must never take the hub down.
  }
}
