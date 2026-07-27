// safe-git-allow: test file — uses SafeFsExecutor.safeRmSync; raw fs.* only for setup.
/**
 * Natural-language recall for SemanticMemory.search.
 *
 * The recall hook feeds `search()` the user's raw message — always a sentence.
 * FTS5 requires EVERY bare token to match, and no stored entity contains the
 * word "why", so a question could never match anything no matter what content
 * words sat beside it. Recall was enabled, wired, and structurally incapable of
 * returning a result for the queries it actually received.
 *
 * Measured on a live 2,852-entity store before the fix:
 *   "can I reach Codey"                 -> 0     "reach Codey"     -> 7
 *   "is Codey responding to my messages"-> 0     "Codey messages"  -> 17
 *   "why is Codey not replying"         -> 0     "Codey"           -> 20
 *
 * The lesson that would have prevented a real incident was stored, indexed, and
 * unreachable. These tests pin both halves: stopwords must not zero a query, and
 * a strict match must still win when it exists (the fallback must not add noise).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  SemanticMemory,
  buildFtsQueryVariants,
} from '../../src/memory/SemanticMemory.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('buildFtsQueryVariants', () => {
  it('drops stopwords that would zero an implicit-AND query', () => {
    const v = buildFtsQueryVariants('why is Codey not replying');
    expect(v).not.toBeNull();
    expect(v!.strict).toBe('Codey replying');
  });

  it('ORs the content words for the fallback expression', () => {
    const v = buildFtsQueryVariants('can I reach Codey');
    expect(v!.strict).toBe('reach Codey');
    expect(v!.loose).toBe('reach OR Codey');
  });

  it('leaves a pure keyword query untouched', () => {
    const v = buildFtsQueryVariants('telegram bot');
    expect(v!.strict).toBe('telegram bot');
  });

  it('keeps the original tokens when a query is ALL stopwords', () => {
    // Must degrade to previous semantics, never to an empty match-everything query.
    const v = buildFtsQueryVariants('what is it');
    expect(v!.strict).toBe('what is it');
  });

  it('collapses to a single term without an OR when only one word survives', () => {
    const v = buildFtsQueryVariants('what about Codey');
    expect(v!.strict).toBe('Codey');
    expect(v!.loose).toBe('Codey');
  });

  it('returns null for an empty or syntax-only query', () => {
    expect(buildFtsQueryVariants('')).toBeNull();
    expect(buildFtsQueryVariants('   ')).toBeNull();
    expect(buildFtsQueryVariants('*()')).toBeNull();
  });

  it('still strips FTS5 operators so a query cannot be manipulated', () => {
    const v = buildFtsQueryVariants('Codey AND secrets');
    expect(v!.strict).not.toContain('AND');
  });
});

describe('SemanticMemory.search — natural-language recall', () => {
  let dir: string;
  let memory: SemanticMemory;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-recall-'));
    memory = new SemanticMemory({ dbPath: path.join(dir, 'semantic.db') });
    await memory.open();

    // The real entity, as it was actually stored on 2026-07-19.
    memory.remember({
      type: 'fact',
      name: 'Telegram bot visibility limit',
      content:
        "Telegram bots cannot see other bots' messages, which means a topic post " +
        'can appear successful while still failing to reach the intended bot pipeline.',
      confidence: 0.7,
      lastVerified: new Date().toISOString(),
      source: 'session:test',
      tags: ['telegram', 'messaging'],
    });
    memory.remember({
      type: 'fact',
      name: 'Vercel deploy target',
      content: 'Production deploys to Vercel from the main branch.',
      confidence: 0.7,
      lastVerified: new Date().toISOString(),
      source: 'session:test',
      tags: ['deploy'],
    });
  });

  afterEach(() => {
    memory.close();
    SafeFsExecutor.safeRmSync(dir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/semantic-memory-recall-query.test.ts',
    });
  });

  it('finds a stored lesson from a natural-language question (the reported bug)', () => {
    const results = memory.search('why can a telegram bot not see messages');
    expect(results.length).toBeGreaterThan(0);
    expect(results.map((r) => r.name)).toContain(
      'Telegram bot visibility limit',
    );
  });

  it('finds it from a question phrased as the agent would ask it', () => {
    const results = memory.search('can I reach the other bot on telegram');
    expect(results.map((r) => r.name)).toContain(
      'Telegram bot visibility limit',
    );
  });

  it('still finds it from a bare keyword query (no regression)', () => {
    const results = memory.search('telegram bot');
    expect(results.map((r) => r.name)).toContain(
      'Telegram bot visibility limit',
    );
  });

  it('prefers the STRICT match and does not widen when strict already matches', () => {
    // Both entities exist; a strict two-keyword hit must not drag in the
    // unrelated one via the OR fallback.
    const results = memory.search('telegram visibility');
    expect(results.map((r) => r.name)).toContain(
      'Telegram bot visibility limit',
    );
    expect(results.map((r) => r.name)).not.toContain(
      'Vercel deploy target',
    );
  });

  it('returns empty for a question about something genuinely not stored', () => {
    // The fallback must widen the query, not invent relevance.
    expect(memory.search('how do I configure the kubernetes ingress')).toEqual([]);
  });

  it('honours the confidence filter through the fallback path', () => {
    const results = memory.search('why can a telegram bot not see messages', {
      minConfidence: 0.95,
    });
    expect(results).toEqual([]);
  });
});
