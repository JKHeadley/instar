/**
 * The stand-in owner chat for throwaway agents (docs/specs/throwaway-owner-chat.md): the four
 * switch-on conditions (each refusal), unsure vs off, shutting off for good with its sweep, the log
 * bounds and budget, the tap outcome rules, the command allowlist and the route gate.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  ThrowawayOwnerChat, evaluateStandIn, standInEverUsed, STAND_IN_STATE, STAND_IN_LOG, LOG_BUDGET_BYTES, MAX_TEXT_UNITS,
  type ThrowawayOwnerChatDeps,
} from '../../src/server/throwawayOwnerChat.js';
import { mountThrowawayOwnerChatRoutes } from '../../src/server/throwawayOwnerChatRoutes.js';
import { approveTapResult, declineTapResult } from '../../src/messaging/ownerChatTap.js';

const ACCOUNT_HOME = '/nonexistent-account-home-for-stand-in-tests';
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/throwawayOwnerChat.test.ts' }); });

const NONCE = 'a'.repeat(24);
const NONCE2 = 'b'.repeat(24);

function makeHome(opts: { config?: Record<string, unknown>; base?: string } = {}) {
  const dir = fs.mkdtempSync(path.join(opts.base ?? os.tmpdir(), 'toc-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state', 'machine']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({
    messaging: [],
    liveTest: { throwawayOwnerChat: { enabled: true } },
    throwawayAgent: { createdAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString() },
    ...opts.config,
  }));
  fs.writeFileSync(path.join(stateDir, 'machine', 'identity.json'), JSON.stringify({ machineId: 'm_self' }));
  fs.writeFileSync(path.join(stateDir, 'machine', 'registry.json'), JSON.stringify({ version: 1, machines: { m_self: {} } }));
  return { dir, stateDir };
}

function deps(h: { dir: string; stateDir: string }, extra: Partial<ThrowawayOwnerChatDeps> = {}): ThrowawayOwnerChatDeps & { lines: string[] } {
  const lines: string[] = [];
  return { projectDir: h.dir, stateDir: h.stateDir, adapterStarted: () => false, accountHome: ACCOUNT_HOME, agentRegistryFiles: () => [], log: (l) => lines.push(l), lines, ...extra };
}

function editConfig(h: { stateDir: string }, patch: (c: Record<string, any>) => void) {
  const file = path.join(h.stateDir, 'config.json');
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  patch(c);
  fs.writeFileSync(file, JSON.stringify(c));
}

/** A live stand-in with handlers that record what they were asked. */
function liveChat(h = makeHome()) {
  const d = deps(h);
  const chat = new ThrowawayOwnerChat(d);
  const declined: string[] = [];
  const approved: string[] = [];
  chat.mobileDeclineHandler = (n) => { declined.push(n); return { result: 'declined' }; };
  chat.mobileApproveHandler = (n) => { approved.push(n); return { outcome: 'approved', text: '' }; };
  return { h, d, chat, declined, approved };
}

