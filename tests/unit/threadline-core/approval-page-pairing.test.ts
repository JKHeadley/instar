/**
 * Pairing through the local approval page, end to end over a fake relay wire (spec
 * threadline-standalone-pairing r4 D5). Neither side's app can elicit: each tool call returns
 * pending at once, and a "person" drives the page over HTTP. The opener is injected, so the link is
 * captured from the opener, never from the tool result (Echo review R2-1).
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StandalonePairing } from '../../../packages/threadline-mcp/src/pairing.js';
import { PairTools, type ToolResult } from '../../../packages/threadline-mcp/src/pairTools.js';
import { ApprovalCoordinator } from '../../../packages/threadline-mcp/src/approvalPage.js';
import { generateIdentityKeyPair, findInviteToken } from '@sagemindai/threadline-core';

type Env = Record<string, unknown> & { to: string };
const tick = () => new Promise((r) => setTimeout(r, 5));

function agent(name: string, wire: { out: Env[] }, timeoutMs = 60_000) {
  const k = generateIdentityKeyPair();
  const fp = k.publicKey.subarray(0, 16).toString('hex');
  const pairing = new StandalonePairing({
    stateDir: fs.mkdtempSync(path.join(os.tmpdir(), `ap-${name}-`)),
    identity: { fp, publicKey: k.publicKey, privateKey: k.privateKey },
    ownName: () => ({ owner: `${name}-owner`, agent: name }),
    sendEnvelope: (e) => wire.out.push(e as Env),
    relayHttpBase: null,
  });
  const resolvePeer = (n: string) => (/^[0-9a-f]{32}$/.test(n) ? n : null);
  const opened: string[] = [];
  const approvals = new ApprovalCoordinator({ timeoutMs, postWaitMs: 1_000, openBrowser: async (u) => { opened.push(u); return true; } });
  // What server.ts does for an app without elicitation.
  const viaPage = (action: 'open' | 'finish' | 'forget', run: (t: PairTools) => Promise<ToolResult>) =>
    approvals.start(action, (elicit) => run(new PairTools({ pairing, elicit, resolvePeer })));
  const status = () => ({ ...new PairTools({ pairing, elicit: null, resolvePeer }).status(), ...approvals.statusFields() }) as Record<string, unknown>;
  const invite = () => new PairTools({ pairing, elicit: null, resolvePeer }).invite({}) as { ok: true; message: string; iid: string };
  return { name, fp, pairing, approvals, opened, viaPage, status, invite };
}
async function pump(wire: { out: Env[] }, agents: Array<ReturnType<typeof agent>>) {
  while (wire.out.length) {
    const e = wire.out.shift()!;
    const to = agents.find((a) => a.fp === e.to);
    if (to) await to.pairing.receive(e as never);
  }
}

/** The person: waits for the page's current question, then answers it (or presses Cancel). Returns the page shown after. */
async function answer(url: string, values: Record<string, string> | 'cancel'): Promise<{ asked: string; after: string }> {
  let html = '';
  await vi.waitFor(async () => { html = await (await fetch(url)).text(); expect(html).toMatch(/name="qt"/); }, { timeout: 5_000, interval: 20 });
  const qt = /name="qt" value="([0-9a-f]+)"/.exec(html)![1];
  const body = new URLSearchParams(values === 'cancel' ? { qt, action: 'cancel' } : { qt, action: 'submit', ...values });
  const res = await fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  return { asked: html, after: await res.text() };
}

