/**
 * The organization pack (docs/specs/org-pack-and-join.md §A, §C, §D): parsing a policy, generating
 * ORG-INTENT.md from it, the signed record, the invitation bundle, and the one validation used by
 * join and update alike. Pure functions here; file writes and routes live in OrgPackStore and the
 * server routes.
 */
import crypto from 'node:crypto';
import zlib from 'node:zlib';

export const ORG_BUNDLE_MAX_BYTES = 64 * 1024;
export const ORG_ITEMS_MAX = 25;
export const ORG_ITEM_MAX_CHARS = 300;
export const ORG_INTENT_MAX_BYTES = 8 * 1024;

export type MaxIndependence = 'careful' | 'balanced' | 'trusting' | 'independent';
export const INDEPENDENCE_TO_PROFILE = {
  careful: 'cautious', balanced: 'supervised', trusting: 'collaborative', independent: 'autonomous',
} as const;

export interface ParsedPolicy {
  purpose: string[];
  never: string[];
  askFirst: string[];
  normally: string[];
  /** Unknown headings with their lines, kept verbatim. */
  other: Array<{ heading: string; lines: string[] }>;
  /** Text that sits under no recognized heading and is not a list item (asked about one at a time). */
  unplaced: string[];
}

export interface OrgRecord {
  v: 1;
  orgId: string;
  orgName: string;
  version: number;
  policySha256: string;
  maxIndependence: MaxIndependence;
  publishedAt: string;
  publishedBy: string;
  keepers: string[];
  updateOrigin: string | null;
  signerPublicKey: string;
  sig: string;
}

export interface OrgBundle { record: OrgRecord; policy: string }

const HEADINGS: Record<string, keyof Omit<ParsedPolicy, 'other' | 'unplaced'>> = {
  purpose: 'purpose', never: 'never', 'ask first': 'askFirst', normally: 'normally',
};

/** Splits a policy into its sections (§A). A heading is a `#`-line or a bold line ending in a colon or a parenthesis note. */
export function parsePolicy(markdown: string): ParsedPolicy {
  const out: ParsedPolicy = { purpose: [], never: [], askFirst: [], normally: [], other: [], unplaced: [] };
  let current: keyof Omit<ParsedPolicy, 'other' | 'unplaced'> | { other: number } | null = null;
  for (const rawLine of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = headingOf(line);
    if (heading !== null) {
      const known = HEADINGS[heading.name.toLowerCase()];
      if (known) {
        current = known;
        if (heading.rest) pushItem(out, known, heading.rest);
      } else {
        out.other.push({ heading: heading.name, lines: heading.rest ? [heading.rest] : [] });
        current = { other: out.other.length - 1 };
      }
      continue;
    }
    const isListItem = /^(?:[-*+]|\d+[.)])\s+/.test(line);
    const item = line.replace(/^(?:[-*+]|\d+[.)])\s+/, '').trim();
    if (current === null) { out.unplaced.push(line); continue; }
    if (typeof current === 'object') { out.other[current.other]!.lines.push(line); continue; }
    // Under a list heading only list items are rules; a paragraph there is asked about, never guessed.
    if (current !== 'purpose' && !isListItem) { out.unplaced.push(line); continue; }
    pushItem(out, current, item);
  }
  return out;
}

function pushItem(out: ParsedPolicy, key: keyof Omit<ParsedPolicy, 'other' | 'unplaced'>, text: string): void {
  if (text) out[key].push(text);
}

/** `## Never`, `**Never** (…)`, `**Purpose.** text`, `Never:` → { name, rest }. */
function headingOf(line: string): { name: string; rest: string } | null {
  const md = /^#{1,6}\s+(.+?)\s*:?\s*$/.exec(line);
  if (md) return { name: stripNote(md[1]!), rest: '' };
  const bold = /^\*\*(.+?)\*\*\s*(.*)$/.exec(line);
  if (bold) {
    const name = stripNote(bold[1]!.replace(/[.:]\s*$/, ''));
    let rest = bold[2]!.trim();
    // "**Never** (the agent will not do these, whatever it is asked):" — the note is not content.
    if (/^\(.*\):?$/.test(rest)) rest = '';
    rest = rest.replace(/^[.:]\s*/, '');
    if (name.split(/\s+/).length <= 4) return { name, rest };
  }
  return null;
}

function stripNote(s: string): string {
  return s.replace(/\s*\(.*\)\s*$/, '').replace(/[.:]\s*$/, '').trim();
}

