/**
 * threadline-mcp's pair tools (packages/threadline-mcp/src/pairTools.ts; spec threadline-standalone-pairing
 * §4, D3, D4). A fake `elicit` plays the PERSON. The model never sees the recipient's invite, and
 * without elicitation the operator acts are refused.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StandalonePairing } from '../../../packages/threadline-mcp/src/pairing.js';
import { PairTools, type Elicit } from '../../../packages/threadline-mcp/src/pairTools.js';
import { generateIdentityKeyPair, findInviteToken } from '@sagemindai/threadline-core';

type Env = Record<string, unknown> & { to: string };
const tick = () => new Promise((r) => setTimeout(r, 5));

function agent(name: string, wire: { out: Env[] }) {
  const k = generateIdentityKeyPair();
  const fp = k.publicKey.subarray(0, 16).toString('hex');
  const pairing = new StandalonePairing({
    stateDir: fs.mkdtempSync(path.join(os.tmpdir(), `pt-${name}-`)),
    identity: { fp, publicKey: k.publicKey, privateKey: k.privateKey },
    ownName: () => ({ owner: `${name}-owner`, agent: name }),
    sendEnvelope: (e) => wire.out.push(e as Env),
    relayHttpBase: null,
  });
  const contacts = new Map<string, string>();
  const tools = (elicit: Elicit | null) => new PairTools({ pairing, elicit, resolvePeer: (n) => contacts.get(n) ?? (/^[0-9a-f]{32}$/.test(n) ? n : null) });
  return { name, fp, pairing, contacts, tools };
}
async function pump(wire: { out: Env[] }, agents: Array<ReturnType<typeof agent>>) {
  while (wire.out.length) {
    const e = wire.out.shift()!;
    const to = agents.find((a) => a.fp === e.to);
    if (to) await to.pairing.receive(e as never);
  }
}
/** A person who answers each elicitation in turn from a script, recording what they were asked. */
function person(answers: Array<Record<string, string> | null>) {
  const asked: string[] = [];
  const elicit: Elicit = async (message) => { asked.push(message); return answers.shift() ?? null; };
  return { elicit, asked };
}

