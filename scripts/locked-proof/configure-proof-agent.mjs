#!/usr/bin/env node
/**
 * Set a proof agent's config for the locked-Mac proof run. Runs as the proof user.
 *
 *   configure-proof-agent.mjs <agent-dir> --port N [--tunnel] [--front] [--pin-stdin] --execute
 *
 * Without --execute it prints what it would change. It refuses any directory that
 * does not resolve inside /Users/instarproof (the throwaway proof user's home).
 *
 * - remote desktop on, the kept helper on (the proof user's own copy), locked-screen
 *   access left absent (off): the run turns it on with the dashboard PIN route.
 * - updates never auto-applied: the updater would replace the -lockedproof build.
 * - no start-on-login job: the driver starts and stops the server itself.
 * - --tunnel: a Cloudflare quick tunnel (the password box needs a first-tier tunnel).
 * - --front: this agent is its own designated desktop front (needs the machine id,
 *   which exists after the first server start; run again with --front then).
 * - --pin-stdin: the dashboard PIN, read from stdin (stage-proof-agents.sh pipes it from
 *   the operator's vault). The run unlocks the dashboard with it, so the proof never
 *   depends on the server minting one. It is never printed or put on a command line.
 * Only missing or listed keys change; everything else in config.json is kept.
 */
import fs from 'node:fs';
import path from 'node:path';

export const PROOF_HOME = '/Users/instarproof';

/** True only for a resolved path inside the proof user's home. */
export function isInsideProofHome(resolved) {
  return resolved === PROOF_HOME || resolved.startsWith(`${PROOF_HOME}/`);
}

/** A dashboard PIN as the dashboard accepts it: digits only. */
export function validPin(pin) { return typeof pin === 'string' && /^[0-9]{4,12}$/.test(pin); }

export function proofConfig(config, { port, tunnel, frontMachineId, pin }) {
  const next = { ...config, port };
  if (pin !== undefined) {
    if (!validPin(pin)) throw new Error('the dashboard PIN must be 4 to 12 digits');
    next.dashboardPin = pin;
  }
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
  const real = fs.realpathSync(dir);
  if (!isInsideProofHome(real)) { process.stderr.write(`refusing: ${real} is not inside ${PROOF_HOME}\n`); process.exit(1); }
  const file = path.join(real, '.instar', 'config.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  let frontMachineId;
  if (rest.includes('--front')) {
    const identity = path.join(real, '.instar', 'machine', 'identity.json');
    if (!fs.existsSync(identity)) { process.stderr.write('no machine identity yet: start the server once, then run with --front\n'); process.exit(1); }
    frontMachineId = JSON.parse(fs.readFileSync(identity, 'utf8')).machineId;
  }
  const pin = rest.includes('--pin-stdin') ? fs.readFileSync(0, 'utf8').trim() : undefined;
  let next;
  try { next = proofConfig(config, { port, tunnel: rest.includes('--tunnel'), frontMachineId, pin }); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exit(1); }
  if (!rest.includes('--execute')) {
    process.stdout.write(`dry run (no --execute): would write ${file}\n${JSON.stringify({ port: next.port, remoteDesktop: next.remoteDesktop, updates: next.updates, autostart: next.autostart, tunnel: next.tunnel ?? null, dashboardPin: next.dashboardPin ? 'set' : 'absent' })}\n`);
    return;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  process.stdout.write(`configured ${dir} (port ${port}${rest.includes('--tunnel') ? ', quick tunnel' : ''}${frontMachineId ? `, front ${frontMachineId}` : ''}${pin ? ', dashboard PIN set' : ''})\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) main();
