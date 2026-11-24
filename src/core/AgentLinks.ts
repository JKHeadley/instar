/**
 * Permanent agent links (docs/specs/permanent-agent-links.md).
 *
 * A link names the agent by its canonical id (SHA-256 over its Ed25519 public key) and a page,
 * never a machine or an address:
 *
 *   https://instar.sh/a#v=1&i=<64 hex>&t=home|doc|conversation[&r=<ref>][&c=<comment key>]
 *
 * This module holds the pure parts: the v1 grammar (one parser, shared accept/reject vectors with
 * the site's `a.js` and the app), the link builder, the strict identity read the identity route
 * uses, and the possession-proof transcript. It never mints, repairs or rewrites an identity.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { readIdentityKeyFile } from '../identity/IdentityKeyFile.js';
import { computeCanonicalId } from '../identity/types.js';

export const AGENT_LINK_WEB_BASE = 'https://instar.sh/a#';
export const AGENT_LINK_APP_BASE = 'instar://a#';
export const PROOF_DOMAIN = 'instar-agent-link-proof-v1';

export type AgentLinkTarget = 'home' | 'doc' | 'conversation' | 'card';

export interface AgentLink {
  id: string;
  target: AgentLinkTarget;
  ref: string | null;
  comment: string | null;
}

const ID_RE = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TG_RE = /^tg:[1-9][0-9]{0,15}$/;
/** The server's comment-key pattern (src/documents/rows.ts isCommentKey). */
const COMMENT_RE = /^[A-Za-z0-9._:-]{1,200}:[0-9a-f-]{36}$/;
const FIELDS: Record<AgentLinkTarget, readonly string[]> = { home: [], doc: ['r', 'c'], conversation: ['r'], card: ['r'] };
const KEYS = ['v', 'i', 't', 'r', 'c'];

/**
 * A safe upper bound on a valid fragment, computed from the grammar: the longest target name
 * with `c` (which the grammar never allows together), and `c` with every ':' encoded as '%3A'.
 */
export const MAX_FRAGMENT = 'v=1&i=&t=conversation&r=&c='.length + 64 + 36 + 3 * 237;

function isTgRef(ref: string): boolean {
  return TG_RE.test(ref) && Number(ref.slice(3)) <= Number.MAX_SAFE_INTEGER;
}

function validRef(target: AgentLinkTarget, ref: string | null): boolean {
  if (target === 'home') return ref === null;
  if (ref === null) return false;
  if (target === 'doc') return UUID_RE.test(ref);
  if (target === 'card') return /^wc_[0-9a-f]{16}$/.test(ref);
  return UUID_RE.test(ref) || isTgRef(ref);
}

/**
 * Parse a v1 fragment (with or without '#'). Returns null for anything that is not a valid v1
 * link: unknown or duplicate keys, a field the target does not take, a field failing its pattern,
 * or a '%' anywhere except '%3A' inside `r` or `c`.
 */
