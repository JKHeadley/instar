/**
 * Both sides hear how a pairing ended — on the PRODUCTION path (docs/specs/a2a-pairing-invite-link.md §11).
 *
 * Two agents built by the real `bootstrapThreadline`, on a real in-process RelayServer, with real
 * AgentServers, and the real Telegram pairing surface (`PairingInviteTelegram`, wired the way
 * routes.ts wires it) with Telegram itself replaced by a recorder. The operator acts are real taps
 * through `onCallback` (verified, enforcing, the owner's id). Nothing in the protocol is hand-built:
 * accepts, receipts, refusals, the finish and the hellos all travel through the relay, encrypted where
 * the spec says so, and are verified against pinned keys.
 *
 * Covers the three things Justin asked for after his PP ↔ Echo test (topic 61599, 2026-10-20):
 *  - Approve → an immediate "Approved — finishing…" → both sides "Connected ✓" only after the hello;
 *  - a refusal → both sides are told, in plain words;
 *  - a timeout → the side left waiting is told (each side, in its own scenario).
 * Plus the same-owner path: "It's one of my agents" → no Finish tap.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { RelayServer } from '../../../src/threadline/relay/RelayServer.js';
import { bootstrapThreadline } from '../../../src/threadline/ThreadlineBootstrap.js';
import { createUnifiedTrustSystem } from '../../../src/threadline/UnifiedTrustWiring.js';
import type { UnifiedTrustSystem } from '../../../src/threadline/UnifiedTrustWiring.js';
import { HandshakeManager } from '../../../src/threadline/HandshakeManager.js';
import { AgentServer } from '../../../src/server/AgentServer.js';
import { PairingInviteTelegram, OWN_AGENT_PROMPT } from '../../../src/threadline/PairingInviteTelegram.js';
import { PairingTopicStore } from '../../../src/threadline/PairingTopicStore.js';
import { LifelineIngressGuard } from '../../../src/server/LifelineIngressGuard.js';
import { TelegramAdapter } from '../../../src/messaging/TelegramAdapter.js';
import { ensureLifelineIngressSecret, LIFELINE_SECRET_HEADER } from '../../../src/core/LifelineIngressSecret.js';
import { createTempProject, createMockSessionManager } from '../../helpers/setup.js';
import type { TempProject } from '../../helpers/setup.js';
import type { InstarConfig } from '../../../src/core/types.js';
import { useHermeticHome } from '../../setup/hermetic-home.js';

// HOME → temp for every test here: bootstrapThreadline() writes the user-scope
// ~/.claude.json, and this file must never touch the operator's real one.
useHermeticHome();

const PIN = '135790';
const OWNER = 7001;
// Short timers only where a timeout is the thing under test; elsewhere they are long enough that a
// loaded machine cannot fire a timeout the scenario does not expect.
const FAST = { acceptResendMs: [400, 400, 400], answerTimeoutMs: 3_000, helloResendMs: [300, 300, 300], helloTimeoutMs: 3_000 };
const CALM = { acceptResendMs: [2_000, 4_000], answerTimeoutMs: 120_000, helloResendMs: [2_000, 4_000], helloTimeoutMs: 120_000 };

function configFor(project: TempProject, name: string, auth: string): InstarConfig {
  return {
    projectName: name, projectDir: project.dir, stateDir: project.stateDir, port: 0, authToken: auth,
    requestTimeoutMs: 5000, version: '0.9.81', developmentAgent: true, dashboardPin: PIN,
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [], monitoring: {}, updates: {}, users: [],
    threadline: { relayEnabled: true, verifiedPairing: { enabled: true } },
  } as InstarConfig;
}

const portOf = (s: AgentServer) => (s as unknown as { server: { address(): { port: number } } }).server.address().port;

interface Posted { topicId: number; text: string; buttons?: Array<{ text: string; data: string }> }
interface Side {
  name: string; auth: string; project: TempProject;
  boot: Awaited<ReturnType<typeof bootstrapThreadline>>;
  trust: UnifiedTrustSystem; server: AgentServer; url: string; fp: string;
  tg: PairingInviteTelegram; posted: Posted[]; toasts: string[]; undelivered: string[];
  down: boolean;
}

describe('pairing handshake — production path', () => {
  let relay: RelayServer;
  let relayData: TempProject;
  let relayUrl: string;
  const sides: Side[] = [];

  async function bootSide(name: string, port: number, timings: typeof FAST = CALM, enforcing: () => boolean = () => true, whyNoButtons?: () => string | null): Promise<Side> {
    const project = createTempProject();
    const auth = `${name}-auth`;
    const boot = await bootstrapThreadline({
      agentName: name, ownerName: 'Justin', stateDir: project.stateDir, projectDir: project.dir, port, relayEnabled: true, relayUrl,
      getVerifiedPairingConfig: () => ({ enabled: true, dryRun: true, credentialShareEnforced: false }),
      pairingHandshakeTimings: timings,
    });
    expect(boot.relayClient?.connectionState).toBe('connected');
    const pi = boot.pairingInvites!;
    expect(pi.handshake).toBeDefined();
    const trust = createUnifiedTrustSystem(boot.trustManager!, { stateDir: project.stateDir });
    const server = new AgentServer({
      config: configFor(project, name, auth), sessionManager: createMockSessionManager() as never, state: project.state,
      handshakeManager: new HandshakeManager(project.stateDir, name), threadlineRelayClient: boot.relayClient!, unifiedTrust: trust, pairingInvites: pi,
    } as never);
    await server.start();
    const posted: Posted[] = [];
    const toasts: string[] = [];
    const undelivered: string[] = [];
    // Wired exactly as routes.ts wires it, with Telegram's send replaced by a recorder.
    const tg = new PairingInviteTelegram({
      flow: pi.handshake,
      events: pi.events,
      send: async (topicId, text, buttons) => { posted.push({ topicId, text, buttons }); },
      answer: async (_id, text) => { toasts.push(text); },
      ownerUserId: () => OWNER,
      chatId: () => '-100',
      operatorTopicId: () => 1, // the Lifeline topic
      enforcing,
      whyNoButtons,
      topics: new PairingTopicStore(project.stateDir),
      ownOpenInvite: (iid) => { const inv = pi.store.getInternal(iid); return inv && inv.state === 'open' ? { exp: inv.exp } : null; },
      reportUndelivered: (what, reason) => { undelivered.push(`${what}: ${reason}`); },
    });
    const s: Side = { name, auth, project, boot, trust, server, url: `http://127.0.0.1:${portOf(server)}`, fp: boot.relayClient!.fingerprint!.toLowerCase(), tg, posted, toasts, undelivered, down: false };
    sides.push(s);
    return s;
  }

  const call = async (s: Side, method: string, p: string, body?: unknown) => {
    const r = await fetch(`${s.url}${p}`, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.auth}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> };
  };

  const tap = (s: Side, data: string) => s.tg.onCallback({ callbackQueryId: `q-${Math.random()}`, data, fromUserId: OWNER, chatId: '-100', verified: true });
  const button = (s: Side, label: string) => {
    const m = [...s.posted].reverse().find((x) => x.buttons?.some((b) => b.text === label));
    expect(m, `${s.name} has a "${label}" button`).toBeDefined();
    return { topicId: m!.topicId, data: m!.buttons!.find((b) => b.text === label)!.data };
  };
  const texts = (s: Side, topicId?: number) => s.posted.filter((m) => topicId === undefined || m.topicId === topicId).map((m) => m.text);

  /** A makes an invite through its route, the agent posts it in topic `aTopic`; the owner forwards it into B's topic `bTopic`. */
  async function inviteAndForward(A: Side, B: Side, aTopic: number, bTopic: number) {
    const made = await call(A, 'POST', '/threadline/pairing/invites', {});
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    const message = made.body.message as string;
    await A.tg.noteOutboundInvite(message, aTopic); // what /telegram/reply does after posting it
    await B.tg.onForwardedInvite({ text: `Fwd: ${message}`, topicId: bTopic, fromUserId: OWNER, verified: true });
    return { iid: made.body.iid as string, message };
  }

  beforeAll(async () => {
    relayData = createTempProject();
    relay = new RelayServer({
      port: 0, registryDataDir: relayData.stateDir,
      rateLimitConfig: { perAgentPerMinute: 1000, perAgentPerHour: 10000, perIPPerMinute: 10000, globalPerMinute: 50000, discoveryPerMinute: 100, authAttemptsPerMinute: 100 },
      abuseDetectorConfig: { sybilFirstHourLimit: 10000, sybilSecondHourLimit: 10000, spamUniqueRecipientsPerMinute: 10000 },
    });
    await relay.start();
    relayUrl = `ws://127.0.0.1:${relay.address!.port}/v1/connect`;
  }, 120_000);

  afterAll(async () => {
    for (const s of sides) {
      await s.server.stop(); s.trust.shutdown(); if (!s.down) await s.boot.shutdown(); s.project.cleanup();
    }
    await relay?.stop();
    relayData?.cleanup();
  });

  it('a POLLING agent (no lifeline, like PP): the Finish tap read by the real TelegramAdapter completes the pairing', async () => {
    // Luna's read of PP, 2026-10-21 13:27 PDT: 1.3.1384, no lifeline, armedBy no-lifeline-ingress.
    // Pairing used to drop the buttons whenever the server polled Telegram itself.
    const guardDir = createTempProject();
    const guard = new LifelineIngressGuard({
      stateDir: guardDir.stateDir, explicitEnforce: () => undefined, bypass: () => false,
      raiseAttention: () => undefined, config: { developmentAgent: false }, lifelineIsIngress: () => false,
      writeRestartSignal: () => true, reportDegradation: () => {}, log: () => {}, bootNudgeDelayMs: null,
    });
    const adapterDir = createTempProject();
    try {
      const adapter = new TelegramAdapter({ token: '', chatId: '-100', authorizedUserIds: [OWNER] } as never, adapterDir.stateDir);
      const A = await bootSide('pp-polling', 4107, CALM, () => guard.tapsProvable() && adapter.hasPairingHandler());
      adapter.setPairingHandler(A.tg); // what routes.ts does
      const B = await bootSide('echo-dev3', 4108);
      await inviteAndForward(A, B, 100, 110);
      await tap(B, button(B, 'Approve').data);
      await vi.waitFor(() => expect(texts(A, 100).some((t) => t.includes('accepted your pairing invite'))).toBe(true), { timeout: 30_000 });
      const fin = button(A, 'Finish');
      const proc = (adapter as unknown as { processUpdate(u: unknown): Promise<void> }).processUpdate.bind(adapter);
      // Someone else in the group taps first: refused, nothing changes.
      await proc({ update_id: 1, callback_query: { id: 'cq-other', data: fin.data, from: { id: 555, first_name: 'X' }, message: { message_id: 1, chat: { id: -100, type: 'supergroup' } } } });
      expect(A.boot.trustManager!.isCredentialShareAllowedByFingerprint(B.fp)).toBe(false);
      // The owner's tap, read from Telegram by the polling adapter:
      await proc({ update_id: 2, callback_query: { id: 'cq-owner', data: fin.data, from: { id: OWNER, first_name: 'Justin' }, message: { message_id: 1, chat: { id: -100, type: 'supergroup' } } } });
      await vi.waitFor(() => {
        expect(texts(A, 100)).toContain('Connected ✓ "echo-dev3" and I are paired, and we\'ve each checked we can message the other privately.');
        expect(texts(B, 110)).toContain('Connected ✓ "pp-polling" and I are paired, and we\'ve each checked we can message the other privately.');
      }, { timeout: 30_000 });
    } finally {
      guard.flush();
      guardDir.cleanup();
      adapterDir.cleanup();
    }
  }, 120_000);

  it('a new agent whose listener never proved itself: the Finish prompt says WHY there is no button, with its version', async () => {
    // Justin's second PP test, 2026-10-21 12:57 PDT: still "go to the dashboard", and nobody could
    // tell which cause without access to PP's machine. The prompt now names the cause.
    const guardDir = createTempProject();
    const guard = new LifelineIngressGuard({
      stateDir: guardDir.stateDir, explicitEnforce: () => undefined, bypass: () => false,
      raiseAttention: () => undefined, config: { developmentAgent: false }, lifelineIsIngress: () => true,
      writeRestartSignal: () => true, reportDegradation: () => {}, log: () => {}, bootNudgeDelayMs: null,
    });
    try {
      const A = await bootSide('pp-unproven', 4105, CALM, () => guard.tapsProvable(),
        () => { const w = guard.tapsUnprovableReason(); return w ? `${w} (Instar 9.9.9)` : null; });
      const B = await bootSide('echo-dev2', 4106);
      await inviteAndForward(A, B, 80, 90);
      await tap(B, button(B, 'Approve').data);
      await vi.waitFor(() => expect(texts(A, 80).some((t) => t.includes('accepted your pairing invite'))).toBe(true), { timeout: 30_000 });
      const prompt = texts(A, 80).find((t) => t.includes('accepted your pairing invite'))!;
      expect(prompt).toMatch(/because its Telegram listener has not yet proven itself/);
      expect(prompt).toContain('(Instar 9.9.9)');
      expect(A.posted.find((m) => m.text === prompt)?.buttons).toBeUndefined();
    } finally {
      guard.flush();
      guardDir.cleanup();
    }
  }, 120_000);

  it('a NEW agent (fleet, guard still in observe) gets the Finish BUTTON once its lifeline has proven itself — never "go to the dashboard"', async () => {
    // Justin's PP test, 2026-10-21: PP is a normal new agent, so its lifeline guard was in observe
    // and its Finish prompt said "Open the Threadline tab on the dashboard". routes.ts now asks the
    // guard tapsProvable(); this wires a REAL guard the same way.
    const guardDir = createTempProject();
    const guard = new LifelineIngressGuard({
      stateDir: guardDir.stateDir, explicitEnforce: () => undefined, bypass: () => false,
      raiseAttention: () => undefined, config: { developmentAgent: false }, lifelineIsIngress: () => true,
      writeRestartSignal: () => true, reportDegradation: () => {}, log: () => {}, bootNudgeDelayMs: null,
    });
    guard.evaluate({ [LIFELINE_SECRET_HEADER]: ensureLifelineIngressSecret(guardDir.stateDir) }, 'lifeline-proof');
    expect(guard.mode()).toBe('observe');
    try {
      const A = await bootSide('pp-new', 4103, CALM, () => guard.tapsProvable());
      const B = await bootSide('echo-dev', 4104);
      await inviteAndForward(A, B, 60, 70);
      await tap(B, button(B, 'Approve').data);
      await vi.waitFor(() => expect(texts(A, 60).some((t) => t.includes('accepted your pairing invite'))).toBe(true), { timeout: 30_000 });
      expect(texts(A, 60).some((t) => t.includes('dashboard'))).toBe(false);
      const fin = button(A, 'Finish');
      // A tap that did not come through the lifeline is still refused, and changes nothing.
      await A.tg.onCallback({ callbackQueryId: 'q-unproven', data: fin.data, fromUserId: OWNER, chatId: '-100', verified: false });
      expect(A.toasts.at(-1)).toMatch(/did not come through/);
      expect(A.boot.trustManager!.isCredentialShareAllowedByFingerprint(B.fp)).toBe(false);
      await tap(A, fin.data);
      await vi.waitFor(() => {
        expect(texts(A, 60)).toContain('Connected ✓ "echo-dev" and I are paired, and we\'ve each checked we can message the other privately.');
        expect(texts(B, 70)).toContain('Connected ✓ "pp-new" and I are paired, and we\'ve each checked we can message the other privately.');
      }, { timeout: 30_000 });
    } finally {
      guard.flush();
      guardDir.cleanup();
    }
  }, 120_000);

  it('Approve → an immediate "finishing" message → Finish → both sides "Connected ✓" only after the hello', async () => {
    const A = await bootSide('pp', 4091);
    const B = await bootSide('echo', 4092);
    const { iid } = await inviteAndForward(A, B, 40, 50);
    expect(texts(A, 40)).toContain(OWN_AGENT_PROMPT); // offered, not tapped here

    await tap(B, button(B, 'Approve').data);
    // At once, before anything comes back from the other agent:
    expect(B.toasts[0]).toMatch(/^Approved\. Finishing the connection/);
    expect(texts(B, 50)).toContain('Approved — finishing the connection with "pp" and checking we can talk…');

    // The Finish prompt reaches the topic where PP posted the invite (not Lifeline), and Echo hears PP got it.
    await vi.waitFor(() => expect(texts(A, 40).some((t) => t.includes('accepted your pairing invite'))).toBe(true), { timeout: 30_000 });
    await vi.waitFor(() => expect(texts(B, 50)).toContain('"pp" got my approval and is asking its person to finish. I\'ll tell you when it\'s done.'), { timeout: 30_000 });
    expect(texts(B).some((t) => t.startsWith('Connected'))).toBe(false);

    await tap(A, button(A, 'Finish').data);
    expect(texts(A, 40)).toContain('Finishing — checking we can talk with "echo"…');
    await vi.waitFor(() => {
      expect(texts(A, 40)).toContain('Connected ✓ "echo" and I are paired, and we\'ve each checked we can message the other privately.');
      expect(texts(B, 50)).toContain('Connected ✓ "pp" and I are paired, and we\'ve each checked we can message the other privately.');
    }, { timeout: 30_000 });
    expect(texts(B, 50)).toContain('"pp" finished its side. Checking we can talk…');
    expect(A.boot.trustManager!.isCredentialShareAllowedByFingerprint(B.fp)).toBe(true);
    expect(B.boot.trustManager!.isCredentialShareAllowedByFingerprint(A.fp)).toBe(true);
    // Nothing went to Lifeline, nothing was undeliverable, and no timeout fired afterwards (resends
    // stop once answered: a few seconds past the last scheduled one, still nothing).
    await new Promise((r) => setTimeout(r, 7_000));
    expect(texts(A, 1)).toEqual([]);
    expect(texts(B, 1)).toEqual([]);
    expect([...A.undelivered, ...B.undelivered]).toEqual([]);
    expect([...texts(A), ...texts(B)].some((t) => /hasn't answered/.test(t))).toBe(false);
    // The dashboard view shows the completed handshake on both sides.
    const view = await call(A, 'GET', '/threadline/pairing/invites');
    expect((view.body.handshake as Array<{ iid: string; paired: boolean }>).find((h) => h.iid === iid)).toMatchObject({ paired: true });
  }, 120_000);

  it('a refusal reaches BOTH people in plain words (the inviter cancelled the invite)', async () => {
    const A = await bootSide('scout', 4093);
    const B = await bootSide('carl', 4094);
    const { iid } = await inviteAndForward(A, B, 41, 51);
    expect((await call(A, 'DELETE', `/threadline/pairing/invites/${iid}`)).status).toBe(200);
    await tap(B, button(B, 'Approve').data);
    await vi.waitFor(() => {
      expect(texts(B, 51)).toContain('"scout" turned down my approval: its person cancelled that invite. Nothing was paired.');
      expect(texts(A, 41)).toContain('An agent that calls itself "carl" tried to use your invite, and I turned it down: you cancelled that invite. I told it why.');
    }, { timeout: 30_000 });
    // Echo's side stops: no "hasn't answered" afterwards.
    await new Promise((r) => setTimeout(r, 7_000));
    expect(texts(B).some((t) => /hasn't answered/.test(t))).toBe(false);
    expect(B.boot.trustManager!.isCredentialShareAllowedByFingerprint(A.fp)).toBe(false);
  }, 120_000);

  it('"Not them" on the inviter: the acceptor is told too', async () => {
    const A = await bootSide('vega', 4095);
    const B = await bootSide('lyra', 4096);
    await inviteAndForward(A, B, 42, 52);
    await tap(B, button(B, 'Approve').data);
    await vi.waitFor(() => expect(texts(A, 42).some((t) => t.includes('accepted your pairing invite'))).toBe(true), { timeout: 30_000 });
    await tap(A, button(A, 'Not them').data);
    await vi.waitFor(() => expect(texts(B, 52)).toContain('"vega" turned down my approval: its person said I\'m not the agent they meant. Nothing was paired.'), { timeout: 30_000 });
  }, 120_000);

  it('timeouts are told: the inviter is gone → the acceptor hears "no answer"; the acceptor is gone after Finish → the inviter hears "no test message"', async () => {
    // (1) Acceptor left waiting.
    const A = await bootSide('orion', 4097, FAST);
    const B = await bootSide('nova', 4098, FAST);
    await inviteAndForward(A, B, 43, 53);
    await A.boot.shutdown(); A.down = true; // PP goes away after making the invite
    await tap(B, button(B, 'Approve').data);
    await vi.waitFor(() => expect(texts(B, 53)).toContain('"orion" hasn\'t answered my approval in 5 minutes, so nothing is paired yet. It may be offline. If it answers later I\'ll tell you; if not, ask its person to check it is running and send a new invite.'), { timeout: 30_000 });

    // (2) Inviter left waiting after its Finish.
    const C = await bootSide('atlas', 4099, FAST);
    const D = await bootSide('rhea', 4100, CALM);
    await inviteAndForward(C, D, 44, 54);
    await tap(D, button(D, 'Approve').data);
    await vi.waitFor(() => expect(texts(C, 44).some((t) => t.includes('accepted your pairing invite'))).toBe(true), { timeout: 30_000 });
    await D.boot.shutdown(); D.down = true;
    await tap(C, button(C, 'Finish').data);
    await vi.waitFor(() => expect(texts(C, 44)).toContain('"rhea" and I are paired, but it hasn\'t answered my test message in 5 minutes, so I can\'t confirm we can talk yet. I\'ll tell you if it answers.'), { timeout: 30_000 });
    expect(texts(C).some((t) => t.startsWith('Connected'))).toBe(false);
  }, 180_000);

  it('same owner: "It\'s one of my agents" → Approve on the other agent is the only tap left; both say "Connected ✓"', async () => {
    const A = await bootSide('pp2', 4101);
    const B = await bootSide('luna', 4102);
    await inviteAndForward(A, B, 45, 55);
    await tap(A, button(A, 'It\'s one of my agents').data);
    await tap(B, button(B, 'Approve').data);
    await vi.waitFor(() => {
      expect(texts(A, 45).some((t) => t.startsWith('"luna" accepted your invite. You said it\'s one of your own agents'))).toBe(true);
      expect(texts(A, 45)).toContain('Connected ✓ "luna" and I are paired, and we\'ve each checked we can message the other privately.');
      expect(texts(B, 55)).toContain('Connected ✓ "pp2" and I are paired, and we\'ve each checked we can message the other privately.');
    }, { timeout: 30_000 });
    expect(texts(A).some((t) => t.includes('accepted your pairing invite. Finish only'))).toBe(false); // no Finish prompt
    expect(texts(B, 55)).toContain('"pp2" got my approval and is finishing now.');
  }, 120_000);
});
