/** Tier 3: deployed relay shell → canonical SQLite row → truthful stderr. */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const TEMPLATE = path.resolve('src/templates/scripts/telegram-reply.sh');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'telegram-recovery-queue-truth-lifecycle:cleanup' });
});

function fixture(blockState = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-truth-e2e-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, '.instar'), { recursive: true });
  fs.mkdirSync(path.join(root, '.instar', 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.copyFileSync(TEMPLATE, path.join(root, '.instar', 'scripts', 'telegram-reply.sh'));
  fs.chmodSync(path.join(root, '.instar', 'scripts', 'telegram-reply.sh'), 0o755);
  fs.writeFileSync(path.join(root, '.instar', 'config.json'), JSON.stringify({ port: 49999, projectName: 'echo', authToken: 'test' }));
  if (blockState) fs.writeFileSync(path.join(root, '.instar', 'state'), 'not-a-directory');
  fs.writeFileSync(path.join(root, 'bin', 'curl'), `#!/bin/sh
out=""
while [ "$#" -gt 0 ]; do
  [ "$1" = "-o" ] && { shift; out="$1"; }
  shift
done
[ -n "$out" ] && printf '{"error":"upstream"}' > "$out"
printf '503'
`);
  fs.chmodSync(path.join(root, 'bin', 'curl'), 0o755);
  const run = spawnSync('bash', [path.join(root, '.instar', 'scripts', 'telegram-reply.sh'), '458', 'durable truth'], {
    cwd: root,
    env: { ...process.env, PATH: `${path.join(root, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`, INSTAR_AGENT_HOME: root, INSTAR_PORT: '', INSTAR_AUTH_TOKEN: '' },
    encoding: 'utf8',
  });
  return { root, run };
}

describe('telegram recovery queue truth — deployed lifecycle', () => {
  it('claims queued only after the exact delivery row exists at the canonical path', () => {
    const { root, run } = fixture();
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Queued for recovery');
    const canonical = path.join(root, '.instar', 'state', 'pending-relay.echo.sqlite');
    const db = new Database(canonical, { readonly: true });
    expect((db.prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number }).n).toBe(1);
    db.close();
    expect(fs.existsSync(path.join(root, '.instar', 'pending-relay.echo.sqlite'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.instar', 'server-data', 'pending-relay.echo.sqlite'))).toBe(false);
  });

  it('reports failure, never queued, when the canonical store cannot persist', () => {
    const { run } = fixture(true);
    expect(run.status).toBe(1);
    expect(run.stderr).not.toContain('Queued for recovery');
    expect(run.stderr).toContain('message was NOT reported as queued');
  });
});