describe('switch-on conditions: each refusal names its condition', () => {
  const cases: Array<[string, (h: ReturnType<typeof makeHome>) => void, string]> = [
    ['no switch', (h) => editConfig(h, (c) => { delete c.liveTest; }), 'not-asked'],
    ['no throwaway record', (h) => editConfig(h, (c) => { delete c.throwawayAgent; }), 'not-throwaway'],
    ['a keep record', (h) => editConfig(h, (c) => { c.throwawayAgent.keep = true; }), 'not-throwaway'],
    ['an expired record', (h) => editConfig(h, (c) => { c.throwawayAgent.expiresAt = new Date(Date.now() - 1000).toISOString(); }), 'not-throwaway'],
    ['a record created in the future', (h) => editConfig(h, (c) => { c.throwawayAgent.createdAt = new Date(Date.now() + 3_600_000).toISOString(); }), 'not-throwaway'],
    ['a disabled messaging entry', (h) => editConfig(h, (c) => { c.messaging = [{ type: 'telegram', enabled: false, config: {} }]; }), 'real-owner'],
    ['a prompt-gate owner id', (h) => editConfig(h, (c) => { c.monitoring = { promptGate: { ownerId: 42 } }; }), 'real-owner'],
    ['an owner introducer', (h) => editConfig(h, (c) => { c.mobilePairing = { ownerIntroducers: [{ name: 'x', publicKey: 'k' }] }; }), 'real-owner'],
    ['a recorded operator', (h) => fs.writeFileSync(path.join(h.stateDir, 'state', 'topic-operators.json'), JSON.stringify({ '12': { uid: 7 } })), 'real-owner'],
    ['an owner record enrolled before the first build', (h) => fs.writeFileSync(path.join(h.stateDir, 'machine', 'owner-record-enrolled.json'), JSON.stringify({ agentId: 'a', genesis: 'g', at: new Date().toISOString() })), 'real-owner'],
    ['an owner-key entry before the first build', (h) => { fs.mkdirSync(path.join(h.stateDir, 'state', 'owner-record'), { recursive: true }); fs.writeFileSync(path.join(h.stateDir, 'state', 'owner-record', 'entries.jsonl'), '{"kind":"add-owner-key"}\n'); }, 'real-owner'],
    ['a device paired before the first build', (h) => fs.writeFileSync(path.join(h.stateDir, 'state', 'mobile-devices.json'), JSON.stringify({ devices: [{ id: 'd1' }] })), 'real-owner'],
    ['another machine in the registry', (h) => fs.writeFileSync(path.join(h.stateDir, 'machine', 'registry.json'), JSON.stringify({ version: 1, machines: { m_self: {}, m_peer: {} } })), 'not-single-machine'],
  ];
  for (const [name, mutate, condition] of cases) {
    it(`refuses: ${name}`, () => {
      const h = makeHome();
      mutate(h);
      const d = deps(h);
      const chat = ThrowawayOwnerChat.forBoot(d);
      if (condition === 'not-asked') { expect(chat).toBeNull(); return; }
      expect(chat!.builtLive).toBe(false);
      expect(chat!.bootVerdict).toMatchObject({ ok: false, unsure: false, condition });
      expect(d.lines.join('\n')).toContain(`condition ${condition}`);
      // A home refused on its first boot never ran the stand-in: no state file, so pairing stays allowed.
      expect(standInEverUsed(h.stateDir)).toBe(false);
    });
  }

  it('refuses a started adapter', () => {
    const h = makeHome();
    const chat = new ThrowawayOwnerChat(deps(h, { adapterStarted: () => true }));
    expect(chat.bootVerdict).toMatchObject({ ok: false, condition: 'real-owner' });
  });

  it('refuses a project outside the temporary folders, even with a sandboxed HOME and a forged record', () => {
    const outside = fs.mkdtempSync(path.join(process.cwd(), '.toc-outside-'));
    dirs.push(outside);
    const h = makeHome({ base: outside });
    expect(evaluateStandIn({ ...deps(h), projectDir: h.dir })).toMatchObject({ ok: false, condition: 'not-throwaway' });
  });

  it('refuses a temp-folder symlink pointing at a home outside the temporary folders', () => {
    const outside = fs.mkdtempSync(path.join(process.cwd(), '.toc-outside-'));
    dirs.push(outside);
    const real = makeHome({ base: outside });
    const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'toc-link-')), 'agent');
    dirs.push(path.dirname(link));
    fs.symlinkSync(real.dir, link);
    expect(evaluateStandIn({ ...deps(real), projectDir: link, stateDir: path.join(link, '.instar') })).toMatchObject({ ok: false, condition: 'not-throwaway' });
  });

  it('refuses a state folder outside the project folder', () => {
    const h = makeHome();
    const other = makeHome();
    expect(evaluateStandIn({ ...deps(h), stateDir: other.stateDir })).toMatchObject({ ok: false, condition: 'not-throwaway' });
  });

  it('refuses a copy of another agent home (same machine identity)', () => {
    const original = makeHome();
    const copy = makeHome();
    const reg = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'toc-reg-')), 'registry.json');
    dirs.push(path.dirname(reg));
    fs.writeFileSync(reg, JSON.stringify({ version: 1, entries: [{ path: original.dir }, { path: copy.dir }] }));
    expect(evaluateStandIn({ ...deps(copy), agentRegistryFiles: () => [reg] })).toMatchObject({ ok: false, condition: 'real-owner' });
    // A home with its own identity passes the same scan.
    fs.writeFileSync(path.join(copy.stateDir, 'machine', 'identity.json'), JSON.stringify({ machineId: 'm_other' }));
    fs.writeFileSync(path.join(copy.stateDir, 'machine', 'registry.json'), JSON.stringify({ version: 1, machines: { m_other: {} } }));
    expect(evaluateStandIn({ ...deps(copy), agentRegistryFiles: () => [reg] })).toEqual({ ok: true });
    // Another home whose identity file exists but cannot be parsed is unsure, never a non-match.
    fs.writeFileSync(path.join(original.stateDir, 'machine', 'identity.json'), '{ broken');
    expect(evaluateStandIn({ ...deps(copy), agentRegistryFiles: () => [reg] })).toMatchObject({ ok: false, unsure: true });
  });

  it('builds on a clean throwaway and records its first build', () => {
    const h = makeHome();
    const d = deps(h);
    const chat = ThrowawayOwnerChat.forBoot(d)!;
    expect(chat.builtLive).toBe(true);
    expect(chat.live()).toBe(true);
    expect(standInEverUsed(h.stateDir)).toBe(true);
    expect(d.lines[0]).toContain('built');
  });

  it('keeps an enrolment made after the first build across a restart, and adopts its genesis', () => {
    const { h } = liveChat();
    fs.writeFileSync(path.join(h.stateDir, 'machine', 'owner-record-enrolled.json'), JSON.stringify({ agentId: 'a', genesis: 'g1', at: new Date(Date.now() + 1000).toISOString() }));
    fs.writeFileSync(path.join(h.stateDir, 'state', 'mobile-devices.json'), JSON.stringify({ devices: [{ id: 'd1' }] }));
    const again = new ThrowawayOwnerChat(deps(h));
    expect(again.builtLive).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(h.stateDir, STAND_IN_STATE), 'utf8')).genesis).toBe('g1');
    // A different genesis later refuses.
    fs.writeFileSync(path.join(h.stateDir, 'machine', 'owner-record-enrolled.json'), JSON.stringify({ agentId: 'a', genesis: 'g2', at: new Date(Date.now() + 1000).toISOString() }));
    expect(new ThrowawayOwnerChat(deps(h)).builtLive).toBe(false);
  });
});

