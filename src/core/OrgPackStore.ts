/**
 * Applying an organization pack on disk (docs/specs/org-pack-and-join.md §D): the staged
 * transaction, recovery, leave, and reading the cap. Every write is temp + rename; every step is
 * idempotent, so an interrupted apply is finished at the next start from its staging folder.
 *
 * Layout under `<stateDir>/org/`:
 *   staging/<txnId>/{bundle.json, membership.json, pins.json}   one transaction's inputs
 *   txn.json                                                   the marker, present while applying
 *   <orgId>/v<N>/{policy.md, record.json, intent.sha256}        immutable policy versions
 *   <orgId>/current                                            the applied version folder name
 *   <orgId>/clamped.json                                       values the cap rewrote (restored on leave)
 *   membership.json, pins.json, applied-intent.sha256          the applied state
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from './SafeFsExecutor.js';
import {
  INDEPENDENCE_TO_PROFILE, generateOrgIntent, parsePolicy, sha256Hex, validateBundle, verifyRecordSignature,
  type BundleRefusal, type HeldMembership, type OrgBundle, type OrgRecord,
} from './OrgPack.js';
import type { AutonomyProfileLevel } from './types.js';

export interface Membership {
  state: 'joined' | 'left';
  orgId: string;
  version: number | null;
  policySha256: string | null;
  updateOrigin: string | null;
  epoch: number;
  changedAt: string;
  machineId: string;
}

export interface Pins { [orgId: string]: { key: string; versionFloor: number } }

interface Txn { txnId: string; orgId: string; version: number | null; op: 'apply' | 'leave'; replaceHandEdit?: boolean }

export type ApplyResult =
  | { ok: true; applied: 'joined' | 'updated' | 'repaired' | 'left' | 'already-current'; version: number | null }
  | { ok: false; reason: BundleRefusal | 'org-intent-hand-edited' | 'not-member' | 'stale-membership' }
  | { ok: false; reason: 'recovery-needs-person'; pending: true };

/** Effects outside the org folder, injected so tests and the installer can run without a server. */
export interface ApplyEffects {
  /** The current profile, staged before anything is lowered so leave can always restore it. */
  currentProfile?: () => AutonomyProfileLevel;
  /** The three authority settings as they are now, staged with the profile (spec §D cap, "On apply"). */
  currentSettings?: () => Record<string, unknown>;
  /** Lower the autonomy profile to the cap; returns the previous profile when it lowered. */
  lowerProfile?: (cap: AutonomyProfileLevel, orgName: string) => AutonomyProfileLevel | null;
  /** Restore the profile saved at apply (on leave), unless the person changed it since. */
  restoreProfile?: (previous: AutonomyProfileLevel, cap: AutonomyProfileLevel) => void;
  /** Clamp the authority settings to the cap; returns the previous values it changed. */
  clampSettings?: (cap: AutonomyProfileLevel) => Record<string, unknown> | null;
  /** Restore clamped settings on leave, each unless changed since. */
  restoreSettings?: (previous: Record<string, unknown>, cap: AutonomyProfileLevel) => void;
  journal?: (event: string, detail: Record<string, unknown>) => void;
}

function writeAtomic(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')) as T; } catch { return null; } // @silent-fallback-ok — a missing or unreadable state file reads as absent; validators decide what that means
}

export class OrgPackStore {
  readonly root: string;
  constructor(private readonly stateDir: string, private readonly machineId: string, private readonly now: () => number = Date.now) {
    this.root = path.join(stateDir, 'org');
  }

  private get intentFile(): string { return path.join(this.stateDir, 'ORG-INTENT.md'); }
  membership(): Membership | null { return readJson<Membership>(path.join(this.root, 'membership.json')); }
  pins(): Pins { return readJson<Pins>(path.join(this.root, 'pins.json')) ?? {}; }

  /** The applied record, signature checked on every read; null when absent or altered. */
  currentRecord(): OrgRecord | null {
    const m = this.membership();
    if (!m || m.state !== 'joined') return null;
    const ver = (() => { try { return fs.readFileSync(path.join(this.root, m.orgId, 'current'), 'utf-8').trim(); } catch { return null; } })(); // @silent-fallback-ok — no pointer means nothing applied
    if (!ver || !/^v\d+$/.test(ver)) return null;
    const r = readJson<OrgRecord>(path.join(this.root, m.orgId, ver, 'record.json'));
    return r && verifyRecordSignature(r) ? r : null;
  }

  /** The independence cap from the applied, signature-checked record. */
  cap(): { level: AutonomyProfileLevel; orgName: string } | null {
    const r = this.currentRecord();
    return r ? { level: INDEPENDENCE_TO_PROFILE[r.maxIndependence], orgName: r.orgName } : null;
  }

