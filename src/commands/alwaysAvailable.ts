/**
 * `instar always-available …`, for the Instar Mac app's Always available switch
 * (docs/specs/create-agent-accounts-and-always-on.md §B.1, §B.4). The app runs these as the person:
 *   token --email <e>   reads a `claude setup-token` code from stdin (never argv), checks it signs in as
 *                       <e>, and stores it as this agent's Claude sign-in (keeping what was there before);
 *   token-clear         undo: puts the earlier sign-in back if the stored code is still the one set here;
 *   status --json       FileVault on/off/unknown, and whether the Always available code is in use.
 * Exit codes: 0 done, 1 refused (one plain line on stderr), 2 bad usage.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { detectProjectDir } from '../core/Config.js';
import { alwaysAvailableTokenStatus, clearAlwaysAvailableToken, setAlwaysAvailableToken } from '../core/alwaysAvailableToken.js';

function stateDirOf(dir?: string): string {
  return path.join(dir || detectProjectDir(), '.instar');
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf-8');
}

export async function alwaysAvailableTokenCommand(opts: { dir?: string; email?: string }): Promise<void> {
  if (!opts.email) { console.error('Pass the account to sign in as with --email.'); process.exitCode = 2; return; }
  if (process.stdin.isTTY) { console.error('Pipe the code on stdin.'); process.exitCode = 2; return; }
  const r = await setAlwaysAvailableToken({ stateDir: stateDirOf(opts.dir), token: await readStdin(), expectEmail: opts.email });
  if (!r.ok) { console.error(r.message); process.exitCode = 1; return; }
  console.log(`Saved. This agent now signs in to Claude as ${r.email}, even before anyone logs in to this Mac.`);
}

export function alwaysAvailableTokenClearCommand(opts: { dir?: string }): void {
  const r = clearAlwaysAvailableToken(stateDirOf(opts.dir));
  console.log(r.restored ? 'The earlier Claude sign-in is back in place.' : 'Nothing to put back.');
}

/** FileVault: `fdesetup isactive` exits 0 when on and 1 when off; anything else is unknown. */
export function fileVaultState(run: (cmd: string, args: string[]) => { status: number | null } = (cmd, args) => spawnSync(cmd, args, { stdio: 'ignore', timeout: 5000 })): 'on' | 'off' | 'unknown' {
  if (process.platform !== 'darwin') return 'unknown';
  const r = run('/usr/bin/fdesetup', ['isactive']);
  return r.status === 0 ? 'on' : r.status === 1 ? 'off' : 'unknown';
}

export function alwaysAvailableStatusCommand(opts: { dir?: string }): void {
  const token = alwaysAvailableTokenStatus(stateDirOf(opts.dir));
  console.log(JSON.stringify({ fileVault: fileVaultState(), claudeCode: token }));
}
