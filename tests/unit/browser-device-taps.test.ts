/**
 * The owner's Telegram taps for a browser (dashboard-conversations-browser-device §4.1, §4.7):
 * browser wording when the handler reports a browser, phone wording unchanged otherwise, and a
 * Decline that lost to an approval already under way is answered "already approved" — never as
 * declined, and the pairing message is left alone.
 */
import { describe, it, expect } from 'vitest';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';

const OWNER = 555;
const NONCE = 'b'.repeat(24);

function adapter(over: Record<string, unknown>) {
  const a = Object.create(TelegramAdapter.prototype) as TelegramAdapter;
  const seen: { toast: string[]; calls: Array<{ m: string; p: Record<string, unknown> }> } = { toast: [], calls: [] };
  Object.assign(a, {
    getOwnerUserId: () => OWNER,
    answerCallback: async (_id: unknown, text: string) => { seen.toast.push(text); },
    apiCall: async (m: string, p: Record<string, unknown>) => { seen.calls.push({ m, p }); return {}; },
    ...over,
  });
  return { a, seen };
}
const approveTap = { callbackQueryId: 'q1', data: `md:a:${NONCE}`, fromUserId: OWNER, chatId: OWNER, messageId: 9, verified: true };
const declineTap = { ...approveTap, data: `md:d:${NONCE}` };

describe('Telegram taps for a browser', () => {
  it('Approve on a browser says the browser is set up', async () => {
    const { a, seen } = adapter({ mobileApproveHandler: () => ({ outcome: 'approved', text: '', client: 'browser' }) });
    expect(await a.handleMobileApprove(approveTap)).toBe('approved');
    expect(seen.toast[0]).toBe('Approved. That browser is set up.');
    const dm = seen.calls.find((c) => c.m === 'sendMessage');
    expect(String(dm?.p.text)).toContain('That browser can now use your conversations');
  });
  it('Approve on a phone keeps the phone wording byte for byte', async () => {
    const { a, seen } = adapter({ mobileApproveHandler: () => ({ outcome: 'approved', text: '' }) });
    await a.handleMobileApprove(approveTap);
    expect(seen.toast[0]).toBe('Approved. That phone is paired.');
    const dm = seen.calls.find((c) => c.m === 'sendMessage');
    expect(dm?.p.text).toBe('Approved. That phone is paired with this agent. If the app still shows a code box, type the code above to finish. You can remove the phone any time on the Phones page.');
  });
  it('Decline on a phone (string answer) is unchanged', async () => {
    const { a, seen } = adapter({ mobileDeclineHandler: () => 'declined' });
    expect(await a.handleMobileDecline(declineTap)).toBe('declined');
    expect(seen.toast[0]).toBe('Declined. That phone will not be paired.');
    expect(seen.calls[0]).toMatchObject({ m: 'editMessageText', p: { text: 'Declined. That phone was not paired.' } });
  });
  it('Decline on a browser uses browser wording', async () => {
    const { a, seen } = adapter({ mobileDeclineHandler: () => ({ result: 'declined', client: 'browser' }) });
    expect(await a.handleMobileDecline(declineTap)).toBe('declined');
    expect(seen.toast[0]).toBe('Declined. That browser will not be set up.');
    expect(seen.calls[0]).toMatchObject({ m: 'editMessageText', p: { text: 'Declined. That browser was not set up.' } });
  });
  it.each([['already-approved'], [{ result: 'already-approved', client: 'browser' }]])(
    'a Decline that lost to an approval is answered "already approved" and leaves the message alone (%j)', async (answer) => {
      const { a, seen } = adapter({ mobileDeclineHandler: () => answer });
      expect(await a.handleMobileDecline(declineTap)).toBe('unknown');
      expect(seen.toast[0]).toBe("Already approved — remove it on the Phones page if this wasn't you.");
      expect(seen.calls).toEqual([]);
    });
});

// ── The owner phone's id-based decline (§4.1) ──────────────────────────────────────────────────
import { vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../src/server/mobileConsoleTicket.js', async (orig) => {
  const real = await orig<typeof import('../../src/server/mobileConsoleTicket.js')>();
  return { ...real, activeOwnerPhone: () => true };
});

describe('owner phone decline of a record whose approval already started', () => {
  async function app(records: Record<string, Record<string, unknown>>, declineResult: string) {
    const { mountPairingApprovalDeviceRoutes } = await import('../../src/server/mobilePairingApproval.js');
    const declined: string[] = [];
    const svc = {
      enabled: () => true,
      deps: { config: { mobilePairing: { enabled: true } } },
      devices: { get: (id: string) => records[id] ?? null },
      declinePending: (id: string) => { declined.push(id); return declineResult; },
    };
    const router = express.Router();
    mountPairingApprovalDeviceRoutes(router, svc as never);
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => { (req as unknown as { instarPrincipal: unknown }).instarPrincipal = { kind: 'device', deviceId: 'owner-phone' }; next(); });
    a.use(router);
    return { a, declined };
  }
  it('a pending browser carrying `activating` is answered "already approved", never declined', async () => {
    const { a, declined } = await app({ b1: { id: 'b1', status: 'pending', fingerprint: 'ff', client: 'browser', setupState: 'awaiting', activating: { approvedVia: 'telegram-dm' } } }, 'declined');
    const r = await request(a).post('/mobile/pairing-requests/b1/decline').send({});
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'already-approved', detail: "Already approved — remove it in People > Phones if this wasn't you." });
    expect(r.body.declined).toBeUndefined();
    expect(declined).toEqual([]);
  });
  it('an active record is answered "already approved"', async () => {
    const { a } = await app({ b1: { id: 'b1', status: 'active', fingerprint: 'ff', client: 'browser' } }, 'declined');
    const r = await request(a).post('/mobile/pairing-requests/b1/decline').send({});
    expect(r.body.error).toBe('already-approved');
  });
  it('a browser still `notifying` is not waiting; the ended detail uses browser wording', async () => {
    const { a } = await app({ b1: { id: 'b1', status: 'pending', fingerprint: 'ff', client: 'browser', setupState: 'notifying' } }, 'declined');
    const r = await request(a).post('/mobile/pairing-requests/b1/decline').send({});
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'pairing-ended', detail: 'That browser is no longer waiting: it was set up, declined, or its approval window ran out.' });
  });
  it('a phone that is gone keeps the phone ended detail byte for byte', async () => {
    const { a } = await app({}, 'declined');
    const r = await request(a).post('/mobile/pairing-requests/p9/decline').send({});
    expect(r.body).toEqual({ error: 'pairing-ended', detail: 'That phone is no longer waiting: it was paired, declined, or its link expired.' });
  });
});