describe('unsure is not off', () => {
  it('an unparseable config withholds one use without shutting off', async () => {
    const { h, chat } = liveChat();
    const file = path.join(h.stateDir, 'config.json');
    const good = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, '{ not json');
    expect(await chat.sendOwnerDMWithButton('code 123 456', null)).toBeNull();
    expect(chat.messages(0).status).toBe(503);
    // Owner presence stays true while unsure, so the approval channel never flips to the dashboard.
    expect(chat.ownerChatPresent()).toBe(true);
    expect(chat.isOff()).toBe(false);
    fs.writeFileSync(file, good);
    expect(chat.live()).toBe(true);
    expect(await chat.sendOwnerDMWithButton('code 123 456', null)).toBe(1);
  });
});

describe('shutting off for good', () => {
  it('a messaging entry added while running: off recorded, live Decline pressed, others only removed, hooks run, 410 after', async () => {
    const { h, chat, declined } = liveChat();
    const hooks: string[] = [];
    chat.onShutOff('claim', () => hooks.push('claim'));
    const id = await chat.sendOwnerDMWithButton('pair?', [{ text: 'Approve', data: `md:a:${NONCE}` }, { text: 'Decline', data: `md:d:${NONCE}` }]);
    await chat.sendOwnerDMWithButton('first approver code', [{ text: 'Decline', data: 'approver-first-ignore:d1' }]);
    expect(id).toBe(1);
    editConfig(h, (c) => { c.messaging = [{ type: 'telegram', config: {} }]; });
    expect(chat.messages(0)).toMatchObject({ status: 410 });
    expect(declined).toEqual([NONCE]);
    expect(hooks).toEqual(['claim']);
    const st = JSON.parse(fs.readFileSync(path.join(h.stateDir, STAND_IN_STATE), 'utf8'));
    expect(st.off.condition).toBe('real-owner');
    expect(st.swept).toBeTruthy();
    expect(await chat.sendOwnerDMWithButton('more', null)).toBeNull();
    expect(chat.tap(1, 0).status).toBe(410);
    // The next boot refuses on the record alone, even with the entry removed again.
    editConfig(h, (c) => { c.messaging = []; });
    expect(new ThrowawayOwnerChat(deps(h)).bootVerdict).toMatchObject({ ok: false, condition: 'shut-off-earlier' });
    expect(standInEverUsed(h.stateDir)).toBe(true);
  });

  it('an expired record or a new peer shuts it off the same way', () => {
    const a = liveChat();
    editConfig(a.h, (c) => { c.throwawayAgent.expiresAt = new Date(Date.now() - 1).toISOString(); });
    expect(a.chat.live()).toBe(false);
    const b = liveChat();
    fs.writeFileSync(path.join(b.h.stateDir, 'machine', 'registry.json'), JSON.stringify({ version: 1, machines: { m_self: {}, m_peer: {} } }));
    expect(b.chat.messages(0).status).toBe(410);
  });

  it('a boot refused after an earlier build sweeps once the handlers are wired', async () => {
    const { h, chat } = liveChat();
    await chat.sendOwnerDMWithButton('pair?', [{ text: 'Decline', data: `md:d:${NONCE2}` }]);
    editConfig(h, (c) => { c.monitoring = { promptGate: { ownerId: 9 } }; });
    const reboot = new ThrowawayOwnerChat(deps(h));
    expect(reboot.builtLive).toBe(false);
    const declined: string[] = [];
    reboot.mobileDeclineHandler = (n) => { declined.push(n); return 'declined'; };
    let hookRuns = 0;
    reboot.onShutOff('recovery', () => { hookRuns += 1; });
    reboot.finishShutOff();
    reboot.finishShutOff();
    expect(declined).toEqual([NONCE2]);
    expect(hookRuns).toBe(1);
  });

  it('a failing hook is retried at the next start', () => {
    const { h, chat } = liveChat();
    chat.onShutOff('broken', () => { throw new Error('nope'); });
    editConfig(h, (c) => { delete c.liveTest; });
    expect(chat.live()).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(h.stateDir, STAND_IN_STATE), 'utf8')).swept).toBeUndefined();
    const reboot = new ThrowawayOwnerChat(deps(h));
    let ran = false;
    reboot.onShutOff('broken', () => { ran = true; });
    reboot.finishShutOff();
    expect(ran).toBe(true);
  });
});

