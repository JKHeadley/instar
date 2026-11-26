import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { expect, it, vi } from 'vitest';
import { createPairedCoordinationDelivery } from '../../src/threadline/pairedCoordinationDelivery.js';
import { createPairedCoordinationGrantStore } from '../../src/threadline/pairedCoordinationGrantStore.js';
import { createPairedCoordinationPinSurface, PAIRED_COORDINATION_PIN_PATH } from '../../src/threadline/pairedCoordinationPinSurface.js';
import { createPairedCoordinationPolicy, PAIRED_COORDINATION_KIND, pairedCoordinationGrantDigest } from '../../src/threadline/pairedCoordinationPolicy.js';

it('only grants through the dark owner PIN surface and rechecks the exact delivery after revocation', async () => {
  const db = new Database(':memory:');
  try {
    const owner = { operatorId: 'operator-1', ownerRevision: 'owner-1' };
    const store = createPairedCoordinationGrantStore(db, () => owner);
    const surfaceDeps = {
      currentOwner: (req: express.Request) => req.get('Authorization') === 'Bearer fixture-owner' ? owner : null,
      pin: { verify: vi.fn((_req, pin: unknown) => pin === 'fixture-pin'
        ? { ok: true, path: 'local', aggregateFull: false } as const
        : { ok: false, reason: 'missing', path: 'local' } as const) },
      store,
    };
    const app = express().use(express.json()).use(createPairedCoordinationPinSurface({ ...surfaceDeps, enabled: true }));
    const disabled = express().use(createPairedCoordinationPinSurface(surfaceDeps));
    const post = (action: 'allow' | 'revoke', expectedRevision: number, pin?: string) =>
      request(app).post(PAIRED_COORDINATION_PIN_PATH).set('Authorization', 'Bearer fixture-owner')
        .set('X-Instar-Request', '1').send({ action, expectedRevision, pin });
    expect((await request(disabled).get(PAIRED_COORDINATION_PIN_PATH)).status).toBe(404);
    expect((await request(app).get(PAIRED_COORDINATION_PIN_PATH)).status).toBe(403);
    expect((await post('allow', 0)).status).toBe(403);
    expect((await post('allow', 0, 'fixture-pin')).body).toEqual({ active: true, revision: 1 });
    expect((await post('allow', 0, 'fixture-pin')).status).toBe(409);

    const key = 'a'.repeat(32) + 'b'.repeat(32);
    const recipient = { fingerprint: key.slice(0, 32), authenticatedKeyHex: key };
    const bytes = Buffer.from('the exact approved work handoff');
    const work = { coordinationId: 'handoff-1', recipientKeyHex: key,
      messageDigest: createHash('sha256').update(bytes).digest('hex') };
    const policy = createPairedCoordinationPolicy({
      enabled: true,
      readRecipient: () => {
        const grant = store.readGrant(owner.operatorId);
        return grant && { sender: owner, grant, blocked: false, work, peer: {
          ...owner, authenticatedKeyHex: key, pairedKeyHex: key, pairingState: 'mutual-verified',
        } };
      },
    });
    const dispatch = vi.fn(() => true);
    const deliver = createPairedCoordinationDelivery({ policy, dispatch });
    expect(deliver(recipient, work.coordinationId, Buffer.from('different bytes'))).toEqual({ kind: 'refused' });
    expect(deliver(recipient, work.coordinationId, bytes)).toEqual({ kind: PAIRED_COORDINATION_KIND, result: true });
    expect(dispatch).toHaveBeenCalledWith(recipient, bytes, PAIRED_COORDINATION_KIND);
    expect((await post('revoke', 1, 'fixture-pin')).body).toEqual({ active: false, revision: 2 });
    expect(deliver(recipient, work.coordinationId, bytes)).toEqual({ kind: 'refused' });
    expect(dispatch).toHaveBeenCalledOnce();

    const revised = { ...owner, expectedRevision: 2, action: 'allow' as const };
    const proof = { authorizationId: 'previous-pin', operatorId: owner.operatorId,
      requestDigest: pairedCoordinationGrantDigest(revised) };
    expect(store.commitGrantChange({ ...revised, ownerRevision: 'different-owner-revision' }, proof)).toBe(false);
    db.transaction(() => {
      expect(store.commitGrantChange(revised, proof)).toBe(false);
      expect(store.readGrant(owner.operatorId)).toBeNull();
    })();
    expect(store.commitGrantChange(revised, proof)).toBe(true);
    const attemptedReuse = { ...revised, expectedRevision: 3, action: 'revoke' as const };
    expect(store.commitGrantChange(attemptedReuse, { ...proof, requestDigest: pairedCoordinationGrantDigest(attemptedReuse) })).toBe(false);
  } finally {
    db.close();
  }
});
