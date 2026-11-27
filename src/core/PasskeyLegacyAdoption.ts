/**
 * Legacy (prototype) passkey adoption — spec docs/specs/agent-held-google-passkey.md §6.2.
 *
 * Seven prototype passkeys were minted before this feature existed and sit in the SHARED SecretStore
 * as top-level `google_passkey_*` keys (Increment 1 already stops them spreading). For each key, on
 * each machine, the operator chooses on the dashboard (PIN), never in a notice:
 *
 *   - ADOPT: the operator names the account email. The key is copied into the machine-local passkey
 *     store QUARANTINED with `provenance: 'legacy-adopted'`. The adoption COMMITS only after a cold
 *     proof on this machine — signed out, assertion-verified, identity-verified (§3.8) — returns
 *     `ready`; anything else reverts the copy and leaves the shared key where it was. After a commit
 *     the shared copy is removed from the SecretStore. A key minted by another agent is recorded as
 *     cross-agent. Adopted keys carry a re-mint target (`legacyRemintDays`).
 *   - DELETE: the shared copy is removed locally and the cell is reported
 *     `google-side-pending-operator` (Google still lists the passkey; only the operator removes it).
 *
 * Adoption changes nothing on the Google account: the passkey is already registered there.
 *
 * What this module never does: print, log or return key material or the email; adopt over a cell that
 * already holds a credential on this machine; adopt anything whose relying party is not google.com.
 */
import type { PasskeyCredentialStore, PasskeyRecord } from './PasskeyCredentialStore.js';
import { canonicalEmail } from './PasskeyCredentialStore.js';
import { LEGACY_PASSKEY_KEY_PREFIX } from './SecretSync.js';

export const GOOGLE_RP_ID = 'google.com';

/** The credential fields a prototype key must carry. Values are never logged. */
export interface LegacyPasskeyMaterial {
  credentialId: string;
  rpId: string;
  privateKey: string;
  userHandle: string;
  signCount: number;
}

/** Names only: the `google_passkey_*` keys present in a vault snapshot. */
export function listLegacyPasskeyNames(vault: Record<string, unknown>): string[] {
  return Object.keys(vault).filter((k) => k.startsWith(LEGACY_PASSKEY_KEY_PREFIX)).sort();
}

/** Parse a prototype key value (a JSON string or an object). Null when it is not a usable credential. */
export function parseLegacyPasskey(value: unknown): LegacyPasskeyMaterial | null {
  let v: unknown = value;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return null; } // @silent-fallback-ok — an unparseable key is reported as unrecognized, never adopted
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const str = (k: string): string | null => (typeof o[k] === 'string' && (o[k] as string).length > 0 ? (o[k] as string) : null);
  const credentialId = str('credentialId');
  const privateKey = str('privateKey');
  const rpId = str('rpId');
  const userHandle = str('userHandle') ?? '';
  const signCount = typeof o.signCount === 'number' && Number.isFinite(o.signCount) && o.signCount >= 0 ? o.signCount : 0;
  if (!credentialId || !privateKey || !rpId) return null;
  return { credentialId, rpId, privateKey, userHandle, signCount };
}

export type AdoptionOutcome =
  | { adopted: true; crossAgent: boolean }
  | { adopted: false; reason: AdoptionRefusal; proofOutcome?: string; proofReason?: string };

export type AdoptionRefusal =
  | 'legacy-key-absent' | 'legacy-key-unrecognized' | 'legacy-key-not-google'
  | 'cell-already-held' | 'proof-not-ready' | 'proof-error' | 'store-write-failed';

export interface LegacyAdoptionDeps {
  /** Read one shared-vault value by name (the generic read is logged by the legacy-read log). */
  readLegacy: (name: string) => unknown;
  /** Remove the shared copy after a committed adoption or a delete choice. */
  removeLegacy: (name: string) => Promise<void> | void;
  store: PasskeyCredentialStore;
  machineId: string;
  agentName: string;
  /** The §3.8 cold proof for this cell with this exact material (fresh proof profile). */
  coldProof: (input: { canonicalEmail: string; material: LegacyPasskeyMaterial }) => Promise<{ outcome: string; reason: string }>;
  now?: () => Date;
}

export async function adoptLegacyPasskey(deps: LegacyAdoptionDeps, input: { name: string; email: string; mintedByAgent?: string }): Promise<AdoptionOutcome> {
  if (!input.name.startsWith(LEGACY_PASSKEY_KEY_PREFIX)) return { adopted: false, reason: 'legacy-key-absent' };
  const raw = deps.readLegacy(input.name);
  if (raw === undefined || raw === null) return { adopted: false, reason: 'legacy-key-absent' };
  const material = parseLegacyPasskey(raw);
  if (!material) return { adopted: false, reason: 'legacy-key-unrecognized' };
  if (material.rpId !== GOOGLE_RP_ID) return { adopted: false, reason: 'legacy-key-not-google' };
  const email = canonicalEmail(input.email);
  // Never adopt over (or revert away) anything this machine holds for the email: an entry under any
  // machine id (an old id after identity recovery included) or an in-flight enrollment's pending mint.
  if (deps.store.holdsAnythingFor(email)) return { adopted: false, reason: 'cell-already-held' };

  const mintedByAgent = (input.mintedByAgent ?? deps.agentName).slice(0, 64);
  const crossAgent = mintedByAgent !== deps.agentName;
  const record: Omit<PasskeyRecord, 'schemaVersion' | 'canonicalEmail'> & { canonicalEmail: string } = {
    ...material, canonicalEmail: email, mintedOnMachineId: `legacy:${input.name}`.slice(0, 128), mintedByAgent,
    mintedAt: (deps.now ?? (() => new Date()))().toISOString(), provenance: 'legacy-adopted', quarantined: true,
  };
  try { await deps.store.put(record); }
  catch { return { adopted: false, reason: 'store-write-failed' }; } // @silent-fallback-ok — reported by name; nothing was adopted

  let proof: { outcome: string; reason: string };
  try { proof = await deps.coldProof({ canonicalEmail: email, material }); }
  catch {
    // @silent-fallback-ok — a proof that cannot run reverts the copy; the shared key is untouched
    await deps.store.discardQuarantinedAdoption(email);
    return { adopted: false, reason: 'proof-error' };
  }
  if (proof.outcome !== 'ready') {
    await deps.store.discardQuarantinedAdoption(email);
    return { adopted: false, reason: 'proof-not-ready', proofOutcome: proof.outcome.slice(0, 40), proofReason: proof.reason.slice(0, 80) };
  }
  await deps.store.commitAdoption(email);
  await deps.store.release(email);
  await deps.removeLegacy(input.name);
  return { adopted: true, crossAgent };
}

/** The DELETE choice: remove the shared copy here; Google-side removal stays with the operator. */
export async function deleteLegacyPasskey(deps: Pick<LegacyAdoptionDeps, 'readLegacy' | 'removeLegacy'>, name: string): Promise<{ deleted: boolean; googleSide: 'pending-operator' | null }> {
  if (!name.startsWith(LEGACY_PASSKEY_KEY_PREFIX) || deps.readLegacy(name) === undefined) return { deleted: false, googleSide: null };
  await deps.removeLegacy(name);
  return { deleted: true, googleSide: 'pending-operator' };
}
