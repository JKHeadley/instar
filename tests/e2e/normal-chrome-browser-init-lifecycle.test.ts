/**
 * Fresh-install lifecycle (production scaffold path): `instar init --standalone` produces
 * the /normal-chrome-browser skill (both driver sections), the five .instar/scripts/browser/
 * helpers (executable; the macOS ones resolving profiles relative to the agent home) and the
 * macOS + Windows CLAUDE.md awareness section.
 * Specs: docs/specs/normal-chrome-builtin-skill.md, docs/specs/normal-chrome-cross-platform.md.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { initProject, BROWSER_SCRIPT_NAMES } from '../../src/commands/init.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('fresh init delivers the normal-Chrome browser method', () => {
  let tmpHome: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-normal-chrome-init-'));
    prevHome = process.env.HOME;
    process.env.HOME = tmpHome;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    SafeFsExecutor.safeRmSync(tmpHome, { recursive: true, force: true, operation: 'tests/e2e/normal-chrome-browser-init-lifecycle.test.ts' });
  });

  it('standalone init installs skill, scripts and awareness; the scripts resolve profiles under the agent home', async () => {
    const agentName = 'nc-' + Math.random().toString(36).slice(2, 8);
    await initProject({ name: agentName, standalone: true, port: 4097, skipPrereqs: true });
    const agentDir = path.join(tmpHome, '.instar', 'agents', agentName);

    const skill = fs.readFileSync(path.join(agentDir, '.claude', 'skills', 'normal-chrome-browser', 'SKILL.md'), 'utf-8');
    expect(skill).toContain('# /normal-chrome-browser');
    expect(skill).toContain('### macOS: Apple Events tools');
    expect(skill).toContain('### Windows: `native-drive.ps1` through `ndrive.sh`');
    const md = fs.readFileSync(path.join(agentDir, 'CLAUDE.md'), 'utf-8');
    expect(md).toContain('### Normal-Chrome browser (account-bound web tasks, macOS + Windows)');
    expect(md).not.toContain('### Normal-Chrome browser (account-bound web tasks, macOS)\n');

    const browserDir = path.join(agentDir, '.instar', 'scripts', 'browser');
    expect(BROWSER_SCRIPT_NAMES).toHaveLength(5);
    for (const name of BROWSER_SCRIPT_NAMES) {
      expect(fs.statSync(path.join(browserDir, name)).mode & 0o111, name).not.toBe(0);
    }
    expect(fs.readFileSync(path.join(browserDir, 'native-drive.ps1'), 'utf-8')).toContain('native-drive.ps1 — Native Browser Drive (Windows)');

    // The installed chrome-js.sh resolves a profile id to <agent home>/.instar/state/playwright-profiles/<id>
    // (where PlaywrightProfileRegistry allocates profiles). Stub the system tools so this runs anywhere.
    const bin = path.join(tmpHome, 'bin');
    fs.mkdirSync(bin);
    const expected = path.join(fs.realpathSync(agentDir), '.instar', 'state', 'playwright-profiles', 'acct');
    fs.writeFileSync(path.join(bin, 'uname'), '#!/bin/bash\necho Darwin\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'ps'), `#!/bin/bash\necho "  55 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${expected}"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'osascript'), '#!/bin/bash\ncat >/dev/null; echo "pid=$PID"\n', { mode: 0o755 });
    const r = spawnSync('/bin/bash', [path.join(browserDir, 'chrome-js.sh'), 'acct', 'document.title'], {
      encoding: 'utf-8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    expect(r.stdout.trim()).toBe('pid=55');
  }, 120_000);
});
