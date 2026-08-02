/**
 * Unit tests for TopicIntentBriefing — Layer 2 rendering.
 *
 * Covers:
 *   - Empty briefing when no refs at tentative or above
 *   - Authoritative items listed unhedged in SETTLED section
 *   - Tentative items listed with hedge + confidence in TENTATIVE section
 *   - Observation tier NOT surfaced
 *   - Pending confirmation surfaced when outstanding
 *   - maxPerSection truncates with overflow note
 *   - Sort order is by confidence descending
 *   - Framework-agnostic — no Claude-Code or Codex-specific tokens
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  TopicIntentStore,
  buildEvent,
} from '../../src/core/TopicIntent.js';
import { PendingConfirmationManager } from '../../src/core/TopicIntentPendingConfirm.js';
import { renderTopicIntentBriefing } from '../../src/core/TopicIntentBriefing.js';

let tempDir: string;
let store: TopicIntentStore;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-intent-briefing-test-'));
  store = new TopicIntentStore(tempDir);
});

afterEach(() => {
  try { SafeFsExecutor.safeRmSync(tempDir, { recursive: true, force: true, operation: 'tests/unit/TopicIntent-briefing.test.ts' }); } catch { /* best */ }
});

describe('renderTopicIntentBriefing — empty cases', () => {
  it('returns empty result when no refs exist', () => {
    const result = renderTopicIntentBriefing(store, 100);
    expect(result.hasContent).toBe(false);
    expect(result.text).toBe('');
    expect(result.counts).toEqual({
      authoritative: 0,
      tentative: 0,
      frame: 0,
      pendingOutstanding: false,
      awareness: false,
      awarenessLagTurns: 0,
    });
  });

  it('returns empty result when only observation-tier refs exist (not surfaced)', () => {
    store.appendEvidence(101, 'ref-obs', buildEvent('ref-obs', 'agent-reref', 'm1'), { text: 'low-confidence whisper', kind: 'fact' });
    const result = renderTopicIntentBriefing(store, 101);
    expect(result.hasContent).toBe(false);
    expect(result.text).toBe('');
  });
});

describe('renderTopicIntentBriefing — three temporal awareness levels', () => {
  it('renders topic anchor + evolution, recent arc, and current work even without tentative refs', () => {
    const first = store.updateAwareness(150, {
      topic: { goal: 'Preserve the conversation course', trend: 'Establishing durable orientation', themes: ['continuity'] },
      recentArc: { goal: 'Design the hierarchy', trend: 'Separating temporal scopes', themes: ['topic', 'arc'] },
      currentWork: { goal: 'Write the projection', trend: 'Implementing validation', themes: ['storage'] },
      arcTransition: { kind: 'continue' },
    }, {
      messageId: 'm1', messageText: 'Preserve the conversation course', fromUser: true,
      at: '2026-01-01T00:00:00.000Z', turn: 1,
    });
    expect(first).not.toBeNull();

    store.updateAwareness(150, {
      topic: { goal: 'Preserve the course while allowing topic evolution', trend: 'The initial continuity goal is broadening', themes: ['continuity', 'evolution'] },
      recentArc: { goal: 'Build the hierarchy', trend: 'Moving from design to code', themes: ['topic', 'arc', 'work'] },
      currentWork: { goal: 'Test the renderer', trend: 'Proving all fields surface', themes: ['briefing'] },
      arcTransition: { kind: 'continue' },
    }, {
      messageId: 'm2', messageText: 'Allow topic evolution too', fromUser: true,
      at: '2026-01-01T00:01:00.000Z', turn: 2,
    });

    const result = renderTopicIntentBriefing(store, 150);
    expect(result.hasContent).toBe(true);
    expect(result.text).toContain('THREE AWARENESS LEVELS');
    expect(result.text).toContain('initial anchor: Preserve the conversation course');
    expect(result.text).toContain('evolving goal: Preserve the course while allowing topic evolution');
    expect(result.text).toContain('MOST-RECENT ARC');
    expect(result.text).toContain('CURRENT WORK');
    expect(result.text).toContain('goal: Test the renderer');
    expect(result.text).toContain('orientation, not authority');
    expect(result.counts.awareness).toBe(true);
  });

  it('speaks when the projection is more than two user turns stale', () => {
    store.updateAwareness(151, {
      topic: { goal: 'Track the topic', trend: 'Starting', themes: ['awareness'] },
      recentArc: { goal: 'Start an arc', trend: 'Starting', themes: ['arc'] },
      currentWork: { goal: 'Begin work', trend: 'Starting', themes: ['work'] },
    }, {
      messageId: 'm1', messageText: 'Track the topic', fromUser: true,
      at: '2026-01-01T00:00:00.000Z', turn: 1,
    });
    store.bumpTurn(151);
    store.bumpTurn(151);
    store.bumpTurn(151);
    store.bumpTurn(151);

    const result = renderTopicIntentBriefing(store, 151);
    expect(result.counts.awarenessLagTurns).toBe(3);
    expect(result.text).toContain('FRESHNESS WARNING');
  });
});

