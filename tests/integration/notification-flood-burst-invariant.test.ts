/**
 * NOTIFICATION-FLOOD BURST INVARIANT — the fundamental "features can't ship
 * a topic flood" test (docs/STANDARDS-REGISTRY.md "Bounded Notification
 * Surface").
 *
 * Born from the THIRD topic-spam incident (2026-06-05): a boot-time detector
 * mass-flagged 110 false positives, each with a UNIQUE sourceContext — which
 * dodged the per-source budget the 2026-05-28 lockdown added. Only the
 * global ceiling caught it, after 8 individual topics leaked.
 *
 * This test pins the invariant at the real pipeline with PRODUCTION-DEFAULT
 * budgets (not test-tuned ones): no matter how many notifications a feature
 * fires in a burst, and no matter how it varies its labels, the number of
 * forum topics actually created stays under a small constant. It applies to
 * every CURRENT and FUTURE caller automatically because it exercises the
 * chokepoints themselves:
 *
 *   Layer 1 — AttentionTopicGuard at createAttentionItem (the shaper).
 *   Layer 2 — topicCreationBudget INSIDE createForumTopic (the backstop —
 *             covers callers that never go through the attention path).
 *
 * If you arrived here because this test failed your build: your feature is
 * creating topics at volume. Aggregate your notifications (one summary item,
 * not one per element) — see AgentWorktreeDetector.runDetection for the
 * canonical pattern. Raising the budgets is almost never the right fix.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { TopicFloodBudgetError, DEFAULT_ATTENTION_TOPIC_GUARD } from '../../src/messaging/AttentionTopicGuard.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { formatDigest } from '../../src/monitoring/GrowthDigestPublisher.js';
import type { GrowthDigest, GrowthFinding } from '../../src/monitoring/GrowthMilestoneAnalyst.js';

interface Recorder {
  forumTopicsCreated: number;
  topicTitles: string[];
}

function installApiStub(adapter: TelegramAdapter): Recorder {
  const rec: Recorder = { forumTopicsCreated: 0, topicTitles: [] };
  let threadSeq = 5000;
  vi.spyOn(adapter as unknown as { apiCall: (m: string, p: Record<string, unknown>) => Promise<unknown> }, 'apiCall')
    .mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'createForumTopic') {
        rec.forumTopicsCreated++;
        rec.topicTitles.push(String(params.name ?? ''));
        return { message_thread_id: ++threadSeq, name: params.name };
      }
      if (method === 'sendMessage') {
        return { message_id: threadSeq * 10 + rec.forumTopicsCreated };
      }
      return { ok: true };
    });
  return rec;
}

describe('Notification-flood burst invariant (production-default budgets)', () => {
  let adapter: TelegramAdapter;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-burst-invariant-'));
    // DELIBERATELY no guard config — this test pins the SHIPPED defaults.
    adapter = new TelegramAdapter(
      { token: 'test-token-123', chatId: '-100123456', pollIntervalMs: 100 },
      tmpDir,
    );
  });

  afterEach(async () => {
    await adapter.stop();
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'burst-invariant cleanup' });
  });

  it('1,000 LOW attention items with UNIQUE sourceContexts (the 2026-06-05 dodge) create ≤ global-budget + 1 topics', async () => {
    const rec = installApiStub(adapter);

    const N = 1000;
    for (let i = 0; i < N; i++) {
      await adapter.createAttentionItem({
        id: `burst-${i}`,
        title: `synthetic notice ${i}`,
        summary: `burst item ${i}`,
        category: 'burst-test',
        priority: 'LOW',
        // Every item its own "source" — exactly how the worktree detector
        // dodged the per-source budget in the live incident.
        sourceContext: `/some/unique/path/${i}`,
      });
    }

    // The hard bound: the attention guard's GLOBAL ceiling worth of
    // individual topics, plus exactly ONE coalesced notice topic. With
    // shipped defaults that is 8 + 1 = 9 — never 1,000.
    const bound = DEFAULT_ATTENTION_TOPIC_GUARD.maxTopicsGlobal + 1;
    expect(rec.forumTopicsCreated).toBeLessThanOrEqual(bound);
    expect(rec.topicTitles.filter((t) => t.includes('coalesced')).length).toBe(1);

    // No item dropped: every one of the 1,000 is in the attention store.
    expect(adapter.getAttentionItems().filter((a) => a.category === 'burst-test').length).toBe(N);
  });

  it('BACKSTOP: with the attention guard disabled, the createForumTopic budget still bounds the flood', async () => {
    await adapter.stop();
    adapter = new TelegramAdapter(
      {
        token: 'test-token-123',
        chatId: '-100123456',
        pollIntervalMs: 100,
        // A mis-config (or a future feature bypassing the attention path
        // entirely). The chokepoint budget is the layer that must hold.
        attentionTopicGuard: { enabled: false },
      },
      tmpDir,
    );
    const rec = installApiStub(adapter);

    const N = 500;
    for (let i = 0; i < N; i++) {
      await adapter.createAttentionItem({
        id: `nofence-${i}`,
        title: `unfenced notice ${i}`,
        summary: `s`,
        category: 'burst-test',
        priority: 'LOW',
        sourceContext: `/unique/${i}`,
      });
    }

    // All attention-item topics share the 'attention-item' budget label —
    // shipped default 8 per label. No coalesce path here (guard disabled),
    // so the budget refuses the rest; items are still stored, topic-less.
    expect(rec.forumTopicsCreated).toBeLessThanOrEqual(12); // ≤ global ceiling
    expect(adapter.getAttentionItems().filter((a) => a.category === 'burst-test').length).toBe(N);
  });

  it('BACKSTOP: 1,000 raw createForumTopic calls from a hypothetical future feature are bounded and fail loudly', async () => {
    const rec = installApiStub(adapter);

    let refused = 0;
    for (let i = 0; i < 1000; i++) {
      try {
        // No origin declared — the default ('auto') must be the budgeted one,
        // so a feature that never heard of the budget is still bounded.
        await adapter.createForumTopic(`runaway feature topic ${i}`);
      } catch (err) {
        expect(err).toBeInstanceOf(TopicFloodBudgetError);
        refused++;
      }
    }

    expect(rec.forumTopicsCreated).toBeLessThanOrEqual(8); // per-label default
    expect(refused).toBeGreaterThanOrEqual(992);
  });

  it('label variation does NOT dodge the backstop (global ceiling)', async () => {
    const rec = installApiStub(adapter);

    let refused = 0;
    for (let i = 0; i < 200; i++) {
      try {
        // Unique label per call — the per-label budget never trips, the
        // global ceiling must.
        await adapter.createForumTopic(`varied ${i}`, undefined, { label: `feature-${i}` });
      } catch (err) {
        expect(err).toBeInstanceOf(TopicFloodBudgetError);
        refused++;
      }
    }

    expect(rec.forumTopicsCreated).toBeLessThanOrEqual(12); // global default
    expect(refused).toBeGreaterThanOrEqual(188);
  });

  it('user-initiated and system topics are exempt (humans and create-once infra are self-bounded)', async () => {
    const rec = installApiStub(adapter);

    for (let i = 0; i < 30; i++) {
      await adapter.createForumTopic(`user topic ${i}`, undefined, { origin: 'user' });
    }
    for (let i = 0; i < 30; i++) {
      await adapter.createForumTopic(`system topic ${i}`, undefined, { origin: 'system' });
    }

    expect(rec.forumTopicsCreated).toBe(60); // none refused
  });

  it('HIGH/URGENT attention items always get their own topic even mid-flood (critical never coalesced, never budget-refused)', async () => {
    const rec = installApiStub(adapter);

    // Saturate both layers with LOW noise.
    for (let i = 0; i < 50; i++) {
      await adapter.createAttentionItem({
        id: `noise-${i}`, title: `noise ${i}`, summary: 's',
        category: 'burst-test', priority: 'LOW', sourceContext: `/n/${i}`,
      });
    }
    const before = rec.forumTopicsCreated;

    const urgent = await adapter.createAttentionItem({
      id: 'the-real-emergency',
      title: 'disk is on fire',
      summary: 'act now',
      category: 'burst-test',
      priority: 'URGENT',
      sourceContext: '/n/0',
    });

    expect(rec.forumTopicsCreated).toBe(before + 1); // its own topic, no refusal
    expect(urgent.topicId).toBeDefined();
    expect(urgent.coalesced).not.toBe(true);
  });
});

// ── Growth digest — aggregation invariant ─────────────────────────────────────
//
// The GrowthDigestPublisher is exactly the "feature that notifies per-element over
// a collection" the Bounded Notification Surface standard targets. It MUST
// aggregate: ONE message for a 500-finding burst, never one-per-finding (and it
// has no per-element topic path at all — it sends ONE message into the existing
// Updates topic). This pins the render-level invariant that protects the bound.

describe('Growth digest aggregation invariant (500 findings → one bounded message)', () => {
  function finding(rule: GrowthFinding['rule'], priority: GrowthFinding['priority'], i: number): GrowthFinding {
    return { rule, priority, subjectId: `${rule}-${i}`, title: `${rule} item ${i}`, detail: 'No movement.', suggestedAction: 'review' };
  }
  function burstDigest(): GrowthDigest {
    const bulk = Array.from({ length: 500 }, (_, i) => finding('R3', 'low', i));
    const high = finding('R3', 'high', 9999);
    high.title = 'CRITICAL — decide now';
    return {
      generatedAt: '2026-06-08T11:00:00.000Z',
      calm: false,
      summary: 'Growth digest: 501 stalling.',
      findings: [...bulk, high],
      counts: { incubating: 0, promotionReady: 0, expiredUnproven: 0, stalling: 501, specPatterns: 0, correctionPatterns: 0, devGateDark: 0 },
    };
  }

  it('renders exactly ONE message, ≤4096 chars, with the high-priority finding never truncated', () => {
    const text = formatDigest(burstDigest());
    // ONE message (a single string — not an array/stream of per-finding messages).
    expect(typeof text).toBe('string');
    expect(text.length).toBeLessThanOrEqual(4096);
    // The bulk overflowed into a "+N more" summary line, never a wall of 500.
    expect(text).toContain('more (see full digest)');
    // The high-priority finding is rendered in full despite the burst.
    expect(text).toContain('CRITICAL — decide now');
  });
});

// ── Standard C — alerts-topic routing DEFAULT (three-standards-enforcement) ────
//
// Standard C makes hub-routing the RULE for a topic-less notice, not a lucky
// side-effect of the flood-guard. The burst tests above prove the flood BOUND;
// this table-driven contract test proves the ROUTING RULE at the adapter/funnel
// boundary — one extended burst test can miss direct adapter calls / legacy
// paths / future notice sources, so we assert the enumerated routing cases
// directly (spec §Standard C, round-5 external finding):
//   • topic-less non-critical housekeeping → the ONE hub topic (from the FIRST
//     item, never one-per-item)
//   • HIGH / URGENT → its OWN individual topic (critical carve-out preserved)
//   • an existing-owning-topic send → that topic, minting NO new topic
//   • a misconfigured / unresolvable hub → a SAFE fallback (item still stored,
//     never a silent per-item new-topic mint)
// Ship criterion (no-miscite): hub routing covers ONLY non-critical topic-less
// notices — it is NEVER cited as critical-alert reachability (that guarantee is
// the pooled attention queue's read, and the deferred unified push stream's).
describe('Standard C — topic-less notice routing default (contract, adapter boundary)', () => {
  let adapter: TelegramAdapter;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-routing-contract-'));
    // Shipped defaults — the agent-health hub lane is on by default.
    adapter = new TelegramAdapter(
      { token: 'test-token-123', chatId: '-100123456', pollIntervalMs: 100 },
      tmpDir,
    );
  });

  afterEach(async () => {
    await adapter.stop();
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'routing-contract cleanup' });
  });

  it('topic-less non-critical housekeeping burst → the ONE hub topic (from the first item, never one-per-item)', async () => {
    const rec = installApiStub(adapter);
    const N = 200;
    for (let i = 0; i < N; i++) {
      // A topic-less housekeeping notice: no owning conversation, opted into the
      // agent-health hub lane, each with a UNIQUE key (so none is dedup-suppressed).
      await adapter.createAttentionItem({
        id: `health-${i}`,
        title: `session ${i} looks quiet`,
        summary: 'routine self-health notice',
        category: 'agent-health',
        priority: 'LOW',
        lane: 'agent-health',
        sourceContext: `/health/unique/${i}`,
      });
    }
    // The RULE: exactly ONE hub topic for the whole burst — never N topics, and
    // never even the budgeted 8. Every item is still recorded (no drops).
    expect(rec.forumTopicsCreated).toBe(1);
    expect(adapter.getAttentionItems().filter((a) => a.category === 'agent-health').length).toBe(N);
    // All routed items are marked coalesced (hub-routed, not per-item topics).
    expect(adapter.getAttentionItems().filter((a) => a.lane === 'agent-health').every((a) => a.coalesced === true)).toBe(true);
  });

  it('HIGH / URGENT topic-less notices keep their OWN individual topic (critical carve-out preserved)', async () => {
    const rec = installApiStub(adapter);
    // Even a critical item that opts into the housekeeping lane must NOT be
    // muffled into the hub — but here we use the standard attention path: each
    // critical item gets its own topic.
    for (const priority of ['HIGH', 'URGENT'] as const) {
      const before = rec.forumTopicsCreated;
      const item = await adapter.createAttentionItem({
        id: `crit-${priority}`,
        title: `critical ${priority}`,
        summary: 'act now',
        category: 'burst-test',
        priority,
        sourceContext: `/crit/${priority}`,
      });
      expect(rec.forumTopicsCreated).toBe(before + 1); // its OWN topic
      expect(item.coalesced).not.toBe(true);
      expect(item.topicId).toBeDefined();
    }
  });

  it('a send to an EXISTING owning topic mints NO new topic', async () => {
    const rec = installApiStub(adapter);
    // A notice that already belongs to a conversation topic routes THERE — the
    // funnel never mints a fresh topic for an owned notice.
    await (adapter as unknown as { sendToTopic: (id: number, text: string) => Promise<unknown> })
      .sendToTopic(4242, 'a reply on an existing owning topic');
    expect(rec.forumTopicsCreated).toBe(0);
  });

  it('a misconfigured / unresolvable hub falls back SAFELY — item stored, no silent per-item topic mint', async () => {
    // Force hub-topic creation to fail: the lane catches it, the item is still
    // recorded, and NO per-item topic is minted (never a silent new-topic-per-notice).
    const rec: Recorder = { forumTopicsCreated: 0, topicTitles: [] };
    vi.spyOn(adapter as unknown as { apiCall: (m: string, p: Record<string, unknown>) => Promise<unknown> }, 'apiCall')
      .mockImplementation(async (method: string, params: Record<string, unknown>) => {
        if (method === 'createForumTopic') {
          throw new Error('simulated: hub topic unresolvable');
        }
        if (method === 'sendMessage') return { message_id: 1 };
        return { ok: true };
      });
    const item = await adapter.createAttentionItem({
      id: 'health-unresolvable',
      title: 'session looks quiet',
      summary: 'routine notice while hub is unresolvable',
      category: 'agent-health',
      priority: 'LOW',
      lane: 'agent-health',
      sourceContext: '/health/unresolvable',
    });
    // No topic minted (the create attempt threw), and the item is NOT lost.
    expect(rec.forumTopicsCreated).toBe(0);
    expect(adapter.getAttentionItems().some((a) => a.id === 'health-unresolvable')).toBe(true);
    expect(item.coalesced).toBe(true); // routed via the hub lane, not a per-item topic
  });

  it('the hub topic id is resolved from config/state, NEVER a baked-in universal constant', () => {
    // Standard C binding-semantics: the hub id (this agent: 7848) is an EXAMPLE,
    // per-agent value — a hard-coded universal constant would be wrong on every
    // other agent/machine (the hub is physical-credential-locality). Guard against
    // regressions that bake a literal id into the routing source.
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'messaging', 'TelegramAdapter.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/\b7848\b/);
  });
});
