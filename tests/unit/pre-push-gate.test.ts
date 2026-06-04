/**
 * Unit tests — Pre-push gate validation.
 *
 * Ensures the fast pre-push gate correctly validates:
 * - NEXT.md existence and required sections
 * - Version increment from latest published guide
 *
 * These tests verify the gate logic WITHOUT running the actual script,
 * since the script reads from the real filesystem.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const gatePath = path.join(ROOT, 'scripts', 'pre-push-gate.js');

describe('Pre-push gate script', () => {
  it('exists', () => {
    expect(fs.existsSync(gatePath)).toBe(true);
  });

  it('parses without crashing when invoked against the live repo state', () => {
    // The gate's job is to surface errors as exit code 1 with messages, not
    // to always pass against an arbitrary repo state. This test only asserts
    // the script can be invoked end-to-end without a parse/import error —
    // any exit code is acceptable. Detailed validation is covered by the
    // integration tests in the second describe block.
    const result = spawnSync('node', [gatePath], {
      cwd: ROOT,
      encoding: 'utf-8',
    });
    expect(result.status === 0 || result.status === 1).toBe(true);
    // No stack trace = no syntax error / import error
    const combined = `${result.stdout}\n${result.stderr}`;
    expect(combined).not.toMatch(/SyntaxError|Cannot find module|TypeError/);
  });

  it('delegates section + content validation to upgrade-guide-validator.mjs', () => {
    const content = fs.readFileSync(gatePath, 'utf-8');
    // The gate now imports validateGuideContent — the shared single source of
    // truth shared with check-upgrade-guide.js (publish-time gate).
    expect(content).toContain("from './upgrade-guide-validator.mjs'");
    expect(content).toContain('validateGuideContent(content)');
  });

  it('lists required sections in the "no upgrade guide found" error', () => {
    const content = fs.readFileSync(gatePath, 'utf-8');
    expect(content).toContain('## What Changed');
    expect(content).toContain('## What to Tell Your User');
    expect(content).toContain('## Summary of New Capabilities');
  });

  it('validates version is not lower than latest published', () => {
    const content = fs.readFileSync(gatePath, 'utf-8');
    expect(content).toContain('LOWER than the latest published guide');
  });

  it('warns when version matches latest published (no bump)', () => {
    const content = fs.readFileSync(gatePath, 'utf-8');
    expect(content).toContain('Did you forget to bump the version');
  });

  it('errors when src/ changed but no release-note fragment was added (#23)', () => {
    const content = fs.readFileSync(gatePath, 'utf-8');
    // The guard mirrors the src→tests check: it inspects the branch diff for a
    // src/ change with no upgrades/next/<slug>.md (or NEXT.md) fragment — which
    // would make publish.yml silently skip the release.
    expect(content).toContain('no release-note fragment was added');
    expect(content).toContain('SILENTLY SKIPS');
    expect(content).toContain("f.startsWith('upgrades/next/')");
  });

  it('verifies the internal-only lane marker against the diff (objective gate)', () => {
    // Like #23 above, the git-diff path is exercised by source inspection here;
    // the behavioural core (marker detection + assembler auto-fill) is covered by
    // tests/unit/assemble-next-md.test.ts. This asserts the gate REJECTS an
    // <!-- internal-only --> fragment that accompanies a runtime src/ change, so
    // the marker (which lets a fragment skip the user-facing sections) can't be
    // misused to hide a user-facing change.
    const content = fs.readFileSync(gatePath, 'utf-8');
    expect(content).toContain('hasInternalOnlyMarker');
    expect(content).toContain('Internal-only release fragment(s) accompany');
    expect(content).toContain('internalOnlyFragments.length > 0 && srcChanges.length > 0');
  });
});

// ── Integration: malformed NEXT.md rejection ─────────────────────────
//
// Regression for the 2-day silent publish failure on 2026-05-13–15: the
// upgrade-guide validator runs at publish time, but the pre-push gate did
// not include the same checks. Malformed NEXT.md (inline code in WTTYU,
// camelCase config keys in WTTYU, missing Evidence when fixes are claimed)
// passed pre-push, merged on main, then silently failed the publish
// workflow — dropping multiple releases until a human noticed.
//
// These tests run the actual gate script against a malformed NEXT.md fixture
// in a tmp working directory + assert non-zero exit + the right error text.

import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('Pre-push gate integration — malformed NEXT.md', () => {
  let scratch: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'prepush-gate-int-'));
    // Build a minimal repo layout: package.json + scripts/ + upgrades/.
    fs.mkdirSync(path.join(scratch, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(scratch, 'upgrades'), { recursive: true });
    fs.writeFileSync(
      path.join(scratch, 'package.json'),
      JSON.stringify({ name: 'instar-test', version: '0.28.999' }),
    );
    // COPY (not symlink) the real gate + validator + lint scripts into the
    // scratch repo. Node resolves symlinks for import.meta.url, so a symlinked
    // script would still see the production __dirname and walk the production
    // tree — making the integration test sensitive to unrelated changes in
    // the rest of the repo. Copying isolates the test to its scratch dir.
    for (const file of ['pre-push-gate.js', 'upgrade-guide-validator.mjs', 'assemble-next-md.mjs', 'lint-no-direct-destructive.js', 'lint-no-direct-llm-http.js']) {
      fs.copyFileSync(
        path.join(ROOT, 'scripts', file),
        path.join(scratch, 'scripts', file),
      );
    }
    // Also need a src/ dir for the URL.pathname grep step (empty is fine).
    fs.mkdirSync(path.join(scratch, 'src'), { recursive: true });
    // Side-effects artifact directory must exist with at least one recent
    // entry for the "well-formed" case, since the gate requires it whenever
    // What Changed mentions add/new/feature/fix words. Tests that want to
    // assert REJECTION on a separate failure can leave this empty.
    fs.mkdirSync(path.join(scratch, 'upgrades', 'side-effects'), { recursive: true });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(scratch, { recursive: true, force: true, operation: 'tests/unit/pre-push-gate.test.ts:afterEach' });
  });

  function runGate(): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [path.join(scratch, 'scripts', 'pre-push-gate.js')], {
      cwd: scratch,
      encoding: 'utf-8',
      env: { ...process.env, CI: '', NODE_ENV: 'test' },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it('REJECTS malformed NEXT.md with inline code in "What to Tell Your User"', () => {
    fs.writeFileSync(
      path.join(scratch, 'upgrades', 'NEXT.md'),
      [
        '# Upgrade Guide — vNEXT',
        '',
        '<!-- bump: patch -->',
        '',
        '## What Changed',
        '',
        'A general improvement to the agent infrastructure.',
        '',
        '## What to Tell Your User',
        '',
        // VIOLATION: backtick-inline code in user-facing text
        'Your agent will now read from `~/.instar/config.json` automatically.',
        '',
        '## Summary of New Capabilities',
        '',
        '| Capability | How to Use |',
        '|-----------|-----------|',
        '| Auto-config read | automatic |',
        '',
      ].join('\n'),
    );

    const { status, stdout } = runGate();
    expect(status).not.toBe(0);
    expect(stdout).toContain('contains inline code');
  });

  it('REJECTS malformed NEXT.md with camelCase config key in "What to Tell Your User"', () => {
    fs.writeFileSync(
      path.join(scratch, 'upgrades', 'NEXT.md'),
      [
        '# Upgrade Guide — vNEXT',
        '',
        '<!-- bump: patch -->',
        '',
        '## What Changed',
        '',
        'A general improvement to the agent infrastructure.',
        '',
        '## What to Tell Your User',
        '',
        // VIOLATION: camelCase config key reference
        'To opt in, set the flag silentReject: true in your configuration.',
        '',
        '## Summary of New Capabilities',
        '',
        '| Capability | How to Use |',
        '|-----------|-----------|',
        '| Silent reject | automatic |',
        '',
      ].join('\n'),
    );

    const { status, stdout } = runGate();
    expect(status).not.toBe(0);
    expect(stdout).toContain('camelCase config key reference');
  });

  it('REJECTS NEXT.md that claims a fix but has no "## Evidence" section', () => {
    fs.writeFileSync(
      path.join(scratch, 'upgrades', 'NEXT.md'),
      [
        '# Upgrade Guide — vNEXT',
        '',
        '<!-- bump: patch -->',
        '',
        '## What Changed',
        '',
        'Fix the misbehavior in the recovery path that was producing duplicate messages.',
        '',
        '## What to Tell Your User',
        '',
        'I fixed a bug that was producing duplicate messages in recovery.',
        '',
        '## Summary of New Capabilities',
        '',
        '| Capability | How to Use |',
        '|-----------|-----------|',
        '| Recovery dedupe | automatic |',
        '',
      ].join('\n'),
    );

    const { status, stdout } = runGate();
    expect(status).not.toBe(0);
    expect(stdout).toContain('has no "## Evidence" section');
  });

  it('ACCEPTS a well-formed NEXT.md (no fix-claim, no violations)', () => {
    // Side-effects artifact for the "improvement" claim (gate detects
    // add/new/feature words and requires an artifact within the last 24h).
    fs.writeFileSync(
      path.join(scratch, 'upgrades', 'side-effects', 'test-artifact.md'),
      '# Side-Effects Review (test scratch)\n\nMinimal placeholder.\n',
    );
    fs.writeFileSync(
      path.join(scratch, 'upgrades', 'NEXT.md'),
      [
        '# Upgrade Guide — vNEXT',
        '',
        '<!-- bump: patch -->',
        '',
        '## What Changed',
        '',
        // Note: no fix-keyword, so no Evidence section required.
        'A small improvement to the agent infrastructure.',
        '',
        '## What to Tell Your User',
        '',
        'Your agent picked up a small infrastructure tune-up. Nothing changes about how it talks to you.',
        '',
        '## Summary of New Capabilities',
        '',
        '| Capability | How to Use |',
        '|-----------|-----------|',
        '| Tune-up | automatic |',
        '',
      ].join('\n'),
    );

    const { status } = runGate();
    expect(status).toBe(0);
  });
});

// ── Integration: fragment-aware validation ───────────────────────────
//
// Release notes are now authored as per-PR fragments (upgrades/next/<slug>.md)
// so concurrent PRs never collide on a shared NEXT.md. The pre-push gate must
// validate the ASSEMBLED result so a PR that ships ONLY a fragment (no NEXT.md)
// still passes the same section/content checks. It must also reject a malformed
// fragment loudly, and must NOT write a generated NEXT.md to disk.

describe('Pre-push gate integration — release-note fragments', () => {
  let scratch: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'prepush-frag-'));
    fs.mkdirSync(path.join(scratch, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(scratch, 'upgrades', 'next'), { recursive: true });
    fs.mkdirSync(path.join(scratch, 'upgrades', 'side-effects'), { recursive: true });
    fs.mkdirSync(path.join(scratch, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(scratch, 'package.json'),
      JSON.stringify({ name: 'instar-test', version: '0.28.999' }),
    );
    for (const file of ['pre-push-gate.js', 'upgrade-guide-validator.mjs', 'assemble-next-md.mjs', 'lint-no-direct-destructive.js', 'lint-no-direct-llm-http.js']) {
      fs.copyFileSync(path.join(ROOT, 'scripts', file), path.join(scratch, 'scripts', file));
    }
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(scratch, { recursive: true, force: true, operation: 'tests/unit/pre-push-gate.test.ts:afterEach' });
  });

  function runGate(): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [path.join(scratch, 'scripts', 'pre-push-gate.js')], {
      cwd: scratch,
      encoding: 'utf-8',
      env: { ...process.env, CI: '', NODE_ENV: 'test' },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it('ACCEPTS a fragment-only push (no NEXT.md) and writes no NEXT.md', () => {
    fs.writeFileSync(
      path.join(scratch, 'upgrades', 'side-effects', 'frag-artifact.md'),
      '# Side-Effects Review (test scratch)\n\nMinimal placeholder.\n',
    );
    fs.writeFileSync(
      path.join(scratch, 'upgrades', 'next', 'my-feature.md'),
      [
        '# Upgrade Guide — vNEXT',
        '',
        '<!-- bump: minor -->',
        '',
        '## What Changed',
        '',
        'A small improvement to the agent infrastructure.',
        '',
        '## What to Tell Your User',
        '',
        'Your agent picked up a small tune-up. Nothing changes about how it talks to you.',
        '',
        '## Summary of New Capabilities',
        '',
        '| Capability | How to Use |',
        '|-----------|-----------|',
        '| Tune-up | automatic |',
        '',
      ].join('\n'),
    );

    const { status } = runGate();
    expect(status).toBe(0);
    // The gate assembles in-memory only — it must NOT leave a NEXT.md on disk.
    expect(fs.existsSync(path.join(scratch, 'upgrades', 'NEXT.md'))).toBe(false);
    // The fragment itself is untouched.
    expect(fs.existsSync(path.join(scratch, 'upgrades', 'next', 'my-feature.md'))).toBe(true);
  });

  it('REJECTS a fragment-only push when WTTYU has inline code (validates assembled result)', () => {
    fs.writeFileSync(
      path.join(scratch, 'upgrades', 'next', 'bad-wttyu.md'),
      [
        '# Upgrade Guide — vNEXT',
        '',
        '<!-- bump: patch -->',
        '',
        '## What Changed',
        '',
        'A general improvement.',
        '',
        '## What to Tell Your User',
        '',
        'Your agent now reads from `~/.instar/config.json` automatically.',
        '',
        '## Summary of New Capabilities',
        '',
        '| Capability | How to Use |',
        '|-----------|-----------|',
        '| Auto-config | automatic |',
        '',
      ].join('\n'),
    );

    const { status, stdout } = runGate();
    expect(status).not.toBe(0);
    expect(stdout).toContain('contains inline code');
  });

  it('REJECTS a malformed fragment (no "## " section) loudly', () => {
    fs.writeFileSync(
      path.join(scratch, 'upgrades', 'next', 'broken.md'),
      'just some prose with no section headings at all',
    );

    const { status, stdout } = runGate();
    expect(status).not.toBe(0);
    expect(stdout).toContain('Release-note fragments are malformed');
  });
});