  heldFor(orgId: string): HeldMembership {
    const m = this.membership();
    const pin = this.pins()[orgId];
    const joinedAny = m?.state === 'joined';
    // `joined` is about THIS organization; `joinedOrgId` names whatever this agent is joined to.
    const joined = joinedAny && m!.orgId === orgId;
    return {
      pinnedKey: pin?.key ?? null, versionFloor: pin?.versionFloor ?? 0, joined,
      joinedVersion: joined ? m!.version : null, joinedHash: joined ? m!.policySha256 : null, joinedOrgId: joinedAny ? m!.orgId : null,
    };
  }

  /** §D.0: the rules file was written by hand when its hash matches nothing this agent wrote. */
  handEdited(): boolean {
    let text: string;
    try { text = fs.readFileSync(this.intentFile, 'utf-8'); } catch { return false; } // @silent-fallback-ok — no file, nothing to protect
    const h = sha256Hex(text);
    const applied = (() => { try { return fs.readFileSync(path.join(this.root, 'applied-intent.sha256'), 'utf-8').trim(); } catch { return null; } })(); // @silent-fallback-ok — absent applied hash handled below
    const txn = readJson<Txn>(path.join(this.root, 'txn.json'));
    const pendingHash = txn?.version ? (() => { try { return fs.readFileSync(path.join(this.root, txn.orgId, `v${txn.version}`, 'intent.sha256'), 'utf-8').trim(); } catch { return null; } })() : null; // @silent-fallback-ok — no pending version
    return h !== applied && h !== pendingHash;
  }

  private nextOrdering(): { epoch: number; changedAt: string; machineId: string } {
    return { epoch: (this.membership()?.epoch ?? 0) + 1, changedAt: new Date(this.now()).toISOString(), machineId: this.machineId };
  }

  /** Newer-than test on the ordering tuple (§Multi-machine). */
  static newer(a: Pick<Membership, 'epoch' | 'changedAt' | 'machineId'>, b: Pick<Membership, 'epoch' | 'changedAt' | 'machineId'> | null): boolean {
    if (!b) return true;
    if (a.epoch !== b.epoch) return a.epoch > b.epoch;
    if (a.changedAt !== b.changedAt) return a.changedAt > b.changedAt;
    return a.machineId > b.machineId;
  }

  /**
   * Join or update from a validated-on-arrival bundle. `ordering` is given when a peer fans out an
   * already-ordered change; otherwise this machine assigns the next one.
   */
  apply(input: unknown, opts: { replaceHandEdit?: boolean; ordering?: Pick<Membership, 'epoch' | 'changedAt' | 'machineId'>; reconcile?: boolean } = {}, fx: ApplyEffects = {}): ApplyResult {
    // A leftover transaction is finished first, never overwritten (spec §D Recovery).
    if (fs.existsSync(path.join(this.root, 'txn.json')) && !this.finish(fx) && fs.existsSync(path.join(this.root, 'txn.json'))) {
      return { ok: false, reason: 'org-intent-hand-edited' };
    }
    const orgId = (input as OrgBundle | null)?.record?.orgId;
    const held = this.heldFor(typeof orgId === 'string' ? orgId : '');
    const v = validateBundle(input, held, { skipMembership: opts.reconcile === true });
    if (!v.ok) return v;
    const bundle = v.bundle;
    const drifted = v.sameVersion && this.handEdited() === false && this.intentDrifted();
    if (v.sameVersion && !drifted) return { ok: true, applied: 'already-current', version: bundle.record.version };
    if (opts.ordering && !OrgPackStore.newer(opts.ordering, this.membership())) return { ok: false, reason: 'stale-membership' };
    if (!opts.replaceHandEdit && this.handEdited()) return { ok: false, reason: 'org-intent-hand-edited' };
    const ordering = opts.ordering ?? this.nextOrdering();
    const membership: Membership = {
      state: 'joined', orgId: bundle.record.orgId, version: bundle.record.version, policySha256: bundle.record.policySha256,
      updateOrigin: bundle.record.updateOrigin, ...ordering,
    };
    const pins: Pins = { ...this.pins(), [bundle.record.orgId]: { key: bundle.record.signerPublicKey, versionFloor: Math.max(held.versionFloor, bundle.record.version) } };
    const txnId = crypto.randomUUID();
    this.stage(txnId, { bundle }, membership, pins);
    const before = fx.currentProfile?.();
    if (before) writeAtomic(path.join(this.root, 'staging', txnId, 'authority-before.json'), JSON.stringify({ profile: before, settings: fx.currentSettings?.() ?? null }));
    writeAtomic(path.join(this.root, 'txn.json'), JSON.stringify({ txnId, orgId: bundle.record.orgId, version: bundle.record.version, op: 'apply', ...(opts.replaceHandEdit ? { replaceHandEdit: true } : {}) } satisfies Txn));
    this.finish(fx);
    return { ok: true, applied: drifted ? 'repaired' : held.joined ? 'updated' : 'joined', version: bundle.record.version };
  }

