import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import { PlaywrightProfileRegistry, type PlaywrightProfile } from '../../core/PlaywrightProfileRegistry.js';
import { canonicalOrigin } from './CanonicalOrigin.js';

export interface BrowserProfileProcess { pid: number; started: string; commandDigest: string; }
const exec = promisify(execFile);
/** Exact dedicated profile argument, never a broad browser-name kill. */
export function commandUsesTelegramProfile(command: string, directory: string): boolean {
  const escaped = directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return /(?:Google Chrome|chromium|playwright.*(?:mcp|cli))/i.test(command) &&
    new RegExp(`--user-data-dir(?:=|\\s+)["']?${escaped}(?:["']|\\s|$)`).test(command);
}
export async function inspectBrowserProfileProcesses(directory: string): Promise<BrowserProfileProcess[]> {
  const canonical = await realpath(directory);
  const { stdout } = await exec('/bin/ps', ['-u', String(process.getuid?.() ?? 0), '-o', 'pid=,lstart=,command='], {
    encoding: 'utf8', timeout: 3000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' },
  });
  const found: BrowserProfileProcess[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const row = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(line);
    if (!row) throw new Error('browser-process-census-unreadable');
    if (!commandUsesTelegramProfile(row[3], directory) && !commandUsesTelegramProfile(row[3], canonical)) continue;
    found.push({ pid: Number(row[1]), started: row[2], commandDigest: createHash('sha256').update(row[3]).digest('hex') });
  }
  if (found.length > 64) throw new Error('browser-profile-process-bound');
  return found;
}

/** Trusted migration entrypoint, absent from generic browser routes/MCP.
 * The registry first withdraws generic activation, then exact prior processes
 * are retired. A failed census/retirement leaves the profile held, never ready. */
export async function enrollOriginBrowser(input: {
  registry: PlaywrightProfileRegistry; profileId: string;
  enrollment: NonNullable<PlaywrightProfile['telegramBroker']>;
  inspectProcesses?: (directory: string) => Promise<BrowserProfileProcess[]>;
  stopProcess?: (process: BrowserProfileProcess) => Promise<void>;
}): Promise<PlaywrightProfile> {
  const inspectSource = input.inspectProcesses ?? inspectBrowserProfileProcesses;
  const deadline = Date.now() + 10_000;
  const inspect = async (directory: string) => {
    if (Date.now() >= deadline) throw new Error('browser-enrollment-deadline');
    const result = await inspectSource(directory);
    if (Date.now() >= deadline) throw new Error('browser-enrollment-deadline');
    return result;
  };
  const { exclusiveEnrollment: _oldProof, ...enrollment } = input.enrollment;
  const claimed = input.registry.claimTelegramBrokerProfile(input.profileId, enrollment);
  const directory = claimed.userDataDir!;
  const active = input.registry.resolvePlaywrightMcpConfig();
  if (active?.userDataDir && await realpath(active.userDataDir) === await realpath(directory)) {
    const fallback = input.registry.listProfiles().find(profile => profile.isDefault && profile.id !== input.profileId && profile.executionOwner !== 'telegram-origin-broker');
    if (!fallback) throw new Error('browser-generic-profile-replacement-unavailable');
    input.registry.writeActivation(input.registry.computeActivation(fallback.id));
  }
  const previous = await inspect(directory);
  if (previous.length > 64) throw new Error('browser-profile-process-bound');
  const retiredPids: number[] = [];
  for (const candidate of previous) {
    const current = (await inspect(directory)).find(process => process.pid === candidate.pid);
    if (!current) continue;
    if (current.started !== candidate.started || current.commandDigest !== candidate.commandDigest) throw new Error('browser-process-incarnation-changed');
    if (candidate.pid === process.pid || candidate.pid <= 0 || !Number.isSafeInteger(candidate.pid)) throw new Error('browser-process-target-invalid');
    if (input.stopProcess) await input.stopProcess(candidate);
    else {
      try { process.kill(candidate.pid, 'SIGTERM'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    retiredPids.push(candidate.pid);
  }
  let remaining = await inspect(directory);
  for (let attempt = 0; remaining.length && attempt < 20; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100)); remaining = await inspect(directory);
  }
  if (remaining.length) throw new Error('browser-profile-revocation-incomplete');
  const checkedAt = Date.now();
  const proofDigest = createHash('sha256').update(canonicalOrigin({ profileId: claimed.id, checkedAt, previous, remaining: [] })).digest('hex');
  return input.registry.claimTelegramBrokerProfile(claimed.id, { ...enrollment,
    exclusiveEnrollment: { version: 1, checkedAt, retiredPids, proofDigest } });
}
