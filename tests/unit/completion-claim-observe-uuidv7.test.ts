/**
 * Regression: the completion-claim-observe Stop hook's uuidv7() must actually RUN.
 *
 * ACT-966 (2026-07-24): uuidv7() sits at MODULE scope in the generated hook,
 * while `const crypto = await import('node:crypto')` lives inside the stdin
 * 'end' callback. A bare `crypto` at module scope therefore resolves to the
 * global WebCrypto object, which has getRandomValues but NOT randomBytes — so
 * every invocation threw `crypto.randomBytes is not a function` and the hook
 * exited 0 silently. The Verify-Before-Done observer never recorded a single
 * hook-originated observation, and nothing surfaced because the failure was
 * indistinguishable from "nothing to report".
 *
 * These tests EXECUTE the generated function rather than string-matching it.
 * A string assertion ("does it mention getRandomValues?") would have passed
 * against several broken variants; only running it proves the scope trap is
 * gone. The function is extracted from the real generated hook content, so the
 * test tracks whatever the migrator actually ships.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function generatedHookSource(): string {
  const migrator = new PostUpdateMigrator({ projectDir: os.tmpdir() } as never);
  return migrator.getHookContent('completion-claim-observe');
}

/** Pull the uuidv7 declaration out of the generated hook. */
function extractUuidv7(source: string): string {
  const start = source.indexOf('function uuidv7()');
  expect(start, 'uuidv7() not found in the generated hook').toBeGreaterThan(-1);

  // Walk braces from the function's opening brace to its matching close.
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced braces in uuidv7()');
}

/**
 * Run the extracted function at MODULE scope in a real node process — the
 * exact condition that broke. Running it inside a vitest closure would NOT
 * reproduce the bug, because the module-scope identifier resolution is the
 * whole defect.
 */
function runAtModuleScope(fnSource: string, ext: 'js' | 'mjs'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-uuidv7-'));
  const file = path.join(dir, `probe.${ext}`);
  fs.writeFileSync(file, `${fnSource}\nprocess.stdout.write(uuidv7());\n`);
  try {
    return execFileSync(process.execPath, [file], { encoding: 'utf-8' }).trim();
  } finally {
    SafeFsExecutor.safeRmSync(dir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/completion-claim-observe-uuidv7.test.ts:runAtModuleScope',
    });
  }
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('completion-claim-observe hook — uuidv7 executes at module scope', () => {
  const fnSource = extractUuidv7(generatedHookSource());

  it('does not CALL node:crypto randomBytes (the scope trap)', () => {
    // Comments are stripped first: the fix deliberately quotes the old error
    // string ("crypto.randomBytes is not a function") to explain the trap, and
    // a naive match on the raw source flags that prose. Only a real call site
    // matters — randomBytes is reachable only via the import inside an inner
    // callback, so at module scope it is guaranteed absent.
    const code = fnSource
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter(line => !line.trim().startsWith('//'))
      .join('\n');

    expect(code).not.toMatch(/crypto\s*\.\s*randomBytes\s*\(/);
    expect(code, 'the fix must use the import-free global').toMatch(/getRandomValues/);
  });

  it('produces a valid UUIDv7 when run as a CJS file', () => {
    const id = runAtModuleScope(fnSource, 'js');
    expect(id, `generated id was "${id}"`).toMatch(UUID_V7);
  });

  it('produces a valid UUIDv7 when run as an ESM file', () => {
    // The 2026 hook-event-reporter lesson: an ESM host broke a CJS-only hook.
    const id = runAtModuleScope(fnSource, 'mjs');
    expect(id, `generated id was "${id}"`).toMatch(UUID_V7);
  });

  it('emits distinct, time-ordered ids across calls', () => {
    const first = runAtModuleScope(fnSource, 'js');
    const second = runAtModuleScope(fnSource, 'js');
    expect(first).not.toBe(second);
    // uuidv7 leads with a big-endian ms timestamp, so ids sort chronologically.
    expect(second >= first).toBe(true);
  });

  it('honours CLAUDE_CONFIG_DIR when confining transcript reads', () => {
    // Second cause of ACT-966: the transcript guard hardcoded
    // ~/.claude/projects. An agent running under a custom config dir (this one
    // uses ~/.claude-followme-<name>) keeps transcripts under THAT dir, so
    // every transcript was rejected and the hook exited 0 — silently, which is
    // why fixing uuidv7 alone would still have recorded nothing here.
    const source = generatedHookSource();
    expect(source, 'the guard must consult CLAUDE_CONFIG_DIR').toContain('CLAUDE_CONFIG_DIR');
    // The default root must remain allowed so agents without the var still work.
    expect(source).toMatch(/homedir\(\)\s*,\s*'\.claude'\s*,\s*'projects'/);
  });

  it('the shipped hook still carries the observer entrypoint', () => {
    // Guards against an extraction that silently matches an unrelated file.
    const source = generatedHookSource();
    expect(source).toContain('uuidv7');
    expect(source.length).toBeGreaterThan(500);
  });
});