describe('pairing through the approval page (no elicitation)', () => {
  it('open returns pending at once; the person pastes and approves on the page; the inviter finishes on its own page; both end mutual-verified', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('scout', wire), B = agent('carl', wire);
    const made = A.invite();

    const opened = await B.viaPage('open', (t) => t.open());
    expect(opened).toMatchObject({ ok: true, pending: true, opened: true, action: 'open' });
    expect(B.opened).toHaveLength(1);
    const bLink = B.opened[0];
    expect(JSON.stringify(opened)).not.toContain(bLink.split('/').pop()!);
    expect(B.status()).toMatchObject({ pendingApproval: { action: 'open' } });

    const paste = await answer(bLink, { invite: `here you go: ${made.message}` });
    expect(paste.asked).toContain('Pairing invite');
    expect(paste.after).toContain('calls itself &quot;scout&quot;'); // the next question, shown in the POST's answer
    const approve = await answer(bLink, { decision: 'approve' });
    expect(approve.asked.indexOf('value="decline"')).toBeLessThan(approve.asked.indexOf('value="approve"'));
    expect(approve.after).toMatch(/Approved\. You will be paired with the agent that calls itself &quot;scout&quot;/);
    await vi.waitFor(() => expect(B.status()).toMatchObject({ lastApproval: { action: 'open', result: { ok: true, result: 'approved' } } }));
    expect(B.status()).not.toHaveProperty('pendingApproval');
    expect(JSON.stringify(B.status())).not.toContain(findInviteToken(made.message)!);
    expect(wire.out.length).toBeGreaterThan(0); // the accept is sent
    await pump(wire, [A, B]);

    const fin = await A.viaPage('finish', (t) => t.finish({}));
    expect(fin).toMatchObject({ ok: true, pending: true, action: 'finish' });
    const done = await answer(A.opened[0], { decision: 'finish' });
    expect(done.asked).toContain('calls itself &quot;carl&quot;');
    expect(done.after).toContain('Paired with the agent that calls itself &quot;carl&quot;.');
    await vi.waitFor(() => expect(A.status()).toMatchObject({ lastApproval: { action: 'finish', result: { ok: true, result: 'finished' } } }));
    await tick();
    await pump(wire, [A, B]);

    expect(A.pairing.keys.isCredentialShareAllowedByFingerprint(B.fp)).toBe(true);
    expect(B.pairing.keys.isCredentialShareAllowedByFingerprint(A.fp)).toBe(true);
    expect((A.status().paired as Array<{ state: string }>)[0].state).toBe('mutual-verified');
    expect((B.status().paired as Array<{ state: string }>)[0].state).toBe('mutual-verified');
    // The page is gone for questions once the action finished.
    expect(await (await fetch(A.opened[0])).text()).not.toMatch(/name="qt"/);
    A.approvals.close(); B.approvals.close();
  });

  it('Decline on the page pins nothing and sends nothing', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire), B = agent('b', wire);
    const made = A.invite();
    await B.viaPage('open', (t) => t.open());
    await answer(B.opened[0], { invite: made.message });
    const r = await answer(B.opened[0], { decision: 'decline' });
    expect(r.after).toContain('Nothing was changed.');
    await vi.waitFor(() => expect(B.status()).toMatchObject({ lastApproval: { result: { result: 'declined' } } }));
    expect(B.pairing.keys.list()).toEqual([]);
    expect(wire.out).toHaveLength(0);
    B.approvals.close();
  });

  it('an expired page decides nothing: an unanswered Finish stays waiting, and an unanswered open pastes nothing', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire, 300), B = agent('b', wire);
    const made = A.invite();
    await B.viaPage('open', (t) => t.open());
    await answer(B.opened[0], { invite: made.message });
    await answer(B.opened[0], { decision: 'approve' });
    await pump(wire, [A, B]);

    expect(await A.viaPage('finish', (t) => t.finish({}))).toMatchObject({ pending: true });
    await vi.waitFor(() => expect(A.status()).toMatchObject({ lastApproval: { action: 'finish', result: { ok: true, result: 'undecided' } } }), { timeout: 3_000 });
    expect((await fetch(A.opened[0])).status).toBe(404);
    expect(A.pairing.keys.list()).toEqual([]);
    expect(A.pairing.waitingToFinish()).toHaveLength(1);

    const C = agent('c', wire, 300);
    await C.viaPage('open', (t) => t.open());
    await vi.waitFor(() => expect(C.status()).toMatchObject({ lastApproval: { action: 'open', result: { ok: false } } }), { timeout: 3_000 });
    expect(C.pairing.keys.list()).toEqual([]);
    A.approvals.close(); B.approvals.close(); C.approvals.close();
  });

  it('forget through the page: Cancel keeps the pairing', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire), B = agent('b', wire);
    const made = A.invite();
    await B.viaPage('open', (t) => t.open());
    await answer(B.opened[0], { invite: made.message });
    await answer(B.opened[0], { decision: 'approve' });
    await pump(wire, [A, B]);
    await A.viaPage('finish', (t) => t.finish({}));
    await answer(A.opened[0], { decision: 'finish' });
    await vi.waitFor(() => expect(A.status()).toHaveProperty('lastApproval'));
    await tick(); await pump(wire, [A, B]);

    await A.viaPage('forget', (t) => t.forget({ peer: B.fp }));
    await answer(A.opened[1], 'cancel');
    await vi.waitFor(() => expect(A.status()).toMatchObject({ lastApproval: { action: 'forget', result: { result: 'kept' } } }));
    expect(A.pairing.keys.getProfileByFingerprint(B.fp)).toBeTruthy();
    A.approvals.close(); B.approvals.close();
  });
});
