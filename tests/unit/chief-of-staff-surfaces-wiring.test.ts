/**
 * Wiring-integrity for the Chief of Staff surfaces (docs/specs/chief-of-staff-topic.md §1.4, §3, §4, §6; PR 4):
 * the topic is ensured at both boot sites and adopted on standbys; the system-topic key is registered; the
 * inbound handler drops non-owner input in the CoS topic; `cos:` taps are owner-checked in the adapter and
 * handed to the loop (and count as a check-in); the app list gets the pinned/tree provider; the note carries
 * its buttons; the CLAUDE.md template carries the marker line and the registry row; the console models and
 * the needs registry carry the feature.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SYSTEM_TOPIC_STATE_KEYS } from '../../src/core/StateManager.js';
import { SYSTEM_TOPIC_KINDS } from '../../src/messaging/SystemTopicAdoption.js';
import { TelegramAdapter, TOPIC_STYLE } from '../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const ROOT = path.join(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

describe('Chief of Staff surfaces — static wiring', () => {
  const server = read('src/commands/server.ts');
  it('the topic is ensured at both boot sites and in both adoption ensureOwn closures; the key is a system-topic kind', () => {
    expect(server.match(/ensureChiefOfStaffTopicFor\(telegram, state, liveConfig, config\)/g)?.length).toBe(2);
    expect(server.match(/await ensureChiefOfStaffTopicFor\(telegram!, state, liveConfig, config\)/g)?.length).toBe(2);
    expect(SYSTEM_TOPIC_STATE_KEYS.chiefOfStaff).toBe('chief-of-staff-topic');
    expect(SYSTEM_TOPIC_KINDS).toContain('chiefOfStaff');
    expect(TOPIC_STYLE.CHIEF.emoji).toBe('🧭');
  });
  it('non-owner input in the CoS topic is dropped before routing; owner taps renew and reach ownerTap', () => {
    expect(server).toContain("console.warn(`[chief-of-staff] dropped a non-owner message in the Chief of Staff topic");
    expect(server).toContain('_cosOwnerOnlyTopicId = _cosTopicId;');
    expect(server).toContain("telegram.onChiefOfStaffTap = async (tap) => {");
    expect(server).toContain("return loop.ownerTap(tap.data, 'owner-tap');");
    expect(server).toContain('sign: (c) => idMod.sign(c, localSigningKeyPem),');
    expect(server).toContain('resolveApprovalOwner(telegram.getOwnerUserId(), [], [])'); // owner id normalised (config may hold a string)
  });
  it('the note carries its buttons through the topic or the owner DM, failing closed on an unreadable reader count', () => {
    expect(server).toContain('await telegram.sendOfferList(cosTopic, text, buttons)');
    expect(server).toContain('await telegram.sendOwnerDMWithButton(text, buttons)');
    expect(server).toContain('readers === null || readers > 1');
  });
  it('the app list gets the pinned/tree provider only with the loop; the route serves it to owner-role callers only', () => {
    expect(read('src/server/AgentServer.ts')).toContain('chiefOfStaff: options.chiefOfStaffLoop ? () => {');
    const route = read('src/server/mobileConversationRoutes.ts');
    expect(route).toContain("(person === null || person.role === 'owner') ? (deps.chiefOfStaff?.() ?? null) : null");
    expect(route).toContain('if (!cosView || !cosView.pinnedKey || cursor !== null) return {};');
  });
  it('status route exposes the conversation key; the check-in route is PIN-gated', () => {
    const routes = read('src/server/routes.ts');
    expect(routes).toContain("router.post('/chief-of-staff/check-in'");
    expect(routes).toContain("if (!requireMandatePin(req, res)) return;\n    const r = ctx.chiefOfStaffLoop.checkIn(");
    expect(routes).toContain("conversationKey: typeof cosTopic === 'number' && cosTopic > 1 ? `telegram:${cosTopic}` : null");
  });
  it('the CLAUDE.md template carries the marker line and the registry row; the console carries the feature', () => {
    const t = read('src/scaffold/templates.ts');
    expect(t).toContain('<!-- instar:chief-of-staff -->');
    expect(t).toContain('What does the Chief of Staff need from me?');
    expect(read('dashboard/console/needs-model.js')).toContain("{ id: 'chief-of-staff', page: 'work/chats', reads: { cos: '/chief-of-staff' },");
    expect(read('dashboard/console/chats.js')).toContain("'data-operator-need': 'chief-of-staff'");
    expect(read('dashboard/console/chats.js')).toContain('orderWithTree(this.rows, this.pinnedKey)');
  });
});

describe('TelegramAdapter — cos: taps are owner-only and answered plainly', () => {
  const dirs: string[] = []; const adapters: TelegramAdapter[] = [];
  afterEach(async () => { vi.restoreAllMocks(); await Promise.all(adapters.splice(0).map((a) => a.stop())); for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'cos tap test cleanup' }); });
  function make(ownerUserId: number | undefined) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-tap-')); dirs.push(d);
    const a = new TelegramAdapter({ token: 'test-token-123', chatId: '-100123456', pollIntervalMs: 100, ...(ownerUserId ? { ownerUserId } : {}) } as never, d);
    adapters.push(a);
    const answers: string[] = [];
    vi.spyOn(a as unknown as { apiCall: (m: string, p: Record<string, unknown>) => Promise<unknown> }, 'apiCall').mockImplementation(async (method, params) => { if (method === 'answerCallbackQuery') answers.push(String(params.text)); return { ok: true }; });
    return { a, answers };
  }
  const tap = (a: TelegramAdapter, from: number, data: string) => (a as unknown as { handleForwardedCallback: (q: unknown) => Promise<void> }).handleForwardedCallback({ id: 'q1', data, from: { id: from }, message: { chat: { id: -100123456 }, message_id: 5, message_thread_id: 900 } });
  it('a non-owner tap is refused and the handler never runs; no owner configured ⇒ refused too', async () => {
    const { a, answers } = make(4242);
    let ran = 0; a.onChiefOfStaffTap = async () => { ran++; return 'ok'; };
    await tap(a, 1, 'cos:unpark:telegram:1');
    expect(ran).toBe(0); expect(answers).toEqual(['Only the owner can tap this.']);
    const none = make(undefined); none.a.onChiefOfStaffTap = async () => { ran++; return 'ok'; };
    await tap(none.a, 4242, 'cos:unpark:telegram:1');
    expect(ran).toBe(0);
  });
  it('the owner\'s tap reaches the handler with the data; ok ⇒ "Done."; ignored ⇒ no-longer-applies; a throwing handler answers a plain failure', async () => {
    const { a, answers } = make(4242);
    const seen: string[] = [];
    a.onChiefOfStaffTap = async (t) => { seen.push(t.data); return t.data.includes('unpark') ? 'ok' : 'ignored'; };
    await tap(a, 4242, 'cos:unpark:telegram:1'); await tap(a, 4242, 'cos:confirm-done:telegram:2');
    expect(seen).toEqual(['cos:unpark:telegram:1', 'cos:confirm-done:telegram:2']);
    expect(answers).toEqual(['Done.', 'That action no longer applies.']);
    a.onChiefOfStaffTap = async () => { throw new Error('boom'); };
    await tap(a, 4242, 'cos:unpark:telegram:3');
    expect(answers[2]).toBe('Not available right now.');
  });
});