/** Size limits (§A): too long a policy is refused before anything is written. */
export function policyTooLong(p: ParsedPolicy): string | null {
  for (const [label, items] of [['Purpose', p.purpose], ['Never', p.never], ['Ask first', p.askFirst], ['Normally', p.normally]] as const) {
    if (items.length > ORG_ITEMS_MAX) return `${label} has ${items.length} items; the most is ${ORG_ITEMS_MAX}.`;
    const long = items.find((i) => i.length > ORG_ITEM_MAX_CHARS);
    if (long) return `A ${label} item is ${long.length} characters; the most is ${ORG_ITEM_MAX_CHARS}.`;
  }
  return null;
}

const NEGATED = /^(never|do not|don't|dont|must not|should not|shouldn't)\b/i;

/** The rules file in the existing ORG-INTENT format, meaning preserved line by line (§A). */
export function generateOrgIntent(orgName: string, version: number, policySha256: string, p: ParsedPolicy): string {
  const esc = (l: string): string => l.replace(/^#/, '\\#');
  const lines: string[] = [];
  lines.push(`# Organizational Intent: ${orgName}`);
  lines.push('');
  lines.push(`<!-- Generated from ${orgName}'s published AI policy, version ${version} (sha256 ${policySha256}). Do not edit: your organization's policy replaces this file. -->`);
  if (p.purpose.length) {
    lines.push('', '## Purpose', '', ...p.purpose.map(esc));
  }
  if (p.never.length) {
    lines.push('', '## Constraints', '');
    // An item already worded as a prohibition keeps its words; any other is prefixed, so meaning never flips.
    for (const n of p.never) lines.push(NEGATED.test(n) ? `- ${n}` : `- Never: ${n}`);
  }
  if (p.askFirst.length) {
    lines.push('', '## Ask First', '');
    for (const a of p.askFirst) lines.push(`- Ask your person first before: ${a}`);
  }
  if (p.normally.length) {
    lines.push('', '## Goals', '');
    for (const g of p.normally) lines.push(`- By default: ${g}`);
  }
  if (p.other.length || p.unplaced.length) {
    lines.push('', '## Also In This Policy', '');
    for (const u of p.unplaced) lines.push(esc(u));
    for (const o of p.other) {
      lines.push(`**${o.heading.replace(/\*/g, '')}**`);
      for (const l of o.lines) lines.push(esc(l));
    }
  }
  lines.push('');
  return lines.join('\n');
}

export function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Short code for the organization's key (§A): first 10 bytes of SHA-256, 5 groups of 4 hex. */
export function orgKeyCode(signerPublicKey: string): string {
  const h = crypto.createHash('sha256').update(Buffer.from(signerPublicKey, 'base64url')).digest('hex').slice(0, 20).toUpperCase();
  return h.match(/.{4}/g)!.join('-');
}

/** Canonical JSON (sorted keys) of the record without `sig`. */
export function recordPayload(r: Omit<OrgRecord, 'sig'> | OrgRecord): string {
  const { sig: _sig, ...rest } = r as OrgRecord;
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])])) : v;
  return JSON.stringify(sort(rest));
}

export function newOrgKeyPair(): { publicKey: string; privateKeyPem: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return { publicKey: raw.toString('base64url'), privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }) as string };
}

export function signRecord(unsigned: Omit<OrgRecord, 'sig'>, privateKeyPem: string): OrgRecord {
  const sig = crypto.sign(null, Buffer.from(recordPayload(unsigned)), privateKeyPem).toString('base64url');
  return { ...unsigned, sig };
}

export function verifyRecordSignature(r: OrgRecord): boolean {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(r.signerPublicKey, 'base64url'), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(recordPayload(r)), key, Buffer.from(r.sig, 'base64url'));
  } catch { return false; } // @silent-fallback-ok — a key or signature that cannot be read is an invalid signature
}

export function encodeBundle(b: OrgBundle): string {
  return zlib.deflateRawSync(Buffer.from(JSON.stringify(b), 'utf8')).toString('base64url');
}

export type BundleRefusal =
  | 'bundle-unreadable' | 'bundle-too-large' | 'bundle-shape' | 'policy-hash-mismatch' | 'bad-signature'
  | 'policy-too-long' | 'org-key-changed' | 'older-version' | 'version-conflict' | 'already-member';

