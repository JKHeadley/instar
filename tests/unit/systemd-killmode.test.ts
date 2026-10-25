/**
 * systemd KillMode — a service restart must not kill the agent's tmux sessions.
 *
 * THE DEFECT (2026-10-22, Mama PC, WSL). The Linux user service had no KillMode,
 * so systemd used control-group: stop/restart killed every process the service
 * ever started. The tmux server holding every session is one of them (it
 * daemonizes but stays in the cgroup), so one `systemctl --user restart` destroyed
 * a live autonomous run. KillMode=process stops only the main process.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { addSystemdKillModeProcess } from '../../src/core/PostUpdateMigrator.js';
import { SYSTEMD_KILL_MODE_LINE } from '../../src/commands/setup.js';

const OLD_UNIT = `[Unit]
Description=Instar Agent - echo
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/node /x/cli.js lifeline start --dir /home/echo/agent
WorkingDirectory=/home/echo/agent
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`;

describe('systemd KillMode', () => {
  it('the shipped value is process', () => {
    expect(SYSTEMD_KILL_MODE_LINE).toBe('KillMode=process');
  });

  it('new units carry it inside [Service]', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/commands/setup.ts'), 'utf-8');
    const body = src.slice(src.indexOf('function installLinuxSystemdService('));
    const service = body.slice(body.indexOf('[Service]'), body.indexOf('[Install]'));
    expect(service).toContain('${SYSTEMD_KILL_MODE_LINE}');
  });

  it('`instar server restart` stops the server tmux session, not just the unit', () => {
    // With KillMode=process a bare `systemctl restart` leaves the tmux-hosted
    // server alive and the new lifeline adopts it, so the CLI restart must stop
    // that session itself or it never loads new server code.
    const src = fs.readFileSync(path.join(__dirname, '../../src/commands/server.ts'), 'utf-8');
    const body = src.slice(src.indexOf('export async function restartServer('));
    const linux = body.slice(body.indexOf("process.platform === 'linux'"), body.indexOf('// No autostart'));
    expect(linux).toContain("['--user', 'stop', serviceName]");
    expect(linux).toContain("['--user', 'start', serviceName]");
    expect(linux).not.toContain("['--user', 'restart', serviceName]");
    expect(linux).toContain('await stopServerSessionIfPresent(options)');
    const darwin = body.slice(body.indexOf("process.platform === 'darwin'"), body.indexOf("process.platform === 'linux'"));
    expect(darwin).toContain('await stopServerSessionIfPresent(options)');
  });

  it('adds it to an existing unit, right after [Service], rest unchanged', () => {
    const next = addSystemdKillModeProcess(OLD_UNIT);
    expect(next).toBe(OLD_UNIT.replace('[Service]\n', '[Service]\nKillMode=process\n'));
  });

  it('is idempotent', () => {
    const once = addSystemdKillModeProcess(OLD_UNIT);
    expect(addSystemdKillModeProcess(once)).toBe(once);
  });

  it('leaves an operator-chosen KillMode alone', () => {
    const custom = OLD_UNIT.replace('Type=simple\n', 'Type=simple\nKillMode=mixed\n');
    expect(addSystemdKillModeProcess(custom)).toBe(custom);
  });

  it('leaves a file with no [Service] section alone', () => {
    const notOurs = '[Unit]\nDescription=x\n';
    expect(addSystemdKillModeProcess(notOurs)).toBe(notOurs);
  });

  it('handles CRLF line endings', () => {
    const crlf = OLD_UNIT.replace(/\n/g, '\r\n');
    const next = addSystemdKillModeProcess(crlf);
    expect(next).toContain('[Service]\r\nKillMode=process\n');
    expect(addSystemdKillModeProcess(next)).toBe(next);
  });
});