describe('pair tools', () => {
  it('the whole flow, both persons answering through elicitation; the invite never appears in a tool result', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('scout', wire), B = agent('carl', wire);
    const made = A.tools(null).invite({}) as { ok: true; message: string; iid: string };
    expect(made.ok).toBe(true);
    const bob = person([{ invite: `hey, here: ${made.message}` }, { decision: 'approve' }]);
    const opened = await B.tools(bob.elicit).open();
    expect(opened).toMatchObject({ ok: true, result: 'approved' });
    expect(JSON.stringify(opened)).not.toContain(findInviteToken(made.message)!); // D4
    expect(bob.asked[1]).toContain('calls itself "scout"');
    await pump(wire, [A, B]);

    const alice = person([{ decision: 'finish' }]);
    expect(await A.tools(alice.elicit).finish({})).toMatchObject({ ok: true, result: 'finished' });
    expect(alice.asked[0]).toContain('calls itself "carl"');
    await tick();
    await pump(wire, [A, B]);
    expect(A.pairing.keys.isCredentialShareAllowedByFingerprint(B.fp)).toBe(true);
    expect(B.pairing.keys.isCredentialShareAllowedByFingerprint(A.fp)).toBe(true);
    const st = A.tools(null).status() as { ok: true; paired: Array<{ state: string }> };
    expect(st.paired[0].state).toBe('mutual-verified');
    expect(JSON.stringify(st)).not.toMatch(/secret|macKey|tlinv1:/);
  });

  it('without elicitation the person cannot be asked, so open and finish refuse and change nothing', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire);
    expect(await A.tools(null).open()).toMatchObject({ ok: false, error: expect.stringMatching(/cannot ask you questions directly/) });
    expect(await A.tools(null).finish({})).toMatchObject({ ok: false });
    expect(wire.out).toHaveLength(0);
  });

  it('declining (or cancelling the paste) sends nothing', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire), B = agent('b', wire);
    const made = A.tools(null).invite({}) as { message: string };
    expect(await B.tools(person([{ invite: made.message }, { decision: 'decline' }]).elicit).open()).toMatchObject({ ok: true, result: 'declined' });
    expect(await B.tools(person([null]).elicit).open()).toMatchObject({ ok: false });
    expect(wire.out).toHaveLength(0);
    expect(B.pairing.keys.list()).toEqual([]);
  });

  it('a bad invite is reported and nothing is asked further', async () => {
    const wire = { out: [] as Env[] };
    const B = agent('b', wire);
    const p = person([{ invite: 'tlinv1:AAAA.BBBB' }, { decision: 'approve' }]);
    expect(await B.tools(p.elicit).open()).toMatchObject({ ok: false, error: expect.stringMatching(/can't be used/) });
    expect(p.asked).toHaveLength(1);
  });

  it('"not them" refuses the acceptor; nothing is pinned on the inviter', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire), B = agent('b', wire);
    const made = A.tools(null).invite({}) as { message: string };
    await B.tools(person([{ invite: made.message }, { decision: 'approve' }]).elicit).open();
    await pump(wire, [A, B]);
    expect(await A.tools(person([{ decision: 'not them' }]).elicit).finish({})).toMatchObject({ ok: true, result: 'not-them' });
    expect(A.pairing.keys.list()).toEqual([]);
    expect(await A.tools(person([{ decision: 'finish' }]).elicit).finish({})).toMatchObject({ ok: false }); // decided once
  });

  it('dismissing the Finish question finishes nothing (only an explicit "finish" pairs)', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire), B = agent('b', wire);
    const made = A.tools(null).invite({}) as { message: string };
    await B.tools(person([{ invite: made.message }, { decision: 'approve' }]).elicit).open();
    await pump(wire, [A, B]);
    expect(await A.tools(person([null]).elicit).finish({})).toMatchObject({ ok: true, result: 'undecided' });
    expect(A.pairing.keys.list()).toEqual([]);
    expect(A.pairing.waitingToFinish()).toHaveLength(1); // still waiting for a real decision
  });

  it('inviting a known contact binds the invite to it; an unknown name is refused; ttl is bounded', () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire);
    A.contacts.set('Carl', 'c'.repeat(32));
    expect(A.tools(null).invite({ for: 'Carl' })).toMatchObject({ ok: true, boundTo: 'c'.repeat(32) });
    expect(A.tools(null).invite({ for: 'Nobody' })).toMatchObject({ ok: false });
    expect(A.tools(null).invite({ ttlMinutes: 5000 })).toMatchObject({ ok: false });
  });

  it('when pairing is unavailable (no direct relay connection), invite, open and finish refuse without asking the person', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire);
    const asked: string[] = [];
    const tools = new PairTools({ pairing: A.pairing, elicit: async (m) => { asked.push(m); return null; }, resolvePeer: () => null, unavailable: () => 'Pairing is unavailable: proxy' });
    expect(tools.invite({})).toEqual({ ok: false, error: 'Pairing is unavailable: proxy' });
    expect(await tools.open()).toEqual({ ok: false, error: 'Pairing is unavailable: proxy' });
    expect(await tools.finish({})).toEqual({ ok: false, error: 'Pairing is unavailable: proxy' });
    expect(asked).toEqual([]);
    expect(A.pairing.invites.list()).toEqual([]);
    expect(wire.out).toHaveLength(0);
  });

  it('forget (unpair) is the person\'s decision: refused without elicitation, "keep" changes nothing, "unpair" removes the pin', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire), B = agent('b', wire);
    const made = A.tools(null).invite({}) as { message: string };
    await B.tools(person([{ invite: made.message }, { decision: 'approve' }]).elicit).open();
    await pump(wire, [A, B]);
    await A.tools(person([{ decision: 'finish' }]).elicit).finish({});
    await tick(); await pump(wire, [A, B]);
    expect(await A.tools(null).forget({ peer: B.fp })).toMatchObject({ ok: false });
    expect(await A.tools(person([{ decision: 'keep' }]).elicit).forget({ peer: B.fp })).toMatchObject({ ok: true, result: 'kept' });
    expect(await A.tools(person([null]).elicit).forget({ peer: B.fp })).toMatchObject({ ok: true, result: 'kept' });
    expect(A.pairing.keys.getProfileByFingerprint(B.fp)).toBeTruthy();
    const p = person([{ decision: 'unpair' }]);
    expect(await A.tools(p.elicit).forget({ peer: B.fp })).toMatchObject({ ok: true, result: 'unpaired' });
    expect(p.asked[0]).toMatch(/Unpair from the agent "b"/);
    expect(A.pairing.keys.getProfileByFingerprint(B.fp)).toBeFalsy();
    expect(await A.tools(person([{ decision: 'unpair' }]).elicit).forget({ peer: 'c'.repeat(32) })).toMatchObject({ ok: false });
  });

  it('without elicitation, the terminal is mentioned only when the person turned it on', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire);
    const off = await new PairTools({ pairing: A.pairing, elicit: null, resolvePeer: () => null }).open() as { error: string };
    expect(off.error).toMatch(/cannot ask you questions directly/);
    expect(off.error).not.toMatch(/npx threadline-mcp|terminal/i);
    const on = await new PairTools({ pairing: A.pairing, elicit: null, resolvePeer: () => null, terminalEnabled: true, terminalCommand: '"/usr/bin/node" "/opt/tl/dist/server.js"' }).finish({}) as { error: string };
    expect(on.error).toMatch(/"\/usr\/bin\/node" "\/opt\/tl\/dist\/server\.js" pair finish/);
    expect(on.error).not.toMatch(/npx/);
    expect(on.error).toMatch(/any program running as you/);
  });

  it('status flags an unpaired agent that claims a paired agent\'s name (a new key is never the same pairing)', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire), B = agent('carl', wire);
    const made = A.tools(null).invite({}) as { message: string };
    await B.tools(person([{ invite: made.message }, { decision: 'approve' }]).elicit).open();
    await pump(wire, [A, B]);
    await A.tools(person([{ decision: 'finish' }]).elicit).finish({});
    await tick(); await pump(wire, [A, B]);
    const impostor = 'd'.repeat(32);
    const wide = 'a'.repeat(32);
    const known = [{ fingerprint: B.fp, name: 'carl' }, { fingerprint: impostor, name: 'Carl ' }, { fingerprint: wide, name: 'ｃａｒｌ' }, { fingerprint: 'e'.repeat(32), name: 'someone' }];
    const st = new PairTools({ pairing: A.pairing, elicit: null, resolvePeer: () => null, knownAgents: () => known }).status() as { lookalikes: Array<Record<string, string>> };
    expect(st.lookalikes).toEqual([expect.objectContaining({ fingerprint: impostor, claimsNameOf: B.fp }), expect.objectContaining({ fingerprint: wide, claimsNameOf: B.fp })]);
    expect(st.lookalikes[0].note).toMatch(/different key/);
    expect(new PairTools({ pairing: A.pairing, elicit: null, resolvePeer: () => null, knownAgents: () => known.slice(0, 1) }).status()).not.toHaveProperty('lookalikes');
  });

  it('every pairing question lists the safe choice first and never matches the permission auto-resolver (LES-4)', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire), B = agent('b', wire);
    const seen: Array<{ message: string; choices: string[] }> = [];
    const recordAs = (answers: Array<Record<string, string> | null>): Elicit => async (message, fields) => {
      const enumField = Object.values(fields).find((f) => f.enum);
      if (enumField) seen.push({ message, choices: enumField.enum! });
      return answers.shift() ?? null;
    };
    const made = A.tools(null).invite({}) as { message: string };
    await B.tools(recordAs([{ invite: made.message }, { decision: 'approve' }])).open();
    await pump(wire, [A, B]);
    await A.tools(recordAs([{ decision: 'finish' }])).finish({});
    await tick(); await pump(wire, [A, B]);
    await A.tools(recordAs([{ decision: 'keep' }])).forget({ peer: B.fp });
    expect(seen.map((q) => q.choices[0])).toEqual(['decline', 'not them', 'keep']);
    // Instar's PermissionPromptAutoResolver approves prompts matching these (src/monitoring/PermissionPromptAutoResolver.ts).
    for (const q of seen) {
      expect(q.message).not.toMatch(/Do you want to proceed\?/i);
      for (const c of q.choices) expect(c).not.toMatch(/^(yes|proceed|allow|continue)\b/i);
    }
  });

  it('cancel revokes an open invite once', () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire);
    const made = A.tools(null).invite({}) as { iid: string };
    expect(A.tools(null).cancel({ iid: made.iid })).toMatchObject({ ok: true });
    expect(A.tools(null).cancel({ iid: made.iid })).toMatchObject({ ok: false });
  });
});