  /**
   * A peer's fan-out or start-up catch-up (§Multi-machine): newer membership wins by the ordering
   * tuple, even for another organization; an unchanged policy only advances the tuple.
   */
  reconcile(membership: Membership, bundle: unknown | null, fx: ApplyEffects = {}): ApplyResult {
    const ordering = { epoch: membership.epoch, changedAt: membership.changedAt, machineId: membership.machineId };
    if (!OrgPackStore.newer(ordering, this.membership())) return { ok: false, reason: 'stale-membership' };
    if (membership.state === 'left') return this.leave({ ordering }, fx);
    const cur = this.membership();
    if (cur?.state === 'joined' && cur.orgId === membership.orgId && cur.policySha256 === membership.policySha256 && cur.version === membership.version) {
      writeAtomic(path.join(this.root, 'membership.json'), JSON.stringify({ ...cur, ...ordering }));
      return { ok: true, applied: 'already-current', version: cur.version };
    }
    return this.apply(bundle, { ordering, reconcile: true }, fx);
  }

  /** Leave (§C). The pin and version floor stay, so an old invitation cannot roll a rejoin back. */
  leave(opts: { ordering?: Pick<Membership, 'epoch' | 'changedAt' | 'machineId'> } = {}, fx: ApplyEffects = {}): ApplyResult {
    const m = this.membership();
    if (!m || m.state !== 'joined') return { ok: false, reason: 'not-member' };
    if (this.handEdited()) return { ok: false, reason: 'org-intent-hand-edited' };
    if (opts.ordering && !OrgPackStore.newer(opts.ordering, m)) return { ok: false, reason: 'stale-membership' };
    const membership: Membership = { ...m, state: 'left', ...(opts.ordering ?? this.nextOrdering()) };
    const txnId = crypto.randomUUID();
    this.stage(txnId, { leave: true }, membership, this.pins());
    writeAtomic(path.join(this.root, 'txn.json'), JSON.stringify({ txnId, orgId: m.orgId, version: null, op: 'leave' } satisfies Txn));
    this.finish(fx);
    return { ok: true, applied: 'left', version: null };
  }

  private stage(txnId: string, input: { bundle?: OrgBundle; leave?: true }, membership: Membership, pins: Pins): void {
    const dir = path.join(this.root, 'staging', txnId);
    writeAtomic(path.join(dir, 'bundle.json'), JSON.stringify(input));
    writeAtomic(path.join(dir, 'membership.json'), JSON.stringify(membership));
    writeAtomic(path.join(dir, 'pins.json'), JSON.stringify(pins));
  }

  private intentDrifted(): boolean {
    const applied = (() => { try { return fs.readFileSync(path.join(this.root, 'applied-intent.sha256'), 'utf-8').trim(); } catch { return null; } })(); // @silent-fallback-ok — absent means drifted
    let text = '';
    try { text = fs.readFileSync(this.intentFile, 'utf-8'); } catch { return true; } // @silent-fallback-ok — a missing rules file has drifted
    return sha256Hex(text) !== applied;
  }