describe('messages, bounds and the log', () => {
  it('ids are positive, bounds refuse, a restart keeps live buttons', async () => {
    const { h, chat } = liveChat();
    expect(await chat.sendOwnerDMWithButton('x'.repeat(MAX_TEXT_UNITS + 1), null)).toBeNull();
    expect(await chat.sendOwnerDMWithButton('ok', [{ text: 'A', data: 'x'.repeat(65) }])).toBeNull();
    expect(await chat.sendOwnerDMWithButton('ok', Array.from({ length: 20 }, (_, i) => ({ text: 'L'.repeat(2000), data: `d${i}` })))).toBeNull();
    expect(await chat.sendOwnerDMWithButton('ok', Array.from({ length: 101 }, (_, i) => ({ text: 'b', data: `d${i}` })))).toBeNull();
    const id = await chat.sendOwnerDMWithButton('pair?', [{ text: 'Approve', data: `md:a:${NONCE}` }]);
    expect(id).toBeGreaterThan(0);
    expect((fs.statSync(path.join(h.stateDir, STAND_IN_LOG)).mode & 0o777)).toBe(0o600);
    const reboot = new ThrowawayOwnerChat(deps(h));
    reboot.mobileApproveHandler = () => ({ outcome: 'approved', text: '' });
    expect(reboot.tap(id, 0).status).toBe(200);
  });

  it('refuses a tap before its handler runs when the budget has no room for its result', async () => {
    const { chat, approved } = liveChat();
    const id = await chat.sendOwnerDMWithButton('pair?', [{ text: 'Approve', data: `md:a:${NONCE}` }]);
    (chat as unknown as { bytes: number }).bytes = LOG_BUDGET_BYTES - 1000;
    expect(chat.tap(id, 0)).toMatchObject({ status: 507 });
    expect(approved).toEqual([]);
    expect(await chat.sendOwnerDMWithButton('x'.repeat(2000), null)).toBeNull();
  });

  it('a tap is logged as an intent first; an intent with no result reads as indeterminate after a restart', async () => {
    const { h, chat } = liveChat();
    const id = (await chat.sendOwnerDMWithButton('pair?', [{ text: 'Approve', data: `md:a:${NONCE}` }]))!;
    chat.tap(id, 0);
    const entries = chat.messages(0).body.entries as Array<{ kind: string; indeterminate?: boolean }>;
    expect(entries.find((e) => e.kind === 'tap-intent')).toMatchObject({ indeterminate: false });
    // A crash after the intent and before the result: only the intent reached the log.
    fs.appendFileSync(path.join(h.stateDir, STAND_IN_LOG), JSON.stringify({ kind: 'tap-intent', id: 99, at: new Date().toISOString(), messageId: id, button: 0, data: `md:a:${NONCE}` }) + '\n');
    const reboot = new ThrowawayOwnerChat(deps(h));
    const after = reboot.messages(0).body.entries as Array<{ kind: string; id: number; indeterminate?: boolean }>;
    expect(after.find((e) => e.id === 99)).toMatchObject({ indeterminate: true });
  });

  it('a torn last log line does not swallow the next entry', async () => {
    const { h, chat } = liveChat();
    await chat.sendOwnerDMWithButton('one', null);
    fs.appendFileSync(path.join(h.stateDir, STAND_IN_LOG), '{"kind":"mess');
    const reboot = new ThrowawayOwnerChat(deps(h));
    const id = await reboot.sendOwnerDMWithButton('two', null);
    const again = new ThrowawayOwnerChat(deps(h));
    expect((again.messages(0).body.entries as Array<{ id: number }>).map((e) => e.id)).toContain(id);
  });

  it('pages GET', async () => {
    const { chat } = liveChat();
    for (let i = 0; i < 205; i++) await chat.sendOwnerDMWithButton(`m${i}`, null);
    const page = chat.messages(0);
    expect((page.body.entries as unknown[]).length).toBe(200);
    expect(page.body.more).toBe(true);
  });
});

