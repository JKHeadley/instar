/**
 * Hermetic HOME for tests that boot the Threadline stack in-process.
 *
 * `bootstrapThreadline()` registers the Threadline MCP server into the
 * user-scope `~/.claude.json` (keyed by the project dir it was given). A
 * test that calls it with a temp project dir therefore adds a junk
 * `projects["/var/folders/.../project"]` entry to the OPERATOR'S real
 * ~/.claude.json on every run — the same leak class as the 2026-10-20
 * ~/.codex/config.toml rewrite (that one is closed globally in
 * tests/vitest-setup.ts via CODEX_HOME; the Claude side is per-test because
 * HOME steers far more than one file).
 *
 * Call `useHermeticHome()` at module level in any test file that imports
 * `bootstrapThreadline`. It swaps HOME (and USERPROFILE) to a fresh temp dir
 * before the file's own `beforeAll`/`beforeEach` hooks run and restores it
 * after its `afterAll`, so `os.homedir()` — and everything built on it (the
 * ~/.instar registry, agent tokens, ~/.claude.json) — lands in ONE temp dir
 * for the whole file. File-scoped on purpose: several Threadline tests seed
 * home-relative state in beforeAll and read it in tests, so a per-test swap
 * would split setup from use. The
 * guard test tests/unit/test-setup-hermetic-codex-home.test.ts refuses any
 * test file that imports `bootstrapThreadline` without this helper (or an
 * explicit `process.env.HOME =` of its own).
 */

import { afterAll, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

export interface HermeticHomeHandle {
  /** The temp HOME in effect for this test file (set in beforeAll). */
  readonly dir: string;
}

export function useHermeticHome(): HermeticHomeHandle {
  let realHome: string | undefined;
  let realUserProfile: string | undefined;
  let dir = '';

  beforeAll(() => {
    realHome = process.env.HOME;
    realUserProfile = process.env.USERPROFILE;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-hermetic-home-'));
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
  });

  afterAll(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    if (realUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = realUserProfile;
    if (dir) {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/setup/hermetic-home.ts:cleanup' });
      dir = '';
    }
  });

  return {
    get dir() {
      return dir;
    },
  };
}
