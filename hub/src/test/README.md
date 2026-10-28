Extra selftest files. `npm run selftest` runs `src/selftest.ts`, then every `*.test.ts` here in turn.

Each file is a standalone script: set `process.env.DASH_DATA` to a fresh `mkdtempSync` folder (and
`TZ ??= 'America/New_York'`) **before** importing anything from `../paths.ts`, print `✓`/`✗` lines,
and `process.exit(1)` if any check failed. Never touch the real Documents, Desktop or ~/.claude.