describe('taps follow the adapter outcome rules', () => {
  it('approved removes the buttons and stores the confirmation; a second tap is 409', async () => {
    const { chat } = liveChat();
    const id = (await chat.sendOwnerDMWithButton('pair?', [{ text: 'Approve', data: `md:a:${NONCE}` }, { text: 'Decline', data: `md:d:${NONCE}` }]))!;
    const r = chat.tap(id, 0);
    expect(r.body).toMatchObject({ outcome: 'approved', toast: 'Approved. That phone is paired.', buttonsRemoved: true });
    const all = chat.messages(0).body.entries as Array<{ kind: string; text?: string }>;
    expect(all.some((e) => e.kind === 'message' && e.text === approveTapResult({ outcome: 'approved', text: '' }).confirmation)).toBe(true);
    expect(chat.tap(id, 1)).toMatchObject({ status: 409, body: { error: 'buttons-removed' } });
  });

  it('declined replaces the text; any other outcome leaves the buttons live', async () => {
    const { chat } = liveChat();
    const id = (await chat.sendOwnerDMWithButton('pair?', [{ text: 'Decline', data: `md:d:${NONCE}` }]))!;
    expect(chat.tap(id, 0).body).toMatchObject({ outcome: 'declined', buttonsRemoved: true });
    const other = liveChat();
    other.chat.mobileApproveHandler = () => ({ outcome: 'other', text: 'Removing it.' });
    const id2 = (await other.chat.sendOwnerDMWithButton('remove?', [{ text: 'Approve', data: `md:a:${NONCE}` }]))!;
    expect(other.chat.tap(id2, 0).body).toMatchObject({ outcome: 'other', toast: 'Removing it.', buttonsRemoved: false });
    expect(other.chat.tap(id2, 0).status).toBe(200);
  });

  it('a button outside the approval patterns is not handled; unknown ids are 404', async () => {
    const { chat } = liveChat();
    const id = (await chat.sendOwnerDMWithButton('code', [{ text: 'Decline', data: 'approver-first-ignore:d1' }]))!;
    expect(chat.tap(id, 0)).toMatchObject({ status: 409, body: { error: 'button-not-handled' } });
    expect(chat.tap(id, 5).status).toBe(404);
    expect(chat.tap(999, 0).status).toBe(404);
  });

  it('the shared words match for both surfaces', () => {
    expect(declineTapResult({ result: 'declined', client: 'browser' })).toEqual({ toast: 'Declined. That browser will not be set up.', replaceText: 'Declined. That browser was not set up.', declined: true });
    expect(declineTapResult('already-approved').toast).toBe("Already approved — remove it on the Phones page if this wasn't you.");
    expect(declineTapResult({ result: 'declined', text: 'Kept.' })).toMatchObject({ toast: 'Kept.', replaceText: 'Kept.' });
    expect(approveTapResult({ outcome: 'ended', text: 'This pairing has already ended.' })).toEqual({ toast: 'This pairing has already ended.', removeButtons: false, confirmation: null, approved: false });
  });
});

