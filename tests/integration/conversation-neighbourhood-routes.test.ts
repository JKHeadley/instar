/**
 * HTTP pipeline for the conversation neighbourhood (docs/specs/work-front-doors.md §4.3) over the
 * real route module, the real derive/render and the real live-source adapter (neighbourhoodSources)
 * fed by a real WorkBoardService-shaped board and a Chief of Staff-shaped loop:
 *   - the bearer reads any conversation; 400 on a missing or malformed key; 503 while off;
 *   - a session token reads ONLY its own conversation; naming another is 403;
 *   - a phone or browser principal is refused (it is the agent's read);
 *   - a team member who reads the conversation narrows what the agent is shown (both ends);
 *   - the per-prompt route carries a changed block once per session (rule 117), and a card change
 *     made through one read is reflected in a second session's next prompt.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerConversationNeighbourhoodRoutes } from '../../src/server/conversationNeighbourhoodRoutes.js';
import { neighbourhoodSources, type NeighbourhoodLiveDeps } from '../../src/server/neighbourhoodSources.js';
import { resolveCeilings, NeighbourhoodDeliveries, neighbourhoodPointer } from '../../src/core/RelationshipIndex.js';
import { createPromptContextRoutes } from '../../src/server/promptContextRoutes.js';
import { SeedFetchLog } from '../../src/monitoring/contextLayers/promptContext.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type Card = { cardId: string; created: boolean; redacted?: unknown; conversationKey: string; title: string; projectKey: string | null; source: { conversationKey: string } | null; waitingOn: unknown; carrier: unknown; status: string };

function world() {
  const cards = new Map<string, Card>();
  let hlc = 1;
  const add = (c: Partial<Card> & { cardId: string }) => { cards.set(c.cardId, { created: true, conversationKey: `${c.cardId}-conv`, title: c.cardId, projectKey: 'telegram:100', source: null, waitingOn: { personKey: 'justin' }, carrier: 'agent', status: 'waiting-on-person', ...c }); hlc++; };
  const shared: Record<string, string[]> = {};
  let teamOn = false;
  let enabled = true;
  let reach: 'owner' | 'shared' | 'unknown' = 'owner';
  let history: Array<Record<string, unknown>> = [];
  let briefingText = '';
  const live: NeighbourhoodLiveDeps = {
    graphModel: () => null,
    telegramChatId: () => '-1001',
    workBoard: () => ({
      svc: {
        cardIds: () => [...cards.keys()],
        view: (id) => { const c = cards.get(id); return c ? { status: c.status, card: c } : null; },
        newestHlc: () => ({ physical: hlc, logical: 0, node: 'm_self' }),
      },
      behind: () => null,
    }),
    chiefOfStaff: () => ({
      projectsOverview: () => [{ conversationKey: 'telegram:100', title: 'Instar task system' }],
      tree: () => new Map([['telegram:101', { conversationKey: 'telegram:101', parentConversationKey: 'telegram:100' }]]),
    }),
    commitments: () => ({ own: () => [{ id: 'CMT-7', status: 'pending', topicId: 100, agentResponse: 'Ship stage 2' }], replicas: () => [], selfId: 'm_self' }),
    pairing: () => ({
      teamOn: () => teamOn,
      teamLog: () => ({ healthState: () => 'ok', gaps: () => [], state: () => ({ people: new Map([['adriana', {}]]) }) }),
      teamPuller: null,
      teamStanding: (k) => (k === 'adriana' ? { name: 'Adriana', tier: 'member' } : null),
      devices: { list: () => [] },
      personOfDevice: () => ({ ok: false }),
      mayUse: (person, ref) => (person as { role?: string }).role === 'owner' || (shared[(person as { userId: string }).userId] ?? []).includes(ref),
    }),
    ownerPersonKey: () => 'justin',
    privacyReach: () => reach,
    displayName: (k) => (k === 'justin' ? 'Justin' : k),
  };

  const app = express();
  // Test principals: x-test-session=<placeKey> acts as a scoped session token; x-test-device marks a phone.
  app.use((req, res, next) => {
    const place = req.header('x-test-session');
    if (place) (res.locals as Record<string, unknown>).memorySession = { placeKey: place };
    if (req.header('x-test-device')) (req as unknown as { instarPrincipal: unknown }).instarPrincipal = { kind: 'device', deviceId: 'd1' };
    next();
  });
  const router = express.Router();
  let clock = 1_000_000;
  const blockFor = registerConversationNeighbourhoodRoutes(router, { enabled: () => enabled, sources: () => neighbourhoodSources(live), ceilings: () => resolveCeilings(undefined), now: () => clock });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nbh-int-'));
  const deliveries = new NeighbourhoodDeliveries();
  app.use(createPromptContextRoutes({
    stateDir: dir, shadowOn: () => false, deltaSwitchOn: () => false, canary: () => undefined,
    briefing: () => briefingText, messages: () => history, seedFetches: new SeedFetchLog(),
    neighbourhood: (topicId, sessionKey) => {
      const r = blockFor(`telegram:${topicId}`);
      const key = `${topicId}|${sessionKey}`;
      return r && r.block && deliveries.isNew(key, r.revision) ? { block: r.block, pointer: neighbourhoodPointer(`telegram:${topicId}`, r.revision), commit: () => deliveries.mark(key, r.revision) } : null;
    },
  }));
  app.use(router);
  return { app, add, cards, shared, setTeam: (v: boolean) => { teamOn = v; }, setEnabled: (v: boolean) => { enabled = v; },
    setReach: (v: typeof reach) => { reach = v; }, setHistory: (h: typeof history) => { history = h; }, setBriefing: (b: string) => { briefingText = b; }, tick: (ms: number) => { clock += ms; }, cleanup: () => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/conversation-neighbourhood-routes.test.ts' }) };
}

describe('GET /conversation-neighbourhood', () => {
  it('the bearer reads a conversation: project, open cards with whose turn, promises, source versions', async () => {
    const w = world();
    w.add({ cardId: 'wc_1', title: 'Pick a venue' });
    w.add({ cardId: 'wc_2', status: 'done' });
    const r = await request(w.app).get('/conversation-neighbourhood?conversation=telegram:101');
    expect(r.status).toBe(200);
    expect(r.body.schema).toBe('conversation-neighbourhood/1');
    expect(r.body.project).toEqual({ key: 'telegram:100', title: 'Instar task system', via: 'chief-of-staff' });
    expect(r.body.cards.items.map((c: { cardId: string; turn: string }) => [c.cardId, c.turn])).toEqual([['wc_1', 'Justin']]);
    expect(r.body.sourceVersions['work-board']).toMatch(/\.0\.m_self$/);
    expect(r.body.couldNotCheck).toEqual(['conversation graph (off)']);
    expect(r.body.complete).toBe(false);
    w.cleanup();
  });

  it('400 on a missing or malformed conversation; 503 while off', async () => {
    const w = world();
    expect((await request(w.app).get('/conversation-neighbourhood')).status).toBe(400);
    expect((await request(w.app).get('/conversation-neighbourhood?conversation=telegram:abc')).status).toBe(400);
    w.setEnabled(false);
    const off = await request(w.app).get('/conversation-neighbourhood?conversation=telegram:100');
    expect(off.status).toBe(503);
    expect(off.body.error).toBe('relationship-index-off');
    w.cleanup();
  });

  it('a session token reads its own conversation only', async () => {
    const w = world();
    const own = await request(w.app).get('/conversation-neighbourhood').set('x-test-session', 'telegram:topic:100');
    expect(own.status).toBe(200);
    expect(own.body.conversation).toBe('telegram:100');
    const other = await request(w.app).get('/conversation-neighbourhood?conversation=telegram:101').set('x-test-session', 'telegram:topic:100');
    expect(other.status).toBe(403);
    expect(other.body.error).toBe('own-conversation-only');
    const placeless = await request(w.app).get('/conversation-neighbourhood').set('x-test-session', 'system');
    expect(placeless.status).toBe(403);
    w.cleanup();
  });

  it('a phone is refused: this is the agent\'s read', async () => {
    const w = world();
    const r = await request(w.app).get('/conversation-neighbourhood?conversation=telegram:100').set('x-test-device', '1');
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('agent-read-only');
    w.cleanup();
  });

  it('a team member reading the conversation narrows the agent\'s view: no project name, no card she cannot read', async () => {
    const w = world();
    w.add({ cardId: 'wc_1' });
    w.add({ cardId: 'wc_2' });
    w.setTeam(true);
    w.shared.adriana = ['telegram:100', 'app:wc_2-conv'];
    const r = await request(w.app).get('/conversation-neighbourhood?conversation=telegram:100');
    expect(r.body.audience).toEqual({ kind: 'shared', readers: 2 });
    expect(r.body.project.title).toBeNull();
    expect(r.body.cards.items.map((c: { cardId: string }) => c.cardId)).toEqual(['wc_2']);
    w.cleanup();
  });
});

describe('second-pass fixes through the route', () => {
  it('someone else reading the conversation through memory privacy hides project names and cards', async () => {
    const w = world();
    w.add({ cardId: 'wc_1', title: 'Private plan' });
    w.setReach('shared');
    const r = await request(w.app).get('/conversation-neighbourhood?conversation=telegram:100');
    expect(r.body.audience.kind).toBe('shared');
    expect(r.body.project.title).toBeNull();
    expect(r.body.cards.items).toEqual([]);
    const block = (await request(w.app).get('/conversation-neighbourhood/session-context?topicId=100')).body.block as string;
    expect(block).not.toMatch(/Private plan|Instar task system/);
    w.cleanup();
  });

  it('an unknown memory-privacy audience shows nothing and says so', async () => {
    const w = world();
    w.setReach('unknown');
    const r = await request(w.app).get('/conversation-neighbourhood?conversation=telegram:100');
    expect(r.body.audience.kind).toBe('unresolved');
    expect(r.body.commitments.items).toEqual([]);
    w.cleanup();
  });

  it('a removed (redacted) card is gone, even from its own conversation', async () => {
    const w = world();
    w.add({ cardId: 'wc_1', title: 'Secret title', redacted: { by: { kind: 'person' }, at: 'x' }, status: 'removed' });
    const r = await request(w.app).get('/conversation-neighbourhood?conversation=app:wc_1-conv');
    expect(r.body.isCard).toBeNull();
    expect(JSON.stringify(r.body)).not.toMatch(/Secret title/);
    w.cleanup();
  });
});

describe('GET /conversation-neighbourhood/session-context', () => {
  it('returns the labelled block for a topic', async () => {
    const w = world();
    w.add({ cardId: 'wc_1', title: 'Pick a venue' });
    const r = await request(w.app).get('/conversation-neighbourhood/session-context?topicId=100');
    expect(r.status).toBe(200);
    expect(r.body.present).toBe(true);
    expect(r.body.block).toMatch(/^<conversation-neighbourhood src='relationship-index'/);
    expect(r.body.block).toMatch(/This conversation is in project "Instar task system"/);
    expect(r.body.block).toMatch(/1 open card, 1 waiting on Justin:/);
    w.cleanup();
  });
});

describe('per-prompt refresh for running sessions (rule 117)', () => {
  it('a changed neighbourhood rides the prompt once per session, and a change reaches a second running session', async () => {
    const w = world();
    const first = await request(w.app).get('/topic/100/prompt-context?session=sessA');
    expect(first.body.neighbourhood).toMatch(/conversation-neighbourhood/);
    const again = await request(w.app).get('/topic/100/prompt-context?session=sessA');
    expect(again.body.neighbourhood).toBe('');
    // Session B has its own delivery memory.
    expect((await request(w.app).get('/topic/100/prompt-context?session=sessB')).body.neighbourhood).toMatch(/conversation-neighbourhood/);
    expect((await request(w.app).get('/topic/100/prompt-context?session=sessB')).body.neighbourhood).toBe('');
    // A card made in session A's work changes the neighbourhood: both running sessions get it on their next prompt.
    w.add({ cardId: 'wc_9', title: 'Brand new card' });
    w.tick(6_000); // past the per-prompt reuse window
    const a = await request(w.app).get('/topic/100/prompt-context?session=sessA');
    const b = await request(w.app).get('/topic/100/prompt-context?session=sessB');
    expect(a.body.neighbourhood).toMatch(/Brand new card/);
    expect(b.body.neighbourhood).toMatch(/Brand new card/);
    w.cleanup();
  });

  it('a block too large for a crowded prompt becomes a one-line pointer; with no room at all it waits and is not recorded', async () => {
    const w = world();
    w.add({ cardId: 'wc_1', title: 'Pick a venue' });
    w.setBriefing('b'.repeat(8_050)); // room for a pointer, not for the block
    const crowded = await request(w.app).get('/topic/100/prompt-context?session=big');
    expect(crowded.body.neighbourhood).toMatch(/^<conversation-neighbourhood src='relationship-index' revision='[0-9a-f]+'>What this conversation is connected to changed/);
    expect(crowded.body.neighbourhood).not.toMatch(/Pick a venue/);
    expect((await request(w.app).get('/topic/100/prompt-context?session=big')).body.neighbourhood).toBe(''); // delivered once
    w.setBriefing('b'.repeat(8_300)); // no room even for the pointer
    expect((await request(w.app).get('/topic/100/prompt-context?session=full')).body.neighbourhood).toBe('');
    w.setBriefing('');
    // Not marked delivered while held back: offered again, intact, once there is room.
    expect((await request(w.app).get('/topic/100/prompt-context?session=full')).body.neighbourhood).toMatch(/Pick a venue/);
    w.cleanup();
  });

  it('while off, the prompt carries no block', async () => {
    const w = world();
    w.setEnabled(false);
    expect((await request(w.app).get('/topic/100/prompt-context?session=s')).body.neighbourhood).toBe('');
    w.cleanup();
  });
});
