/**
 * InterruptedMoveResume — a move that closes a session mid-step must not drop the
 * person's request (2026-11-14, topic 142440: "check in with Luna" was cut off when the
 * conversation moved from the Mama PC to the Studio, and the only notice went to the
 * quiet feed). Both sides of every boundary: owner confirmed / never confirmed / moved
 * on, live session / no session, resume ok / resume failed, target accepts / target
 * refuses / target unreachable / older target without the verb.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  InterruptedMoveResumeReceiver,
  handOffInterruptedMove,
  interruptedMoveResumeNote,
  parseInterruptedMoveResume,
  resumeAccepted,
  type InterruptedMoveResumeReceiverDeps,
} from '../../src/core/InterruptedMoveResume.js';

type Rec = { ownerMachineId: string; ownershipEpoch: number; status: string } | null;

function receiver(opts: {
  records?: Rec[];               // successive readOwnership answers (last one repeats)
  emergency?: boolean;
  resume?: () => Promise<'injected' | 'spawned'>;
  waitMs?: number;
} = {}) {
  let now = 0;
  let reads = 0;
  const records = opts.records ?? [{ ownerMachineId: 'm_studio', ownershipEpoch: 6, status: 'active' }];
  const resumeTopic = vi.fn(opts.resume ?? (async () => 'spawned' as const));
  const sendNotice = vi.fn(async () => undefined);
  const deps: InterruptedMoveResumeReceiverDeps = {
    selfMachineId: 'm_studio',
    readOwnership: () => records[Math.min(reads++, records.length - 1)],
    emergencyStopActive: () => opts.emergency === true,
    resumeTopic,
    sendNotice,
    now: () => now,
    sleep: async (ms) => { now += ms; },
    ownershipWaitMs: opts.waitMs ?? 5_000,
    pollMs: 500,
  };
  return { r: new InterruptedMoveResumeReceiver(deps), resumeTopic, sendNotice };
}

describe('InterruptedMoveResumeReceiver (target side)', () => {
  it('owner confirmed at the claim epoch → accepted; the session gets the note, then ONE resuming notice anchored to the person\'s message', async () => {
    const h = receiver();
    const a = await h.r.receive({ sessionKey: '142440', claimEpoch: 6, fromName: 'Mama PC', inboundMessageId: '9001' });
    expect(a).toEqual({ ok: true, outcome: 'accepted' });
    await h.r.lastResume;
    expect(h.resumeTopic).toHaveBeenCalledTimes(1);
    expect(h.resumeTopic.mock.calls[0][0]).toBe(142440);
    expect(h.resumeTopic.mock.calls[0][1]).toContain('Mama PC');
    expect(h.sendNotice).toHaveBeenCalledTimes(1);
    expect(h.sendNotice.mock.calls[0]).toEqual([142440, true, '9001']);
  });

  it('waits while the claim is still replicating (transferring at the source), then accepts', async () => {
    const h = receiver({
      records: [
        { ownerMachineId: 'm_mama', ownershipEpoch: 5, status: 'transferring' },
        { ownerMachineId: 'm_mama', ownershipEpoch: 5, status: 'transferring' },
        { ownerMachineId: 'm_studio', ownershipEpoch: 6, status: 'active' },
      ],
    });
    const a = await h.r.receive({ sessionKey: '142440', claimEpoch: 6 });
    expect(a.outcome).toBe('accepted');
  });

  it('never becomes owner within the wait → not-owner, nothing restarted, no notice (the source sends it)', async () => {
    const h = receiver({ records: [{ ownerMachineId: 'm_mama', ownershipEpoch: 5, status: 'transferring' }], waitMs: 2_000 });
    const a = await h.r.receive({ sessionKey: '142440', claimEpoch: 6 });
    expect(a).toMatchObject({ ok: false, outcome: 'not-owner', reason: 'claim-not-seen' });
    expect(h.resumeTopic).not.toHaveBeenCalled();
    expect(h.sendNotice).not.toHaveBeenCalled();
  });

  it('a stale request (the conversation moved on to another machine) does nothing', async () => {
    const h = receiver({ records: [{ ownerMachineId: 'm_laptop', ownershipEpoch: 8, status: 'active' }] });
    const a = await h.r.receive({ sessionKey: '142440', claimEpoch: 6 });
    expect(a).toMatchObject({ ok: false, outcome: 'not-owner', reason: 'moved-on' });
    expect(h.resumeTopic).not.toHaveBeenCalled();
  });

  it('an owner record BELOW the claim epoch is not enough (an older ownership of the same machine)', async () => {
    const h = receiver({ records: [{ ownerMachineId: 'm_studio', ownershipEpoch: 3, status: 'active' }], waitMs: 1_000 });
    const a = await h.r.receive({ sessionKey: '142440', claimEpoch: 6 });
    expect(a.outcome).toBe('not-owner');
  });

  it('emergency stop → nothing restarted', async () => {
    const h = receiver({ emergency: true });
    const a = await h.r.receive({ sessionKey: '142440', claimEpoch: 6 });
    expect(a).toMatchObject({ ok: false, outcome: 'emergency-stop' });
    expect(h.resumeTopic).not.toHaveBeenCalled();
  });

  it('a repeated request for the same (conversation, epoch) resumes once', async () => {
    const h = receiver();
    const [a, b] = await Promise.all([
      h.r.receive({ sessionKey: '142440', claimEpoch: 6 }),
      h.r.receive({ sessionKey: '142440', claimEpoch: 6 }),
    ]);
    const c = await h.r.receive({ sessionKey: '142440', claimEpoch: 6 });
    await h.r.lastResume;
    expect([a.outcome, b.outcome].sort()).toEqual(['accepted', 'duplicate']);
    expect(c.outcome).toBe('duplicate');
    expect(h.resumeTopic).toHaveBeenCalledTimes(1);
  });

  it('a failed restart still tells the person, with the "may be incomplete" wording', async () => {
    const h = receiver({ resume: async () => { throw new Error('spawn refused'); } });
    const a = await h.r.receive({ sessionKey: '142440', claimEpoch: 6, inboundMessageId: '9001' });
    expect(a.outcome).toBe('accepted');
    await h.r.lastResume;
    expect(h.sendNotice.mock.calls[0]).toEqual([142440, false, '9001']);
  });

  it('a non-Telegram key is unsupported here (app conversations keep their in-conversation notice)', async () => {
    const h = receiver();
    const a = await h.r.receive({ sessionKey: 'app:abc', claimEpoch: 6 });
    expect(a.outcome).toBe('unsupported');
  });
});

describe('handOffInterruptedMove (source side) — exactly one machine sends the notice', () => {
  it('target accepted → the source sends nothing (the target owns the notice)', async () => {
    const sendIncompleteNotice = vi.fn(async () => undefined);
    const r = await handOffInterruptedMove({
      requestResume: async () => ({ ok: true, result: { ok: true, outcome: 'accepted' } }),
      sendIncompleteNotice,
    });
    expect(r.accepted).toBe(true);
    expect(sendIncompleteNotice).not.toHaveBeenCalled();
  });

  it.each([
    ['target refused (not owner)', async () => ({ ok: true, result: { ok: false, outcome: 'not-owner' } })],
    ['older target without the verb', async () => ({ ok: false, reason: 'no-handler' })],
    ['mesh unavailable', async () => ({ ok: false, reason: 'mesh-unavailable' })],
    ['target unreachable (throws)', async () => { throw new Error('fetch failed'); }],
  ])('%s → the source sends the "may be incomplete" notice', async (_label, requestResume) => {
    const sendIncompleteNotice = vi.fn(async () => undefined);
    const r = await handOffInterruptedMove({ requestResume, sendIncompleteNotice } as Parameters<typeof handOffInterruptedMove>[0]);
    expect(r.accepted).toBe(false);
    expect(sendIncompleteNotice).toHaveBeenCalledTimes(1);
  });

  it('never throws, even when the notice send fails', async () => {
    await expect(handOffInterruptedMove({
      requestResume: async () => ({ ok: false }),
      sendIncompleteNotice: async () => { throw new Error('telegram down'); },
    })).resolves.toEqual({ accepted: false });
  });

  it('resumeAccepted reads only an explicit accepted/duplicate answer', () => {
    expect(resumeAccepted({ ok: true, result: { ok: true, outcome: 'accepted' } })).toBe(true);
    expect(resumeAccepted({ ok: true, result: { ok: true, outcome: 'duplicate' } })).toBe(true);
    expect(resumeAccepted({ ok: true, result: { ok: false, outcome: 'accepted' } })).toBe(false);
    expect(resumeAccepted({ ok: true, result: undefined })).toBe(false);
    expect(resumeAccepted(null)).toBe(false);
  });
});

describe('the resume note and the request parser', () => {
  it('the note says what happened and what to do, names the machine, never an id', () => {
    const n = interruptedMoveResumeNote('Mama PC');
    expect(n).toContain('the Mama PC');
    expect(n).toMatch(/closed before it finished/);
    expect(n).toMatch(/so nothing runs twice/);
    expect(n).toMatch(/always reply/);
    expect(interruptedMoveResumeNote('m_e8c9b243c449b1337713bc29d47a6f3a')).not.toContain('m_e8c9');
    expect(interruptedMoveResumeNote(null)).toContain('another machine');
  });

  it('parses a well-formed request and refuses malformed ones', () => {
    expect(parseInterruptedMoveResume({ sessionKey: '142440', claimEpoch: 6, fromName: 'Mama PC', inboundMessageId: '9001' }))
      .toEqual({ sessionKey: '142440', claimEpoch: 6, fromName: 'Mama PC', inboundMessageId: '9001' });
    expect(parseInterruptedMoveResume({ sessionKey: '', claimEpoch: 6 })).toBeNull();
    expect(parseInterruptedMoveResume({ sessionKey: '1', claimEpoch: -1 })).toBeNull();
    expect(parseInterruptedMoveResume({ sessionKey: '1', claimEpoch: 1.5 })).toBeNull();
    expect(parseInterruptedMoveResume({ sessionKey: '1', claimEpoch: 2, inboundMessageId: 'bad id with spaces' })?.inboundMessageId).toBeNull();
  });
});