export function decodeBundle(encoded: string): { ok: true; bundle: OrgBundle } | { ok: false; reason: BundleRefusal } {
  if (typeof encoded !== 'string' || encoded.length > ORG_BUNDLE_MAX_BYTES * 2) return { ok: false, reason: 'bundle-too-large' };
  let raw: Buffer;
  try { raw = zlib.inflateRawSync(Buffer.from(encoded, 'base64url'), { maxOutputLength: ORG_BUNDLE_MAX_BYTES }); } catch (err) {
    return { ok: false, reason: (err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' ? 'bundle-too-large' : 'bundle-unreadable' };
  }
  let b: unknown;
  try { b = JSON.parse(raw.toString('utf8')); } catch { return { ok: false, reason: 'bundle-unreadable' }; } // @silent-fallback-ok — returned as a refusal
  return isBundle(b) ? { ok: true, bundle: b } : { ok: false, reason: 'bundle-shape' };
}

const INDEPENDENCE = new Set<MaxIndependence>(['careful', 'balanced', 'trusting', 'independent']);

function isBundle(b: unknown): b is OrgBundle {
  const x = b as OrgBundle;
  const r = x?.record;
  return !!x && typeof x.policy === 'string' && !!r && r.v === 1
    && typeof r.orgId === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(r.orgId)
    // One plain line: a name is written into a heading, so a newline could inject rule lines.
    && typeof r.orgName === 'string' && /^[^\x00-\x1f\x7f#*]{1,120}$/.test(r.orgName)
    && Number.isSafeInteger(r.version) && r.version >= 1
    && typeof r.policySha256 === 'string' && /^[0-9a-f]{64}$/.test(r.policySha256)
    && INDEPENDENCE.has(r.maxIndependence)
    && typeof r.publishedAt === 'string' && typeof r.publishedBy === 'string' && /^[^\x00-\x1f\x7f]{0,120}$/.test(r.publishedBy)
    && Array.isArray(r.keepers) && r.keepers.length <= 10 && r.keepers.every((k) => typeof k === 'string' && /^[^\x00-\x1f\x7f]{1,120}$/.test(k))
    && (r.updateOrigin === null || typeof r.updateOrigin === 'string')
    && typeof r.signerPublicKey === 'string' && typeof r.sig === 'string';
}

export interface HeldMembership { pinnedKey: string | null; versionFloor: number; joined: boolean; joinedVersion: number | null; joinedHash: string | null; joinedOrgId: string | null }

/**
 * The one check for join and update (§D `validateBundle`). `held` describes what this agent already
 * holds for the bundle's org (pins.json and membership.json).
 */
export function validateBundle(input: unknown, held: HeldMembership, opts: { skipMembership?: boolean } = {}):
  { ok: true; bundle: OrgBundle; parsed: ParsedPolicy; sameVersion: boolean } | { ok: false; reason: BundleRefusal } {
  // Raw input: shape and whole-bundle size first, before any field is read (spec §D validateBundle).
  if (!isBundle(input)) return { ok: false, reason: 'bundle-shape' };
  const b = input;
  if (Buffer.byteLength(JSON.stringify(b), 'utf8') > ORG_BUNDLE_MAX_BYTES) return { ok: false, reason: 'bundle-too-large' };
  if (sha256Hex(b.policy) !== b.record.policySha256) return { ok: false, reason: 'policy-hash-mismatch' };
  if (!verifyRecordSignature(b.record)) return { ok: false, reason: 'bad-signature' };
  const parsed = parsePolicy(b.policy);
  if (policyTooLong(parsed)) return { ok: false, reason: 'policy-too-long' };
  if (Buffer.byteLength(generateOrgIntent(b.record.orgName, b.record.version, b.record.policySha256, parsed), 'utf8') > ORG_INTENT_MAX_BYTES) {
    return { ok: false, reason: 'policy-too-long' };
  }
  if (!opts.skipMembership && held.joinedOrgId && held.joinedOrgId !== b.record.orgId) return { ok: false, reason: 'already-member' };
  if (held.pinnedKey && held.pinnedKey !== b.record.signerPublicKey) return { ok: false, reason: 'org-key-changed' };
  if (b.record.version < held.versionFloor) return { ok: false, reason: 'older-version' };
  const sameVersion = held.joined && held.joinedVersion === b.record.version;
  if (sameVersion && held.joinedHash !== b.record.policySha256) return { ok: false, reason: 'version-conflict' };
  return { ok: true, bundle: b, parsed, sameVersion };
}
