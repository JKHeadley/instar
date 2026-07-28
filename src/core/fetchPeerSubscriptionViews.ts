/**
 * WS5.2 §5.1 — fetch each online peer's account inventory for cross-machine depth detection.
 *
 * Extracts the `?scope=pool` fan-out into a standalone, injectable, unit-testable function: it
 * queries each registered ONLINE peer's PLAIN `/subscription-pool` (NEVER `?scope=pool` — no
 * recursion) and maps the result into the depth adapter's `MachinePoolView[]`. A peer that reports
 * an account in its own plain pool HOLDS it locally (it has a config-home there), so those rows
 * are `locallyHeld: true` — exactly what the detector needs to tell a depth-zero peer from one
 * that can serve. Dark/slow/erroring peers are TOLERATED (skipped), never a throw — mirroring the
 * existing scope=pool "classified per-peer failure, never a 500" discipline.
 *
 * Pure over injected deps (peer list, fetch, auth) ⇒ unit-testable with a mock fetch; the route/
 * server wires the real peer URLs (resolvePeerUrls) + the agent's authToken.
 */

import type { MachinePoolView, MachineAccountRow } from './accountFollowMeDepth.js';

export interface PeerRef {
  machineId: string;
  nickname: string;
  /** Base URL of the peer's instar server (no trailing slash needed). */
  url: string;
}

export interface FetchPeerViewsDeps {
  /** Online, registered peers (excluding self). */
  peers: () => PeerRef[] | Promise<PeerRef[]>;
  /** Injected fetch (real `fetch` in prod; a stub in tests). */
  fetchImpl: (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
  /** Bearer token for the peer's authenticated `/subscription-pool` read. */
  authToken: string;
  /** Per-peer timeout (ms). Default 4000. */
  timeoutMs?: number;
  log?: (msg: string) => void;
}

/** Shape of a peer's plain /subscription-pool account row (defensively parsed). */
interface RawAccount {
  id?: unknown;
  email?: unknown;
  status?: unknown;
}

function mapAccounts(raw: unknown): MachineAccountRow[] {
  const accounts = (raw && typeof raw === 'object' && Array.isArray((raw as { accounts?: unknown }).accounts))
    ? ((raw as { accounts: unknown[] }).accounts)
    : [];
  const out: MachineAccountRow[] = [];
  for (const a of accounts) {
    const r = a as RawAccount;
    if (typeof r.id !== 'string' || r.id.length === 0) continue;
    out.push({
      accountId: r.id,
      email: typeof r.email === 'string' ? r.email : undefined,
      status: typeof r.status === 'string' ? r.status : 'active',
      // A peer reporting an account in its OWN plain pool holds it locally.
      locallyHeld: true,
    });
  }
  return out;
}

/**
 * Fetch peer views. Tolerant: a peer that is down / slow / non-200 / unparseable contributes
 * NOTHING (skipped, logged) rather than failing the whole detection — a dark peer must not block
 * depth detection on the others.
 */
export async function fetchPeerSubscriptionViews(deps: FetchPeerViewsDeps): Promise<MachinePoolView[]> {
  const peers = await deps.peers();
  const timeoutMs = deps.timeoutMs ?? 4000;
  const views: MachinePoolView[] = [];
  for (const p of peers) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      let resp: { ok: boolean; status: number; json: () => Promise<unknown> };
      try {
        resp = await deps.fetchImpl(`${p.url.replace(/\/$/, '')}/subscription-pool`, {
          headers: { Authorization: `Bearer ${deps.authToken}` },
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(t);
      }
      if (!resp.ok) {
        deps.log?.(`[account-follow-me] peer ${p.machineId} returned ${resp.status}; skipping`);
        continue;
      }
      const body = await resp.json();
      views.push({ machineId: p.machineId, nickname: p.nickname, accounts: mapAccounts(body) });
    } catch (err) {
      deps.log?.(`[account-follow-me] peer ${p.machineId} unreachable (${err instanceof Error ? err.message : String(err)}); skipping`);
    }
  }
  return views;
}
