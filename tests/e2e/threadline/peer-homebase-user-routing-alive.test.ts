/**
 * Feature-alive / wiring integrity — peer-conversation-homebase-topic §2.6.
 *
 * Guards the dead-code failure mode this feature already had once: the homebase was recorded
 * but nothing READ it at delivery time. Asserts against the real boot source that the resolver
 * is constructed and reaches every delivery point, that both pairing sides create a homebase,
 * and then runs the real objects end to end.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makePeerUserTopicResolver } from '../../../src/threadline/peerHomebase.js';
import { PeerHomebaseRelay } from '../../../src/threadline/peerHomebaseRelay.js';
import { SalienceGate } from '../../../src/threadline/SalienceGate.js';
import { buildPeerUserMeantJudge } from '../../../src/threadline/PeerUserMeantJudge.js';
import os from 'node:os';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import type { IntelligenceProvider } from '../../../src/core/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => fs.readFileSync(path.resolve(__dirname, p), 'utf-8');
const serverSrc = read('../../../src/commands/server.ts');
const routesSrc = read('../../../src/server/routes.ts');
const agentServerSrc = read('../../../src/server/AgentServer.ts');

describe('§2.6 user-meant peer messages land in the homebase — wiring', () => {
  it('boot builds ONE resolver over the live trust store and the relay over it', () => {
    expect(serverSrc).toMatch(/const peerUserTopic = makePeerUserTopicResolver\(\{/);
    expect(serverSrc).toMatch(/new PeerHomebaseRelay\(\{\s*resolve: peerUserTopic/);
    // The late-bound trust read is actually assigned (not left null forever).
    // Fingerprint only — a display-name lookup would let a stranger post into a peer's topic.
    expect(serverSrc).toMatch(/_peerProfileFor = \(fp\) => tm\.getProfileByFingerprint\(fp\);/);
  });

  it('the resolver reaches the topic-linked reply path and the spawn prompt', () => {
    const i = serverSrc.indexOf('resolveUserTopic: (q) =>');
    expect(i).toBeGreaterThan(serverSrc.indexOf('new TopicLinkageHandler({'));
    expect(serverSrc).toMatch(/threadlineRouter\.setPeerUserTopicResolver\(/);
  });

  it('the relay is invoked at every inbound seam, with the silent hub as its fallback', () => {
    const relaySeam = serverSrc.indexOf('peerHomebaseRelay.relayInbound({');
    expect(relaySeam).toBeGreaterThan(0);
    // The hub surface is the fallback the relay chains to when it does not post.
    const hubDef = serverSrc.lastIndexOf('const hubSurface = () => {', relaySeam);
    expect(hubDef).toBeGreaterThan(0);
    expect(serverSrc.slice(hubDef, relaySeam)).toMatch(/collaborationSurfacer\??\.surface\(\{/);
    const routeIdx = routesSrc.indexOf("router.post('/messages/relay-agent'");
    expect(routesSrc.indexOf('ctx.peerHomebaseRelay.relayInbound({')).toBeGreaterThan(routeIdx);
    // The signed-HTTP receive path is wired too, keyed on the verified fingerprint.
    expect(routesSrc).toMatch(/peerHomebaseRelay: ctx\.peerHomebaseRelay,\s*conversationBound:/);
    expect(read('../../../src/threadline/ThreadlineEndpoints.ts')).toMatch(/config\.peerHomebaseRelay\.relayInbound\(\{[\s\S]{0,80}peers: \[hbFp\]/);
    // A message the relay does not post still reaches the hub.
    expect(serverSrc).toMatch(/\.then\(\(r\) => \{ if \(!r\.posted\) hubSurface\(\); \}/);
    expect(agentServerSrc).toMatch(/peerHomebaseRelay: options\.peerHomebaseRelay/);
    expect(serverSrc).toMatch(/collaborationSurfacer, peerHomebaseRelay, threadResumeMap/);
  });

  it('BOTH pairing sides create a homebase at mutual-verified (inviter finishing, acceptor finish-received)', () => {
    const i = serverSrc.indexOf("threadline.pairingInvites?.events.on('notice'");
    expect(i).toBeGreaterThan(0);
    const block = serverSrc.slice(i, i + 500);
    expect(block).toContain("'finishing'");
    expect(block).toContain("'finish-received'");
    expect(block).toContain('ensureFor(n.peerFp)');
  });

  it('is alive end to end: a mutual-verified peer message is posted to its homebase', async () => {
    const sent: Array<[number, string]> = [];
    const resolve = makePeerUserTopicResolver({
      enabled: () => true,
      profileFor: (p) => (p === 'fp-scout' ? { pairingState: 'mutual-verified', homebaseTopicId: 4242, fingerprint: 'fp-scout' } : null),
      conversationFor: () => null,
    });
    const relay = new PeerHomebaseRelay({ resolve, salienceGate: new SalienceGate(), sendToTopic: async (t, x) => { sent.push([t, x]); } });
    const r = await relay.relayInbound({ threadId: 'th', peers: ['fp-scout', 'scout'], senderName: 'scout', text: 'Hi Justin, the report is ready.' });
    expect(r).toEqual({ posted: true, topicId: 4242 });
    expect(sent[0][0]).toBe(4242);
    expect(vi).toBeDefined();
  });
});

describe('§2.7 every user-meant message is judged — wiring', () => {
  it('boot builds the judge (Codex then the shared provider as referees) and hands it to the relay', () => {
    expect(serverSrc).toMatch(/peerUserMeantJudge = buildPeerUserMeantJudge\(\{/);
    expect(serverSrc).toMatch(/readPeerHomebaseBlock: \(\) => liveConfig\.get<unknown>\('threadline\.peerHomebase', undefined\)/);
    expect(serverSrc).toMatch(/name: 'codex', provider: userMeantCodex[\s\S]{0,120}name: 'shared', provider: sharedIntelligence/);
    expect(serverSrc).toMatch(/new PeerHomebaseRelay\(\{[\s\S]{0,200}userMeantJudge: peerUserMeantJudge,/);
  });

  it('the topic-linked redirect and the spawn prompt are wired to it', () => {
    const tlh = serverSrc.indexOf('new TopicLinkageHandler({');
    expect(serverSrc.indexOf('judgeUserMeant: async (q) =>')).toBeGreaterThan(tlh);
    expect(serverSrc).toMatch(/setPeerUserTopicResolver\([\s\S]{0,200}serverPostsUserMeant: \(threadId\) =>/);
    // The relay seam passes the wire type, so protocol traffic is excluded by type.
    expect(serverSrc).toMatch(/messageType: typeof msgType === 'string' \? msgType : null/);
  });

  it('is alive end to end through the production factory: a later message is posted, an internal one is not', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-pm-e2e-'));
    try {
      const shared = { evaluate: async (p: string) => (/approve/.test((p.split('<<<TEXT')[1] ?? '').split('TEXT>>>')[0]) ? '{"user_meant": true}' : '{"user_meant": false}') } as unknown as IntelligenceProvider;
      const judge = buildPeerUserMeantJudge({
        readPeerHomebaseBlock: () => undefined, // omitted ⇒ on
        readSecret: () => null, // no Jev key: the single-provider path
        referees: () => [{ name: 'shared', provider: shared }],
        stateDir: path.join(dir, '.instar'),
      });
      expect(judge.enabled()).toBe(true);
      const sent: number[] = [];
      let now = 1_000_000;
      const relay = new PeerHomebaseRelay({
        resolve: () => ({ topicId: 4242, via: 'homebase' }),
        salienceGate: new SalienceGate(),
        userMeantJudge: judge,
        sendToTopic: async (t) => { sent.push(t); },
        now: () => now,
      });
      await relay.relayInbound({ threadId: 'th', peers: ['fp-scout'], senderName: 'scout', text: 'Report is ready.' });
      now += 1000;
      expect(await relay.relayInbound({ threadId: 'th', peers: ['fp-scout'], senderName: 'scout', text: 'Justin, please approve the spend.' })).toEqual({ posted: true, topicId: 4242 });
      expect(await relay.relayInbound({ threadId: 'th2', peers: ['fp-scout'], senderName: 'scout', text: 'x', messageType: 'ack' })).toMatchObject({ posted: false });
      expect(sent.filter((t) => t === 4242).length).toBeGreaterThanOrEqual(1);
      expect(fs.existsSync(path.join(dir, 'logs', 'peer-user-meant.jsonl'))).toBe(true);
      // Kill switch: explicit false restores first-only.
      const off = buildPeerUserMeantJudge({ readPeerHomebaseBlock: () => ({ perMessageClassification: false }), readSecret: () => null, referees: () => [], stateDir: path.join(dir, '.instar') });
      expect(off.enabled()).toBe(false);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/threadline/peer-homebase-user-routing-alive.test.ts' });
    }
  });
});