describe('the command route', () => {
  it('only /approver_reset, handed the trimmed rest; 409 when not wired', async () => {
    const { chat } = liveChat();
    expect(chat.command('/approver_reset')).toMatchObject({ status: 409, body: { error: 'not-wired' } });
    const args: string[] = [];
    chat.approverResetHandler = (a) => { args.push(a); return { text: 'Start a reset?', buttons: [{ text: 'Start', data: `md:a:${NONCE}` }] }; };
    expect(chat.command('/approver_reset  KITE-1234 ').status).toBe(200);
    const logged = chat.messages(0).body.entries as Array<{ kind: string; indeterminate?: boolean }>;
    expect(logged.find((e) => e.kind === 'command-intent')).toMatchObject({ indeterminate: false });
    expect(chat.command(`/approver_reset ${'x'.repeat(MAX_TEXT_UNITS)}`).status).toBe(400);
    expect(args).toEqual(['KITE-1234']);
    expect(chat.command('/start').status).toBe(400);
    expect(chat.command('hello /approver_reset').status).toBe(400);
    chat.approverResetHandler = () => ({ text: 'x'.repeat(MAX_TEXT_UNITS + 1) });
    expect(chat.command('/approver_reset')).toMatchObject({ status: 500, body: { error: 'reply-over-bounds' } });
  });
});

describe('the route gate', () => {
  function app() {
    const { chat } = liveChat();
    const a = express();
    a.use(express.json());
    mountThrowawayOwnerChatRoutes(a, chat, { authToken: () => 'tok', port: () => 4999 });
    return { a, chat };
  }
  const local = (q: request.Test) => q.set('Host', 'localhost:4999').set('Authorization', 'Bearer tok');

  it('a local test holding the master token is served', async () => {
    const { a } = app();
    expect((await local(request(a).get('/throwaway/owner-chat/messages'))).status).toBe(200);
  });

  it('refuses a wrong token, another host, forwarding headers, a device signature and an Origin (404)', async () => {
    const { a } = app();
    expect((await request(a).get('/throwaway/owner-chat/messages').set('Host', 'localhost:4999').set('Authorization', 'Bearer nope')).status).toBe(404);
    expect((await request(a).get('/throwaway/owner-chat/messages').set('Host', 'agent.example.dev').set('Authorization', 'Bearer tok')).status).toBe(404);
    expect((await local(request(a).get('/throwaway/owner-chat/messages')).set('X-Forwarded-For', '1.2.3.4')).status).toBe(404);
    expect((await local(request(a).get('/throwaway/owner-chat/messages')).set('Cf-Connecting-Ip', '1.2.3.4')).status).toBe(404);
    expect((await local(request(a).post('/throwaway/owner-chat/tap')).set('X-Instar-Device', 'dev1').send({ messageId: 1, button: 0 })).status).toBe(404);
    expect((await local(request(a).get('/throwaway/owner-chat/messages')).set('Origin', 'http://localhost:4999')).status).toBe(404);
  });

  it('refuses everything when no token is configured', async () => {
    const { chat } = liveChat();
    const a = express();
    mountThrowawayOwnerChatRoutes(a, chat, { authToken: () => undefined, port: () => 4999 });
    expect((await request(a).get('/throwaway/owner-chat/messages').set('Host', 'localhost:4999')).status).toBe(404);
  });
});
