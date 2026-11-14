/**
 * systemd stable start: an agent installed through npx must come back after a reboot.
 *
 * THE DEFECT (Cirrus, fresh Ubuntu 24.04, 2026-11-03). `npx instar install` wrote
 * `ExecStart=instar server start ...` with the npx cache on PATH. systemd refuses a bare
 * name (203/EXEC, a restart loop from the first second), and npm may clear its cache at any
 * time. The agent only ran because the installer had started its own copy.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildLinuxSystemdUnit, installBootWrapper, systemdUnitNeedsStableStart, withoutNpxCache } from '../../src/commands/setup.js';

const NPX_PATH = '/home/instar/.npm/_npx/5f7c/node_modules/.bin:/usr/local/bin:/usr/bin:/bin';

const CIRRUS_UNIT = `[Unit]
Description=Instar Agent - cirrus

[Service]
Type=simple
KillMode=process
ExecStart=instar server start --foreground --dir /home/instar/.instar/agents/cirrus
Restart=always
Environment=PATH=${NPX_PATH}
`;

describe('systemd unit start', () => {
  it('recognizes the unit the npx install wrote, and leaves stable ones alone', () => {
    expect(systemdUnitNeedsStableStart(CIRRUS_UNIT)).toBe(true);
    expect(systemdUnitNeedsStableStart(CIRRUS_UNIT.replace('ExecStart=instar', 'ExecStart=/home/instar/.npm/_npx/5f7c/node_modules/.bin/instar'))).toBe(true);
    expect(systemdUnitNeedsStableStart(CIRRUS_UNIT.replace('ExecStart=instar', 'ExecStart=/usr/bin/instar'))).toBe(true); // PATH still in the cache
    const hand = CIRRUS_UNIT.replace('ExecStart=instar', 'ExecStart=/usr/bin/instar').replace(NPX_PATH, '/usr/bin:/bin');
    expect(systemdUnitNeedsStableStart(hand)).toBe(false);
    expect(systemdUnitNeedsStableStart('[Service]\nType=simple\n')).toBe(false);
    // systemd's prefixes before the path don't make it relative.
    expect(systemdUnitNeedsStableStart(hand.replace('ExecStart=/usr/bin/instar', 'ExecStart=-/usr/bin/instar'))).toBe(false);
  });

  it('writes an absolute start through the boot wrapper, with no npx cache on PATH', () => {
    const unit = buildLinuxSystemdUnit({
      projectName: 'cirrus', projectDir: '/home/instar/.instar/agents/cirrus', hasTelegram: false,
      bootWrapper: '/home/instar/.instar/agents/cirrus/.instar/instar-boot.sh', envPath: NPX_PATH,
    });
    expect(unit).toContain('ExecStart=/bin/bash /home/instar/.instar/agents/cirrus/.instar/instar-boot.sh server start --foreground --dir /home/instar/.instar/agents/cirrus');
    expect(unit).toContain('Environment=PATH=/usr/local/bin:/usr/bin:/bin\n');
    expect(unit).toContain('KillMode=process');
    expect(systemdUnitNeedsStableStart(unit)).toBe(false);
    const lifeline = buildLinuxSystemdUnit({
      projectName: 'a', projectDir: '/d', hasTelegram: true, bootWrapper: '/d/.instar/instar-boot.sh', envPath: '/usr/bin',
    });
    expect(lifeline).toContain('ExecStart=/bin/bash /d/.instar/instar-boot.sh lifeline start --dir /d');
  });

  it('drops only npx cache folders from PATH', () => {
    expect(withoutNpxCache(NPX_PATH)).toBe('/usr/local/bin:/usr/bin:/bin');
    expect(withoutNpxCache('/opt/node/bin:/usr/bin')).toBe('/opt/node/bin:/usr/bin');
    // What `npm exec` puts in front (seen on a fresh Ubuntu install, 2026-11-03).
    expect(withoutNpxCache('/home/instar/node_modules/.bin:/home/node_modules/.bin:/node_modules/.bin:/usr/lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin:/usr/bin:/bin'))
      .toBe('/usr/bin:/bin');
  });

  it('the boot wrapper finds a node outside Homebrew folders for its one-shot reinstall', () => {
    // Ubuntu's node is /usr/bin/node; the wrapper only looked in /opt/homebrew and /usr/local.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-wrapper-'));
    fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
    const { sh } = installBootWrapper(dir);
    const text = fs.readFileSync(sh, 'utf-8');
    expect(text).toContain('NODE_BIN="$(command -v node 2>/dev/null || true)"');
    expect(text).toContain('/usr/bin/node');
    expect(spawnSync('bash', ['-n', sh]).status).toBe(0);
  });

  it('a stop signal to the wrapper reaches node, so a service restart really restarts', async () => {
    // With KillMode=process systemd signals only the unit's main process, the wrapper's bash.
    // Without forwarding, bash died and node kept the port and the agent's lock.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-signal-'));
    const shadowCli = path.join(dir, '.instar', 'shadow-install', 'node_modules', 'instar', 'dist', 'cli.js');
    fs.mkdirSync(path.dirname(shadowCli), { recursive: true });
    const marker = path.join(dir, 'got-term');
    fs.writeFileSync(shadowCli, `process.on('SIGTERM', () => { require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); process.exit(0); }); console.log('up'); setInterval(() => {}, 1000);`);
    const { sh } = installBootWrapper(dir);
    const { spawn } = await import('node:child_process');
    const child = spawn('bash', [sh], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('node never started')), 10_000);
      child.stdout.on('data', (d) => { if (String(d).includes('up')) { clearTimeout(t); resolve(); } });
    });
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
    expect(fs.existsSync(marker)).toBe(true);
  }, 20_000);
});
