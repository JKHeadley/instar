/**
 * Unit tests — analyze-release.js emits the silent-by-default user_announcement
 * block, and it round-trips through the canonical TS parser
 * (mature-update-announcements spec, D3 + wiring integrity across the JS↔TS
 * boundary).
 *
 * The load-bearing guarantee: the structure the release analyzer WRITES is
 * exactly the structure the notify-side READS, and its DEFAULT is silence
 * (every drafted entry is `audience: agent-only`, so zero user-facing entries
 * until a human deliberately promotes one).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  parseUserAnnouncement,
  userFacingEntries,
} from '../../src/core/upgradeAnnouncement.js';

describe('analyze-release.js user_announcement front-matter', () => {
  let tmpDir: string;
  const scriptPath = path.resolve(__dirname, '../../scripts/analyze-release.js');

  const git = (args: string[]) =>
    SafeGitExecutor.run(args, { cwd: tmpDir, operation: 'tests/unit/analyze-release-announcement.test.ts:git' });

  function commit(message: string, file: string, body = 'x') {
    const full = path.join(tmpDir, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `${body}\n`);
    git(['add', '-A']);
    git(['commit', '-m', message]);
  }

  function draft(): { exitCode: number } {
    const localScript = path.join(tmpDir, 'scripts', 'analyze-release.js');
    try {
      execSync(`node "${localScript}" --draft-guide`, {
        cwd: tmpDir,
        encoding: 'utf-8',
        env: { ...process.env, NODE_PATH: '' },
      });
      return { exitCode: 0 };
    } catch (err: any) {
      return { exitCode: err.status || 1 };
    }
  }

  // Run the analyzer's MAIN path (no --draft-guide). log() writes to stderr; the
  // forgot-block advisory lands there. The analyzer may exit non-zero on
  // coverage gaps — we only care about the captured stderr either way.
  function analyze(): string {
    const localScript = path.join(tmpDir, 'scripts', 'analyze-release.js');
    // Merge stderr→stdout so the log()-based advisory is captured regardless of
    // exit code.
    try {
      return execSync(`node "${localScript}" 2>&1`, {
        cwd: tmpDir,
        encoding: 'utf-8',
        env: { ...process.env, NODE_PATH: '' },
      });
    } catch (err: any) {
      return `${err.stdout || ''}${err.stderr || ''}`;
    }
  }

  const writeGuide = (content: string) =>
    fs.writeFileSync(path.join(tmpDir, 'upgrades', 'NEXT.md'), content);

  const nextMd = () => fs.readFileSync(path.join(tmpDir, 'upgrades', 'NEXT.md'), 'utf-8');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analyze-release-ann-'));
    const scriptsDir = path.join(tmpDir, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(scriptsDir, 'analyze-release.js'), fs.readFileSync(scriptPath, 'utf-8'));
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '9.9.9', type: 'module' }, null, 2),
    );
    fs.mkdirSync(path.join(tmpDir, 'upgrades'), { recursive: true });

    git(['init', '-q']);
    git(['config', 'user.email', 'fixture@instar.local']);
    git(['config', 'user.name', 'Fixture']);
    git(['config', 'commit.gpgsign', 'false']);
    commit('chore: initial', 'README.md');
    git(['tag', 'v0.0.1']);
    commit('feat: add widget endpoint', 'src/server/routes.ts', "router.post('/widget', h)");
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/analyze-release-announcement.test.ts:afterEach',
    });
  });

  it('emits a user_announcement block defaulting every entry to agent-only', () => {
    expect(draft().exitCode).toBe(0);
    const md = nextMd();
    expect(md).toContain('user_announcement:');
    expect(md).toContain('audience: agent-only');
    expect(md).not.toContain('audience: user');
    // The H1 + bump marker are still present (front-matter sits above them).
    expect(md).toContain('# Upgrade Guide — vNEXT');
    expect(md).toContain('<!-- bump:');
  });

  it('round-trips: the parser reads the emitted block as ZERO user-facing entries (silent)', () => {
    expect(draft().exitCode).toBe(0);
    const entries = parseUserAnnouncement(nextMd());
    // The block parses (it is well-formed)…
    expect(entries.length).toBeGreaterThan(0);
    // …but nothing is user-facing by default, so no user message would be composed.
    expect(userFacingEntries(entries)).toEqual([]);
  });

  it('the front-matter parses before the H1 without breaking the guide body', () => {
    expect(draft().exitCode).toBe(0);
    const md = nextMd();
    // Front-matter is the very first thing in the file.
    expect(md.startsWith('---\n')).toBe(true);
    expect(md).toContain('## What Changed');
  });

  describe('forgot-block author advisory (main path)', () => {
    const BODY =
      '# Upgrade Guide — vNEXT\n<!-- bump: minor -->\n## What Changed\nAdded POST /widget.\n' +
      '## What to Tell Your User\n- new widget\n## Summary of New Capabilities\n| widget | POST /widget |\n';

    it('warns when a guide with user-relevant changes has no user_announcement block', () => {
      writeGuide(BODY); // no front-matter block
      const out = analyze();
      expect(out).toContain('user-relevant change');
      expect(out).toContain('no `user_announcement` block');
    });

    it('does NOT warn when the guide carries a user_announcement block', () => {
      writeGuide(
        `---\nuser_announcement:\n  - audience: agent-only\n    maturity: experimental\n    headline: Widget\n    body: x\n---\n${BODY}`,
      );
      const out = analyze();
      expect(out).not.toContain('has no `user_announcement` block');
    });
  });
});
