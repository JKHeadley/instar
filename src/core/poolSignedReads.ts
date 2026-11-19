import fs from 'node:fs';
/**
 * Signed pool reads: verb first, bearer only on a definite "cannot serve this kind of read"
 * (native-conversation-any-machine-access §3d items 3 and 5, FD-18).
 *
 * The bearer hop is allowed only when the peer says, definitely, that it cannot serve this kind of
 * read:
 *   - the mesh reason `no-handler` (the verb is known to RBAC but has no handler there);
 *   - `claim-unauthorized` from a peer whose version advert is absent or older than the release that
 *     carries the verbs (an older peer answers an unknown verb that way from its RBAC default);
 *     `claim-unauthorized` alone, from a peer that should know the verb, is a real denial;
 *   - for pool history, an answer that does not echo `shape: 'pool'` (a peer with the history verb
 *     but not the pool shape).
 * A timeout or any other error is that machine's failure and never downgrades to sending the token.
 *
 * What each machine has answered in signed form is remembered per machine, per kind of read and
 * per version (`signedCapable`); a remembered "needs bearer" is dropped when the peer's version
 * changes. This is a derived per-machine cache, rebuilt by the next read (Multi-machine posture).
 */
import type { MeshRpcClientResult } from './MeshRpcClient.js';

export type SignedReadKind = 'transcript' | 'list' | 'historyPool';
export const SIGNED_READ_KINDS: readonly SignedReadKind[] = ['transcript', 'list', 'historyPool'];

/**
 * The first release that serves `session-transcript-pull` and the pool shape of
 * `topic-history-pull`. A peer advertising this version or newer that answers `claim-unauthorized`
 * is refusing, not old.
 */
export const SIGNED_POOL_READS_MIN_VERSION = '1.3.1740';

export function versionAtLeast(actual: string | null | undefined, minimum: string): boolean {
  if (typeof actual !== 'string') return false;
  const parse = (v: string) => v.replace(/^v/, '').split(/[.-]/).slice(0, 3).map((p) => Number(p));
  const a = parse(actual);
  const b = parse(minimum);
  if (a.length < 3 || a.some((n) => !Number.isSafeInteger(n))) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
}

/** Whether a signed answer permits the bearer hop for this kind of read. */
export function bearerFallbackPermitted(kind: SignedReadKind, res: MeshRpcClientResult, peerVersion: string | null): boolean {
  if (!res.ok) {
    if (res.reason === 'no-handler') return true;
    if (res.reason === 'claim-unauthorized') return !versionAtLeast(peerVersion, SIGNED_POOL_READS_MIN_VERSION);
    return false;
  }
  if (kind === 'historyPool') {
    const body = res.result as { ok?: unknown; shape?: unknown } | null | undefined;
    // An answer that is a success but does not echo the pool shape is an older peer's default shape.
    return !!body && body.ok === true && body.shape !== 'pool';
  }
  return false;
}

/**
 * SEC-114 (active form), an interim mitigation. A MeshRpc ANSWER is not signed, so "I cannot serve
 * this read" can be forged by anyone on the network path between two machines, to make the sender
 * fall back to the bearer and send the agent token over that same path. No version source is signed
 * either (the capacity advert also arrives in an unsigned answer), so this does NOT guarantee the
 * token is never sent; it raises the cost. The rule: once a machine has EVER been seen at a version
 * that serves these reads, the fallback to it is refused, whatever an answer says. The highest
 * version seen is a ratchet ({@link PeerVersionFloor}): an attacker can only raise it, which causes
 * refusals (the safe direction), never lower it to reopen the fallback. The full fix is signed answers.
 */
export function bearerFallbackBarredByVersionFloor(highestVersionSeen: string | null | undefined): boolean {
  return versionAtLeast(highestVersionSeen, SIGNED_POOL_READS_MIN_VERSION);
}

/** Compare two versions; null/unparseable sorts lowest. */
function versionGreater(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!versionAtLeast(a, '0.0.0')) return false;
  if (!versionAtLeast(b, '0.0.0')) return true;
  return versionAtLeast(a, b as string) && !versionAtLeast(b, a as string);
}

/**
 * The highest version ever seen for each peer machine, persisted on THIS machine and never lowered
 * (SEC-114). Fed from every version the pool registry reports; written only when a value rises.
 */
export class PeerVersionFloor {
  private map: Record<string, string> | null = null;
  constructor(private readonly filePath: string | null, private readonly write: (path: string, data: unknown) => void) {}

  private load(): Record<string, string> {
    if (this.map) return this.map;
    this.map = {};
    if (this.filePath) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as { floors?: Record<string, unknown> };
        for (const [k, v] of Object.entries(raw?.floors ?? {})) if (typeof v === 'string') this.map[k] = v;
      } catch { /* @silent-fallback-ok: no file yet, or unreadable: start empty; every observation re-raises it */ }
    }
    return this.map;
  }

  /** Record what is seen now and return the highest version ever seen for this machine. */
  observe(machineId: string, ...seen: Array<string | null | undefined>): string | null {
    const m = this.load();
    let best = m[machineId] ?? null;
    for (const v of seen) if (versionGreater(v, best)) best = v as string;
    if (best && best !== m[machineId]) {
      m[machineId] = best;
      if (this.filePath) {
        try { this.write(this.filePath, { version: 1, floors: m }); } catch { /* @silent-fallback-ok: kept in memory; the next rise retries the write */ }
      }
    }
    return best;
  }
}