describe('renderTopicIntentBriefing — section assembly', () => {
  it('surfaces authoritative items unhedged in SETTLED', () => {
    store.appendEvidence(200, 'ref-auth', buildEvent('ref-auth', 'extract-user', 'm1'), { text: 'use Path A OAuth', kind: 'decision' });
    store.appendEvidence(200, 'ref-auth', buildEvent('ref-auth', 'user-affirm', 'm2'));
    const result = renderTopicIntentBriefing(store, 200);
    expect(result.hasContent).toBe(true);
    expect(result.text).toContain('SETTLED');
    expect(result.text).toContain('[decision] use Path A OAuth');
    expect(result.text).not.toContain('TENTATIVE'); // no tentative items
    expect(result.text).not.toContain('confidence'); // no confidence shown for settled
    expect(result.counts.authoritative).toBe(1);
    expect(result.counts.tentative).toBe(0);
  });

  it('surfaces tentative items with hedge + confidence', () => {
    store.appendEvidence(201, 'ref-ten', buildEvent('ref-ten', 'extract-user', 'm1'), { text: 'timeout is 30s', kind: 'fact' });
    const result = renderTopicIntentBriefing(store, 201);
    expect(result.hasContent).toBe(true);
    expect(result.text).toContain('TENTATIVE');
    expect(result.text).toContain('[fact] timeout is 30s');
    expect(result.text).toContain('confidence');
    expect(result.text).toContain('(confidence 0.40)');
  });

  it('shows both sections when both tiers populated', () => {
    store.appendEvidence(202, 'ref-ten', buildEvent('ref-ten', 'extract-user', 'm1'), { text: 'tentative item', kind: 'fact' });
    store.appendEvidence(202, 'ref-auth', buildEvent('ref-auth', 'extract-user', 'm2'), { text: 'authoritative item', kind: 'decision' });
    store.appendEvidence(202, 'ref-auth', buildEvent('ref-auth', 'user-affirm', 'm3'));
    const result = renderTopicIntentBriefing(store, 202);
    expect(result.text).toContain('SETTLED');
    expect(result.text).toContain('TENTATIVE');
    expect(result.text).toContain('authoritative item');
    expect(result.text).toContain('tentative item');
    expect(result.counts.authoritative).toBe(1);
    expect(result.counts.tentative).toBe(1);
  });

  it('does NOT include observation-tier items even when other tiers are present', () => {
    store.appendEvidence(203, 'ref-obs', buildEvent('ref-obs', 'agent-reref', 'm1'), { text: 'mere whisper', kind: 'fact' });
    store.appendEvidence(203, 'ref-ten', buildEvent('ref-ten', 'extract-user', 'm2'), { text: 'real tentative', kind: 'fact' });
    const result = renderTopicIntentBriefing(store, 203);
    expect(result.text).toContain('real tentative');
    expect(result.text).not.toContain('mere whisper');
  });

  it('surfaces an outstanding pending confirmation', () => {
    store.appendEvidence(204, 'ref-A', buildEvent('ref-A', 'extract-user', 'm1'), { text: 'use Path A', kind: 'decision' });
    const mgr = new PendingConfirmationManager(store);
    mgr.create({
      topicId: 204, arcId: 'arc', refId: 'ref-A',
      propositionText: 'use Path A for the OAuth handshake',
      questionText: 'Just confirming we settled on Path A?',
      currentUserTurn: 5,
    });
    const result = renderTopicIntentBriefing(store, 204);
    expect(result.text).toContain('PENDING CONFIRMATION');
    expect(result.text).toContain('use Path A for the OAuth handshake');
    expect(result.text).toContain('turn 5');
    expect(result.counts.pendingOutstanding).toBe(true);
  });
});

describe('renderTopicIntentBriefing — truncation + sort', () => {
  it('truncates with overflow note when more than maxPerSection authoritative items', () => {
    for (let i = 0; i < 12; i++) {
      const refId = `ref-A${i}`;
      store.appendEvidence(300, refId, buildEvent(refId, 'extract-user', `m${i}-init`), { text: `item ${i}`, kind: 'decision' });
      store.appendEvidence(300, refId, buildEvent(refId, 'user-affirm', `m${i}-aff`));
    }
    const result = renderTopicIntentBriefing(store, 300, { maxPerSection: 5 });
    // 12 authoritative items, max 5 shown, overflow note for 7 more
    expect(result.text).toContain('(… 7 more settled items not shown)');
  });

  it('sorts items within a section by confidence descending', () => {
    // Two authoritative items with different confidences:
    //   ref-hi: extract-user (0.40) + pending-positive (0.50) = 0.90
    //   ref-lo: extract-user (0.40) + user-affirm (0.30) = 0.70
    store.appendEvidence(301, 'ref-hi', buildEvent('ref-hi', 'extract-user', 'm1'), { text: 'higher confidence', kind: 'decision' });
    store.appendEvidence(301, 'ref-hi', buildEvent('ref-hi', 'pending-confirm-positive', 'm2'));
    store.appendEvidence(301, 'ref-lo', buildEvent('ref-lo', 'extract-user', 'm3'), { text: 'lower confidence', kind: 'decision' });
    store.appendEvidence(301, 'ref-lo', buildEvent('ref-lo', 'user-affirm', 'm4'));

    const result = renderTopicIntentBriefing(store, 301);
    const hiIdx = result.text.indexOf('higher confidence');
    const loIdx = result.text.indexOf('lower confidence');
    expect(hiIdx).toBeGreaterThan(-1);
    expect(loIdx).toBeGreaterThan(-1);
    expect(hiIdx).toBeLessThan(loIdx);
  });
});

describe('renderTopicIntentBriefing — framework-agnostic', () => {
  it('output contains no Claude-Code or Codex-specific tokens', () => {
    store.appendEvidence(400, 'ref-auth', buildEvent('ref-auth', 'extract-user', 'm1'), { text: 'something', kind: 'decision' });
    store.appendEvidence(400, 'ref-auth', buildEvent('ref-auth', 'user-affirm', 'm2'));
    const result = renderTopicIntentBriefing(store, 400);
    const forbidden = ['claude', 'codex', '.claude/', '~/.claude'];
    for (const token of forbidden) {
      expect(result.text.toLowerCase()).not.toContain(token.toLowerCase());
    }
  });
});
