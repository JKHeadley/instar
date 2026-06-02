// safe-git-allow: test-tmpdir-cleanup — afterEach removes per-test mkdtempSync tmpdir.
/**
 * Unit test for the cross-model-review frontmatter emission in
 * skills/spec-converge/scripts/write-convergence-tag.mjs (Step B §4).
 *
 * Verifies the tag writer:
 *   - writes `cross-model-review: "codex-cli:gpt-5.5"` when passed the available flag,
 *   - writes `cross-model-review: "unavailable"` + a `-reason` when unavailable,
 *   - is idempotent (re-run strips + rewrites the field, like the review-* chain),
 *   - omits the cross-model field entirely when no flag is passed (backwards-compat).
 *
 * Drives the real .mjs script via execFile (no real codex). Paths are absolute,
 * so the script's `path.resolve(ROOT, ...)` resolves to our tmp fixtures.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(
  REPO_ROOT,
  'skills',
  'spec-converge',
  'scripts',
  'write-convergence-tag.mjs',
);

let tmpDir: string;
let specPath: string;
let reportPath: string;

const SPEC_BODY = `---
title: "Test spec"
slug: "test-spec"
author: "test"
---

# Test spec

## Problem statement
A thing.

## Proposed design
Another thing.
`;

// ELI16 companion must be >= 800 chars or the script refuses to tag.
const ELI16_BODY = 'x'.repeat(900);

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'convtag-test-'));
  specPath = path.join(tmpDir, 'test-spec.md');
  reportPath = path.join(tmpDir, 'test-spec-convergence.md');
  fs.writeFileSync(specPath, SPEC_BODY, 'utf-8');
  // sibling eli16 companion: <basename>.eli16.md
  fs.writeFileSync(path.join(tmpDir, 'test-spec.eli16.md'), ELI16_BODY, 'utf-8');
  fs.writeFileSync(reportPath, '# Convergence report\n', 'utf-8');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function runTag(extraArgs: string[]): void {
  execFileSync(
    process.execPath,
    [
      SCRIPT,
      '--spec',
      specPath,
      '--iterations',
      '3',
      '--report',
      reportPath,
      ...extraArgs,
    ],
    { encoding: 'utf-8' },
  );
}

describe('write-convergence-tag.mjs cross-model-review field', () => {
  it('writes cross-model-review when passed the available flag', () => {
    runTag(['--cross-model-review', 'codex-cli:gpt-5.5']);
    const out = fs.readFileSync(specPath, 'utf-8');
    expect(out).toMatch(/cross-model-review:\s*"codex-cli:gpt-5\.5"/);
    expect(out).toMatch(/review-convergence:/);
  });

  it('writes cross-model-review: unavailable + a reason', () => {
    runTag([
      '--cross-model-review',
      'unavailable',
      '--cross-model-reason',
      'codex-not-installed',
    ]);
    const out = fs.readFileSync(specPath, 'utf-8');
    expect(out).toMatch(/cross-model-review:\s*"unavailable"/);
    expect(out).toMatch(/cross-model-review-reason:\s*"codex-not-installed"/);
  });

  it('quotes a degraded value containing a colon + parens so YAML stays valid', () => {
    runTag(['--cross-model-review', 'codex-cli:gpt-5.5 (degraded: timeout)']);
    const out = fs.readFileSync(specPath, 'utf-8');
    expect(out).toMatch(/cross-model-review:\s*"codex-cli:gpt-5\.5 \(degraded: timeout\)"/);
  });

  it('is idempotent — a second run rewrites, not duplicates, the field', () => {
    runTag(['--cross-model-review', 'unavailable', '--cross-model-reason', 'codex-not-installed']);
    runTag(['--cross-model-review', 'codex-cli:gpt-5.5']);
    const out = fs.readFileSync(specPath, 'utf-8');
    const occurrences = (out.match(/^cross-model-review:/gm) ?? []).length;
    expect(occurrences).toBe(1);
    expect(out).toMatch(/cross-model-review:\s*"codex-cli:gpt-5\.5"/);
    // the stale reason from the first run must be gone
    expect(out).not.toMatch(/cross-model-review-reason:/);
  });

  it('omits the cross-model field when no flag is passed (backwards-compat)', () => {
    runTag([]);
    const out = fs.readFileSync(specPath, 'utf-8');
    expect(out).not.toMatch(/cross-model-review:/);
    expect(out).toMatch(/review-convergence:/);
  });
});