interface KindState { signedAt?: string | null; bearerNeededAt?: string | null }

export class SignedReadCapability {
  private readonly byMachine = new Map<string, Map<SignedReadKind, KindState>>();
  private readonly counts = { signedReads: 0, bearerReads: 0, failuresNotDowngraded: 0, fallbacksRefused: 0 };

  private kindState(machineId: string, kind: SignedReadKind): KindState {
    let m = this.byMachine.get(machineId);
    if (!m) { m = new Map(); this.byMachine.set(machineId, m); }
    let k = m.get(kind);
    if (!k) { k = {}; m.set(kind, k); }
    return k;
  }

  /** The machine answered this kind of read in signed form, at this version. */
  recordSigned(machineId: string, kind: SignedReadKind, version: string | null): void {
    const k = this.kindState(machineId, kind);
    k.signedAt = version;
    delete k.bearerNeededAt;
    this.counts.signedReads++;
  }

  /** The machine said, definitely, that it cannot serve this kind; remembered for this version. */
  recordBearerNeeded(machineId: string, kind: SignedReadKind, version: string | null): void {
    const k = this.kindState(machineId, kind);
    k.bearerNeededAt = version;
    delete k.signedAt;
  }

  recordBearerRead(): void { this.counts.bearerReads++; }

  /** A bearer fallback refused because the peer has been seen at a version that serves this read (SEC-114). */
  recordFallbackRefused(): void { this.counts.fallbacksRefused++; }

  /** A timeout or transport error on the signed read that was reported, not sent on by bearer. */
  recordFailureNotDowngraded(): void { this.counts.failuresNotDowngraded++; }

  /** Whether the machine is remembered as needing bearer for this kind AT this version. */
  bearerRemembered(machineId: string, kind: SignedReadKind, version: string | null): boolean {
    const k = this.byMachine.get(machineId)?.get(kind);
    return !!k && 'bearerNeededAt' in k && k.bearerNeededAt === version;
  }

  signedCapable(machineId: string): Record<SignedReadKind, boolean> {
    const m = this.byMachine.get(machineId);
    return {
      transcript: !!m?.get('transcript') && 'signedAt' in m.get('transcript')!,
      list: !!m?.get('list') && 'signedAt' in m.get('list')!,
      historyPool: !!m?.get('historyPool') && 'signedAt' in m.get('historyPool')!,
    };
  }

  /** For each registered member, the kinds of read not yet verified in signed form (FD-18, CMT-051). */
  bearerFallbackNeededBy(memberIds: readonly string[]): Array<{ machineId: string; kinds: SignedReadKind[] }> {
    const out: Array<{ machineId: string; kinds: SignedReadKind[] }> = [];
    for (const machineId of memberIds) {
      const cap = this.signedCapable(machineId);
      const kinds = SIGNED_READ_KINDS.filter((k) => !cap[k]);
      if (kinds.length) out.push({ machineId, kinds });
    }
    return out;
  }

  status(memberIds: readonly string[]): {
    signedCapable: Record<string, Record<SignedReadKind, boolean>>;
    bearerFallbackNeededBy: Array<{ machineId: string; kinds: SignedReadKind[] }>;
    counts: { signedReads: number; bearerReads: number; failuresNotDowngraded: number; fallbacksRefused: number };
  } {
    return {
      signedCapable: Object.fromEntries(memberIds.map((id) => [id, this.signedCapable(id)])),
      bearerFallbackNeededBy: this.bearerFallbackNeededBy(memberIds),
      // The 3d kill criterion "a token sent after a timeout" is excluded by construction in
      // signedThenBearer; failuresNotDowngraded counts the times that path was exercised.
      counts: { ...this.counts },
    };
  }
}

/**
 * Thrown by a bearer read when the machine ANSWERED and refused (a status, a refused URL, an
 * oversized answer): that machine is awake, so it is not listed as asleep or unreachable.
 */
export class BearerReadRefused extends Error {}

export type SignedReadOutcome<T> =
  | { via: 'signed'; value: T }
  | { via: 'bearer'; value: T }
  | { via: null; error: string; unreachable: boolean };

/**
 * One read of one machine: the signed verb first, the bearer hop only when permitted.
 * `signed` throws on a transport error or timeout; that is reported, never downgraded.
 * `accept` turns a signed success into a value, or a string naming why the answer is unusable.
 */
