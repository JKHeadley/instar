import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

/**
 * `lint-sync-subprocess-chokepoint` is the forward ratchet for tmux event-loop
 * resilience: a SYNCHRONOUS subprocess spawn blocks the single-threaded event
 * loop for the child's whole lifetime, so outside the marker funnel a raw sync
 * spawn is banned. The incident behind it: a blocked-but-alive server looked
 * dead to its supervisor and was restarted for being busy.
 *
 * It matched the spawn NAME on the call line, so two ordinary forms walked past
 * while the plain call was caught:
 *
 *     import { execFileSync as run } from 'node:child_process';  run(...);
 *     const ex = execFileSync;                                   ex(...);
 *
 * A renamed import is not an evasion; it is how people avoid a name collision.
 *
 * MEASURED BEFORE BUILDING, and it changed the scope: the VIOLATION regex also
 * excludes a DOT-prefixed name, and that exclusion is RIGHT. All 14
 * namespace-form occurrences in the scanned directories are either calls
 * through `SafeGitExecutor` (the audited git funnel — 13 of them) or sit inside
 * a generated hook script's template literal, which runs in its own process and
 * cannot block this event loop. Widening to dot-prefixed names would flag the
 * funnel itself. That is left alone deliberately, and pinned below so a future
 * reader does not "fix" it.
 */

const ROOT = path.resolve(__dirname, '..', '..');
const LINT = path.join(ROOT, 'scripts', 'lint-sync-subprocess-chokepoint.js');

let sandbox: string;
let baseline: string;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-spawn-lint-'));
  fs.mkdirSync(path.join(sandbox, 'src', 'core'), { recursive: true });
  baseline = path.join(sandbox, 'baseline.json');
  fs.writeFileSync(baseline, JSON.stringify({ keys: [] }), 'utf-8');
});
afterEach(() => {
  // Through the funnel, not around it — the same rule this file is defending.
  SafeFsExecutor.safeRmSync(sandbox, { operation: 'tests/unit/sync-spawn-alias-resolution.test.ts:teardown', recursive: true, force: true });
});

/** Run the lint against an isolated root so the real baseline never applies. */
function lint(source: string, name = 'probe.ts'): number {
  fs.writeFileSync(path.join(sandbox, 'src', 'core', name), source, 'utf-8');
  try {
    execFileSync('node', [LINT, '--root', sandbox, '--baseline', baseline], {
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    return 0;
  } catch (err: any) {
    return err.status ?? -1;
  }
}

describe('CONTROL — the plain form the lint already caught still fires', () => {
  it('flags a raw execFileSync call', () => {
    // The positive control. Without it, a run where everything returns 0 cannot
    // distinguish "no violations" from "the lint did not scan anything".
    expect(lint([
      'import { execFileSync } from "node:child_process";',
      'export function t() { return execFileSync("tmux", ["ls"]); }',
    ].join('\n'))).toBe(1);
  });
});

describe('THE DEFECT — bound names that walked past the ratchet', () => {
  it('flags a spawn reached through a local alias', () => {
    expect(lint([
      'import { execFileSync } from "node:child_process";',
      'const ex = execFileSync;',
      'export function t() { return ex("tmux", ["ls"]); }',
    ].join('\n'))).toBe(1);
  });

  it('flags a spawn reached through a renamed import', () => {
    // Ordinary code — this is how a name collision gets resolved, not a dodge.
    expect(lint([
      'import { execFileSync as run2 } from "node:child_process";',
      'export function t() { return run2("tmux", ["ls"]); }',
    ].join('\n'))).toBe(1);
  });

  it('resolves an alias declared BELOW the function that uses it', () => {
    expect(lint([
      'import { execFileSync } from "node:child_process";',
      'export function t() { return ex("tmux", ["ls"]); }',
      'const ex = execFileSync;',
    ].join('\n'))).toBe(1);
  });

  it('flags spawnSync and execSync through the same route', () => {
    expect(lint([
      'import { spawnSync as sp } from "node:child_process";',
      'export function t() { return sp("tmux", ["ls"]); }',
    ].join('\n'), 'spawn.ts')).toBe(1);
  });
});

describe('CONTROL — the existing escapes still win over the new reach', () => {
  it('does not flag an aliased spawn wrapped by withSyncOp', () => {
    // The funnel is the REQUIRED pattern. If resolution overrode it, the fix
    // would punish exactly the code the rule is trying to produce.
    expect(lint([
      'import { execFileSync } from "node:child_process";',
      'import { withSyncOp } from "./InFlightSyncOpMarker.js";',
      'const ex = execFileSync;',
      'export function t() { return withSyncOp(() => ex("tmux", ["ls"])); }',
    ].join('\n'))).toBe(0);
  });

  it('does not flag an aliased spawn carrying an allow-comment', () => {
    expect(lint([
      'import { execFileSync } from "node:child_process";',
      'const ex = execFileSync;',
      '// lint-allow-sync-spawn: CLI boot only, never on a cadence',
      'export function t() { return ex("tmux", ["ls"]); }',
    ].join('\n'))).toBe(0);
  });
});

describe('CONTROL — over-block (this lint fails builds)', () => {
  it('does not flag an unrelated identifier that merely shares the name', () => {
    expect(lint([
      'const ex = (a: string) => a;',
      'export function t() { return ex("nothing to do with spawning"); }',
    ].join('\n'))).toBe(0);
  });

  it('does not flag a method call on an object that shares the name', () => {
    // Same dot-exclusion as the original rule: `obj.ex(...)` is a method on
    // something else, not the bound spawn.
    expect(lint([
      'import { execFileSync } from "node:child_process";',
      'const ex = execFileSync;',
      'export function t() { return (globalThis as any).helper.ex("x"); }',
    ].join('\n'))).toBe(0);
  });

  it('does not flag a file with no sync spawn at all', () => {
    expect(lint('export function t() { return 1; }')).toBe(0);
  });
});

describe('the dot-exclusion is DELIBERATE — pinned so it is not "fixed" later', () => {
  it('does not flag a call through the audited git funnel', () => {
    // 13 of the 14 namespace-form occurrences in the scanned dirs are exactly
    // this. Flagging them would flag going THROUGH the funnel as going around
    // it — the precise inversion of the rule.
    expect(lint([
      'import { SafeGitExecutor } from "./SafeGitExecutor.js";',
      'export function t() { return SafeGitExecutor.execSync("git status"); }',
    ].join('\n'))).toBe(0);
  });

  it('does not flag a namespace-qualified spawn', () => {
    // The remaining one of the 14 sits inside a generated hook script's
    // template literal — its own process, blocking nothing here. Left alone on
    // measurement, not on assumption.
    expect(lint([
      'import * as cp from "node:child_process";',
      'export function t() { return cp.execFileSync("tmux", ["ls"]); }',
    ].join('\n'))).toBe(0);
  });
});