export function parseAgentLink(fragment: unknown): AgentLink | null {
  if (typeof fragment !== 'string') return null;
  const raw = fragment.replace(/^#/, '');
  if (!raw || raw.length > MAX_FRAGMENT) return null;
  const q = new Map<string, string>();
  for (const kv of raw.split('&')) {
    const i = kv.indexOf('=');
    if (i <= 0) return null;
    const k = kv.slice(0, i);
    if (!KEYS.includes(k) || q.has(k)) return null;
    let v = kv.slice(i + 1);
    if (v.includes('%')) {
      if ((k !== 'c' && k !== 'r') || /%(?!3[aA])/.test(v)) return null;
      v = v.replace(/%3[aA]/g, ':');
    }
    q.set(k, v);
  }
  if (q.get('v') !== '1') return null;
  const id = q.get('i');
  const target = q.get('t');
  if (!id || !ID_RE.test(id)) return null;
  if (!target || !Object.prototype.hasOwnProperty.call(FIELDS, target)) return null;
  const t = target as AgentLinkTarget;
  for (const k of q.keys()) if (!['v', 'i', 't'].includes(k) && !FIELDS[t].includes(k)) return null;
  const ref = q.get('r') ?? null;
  const comment = q.get('c') ?? null;
  if (!validRef(t, ref)) return null;
  if (comment !== null && !COMMENT_RE.test(comment)) return null;
  return { id, target: t, ref, comment };
}

/** The canonical fragment for a valid link, built from typed values in a fixed order. */
export function canonicalFragment(link: AgentLink): string {
  let f = `v=1&i=${link.id}&t=${link.target}`;
  if (link.ref !== null) f += `&r=${link.ref}`;
  if (link.comment !== null) f += `&c=${link.comment.replace(/:/g, '%3A')}`;
  return f;
}

export type BuildLinkResult =
  | { ok: true; url: string; appUrl: string; link: AgentLink }
  | { ok: false; error: 'bad-target' };

/**
 * Build a link for this agent. `comment` is included only when the caller passes it (a comment
 * key discloses its author's person key). Returns a reference only: no share, grant or pairing.
 */
export function buildAgentLink(canonicalId: string, input: { target?: unknown; ref?: unknown; comment?: unknown }): BuildLinkResult {
  const target = input.target;
  if (target !== 'home' && target !== 'doc' && target !== 'conversation' && target !== 'card') return { ok: false, error: 'bad-target' };
  let ref: string | null = null;
  if (input.ref !== undefined && input.ref !== null) {
    if (typeof input.ref === 'number' && target === 'conversation') ref = `tg:${input.ref}`;
    else if (typeof input.ref === 'string') ref = input.ref.toLowerCase();
    else return { ok: false, error: 'bad-target' };
  }
  let comment: string | null = null;
  if (input.comment !== undefined && input.comment !== null) {
    if (target !== 'doc' || typeof input.comment !== 'string' || !COMMENT_RE.test(input.comment)) return { ok: false, error: 'bad-target' };
    comment = input.comment;
  }
  if (!ID_RE.test(canonicalId) || !validRef(target, ref)) return { ok: false, error: 'bad-target' };
  const link: AgentLink = { id: canonicalId, target, ref, comment };
  // Round-trip through the one parser, so the builder can never emit a link the app refuses.
  const frag = canonicalFragment(link);
  if (!parseAgentLink(frag)) return { ok: false, error: 'bad-target' };
  return { ok: true, url: AGENT_LINK_WEB_BASE + frag, appUrl: AGENT_LINK_APP_BASE + frag, link };
}

export type LinkIdentity =
  | { ok: true; canonicalId: string; publicKey: Buffer; privateKey: Buffer; file: string }
  | { ok: false; error: 'no-agent-identity' | 'identity-key-locked' | 'identity-unreadable' | 'identity-split' };

type Loaded = { kind: 'absent' } | { kind: 'invalid' } | { kind: 'locked'; publicKey: Buffer } | { kind: 'ok'; publicKey: Buffer; privateKey: Buffer };

function load(file: string, read: typeof readIdentityKeyFile): Loaded {
  try {
    const r = read(file, { repair: false });
    if (!r) return { kind: 'absent' };
    if (r.encrypted || !r.privateKey) return { kind: 'locked', publicKey: r.publicKey };
    return { kind: 'ok', publicKey: r.publicKey, privateKey: r.privateKey };
  } catch {
    // @silent-fallback-ok — IdentityFileInvalidError (or any read failure) is reported as identity-unreadable
    return { kind: 'invalid' };
  }
}

/**
 * The identity a link names (spec §2a). Strict: when `<stateDir>/identity.json` exists it alone
 * decides (unusable → identity-unreadable, encrypted → identity-key-locked, no fall-through); the
 * Threadline legacy file is used only when it is absent; both readable with different keys →
 * identity-split. The id is computed from the public key, never read from a stored field.
 */
export function readLinkIdentity(stateDir: string, deps: { read?: typeof readIdentityKeyFile } = {}): LinkIdentity {
  const read = deps.read ?? readIdentityKeyFile;
  const mainFile = path.join(stateDir, 'identity.json');
  const legacyFile = path.join(stateDir, 'threadline', 'identity.json');
  const main = load(mainFile, read);
  const legacy = load(legacyFile, read);
  if (main.kind === 'absent') {
    if (legacy.kind === 'absent') return { ok: false, error: 'no-agent-identity' };
    if (legacy.kind === 'invalid') return { ok: false, error: 'identity-unreadable' };
    if (legacy.kind === 'locked') return { ok: false, error: 'identity-key-locked' };
    return { ok: true, canonicalId: computeCanonicalId(legacy.publicKey), publicKey: legacy.publicKey, privateKey: legacy.privateKey, file: legacyFile };
  }
  if (main.kind === 'invalid') return { ok: false, error: 'identity-unreadable' };
  if (main.kind === 'locked') return { ok: false, error: 'identity-key-locked' };
  if ((legacy.kind === 'ok' || legacy.kind === 'locked') && !legacy.publicKey.equals(main.publicKey)) {
    return { ok: false, error: 'identity-split' };
  }
  return { ok: true, canonicalId: computeCanonicalId(main.publicKey), publicKey: main.publicKey, privateKey: main.privateKey, file: mainFile };
}

/** A nonce is exactly 32 bytes as unpadded base64url; any other spelling is refused. */
export function parseNonce(raw: unknown): string | null {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return null;
  const bytes = Buffer.from(raw, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== raw) return null;
  return raw;
}

/** The exact bytes the identity key signs (spec §2a). The fixed first line is domain separation. */
export function proofTranscript(canonicalId: string, deviceId: string, host: string, nonce: string): Buffer {
  return Buffer.from(`${PROOF_DOMAIN}\n${canonicalId}\n${deviceId}\n${host}\n${nonce}`, 'utf-8');
}

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Sign a proof transcript with the raw 32-byte Ed25519 private key. */
export function signProof(privateKey: Buffer, transcript: Buffer): Buffer {
  const key = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, privateKey]), format: 'der', type: 'pkcs8' });
  return crypto.sign(null, transcript, key);
}

/** Verify a proof (used by tests, and the same check the app makes). */
export function verifyProof(publicKey: Buffer, transcript: Buffer, signature: Buffer): boolean {
  try {
    const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, publicKey]), format: 'der', type: 'spki' });
    return crypto.verify(null, transcript, key, signature);
  } catch {
    return false; // @silent-fallback-ok — a malformed key is simply a failed verification
  }
}