export async function signedThenBearer<T>(o: {
  machineId: string;
  kind: SignedReadKind;
  peerVersion: string | null;
  capability: SignedReadCapability;
  signed: (() => Promise<MeshRpcClientResult>) | null;
  accept: (result: unknown) => T | string;
  bearer: (() => Promise<T>) | null;
  /** The highest version ever seen for this peer (PeerVersionFloor), or null when none (SEC-114). */
  versionFloor?: string | null;
  /** Told once per refused fallback, so a real breakage is loud (SEC-114). */
  onFallbackRefused?: (why: string) => void;
}): Promise<SignedReadOutcome<T>> {
  const barred = bearerFallbackBarredByVersionFloor(o.versionFloor);
  const refuse = (why: string): SignedReadOutcome<T> => {
    o.capability.recordFallbackRefused();
    try { o.onFallbackRefused?.(why); } catch { /* @silent-fallback-ok: the refusal itself is returned to the caller */ }
    return { via: null, error: `bearer-fallback-refused: ${why}`, unreachable: false };
  };
  const viaBearer = async (): Promise<SignedReadOutcome<T>> => {
    if (!o.bearer) return { via: null, error: 'no-bearer-route', unreachable: false };
    try {
      const value = await o.bearer();
      o.capability.recordBearerRead();
      return { via: 'bearer', value };
    } catch (err) {
      return { via: null, error: err instanceof Error ? err.message : String(err), unreachable: !(err instanceof BearerReadRefused) };
    }
  };
  // No signing transport on this machine (mesh not wired): the read is what it was before.
  if (!o.signed) return viaBearer();
  // A remembered "needs bearer" could itself have come from a forged answer: it is not honoured for a
  // peer whose version floor says it serves this read.
  if (o.capability.bearerRemembered(o.machineId, o.kind, o.peerVersion) && !barred) return viaBearer();
  let res: MeshRpcClientResult;
  try {
    res = await o.signed();
  } catch (err) {
    // A timeout or a transport error: that machine's failure. Never send the token after it.
    o.capability.recordFailureNotDowngraded();
    return { via: null, error: err instanceof Error ? (err.name === 'AbortError' ? 'timed out' : err.message) : String(err), unreachable: true };
  }
  if (bearerFallbackPermitted(o.kind, res, o.peerVersion)) {
    if (barred) {
      return refuse(`${o.machineId} answered ${res.ok ? 'an older shape' : (res.reason ?? `HTTP ${res.status}`)} for a ${o.kind} read, but it has been seen at ${o.versionFloor}, which serves it`);
    }
    o.capability.recordBearerNeeded(o.machineId, o.kind, o.peerVersion);
    return viaBearer();
  }
  if (!res.ok) return { via: null, error: res.reason ?? `HTTP ${res.status}`, unreachable: false };
  const accepted = o.accept(res.result);
  if (typeof accepted === 'string') return { via: null, error: accepted, unreachable: false };
  o.capability.recordSigned(o.machineId, o.kind, o.peerVersion);
  return { via: 'signed', value: accepted };
}

/** Content-sniff marker for the CLAUDE.md section (migrateClaudeMd guard). */
export const SIGNED_POOL_READS_AWARENESS_MARKER = '### Reading another machine\'s sessions (signed pool reads)';

/** Agent awareness (native-conversation-any-machine-access §3d, Config and migration parity). */
export function signedPoolReadsAwareness(port: number): string {
  return `${SIGNED_POOL_READS_AWARENESS_MARKER}

Reading a session's transcript, the session list or a topic's pool history on ANOTHER of my machines needs no shared API token: \`GET /sessions/NAME/transcript?machineId=ID\`, the pool session list and a topic's pool History read (\`scope\` set to \`pool\`) ask each machine over the signed mesh first, and each answer says how it was read (\`via: "signed"\` or \`"bearer"\`). The bearer hop is used only when that machine says plainly it is too old for the signed read; a timeout never falls back. A machine that does not answer is named in \`asleepOrUnreachable\` with its last-seen time, so I say "the Mini is asleep (last seen 14:02)", never "no history".
- The transcript is a digest, not the raw record: message text (an entry cut at 4,000 characters carries \`clipped: true\`; ask again with \`full=1\` to read it whole), each tool call as one line, no tool results.
- Paging: pass \`nextBefore\` as \`before\` and, when present, \`nextBeforeIndex\` as \`beforeIndex\`. An answer marked \`truncated\` stopped at the size cap. A single entry larger than the cap comes cut, with \`rowTruncated: { row, totalBytes, from, to }\`: read the rest with \`rowOffset\`, \`rowIndex\` and \`byteFrom=TO\` (pool history: the same page request plus \`machine\`, \`row\` and \`byteFrom\`; the cut row carries \`rowTruncated\`), until \`to\` equals \`totalBytes\`.
- Who may read a transcript: the owner, and only where the owner may see every conversation the session served. "This session serves a conversation that is private to someone else." and "This machine cannot confirm who may see this session right now." are refusals to report as they are, not errors to work around. No phone, member or guest reads a transcript.
- Which machines still need the bearer fallback for which kind of read: \`curl -H "Authorization: Bearer $AUTH" http://localhost:${port}/pool/signed-reads\` (\`signedCapable\`, \`bearerFallbackNeededBy\`).
`;
}
