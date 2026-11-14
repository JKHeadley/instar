/**
 * heavyWorkPlacement — the shared pieces behind GET /pool/placement/preview and
 * POST /pool/heavy-work/spawn (docs/specs/resource-aware-placement.md §6).
 *
 * - `heavyReservations`: this process's in-flight holds on heavy work it SENT to a
 *   machine (decider side, §1). Kept to expiry; released only on a definite refusal.
 * - `acceptedHeavy`: heavy helper spawns THIS machine accepted (target side, §1),
 *   advertised as `heavyPending` in this machine's load report.
 * - `previewPlacement`: a read-only dry run of PlacementExecutor.decide() with one
 *   evidence row per machine. Writes nothing, claims nothing.
 */

import type { MachineCapacity } from './types.js';
import { PlacementExecutor, type PlacementDecision } from './PlacementExecutor.js';
import {
  PendingHeavyWork, effectivePending, freshLoadPerCore, heavyFit, inferWorkWeight, profileOf,
  type WorkWeight,
} from './machineResourceProfile.js';

/** Decider-side reservations (machine-local, in memory, capped, 3-minute expiry). */
export const heavyReservations = new PendingHeavyWork();
/** Target-side count of accepted heavy spawns, advertised in this machine's load report. */
export const acceptedHeavy = new PendingHeavyWork();

/** The executor every heavy decision uses: the same policy, with decider reservations counted. */
export function heavyPlacementExecutor(): PlacementExecutor {
  return new PlacementExecutor(undefined, { pendingHeavy: (id) => heavyReservations.count(id) });
}

export interface PreviewRow {
  machineId: string;
  nickname: string | null;
  self: boolean;
  online: boolean;
  cores: number | null;
  memGiB: number | null;
  sizeSource: 'hardware' | 'load-report' | 'unknown';
  override: 'allow' | 'deny' | null;
  heavyCapable: boolean;
  loadPerCore: number | null;
  loadEvidenceAgeMs: number | null;
  verdict: string;
  headroom: 'headroom' | 'busy' | 'load-unknown';
  pendingHeavy: number;
  eligible: boolean;
  why: string;
}

export interface PlacementPreview {
  answeredBy: { machineId: string | null; nickname: string | null };
  workWeight: WorkWeight;
  decision: PlacementDecision & { chosenNickname: string | null };
  machines: PreviewRow[];
  inferred?: { weight: WorkWeight; matched: string | null };
}

function round2(n: number | null): number | null {
  return n === null ? null : Math.round(n * 100) / 100;
}

/** Read-only dry run. `now` is injectable for tests. */
export function previewPlacement(o: {
  capacities: MachineCapacity[];
  selfMachineId: string | null;
  workWeight: WorkWeight;
  command?: string;
  executor?: PlacementExecutor;
  nowMs?: number;
}): PlacementPreview {
  const nowMs = o.nowMs ?? Date.now();
  const exec = o.executor ?? heavyPlacementExecutor();
  const decision = exec.decide({ sessionKey: 'placement-preview', topicMetadata: {}, machineRegistry: o.capacities, reason: 'new', workWeight: o.workWeight });
  const nick = (id: string | null) => (id ? o.capacities.find((c) => c.machineId === id)?.nickname ?? null : null);
  const machines: PreviewRow[] = o.capacities.map((m) => {
    const pending = effectivePending(m, heavyReservations.count(m.machineId));
    const fit = heavyFit(m, pending, nowMs);
    const prof = profileOf(m);
    const lpc = freshLoadPerCore(m, nowMs);
    const why = !m.online
      ? 'offline'
      : o.workWeight === 'heavy'
        ? fit.reason
        : lpc === null ? 'load-unknown' : 'fits';
    return {
      machineId: m.machineId,
      nickname: m.nickname ?? null,
      self: m.machineId === o.selfMachineId,
      online: m.online,
      cores: prof.cores,
      memGiB: prof.memGiB,
      sizeSource: prof.source,
      override: prof.override,
      heavyCapable: prof.heavyCapable,
      loadPerCore: round2(lpc),
      loadEvidenceAgeMs: typeof m.loadReportAgeMs === 'number' ? m.loadReportAgeMs : null,
      verdict: m.loadVerdict ?? 'unknown',
      headroom: fit.headroom,
      pendingHeavy: pending,
      eligible: m.online && (o.workWeight === 'heavy' ? fit.eligible : true),
      why,
    };
  });
  return {
    answeredBy: { machineId: o.selfMachineId, nickname: nick(o.selfMachineId) },
    workWeight: o.workWeight,
    decision: { ...decision, chosenNickname: nick(decision.chosenMachine) },
    machines,
    ...(typeof o.command === 'string' ? { inferred: inferWorkWeight(o.command) } : {}),
  };
}