  /** Steps 2–5 from the marker and its staging folder; also the recovery path at start. */
  finish(fx: ApplyEffects = {}): boolean {
    const txn = readJson<Txn>(path.join(this.root, 'txn.json'));
    if (!txn) { this.sweepStaging(); return false; }
    // Recovery runs the hand-edit preflight again; a file edited since is never replaced without the person.
    if (!txn.replaceHandEdit && this.handEdited()) return false;
    const dir = path.join(this.root, 'staging', txn.txnId);
    const input = readJson<{ bundle?: OrgBundle; leave?: true }>(path.join(dir, 'bundle.json'));
    const membership = readJson<Membership>(path.join(dir, 'membership.json'));
    const pins = readJson<Pins>(path.join(dir, 'pins.json'));
    if (!input || !membership || !pins) {
      // Staging incomplete means the marker cannot exist (it is written last); a damaged one is dropped.
      SafeFsExecutor.safeUnlinkSync(path.join(this.root, 'txn.json'), { operation: 'org pack: drop a marker with no staging' });
      return false;
    }
    if (input.leave) {
      try { SafeFsExecutor.safeUnlinkSync(this.intentFile, { operation: 'org pack leave: remove generated rules' }); } catch { /* @silent-fallback-ok — already gone */ }
      this.restoreClamped(membership.orgId, fx);
      writeAtomic(path.join(this.root, 'membership.json'), JSON.stringify(membership));
      writeAtomic(path.join(this.root, 'pins.json'), JSON.stringify(pins));
      try { SafeFsExecutor.safeUnlinkSync(path.join(this.root, 'applied-intent.sha256'), { operation: 'org pack leave' }); } catch { /* @silent-fallback-ok — already gone */ }
      // The pack folder is kept for the record under a left-<date> name (§C leave); pins stay.
      const packDir = path.join(this.root, membership.orgId);
      if (fs.existsSync(packDir)) {
        try { fs.renameSync(packDir, path.join(this.root, `left-${new Date(this.now()).toISOString().slice(0, 10)}-${membership.orgId}-${crypto.randomBytes(2).toString('hex')}`)); } catch { /* @silent-fallback-ok — kept under its own name */ }
      }
      fx.journal?.('org-pack-left', { orgId: membership.orgId });
    } else {
      const b = input.bundle!;
      const verDir = path.join(this.root, b.record.orgId, `v${b.record.version}`);
      const parsed = parsePolicy(b.policy);
      const intent = generateOrgIntent(b.record.orgName, b.record.version, b.record.policySha256, parsed);
      if (!fs.existsSync(path.join(verDir, 'record.json'))) {
        writeAtomic(path.join(verDir, 'policy.md'), b.policy);
        writeAtomic(path.join(verDir, 'intent.sha256'), sha256Hex(intent));
        writeAtomic(path.join(verDir, 'record.json'), JSON.stringify(b.record));
      }
      writeAtomic(this.intentFile, intent);
      const cap = INDEPENDENCE_TO_PROFILE[b.record.maxIndependence];
      // The value to restore is saved before anything is lowered (spec §D cap, "On apply").
      const before = readJson<{ profile: AutonomyProfileLevel; settings: Record<string, unknown> | null }>(path.join(dir, 'authority-before.json'));
      const clampedFile = path.join(this.root, b.record.orgId, 'clamped.json');
      // Everything to restore is saved before anything is lowered or clamped (crash-safe).
      if (before && !fs.existsSync(clampedFile)) writeAtomic(clampedFile, JSON.stringify({ profile: before.profile, cap, ...(before.settings ? { settings: before.settings } : {}) }));
      fx.lowerProfile?.(cap, b.record.orgName);
      fx.clampSettings?.(cap);
      writeAtomic(path.join(this.root, b.record.orgId, 'current'), `v${b.record.version}\n`);
      writeAtomic(path.join(this.root, 'membership.json'), JSON.stringify(membership));
      writeAtomic(path.join(this.root, 'pins.json'), JSON.stringify(pins));
      writeAtomic(path.join(this.root, 'applied-intent.sha256'), sha256Hex(intent));
      fx.journal?.('org-pack-applied', { orgId: b.record.orgId, version: b.record.version, policySha256: b.record.policySha256 });
    }
    SafeFsExecutor.safeUnlinkSync(path.join(this.root, 'txn.json'), { operation: 'org pack: transaction done' });
    this.sweepStaging();
    return true;
  }

  private restoreClamped(orgId: string, fx: ApplyEffects): void {
    const file = path.join(this.root, orgId, 'clamped.json');
    const c = readJson<{ profile?: AutonomyProfileLevel; cap: AutonomyProfileLevel; settings?: Record<string, unknown> }>(file);
    if (c?.settings) fx.restoreSettings?.(c.settings, c.cap);
    if (c?.profile) fx.restoreProfile?.(c.profile, c.cap);
    try { SafeFsExecutor.safeUnlinkSync(file, { operation: 'org pack leave: clamp restored' }); } catch { /* @silent-fallback-ok — nothing clamped */ }
  }

  /** Staging folders with no marker naming them are leftovers from an interruption before the marker. */
  private sweepStaging(): void {
    const dir = path.join(this.root, 'staging');
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { return; } // @silent-fallback-ok — no staging folder
    const txn = readJson<Txn>(path.join(this.root, 'txn.json'));
    for (const n of names) {
      if (txn && n === txn.txnId) continue;
      SafeFsExecutor.safeRmSync(path.join(dir, n), { recursive: true, force: true, operation: 'org pack: sweep staging' });
    }
  }
}
