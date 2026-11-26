/**
 * The owned-repository registry routes (docs/specs/no-data-loss-on-machine-death.md §1.7).
 * Bearer-authenticated like every route (the router's auth middleware runs first). Owner-only
 * surface: a team member's phone never reaches it (the Needs-you read filters per viewer).
 *
 *   GET /repos               this machine's repositories, their remotes, single-copy work and ages
 *   GET /repos?scope=pool    every machine: each peer read live (5 s), else from its replicated
 *                            `owned-repo` records, else named `unknown` — never silently left out
 *
 * Read-only: it lists and reports; it changes nothing.
 */
import type { Router } from 'express';
import type { OwnedRepoRegistry, RepoDefect } from '../monitoring/ownedRepos/OwnedRepoRegistry.js';
import { defectsFor } from '../monitoring/ownedRepos/OwnedRepoRegistry.js';
import { validateOwnedRepoReplica, type OwnedRepoReplica } from '../core/OwnedRepoReplicatedStore.js';

export interface OwnedRepoRouteDeps {
  registry: OwnedRepoRegistry;
  machineId: string;
  /** Active peers with a URL the credential guard admits (allowed false ⇒ url-rejected). */
  peers: () => Array<{ machineId: string; name: string; url: string | null; allowed: boolean }>;
  authToken: string | undefined;
  /** Peers' replicated `owned-repo` records, by origin machine (empty when replication is off). */
  replicas: () => Map<string, OwnedRepoReplica[]>;
  fetchImpl?: typeof fetch;
}

export const OWNED_REPOS_OFF = 'The repository registry is switched off on this machine';
const PEER_WAIT_MS = 5_000;

interface MachineAnswer {
  machineId: string;
  machineName: string;
  source: 'self' | 'live' | 'replicated' | 'unknown';
  error?: string;
  repos: unknown[];
  defects: RepoDefect[];
}

/** A peer known only from its replicated records: its repositories and its defects, from those. */
export function replicaAnswer(machineId: string, machineName: string, reps: OwnedRepoReplica[], now: number): MachineAnswer {
  const live = reps.filter((r) => !r.gone);
  const repos = live.map((r) => ({
    repoId: r.repoId, machineId: r.machineId, displayPath: r.displayPath, class: r.class, remotes: r.remotes,
    hasOffMachineRemote: r.remotes.some((x) => x.offMachine),
    singleCopy: { commits: r.singleCopyCommitsBucket, branches: r.singleCopyBranchesBucket, oldestAt: null, approximate: true },
    uncommitted: r.uncommitted, pastGrace: r.pastGrace, state: r.state,
  }));
  const defects = defectsFor(machineId, machineName, repos.map((r) => ({ ...r, singleCopy: { commits: r.singleCopy.commits, branches: r.singleCopy.branches, oldestAt: null, branchNames: [] } })), { now, enabledSince: now, lastCompletedPassAt: now })
    .filter((d) => d.kind !== 'unknown')
    .map((d) => ({ ...d, detail: `${d.detail} (From what ${machineName} last shared: it could not be reached just now.)` }));
  return { machineId, machineName, source: 'replicated', repos, defects };
}

export function mountOwnedRepoRoutes(router: Router, get: () => OwnedRepoRouteDeps | null): void {
  router.get('/repos', async (req, res) => {
    const d = get();
    if (!d) { res.status(503).json({ error: OWNED_REPOS_OFF }); return; }
    const own = d.registry.status();
    if (req.query.scope !== 'pool') { res.json({ scope: 'machine', ...own }); return; }

    const now = Date.now();
    let replicas = new Map<string, OwnedRepoReplica[]>();
    try { replicas = d.replicas(); } catch { replicas = new Map(); } // @silent-fallback-ok — no replicas means each unreachable peer reads `unknown`, named below
    const doFetch = d.fetchImpl ?? fetch;
    const peers = await Promise.all(d.peers().filter((p) => p.machineId !== d.machineId).map(async (p): Promise<MachineAnswer> => {
      const fallback = (error: string): MachineAnswer => {
        const reps = (replicas.get(p.machineId) ?? []).map((r) => validateOwnedRepoReplica(r)).filter((r): r is OwnedRepoReplica => !!r && r.machineId === p.machineId);
        return reps.length ? { ...replicaAnswer(p.machineId, p.name, reps, now), error } : { machineId: p.machineId, machineName: p.name, source: 'unknown', error, repos: [], defects: [] };
      };
      if (!p.url) return fallback('no-known-url');
      if (!p.allowed) return fallback('url-rejected');
      try {
        const r = await doFetch(`${p.url.replace(/\/$/, '')}/repos`, { headers: d.authToken ? { Authorization: `Bearer ${d.authToken}` } : {}, signal: AbortSignal.timeout(PEER_WAIT_MS) });
        if (r.status === 503) return { machineId: p.machineId, machineName: p.name, source: 'live', error: 'switched-off', repos: [], defects: [] };
        if (!r.ok) return fallback(`HTTP ${r.status}`);
        const body = await r.json() as { repos?: unknown[]; defects?: RepoDefect[]; machineName?: string };
        return { machineId: p.machineId, machineName: typeof body.machineName === 'string' ? body.machineName : p.name, source: 'live', repos: Array.isArray(body.repos) ? body.repos : [], defects: Array.isArray(body.defects) ? body.defects.filter((x) => x && typeof x.key === 'string' && x.machineId === p.machineId) : [] };
      } catch (e) { // @silent-fallback-ok — an unreachable peer is read from its replicated records or named unknown in couldNotRead
        return fallback(e instanceof Error ? e.message : String(e));
      }
    }));
    const machines: MachineAnswer[] = [{ machineId: own.machineId, machineName: own.machineName, source: 'self', repos: own.repos, defects: own.defects }, ...peers];
    res.json({
      scope: 'pool',
      ...own,
      machines,
      couldNotRead: peers.filter((p) => p.source === 'unknown').map((p) => ({ machineId: p.machineId, machineName: p.machineName, error: p.error })),
      defects: machines.flatMap((m) => m.defects),
    });
  });
}
