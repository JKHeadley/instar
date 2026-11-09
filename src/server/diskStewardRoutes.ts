/**
 * Disk Steward routes (spec docs/specs/disk-steward.md §3.8). Bearer-authenticated
 * like every route (the router's auth middleware runs first).
 *
 *   GET  /disk-steward[?scope=pool]   this machine (and, pooled, each peer live)
 *   POST /disk-steward/posted         the holder's acknowledgement of a due post
 *   POST /disk-steward/prune          a manual cleanup here, or forwarded once to a peer
 *   GET  /disk-steward/prune/:runId   a run's record
 */
import type { Router } from 'express';
import type { DiskSteward } from '../monitoring/DiskSteward.js';
import { operatorError } from '../core/storageMachineName.js';
import type { PruneRunner } from '../monitoring/diskSteward/pruneRunner.js';

export interface DiskStewardRouteDeps {
  steward: DiskSteward;
  runner: PruneRunner;
  machineId: string;
  /** Active peers with a URL the credential guard admits (allowed false ⇒ url-rejected). */
  peers: () => Array<{ machineId: string; url: string | null; allowed: boolean; refusals?: unknown[] }>;
  authToken: string | undefined;
}

const FORWARD_HEADER = 'x-disk-steward-forwarded';

export function mountDiskStewardRoutes(router: Router, get: () => DiskStewardRouteDeps | null): void {
  const runs = new Map<string, { startedAt: number; done: boolean; result?: unknown }>();

  router.get('/disk-steward', async (req, res) => {
    const d = get();
    if (!d) { res.status(503).json({ error: 'The disk watcher is turned off on this machine' }); return; }
    const body: Record<string, unknown> = { ...d.steward.status() };
    if (req.query.scope === 'pool') {
      const peers = await Promise.all(d.peers().map(async (p) => {
        if (!p.url) return { machineId: p.machineId, error: 'no-known-url' };
        if (!p.allowed) return { machineId: p.machineId, error: 'url-rejected', refusals: p.refusals ?? [] };
        try {
          const r = await fetch(`${p.url.replace(/\/$/, '')}/disk-steward`, {
            headers: d.authToken ? { Authorization: `Bearer ${d.authToken}` } : {}, signal: AbortSignal.timeout(5_000),
          });
          if (!r.ok) return { machineId: p.machineId, error: `HTTP ${r.status}` };
          return { machineId: p.machineId, status: await r.json() };
        } catch (e) {
          return { machineId: p.machineId, error: e instanceof Error ? e.message : String(e) };
        }
      }));
      body.peers = peers;
    }
    res.json(body);
  });

  router.post('/disk-steward/posted', (req, res) => {
    const d = get();
    if (!d) { res.status(503).json({ error: 'The disk watcher is turned off on this machine' }); return; }
    const postId = typeof req.body?.postId === 'string' ? req.body.postId : '';
    const outcome = req.body?.outcome === 'posted' || req.body?.outcome === 'failed' ? req.body.outcome : null;
    if (!postId || !outcome) { res.status(400).json({ error: 'postId and outcome (posted or failed) are required' }); return; }
    if (!d.steward.applyAck(postId, outcome)) { res.status(409).json({ error: 'That is not this machine\'s current due post' }); return; }
    res.json({ ok: true });
  });

  router.post('/disk-steward/prune', async (req, res) => {
    const d = get();
    if (!d) { res.status(503).json({ error: 'The disk watcher is turned off on this machine' }); return; }
    const machineId = typeof req.body?.machineId === 'string' && req.body.machineId ? req.body.machineId : d.machineId;
    const dryRun = req.body?.dryRun === true;
    const post = req.body?.post === true || !dryRun;
    const forwarded = req.headers[FORWARD_HEADER] === '1';
    if (machineId !== d.machineId) {
      // A forwarded request runs only on the machine it names, and is never forwarded again.
      if (forwarded) { res.status(409).json({ error: 'This request was meant for another machine', machineId: d.machineId }); return; }
      const peer = d.peers().find((p) => p.machineId === machineId);
      if (!peer) { res.status(404).json({ error: 'Unknown machine', known: [d.machineId, ...d.peers().map((p) => p.machineId)] }); return; }
      if (!peer.url || !peer.allowed) { res.status(502).json({ error: 'That machine has no address I may send credentials to', machineId }); return; }
      try {
        const r = await fetch(`${peer.url.replace(/\/$/, '')}/disk-steward/prune`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', [FORWARD_HEADER]: '1', ...(d.authToken ? { Authorization: `Bearer ${d.authToken}` } : {}) },
          body: JSON.stringify({ machineId, dryRun, post, requestedBy: req.body?.requestedBy ?? null }),
          signal: AbortSignal.timeout(15_000),
        });
        res.status(r.status).json(await r.json().catch(() => ({})));
      } catch (e) {
        res.status(502).json({ error: 'Could not reach that machine', detail: operatorError(e, res.app?.locals?.stateDir) });
      }
      return;
    }
    const requestedBy = req.body?.requestedBy && typeof req.body.requestedBy === 'object'
      ? { sessionId: typeof req.body.requestedBy.sessionId === 'string' ? req.body.requestedBy.sessionId.slice(0, 120) : undefined,
          topicId: Number.isSafeInteger(req.body.requestedBy.topicId) ? req.body.requestedBy.topicId : undefined }
      : null;
    const started = d.steward.manualPrune({ dryRun, post, requestedBy });
    if (!started.started) { res.status(409).json({ error: 'A cleanup is already running on this machine', runId: started.running?.runId ?? null }); return; }
    const key = `pending-${Date.now().toString(36)}`;
    runs.set(key, { startedAt: Date.now(), done: false });
    // The run id is assigned once the child starts; report it as soon as it exists.
    const runIdP = started.promise!.then((r) => { const rec = runs.get(key)!; rec.done = true; rec.result = r; if (r.runId) runs.set(r.runId, rec); return r.runId; });
    const early = d.runner.running();
    if (early) runs.set(early.runId, runs.get(key)!);
    while (runs.size > 50) runs.delete(runs.keys().next().value!);
    res.status(202).json({ runId: early?.runId ?? null, pending: early ? undefined : key, dryRun });
    void runIdP.catch(() => undefined);
  });

  router.get('/disk-steward/prune/:runId', (req, res) => {
    const d = get();
    if (!d) { res.status(503).json({ error: 'The disk watcher is turned off on this machine' }); return; }
    const running = d.runner.running();
    const rec = runs.get(req.params.runId);
    const last = d.steward.status().prune.lastRun;
    if (running && running.runId === req.params.runId) { res.json({ runId: running.runId, state: 'running', deadline: running.deadline }); return; }
    if (last && last.runId === req.params.runId) { res.json({ runId: last.runId, state: 'done', record: last }); return; }
    if (rec) { res.json({ runId: req.params.runId, state: rec.done ? 'done' : 'starting', result: rec.result ?? null }); return; }
    res.status(404).json({ error: 'No such run on this machine' });
  });
}
