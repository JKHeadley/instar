/**
 * A second policy keeper (docs/specs/org-members-and-keepers.md §D). Keepers propose; the
 * organization's agent checks each proposal and signs the next version with the organization key,
 * so members only ever trust that one key. Keeper rights live only in
 * `org/published/<orgId>.keepers.json` on the machine holding the organization key.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { orgKeyCode, sha256Hex, signRecord, validateBundle, type MaxIndependence, type OrgBundle, type OrgRecord } from './OrgPack.js';
import { plainName, verifyPayload } from './OrgMembers.js';

export const KEEPERS_MAX = 3;
export const PROPOSAL_WINDOW_MS = 10 * 60_000;
const ORDER: MaxIndependence[] = ['careful', 'balanced', 'trusting', 'independent'];

export interface KeeperEntry { name: string; publicKey: string; addedAt: number }

export interface Proposal {
  v: 1;
  orgId: string;
  baseVersion: number;
  basePolicySha256: string;
  policy: string;
  maxIndependence: MaxIndependence;
  proposedBy: string;
  keeperKey: string;
  at: number;
  sig: string;
}

/** The short code a keeper's agent hands the admin: base64url of `{ orgId, name, publicKey }`. */
export function encodeKeeperCode(c: { orgId: string; name: string; publicKey: string }): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}
export function decodeKeeperCode(code: string): { orgId: string; name: string; publicKey: string } | null {
  try {
    const o = JSON.parse(Buffer.from(code, 'base64url').toString('utf8')) as Record<string, unknown>;
    return typeof o.orgId === 'string' && typeof o.name === 'string' && typeof o.publicKey === 'string' ? { orgId: o.orgId, name: o.name, publicKey: o.publicKey } : null;
  } catch { return null; } // @silent-fallback-ok — an unreadable code is no code
}

/** One in-process lock per state directory, shared by publish and propose (spec §D). */
const locks = new Map<string, Promise<unknown>>();
export function withPublishLock<T>(stateDir: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = locks.get(stateDir) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(stateDir, next.catch(() => undefined));
  return next;
}

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')) as T; } catch { return fallback; } // @silent-fallback-ok — absent reads as empty
}
function writeAtomic(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export type ProposalAnswer =
  | { status: 200; body: { ok: true; version: number } }
  | { status: 400 | 403 | 409; body: { error: string; detail?: string; current?: OrgBundle } };

export class OrgKeepers {
  constructor(private readonly stateDir: string, private readonly orgId: string, private readonly now: () => number = Date.now) {}

  private file(): string { return path.join(this.stateDir, 'org', 'published', `${this.orgId}.keepers.json`); }
  list(): KeeperEntry[] { return readJson(this.file(), [] as KeeperEntry[]); }

  /** The admin's tap with the keeper's code (spec §D): the code must name this organization, the name must be plain. */
  add(code: string): { ok: true; keeper: KeeperEntry; fingerprint: string } | { ok: false; error: string } {
    const c = decodeKeeperCode(code);
    if (!c) return { ok: false, error: 'code-unreadable' };
    if (c.orgId !== this.orgId) return { ok: false, error: 'code-for-another-organization' };
    const name = plainName(c.name);
    if (!name) return { ok: false, error: 'name-not-plain' };
    try { crypto.createPublicKey({ key: Buffer.from(c.publicKey, 'base64url'), format: 'der', type: 'spki' }); } catch { return { ok: false, error: 'key-unreadable' }; } // @silent-fallback-ok — reported as a refusal
    const list = this.list().filter((k) => k.publicKey !== c.publicKey);
    if (list.length >= KEEPERS_MAX) return { ok: false, error: 'too-many-keepers' };
    const keeper = { name, publicKey: c.publicKey, addedAt: this.now() };
    list.push(keeper);
    writeAtomic(this.file(), JSON.stringify(list));
    return { ok: true, keeper, fingerprint: orgKeyCode(c.publicKey) };
  }

  remove(publicKey: string): boolean {
    const list = this.list();
    const rest = list.filter((k) => k.publicKey !== publicKey);
    if (rest.length === list.length) return false;
    writeAtomic(this.file(), JSON.stringify(rest));
    return true;
  }

  /**
   * Checks a proposal against the current published bundle and, when it passes, returns the next
   * bundle signed with the organization key (spec §D). The caller writes it under the publish lock.
   */
  accept(raw: unknown, current: OrgBundle, orgKeyPem: string): { answer: ProposalAnswer; bundle?: OrgBundle } {
    const p = raw as Partial<Proposal> | null;
    if (!p || p.v !== 1 || typeof p.keeperKey !== 'string' || typeof p.policy !== 'string' || typeof p.baseVersion !== 'number'
      || typeof p.basePolicySha256 !== 'string' || typeof p.at !== 'number' || !ORDER.includes(p.maxIndependence as MaxIndependence)) {
      return { answer: { status: 400, body: { error: 'malformed' } } };
    }
    if (p.orgId !== this.orgId) return { answer: { status: 400, body: { error: 'unknown-org' } } };
    const keeper = this.list().find((k) => k.publicKey === p.keeperKey);
    if (!keeper) return { answer: { status: 403, body: { error: 'not-a-keeper' } } };
    if (Math.abs(this.now() - p.at) > PROPOSAL_WINDOW_MS) return { answer: { status: 400, body: { error: 'stale' } } };
    if (!verifyPayload(p, p.keeperKey)) return { answer: { status: 403, body: { error: 'bad-signature' } } };
    const cur = current.record;
    if (p.baseVersion !== cur.version || p.basePolicySha256 !== cur.policySha256) {
      return { answer: { status: 409, body: { error: 'stale-base', detail: 'The policy changed since this draft. Review the newer text first.', current } } };
    }
    if (ORDER.indexOf(p.maxIndependence as MaxIndependence) > ORDER.indexOf(cur.maxIndependence)) {
      return { answer: { status: 403, body: { error: 'keeper-cannot-loosen', detail: 'A keeper can keep or tighten the independence limit, not loosen it.' } } };
    }
    const { sig: _sig, ...rest } = cur;
    const record: OrgRecord = signRecord({
      ...rest, version: cur.version + 1, policySha256: sha256Hex(p.policy), maxIndependence: p.maxIndependence as MaxIndependence,
      publishedAt: new Date(this.now()).toISOString(), publishedBy: keeper.name,
    }, orgKeyPem);
    const bundle: OrgBundle = { record, policy: p.policy };
    // The same check every member runs, so nothing is signed that members would refuse.
    const v = validateBundle(bundle, { pinnedKey: cur.signerPublicKey, versionFloor: cur.version, joined: false, joinedVersion: null, joinedHash: null, joinedOrgId: null }, { skipMembership: true });
    if (!v.ok) return { answer: { status: 400, body: { error: 'invalid-version', detail: String((v as { reason?: unknown }).reason ?? 'refused') } } };
    return { answer: { status: 200, body: { ok: true, version: record.version } }, bundle };
  }
}
