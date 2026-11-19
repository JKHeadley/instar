/**
 * GET /owner-record — what the owner record means on this machine right now (identity-security piece 2b §8).
 *
 * Read-only, agent token. Never returns a private key: owner key ids and public keys only.
 */
import type { Router } from 'express';
import type { OwnerRecordStore } from '../core/ownerRecordStore.js';
import type { OwnerRecordSync } from '../core/ownerRecordSync.js';

export interface OwnerRecordRouteDeps {
  store: OwnerRecordStore;
  /** Null on a machine with no mesh (a single machine): the gate then sees no peers. */
  sync: OwnerRecordSync | null;
}

export function mountOwnerRecordRoutes(router: Router, get: () => OwnerRecordRouteDeps | null): void {
  router.get('/owner-record', (_req, res) => {
    const d = get();
    if (!d) { res.status(503).json({ error: 'The owner record is turned off on this machine' }); return; }
    const view = d.sync ? d.sync.peerView() : { allAnswered: true, honouredPeerMarker: false };
    const gate = d.store.gate(view);
    const st = d.store.state();
    const marker = d.store.enrolledMarker();
    const sync = d.sync ? d.sync.status() : null;
    const silent = sync ? (sync.peers as Array<{ machineId: string; answered: boolean }>).filter((p) => !p.answered).map((p) => p.machineId) : [];
    res.json({
      gate: { act: gate.act, enrolment: gate.enrolment, reason: gate.reason },
      status: st?.status ?? 'none',
      level: st?.level ?? 'basic',
      everEnrolled: !!st?.everEnrolled,
      agentProducible: st ? st.agentProducible : true,
      forked: !!st?.forked,
      contested: st?.contested ?? [],
      genesis: st?.genesis ?? null,
      head: st?.head ?? [],
      ownerKeys: (st?.keys ?? []).filter((k) => k.type === 'owner-key').map((k) => k.keyId),
      machineKeys: (st?.keys ?? []).filter((k) => k.type === 'machine').map((k) => k.keyId),
      revoked: st?.revoked ?? [],
      held: st?.held.length ?? 0,
      rejected: st?.rejected.length ?? 0,
      pinned: d.store.pinned(),
      seenMarker: d.store.seenMarker(),
      enrolledMarker: marker.kind,
      peers: sync,
      // An unknown hold that never resolves: say what clears it (§4).
      ...(gate.act === 'hold' && gate.enrolment === 'unknown' && silent.length > 0
        ? { waitingOn: silent, wayOut: "Waiting for the named machines to answer. If one is gone for good, the administrator-prompt reset on this machine (identity plan §9) clears the hold." }
        : {}),
    });
  });
}
