/**
 * `instar mobile ceremony-credential` — the one-time credential for the Instar app on the agent's own
 * computer (identity A5 condition 1; docs/specs/identity-security-piece3e-same-network-first-phone.md §4.6).
 *
 * The app runs this inside the agent's own system as the agent's user (on Windows, a command inside
 * WSL) just before "Add your phone", and passes what it prints to POST /mobile/phone-setup in place of
 * the PIN. It writes only the credential's hash, into the agent's 0600 state file; the credential itself
 * is printed once. It is for the app, not for people: a person in a terminal uses `instar mobile add-phone`.
 */
import fs from 'node:fs';
import { loadConfig } from '../core/Config.js';
import { CEREMONY_SCOPES, mintCeremonyCredential, type CeremonyScope } from '../core/ceremonyCredential.js';
import { ownMachineId } from '../core/localOwnerTicket.js';

interface Options { dir?: string; json?: boolean; for?: string }

function fail(message: string): void {
  console.error(message);
  process.exitCode = 1;
}

export function ceremonyCredential(opts: Options): void {
  const scope = (opts.for ?? 'phone-setup') as CeremonyScope;
  if (!CEREMONY_SCOPES.includes(scope)) { fail(`There is no ceremony called "${String(opts.for)}". Known: ${CEREMONY_SCOPES.join(', ')}.`); return; }
  const config = loadConfig(opts.dir);
  const stateDir = config.stateDir;
  // Only the agent's own user: a credential written by anyone else is refused by the agent anyway.
  try {
    const st = fs.statSync(stateDir);
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) { fail("Run this as the agent's own user."); return; }
  } catch { fail('The agent\'s folder could not be read.'); return; } // @silent-fallback-ok — reported to the caller, nothing written
  const machineId = ownMachineId(stateDir);
  if (!machineId) { fail("This computer's identity for the agent could not be read, so no credential was made."); return; }
  const { credential, expiresAt } = mintCeremonyCredential(stateDir, { scope, machineId });
  if (opts.json) console.log(JSON.stringify({ credential, expiresAt, for: scope }));
  else console.log(credential);
}
