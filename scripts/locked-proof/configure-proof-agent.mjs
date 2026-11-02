#!/usr/bin/env node
/**
 * Set a proof agent's config for the locked-Mac proof run. Runs as the proof user.
 *
 *   configure-proof-agent.mjs <agent-dir> --port N [--tunnel] [--front]
 *
 * - remote desktop on, the kept helper on (the proof user's own copy), locked-screen
 *   access left absent (off): the run turns it on with the dashboard PIN route.
 * - updates never auto-applied: the updater would replace the -lockedproof build.
 * - no start-on-login job: the driver starts and stops the server itself.
 * - --tunnel: a Cloudflare quick tunnel (the password box needs a first-tier tunnel).
 * - --front: this agent is its own designated desktop front (needs the machine id,
 *   which exists after the first server start; run again with --front then).
 * Only missing or listed keys change; everything else in config.json is kept.
 */
import fs from 'node:fs';
import path from 'node:path';

export function proofConfig(config, { port, tunnel, frontMachineId }) {
  const next = { ...config, port };
  next.remoteDesktop = { ...(config.remoteDesktop ?? {}), enabled: true, retainedHelper: true };
  if (frontMachineId) next.remoteDesktop.frontMachineId = frontMachineId;
  delete next.remoteDesktop.lockedScreen;
  next.updates = { ...(config.updates ?? {}), autoApply: false };
  next.autostart = { ...(config.autostart ?? {}), autoInstall: false };
  next.messaging = [];
  if (tunnel) next.tunnel = { ...(config.tunnel ?? {}), enabled: true, type: 'quick' };
  else if (next.tunnel) next.tunnel = { ...next.tunnel, enabled: false };
  return next;
}

function main() {
  const [dir, ...rest] = process.argv.slice(2);
  const opt = name => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
  const port = Number(opt('port'));
  if (!dir || !Number.isSafeInteger(port)) { process.stderr.write('usage: configure-proof-agent.mjs <agent-dir> --port N [--tunnel] [--front]\n'); process.exit(2); }
  const file = path.join(dir, '.instar', 'config.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  let frontMachineId;
  if (rest.includes('--front')) {
    const identity = path.join(dir, '.instar', 'machine', 'identity.json');
    if (!fs.existsSync(identity)) { process.stderr.write('no machine identity yet: start the server once, then run with --front\n'); process.exit(1); }
    frontMachineId = JSON.parse(fs.readFileSync(identity, 'utf8')).machineId;
  }
  const next = proofConfig(config, { port, tunnel: rest.includes('--tunnel'), frontMachineId });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  process.stdout.write(`configured ${dir} (port ${port}${rest.includes('--tunnel') ? ', quick tunnel' : ''}${frontMachineId ? `, front ${frontMachineId}` : ''})\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) main();