/**
 * A DEFINITE spawn refusal, or null (§6). Matches the typed errors and, for an older
 * target that answered 500 with only `err.message`, their concrete message formats:
 * `admission-refused (…): …`, `Max sessions (N) reached with M running`, and
 * `tmux session "…" already exists`.
 */
export function classifySpawnRefusal(err: unknown): 'admission-refused' | 'session-capacity-refused' | 'session-exists' | 'codex-accounts-walled' | null {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'admission-refused') return 'admission-refused';
  if (code === 'session-capacity-refused') return 'session-capacity-refused';
  if (code === 'codex-accounts-walled') return 'codex-accounts-walled';
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return classifySpawnRefusalMessage(msg);
}

export function classifySpawnRefusalMessage(msg: string): 'admission-refused' | 'session-capacity-refused' | 'session-exists' | 'codex-accounts-walled' | null {
  if (typeof msg !== 'string') return null;
  if (/^admission-refused \(/.test(msg)) return 'admission-refused';
  if (/^Max sessions \(\d+\) reached with \d+ running/.test(msg)) return 'session-capacity-refused';
  if (/^tmux session ".*" already exists$/.test(msg)) return 'session-exists';
  if (/^codex-accounts-walled: /.test(msg)) return 'codex-accounts-walled';
  return null;
}

export type ForwardOutcome =
  | { kind: 'started'; status: number; body: Record<string, unknown> }
  | { kind: 'refused'; status: number; body: Record<string, unknown>; code: string | null }
  | { kind: 'unconfirmed'; status: number | null; detail: string };

/**
 * POST the helper spawn to ONE target URL (never a second path for a POST). 2xx →
 * started; 4xx, or a 500 carrying a known refusal message → refused; anything else
 * (timeout, dropped connection, other 5xx) → unconfirmed.
 */
export async function forwardHeavySpawn(o: {
  url: string;
  authHeader: string;
  body: Record<string, unknown>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Extra headers (e.g. X-Instar-AgentId). */
  headers?: Record<string, string>;
  /** Dial override (a peer goes through poolPeerFetch so rope health is recorded); gets the full init. */
  dial?: (init: RequestInit) => Promise<Response>;
}): Promise<ForwardOutcome> {
  const f = o.fetchImpl ?? fetch;
  const init: RequestInit = {
    method: 'POST',
    headers: { Authorization: o.authHeader, 'Content-Type': 'application/json', ...(o.headers ?? {}) },
    body: JSON.stringify(o.body),
    signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
  };
  let r: Response;
  try {
    r = o.dial ? await o.dial(init) : await f(`${o.url.replace(/\/$/, '')}/sessions/spawn`, init);
  } catch (err) {
    // A refused connection means nothing reached the target: a definite refusal.
    const code = (err as { cause?: { code?: unknown }; code?: unknown } | null)?.cause?.code ?? (err as { code?: unknown } | null)?.code;
    if (code === 'ECONNREFUSED') return { kind: 'refused', status: 0, body: { error: 'connection refused' }, code: 'connection-refused' };
    return { kind: 'unconfirmed', status: null, detail: err instanceof Error ? err.name || err.message : String(err) };
  }
  let body: Record<string, unknown> = {};
  try { body = (await r.json()) as Record<string, unknown>; } catch { body = {}; /* @silent-fallback-ok — an unparseable body leaves the status code to decide; a 2xx without a body is still started, a 5xx unconfirmed */ }
  if (r.status >= 200 && r.status < 300) return { kind: 'started', status: r.status, body };
  if (r.status >= 400 && r.status < 500) return { kind: 'refused', status: r.status, body, code: typeof body.code === 'string' ? body.code : null };
  const legacy = classifySpawnRefusalMessage(typeof body.error === 'string' ? body.error : '');
  if (legacy) return { kind: 'refused', status: r.status, body, code: legacy };
  return { kind: 'unconfirmed', status: r.status, detail: typeof body.error === 'string' ? body.error.slice(0, 300) : `HTTP ${r.status}` };
}
