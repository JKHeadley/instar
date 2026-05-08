/**
 * InitiativeExplainer + tracker explanation/comment tests.
 *
 * Covers:
 *  - setUserExplanation persists across reloads and does NOT bump
 *    lastTouchedAt (it's a derived view, not work progress).
 *  - addComment validates input, appends + caps at 100, does NOT bump
 *    lastTouchedAt (conversation is not work).
 *  - InitiativeExplainer.computeHash is content-keyed: identical inputs
 *    → same hash; any one of {title, description, phase, signal} change
 *    → different hash.
 *  - run() skips initiatives whose cached explanation matches the
 *    current source-hash; with force:true it always recomputes.
 *  - run() with no intelligence provider returns a no-op result.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { InitiativeExplainer } from '../../src/core/InitiativeExplainer.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

let tmpDir: string;
let tracker: InitiativeTracker;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-explainer-test-'));
  tracker = new InitiativeTracker(tmpDir);
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/InitiativeExplainer.test.ts:35' });
});

function makeInitiative(id = 'demo') {
  return tracker.create({
    id,
    title: 'Demo Initiative',
    description: 'Phase-based shorthand: A→B→C',
    phases: [
      { id: 'plan', name: 'Plan' },
      { id: 'build', name: 'Build' },
    ],
    needsUser: true,
    needsUserReason: 'Phase B scope call',
  });
}

class StubIntelligence implements IntelligenceProvider {
  public calls = 0;
  public lastPrompt = '';
  constructor(private readonly response: string) {}
  async evaluate(prompt: string): Promise<string> {
    this.calls++;
    this.lastPrompt = prompt;
    return this.response;
  }
}

describe('InitiativeTracker — userExplanation cache', () => {
  it('persists setUserExplanation across reloads without bumping lastTouchedAt', async () => {
    const ini = makeInitiative();
    const beforeTouched = ini.lastTouchedAt;

    // Wait so any accidental re-touch would surface as a different timestamp
    await new Promise((r) => setTimeout(r, 10));

    tracker.setUserExplanation(ini.id, {
      summary: 'Plain English summary.',
      signalText: 'Plain English signal.',
      generatedAt: new Date().toISOString(),
      sourceHash: 'deadbeefdeadbeef',
    });

    const reloaded = new InitiativeTracker(tmpDir).get(ini.id)!;
    expect(reloaded.userExplanation?.summary).toBe('Plain English summary.');
    expect(reloaded.userExplanation?.sourceHash).toBe('deadbeefdeadbeef');
    expect(reloaded.lastTouchedAt).toBe(beforeTouched);
  });

  it('throws when setting explanation on a missing initiative', () => {
    expect(() =>
      tracker.setUserExplanation('nope', {
        summary: 's',
        signalText: '',
        generatedAt: new Date().toISOString(),
        sourceHash: 'x',
      }),
    ).toThrow(/not found/);
  });
});

describe('InitiativeTracker — comments', () => {
  it('appends comments and persists without bumping lastTouchedAt', async () => {
    const ini = makeInitiative();
    const beforeTouched = ini.lastTouchedAt;
    await new Promise((r) => setTimeout(r, 10));

    const { comment } = tracker.addComment(ini.id, 'Hello there', 'user', 'dashboard');
    expect(comment.id).toMatch(/^c_/);
    expect(comment.text).toBe('Hello there');
    expect(comment.author).toBe('user');
    expect(comment.source).toBe('dashboard');

    const reloaded = new InitiativeTracker(tmpDir).get(ini.id)!;
    expect(reloaded.comments).toHaveLength(1);
    expect(reloaded.comments![0].text).toBe('Hello there');
    expect(reloaded.lastTouchedAt).toBe(beforeTouched);
  });

  it('rejects empty/whitespace and oversized comments', () => {
    const ini = makeInitiative();
    expect(() => tracker.addComment(ini.id, '   ')).toThrow(/required/);
    expect(() => tracker.addComment(ini.id, 'x'.repeat(4001))).toThrow(/4000/);
  });

  it('caps the stored comment list at 100', () => {
    const ini = makeInitiative();
    for (let i = 0; i < 110; i++) {
      tracker.addComment(ini.id, `msg-${i}`);
    }
    const got = tracker.get(ini.id)!.comments!;
    expect(got).toHaveLength(100);
    // Newest stays at the end
    expect(got[got.length - 1].text).toBe('msg-109');
    expect(got[0].text).toBe('msg-10');
  });

  it('throws when commenting on a missing initiative', () => {
    expect(() => tracker.addComment('nope', 'hi')).toThrow(/not found/);
  });
});

describe('InitiativeExplainer — hashing', () => {
  it('produces identical hashes for identical inputs', () => {
    const ini = makeInitiative();
    const signal = { initiativeId: ini.id, title: ini.title, reason: 'needs-user' as const, detail: 'X' };
    expect(InitiativeExplainer.computeHash(ini, signal)).toBe(
      InitiativeExplainer.computeHash(ini, signal),
    );
  });

  it('changes when the title, description, phase, or signal changes', () => {
    const ini = makeInitiative();
    const signal = { initiativeId: ini.id, title: ini.title, reason: 'needs-user' as const, detail: 'X' };
    const h0 = InitiativeExplainer.computeHash(ini, signal);

    const h1 = InitiativeExplainer.computeHash({ ...ini, title: 'Different' }, signal);
    expect(h1).not.toBe(h0);

    const h2 = InitiativeExplainer.computeHash({ ...ini, description: 'changed' }, signal);
    expect(h2).not.toBe(h0);

    const h3 = InitiativeExplainer.computeHash(ini, { ...signal, detail: 'Y' });
    expect(h3).not.toBe(h0);

    const h4 = InitiativeExplainer.computeHash(ini, null);
    expect(h4).not.toBe(h0);
  });
});

describe('InitiativeExplainer — run', () => {
  it('returns a no-op result when no intelligence provider is wired', async () => {
    const explainer = new InitiativeExplainer({ tracker });
    expect(explainer.isAvailable()).toBe(false);
    const result = await explainer.run();
    expect(result.applied).toEqual([]);
    expect(result.skipped[0]?.reason).toMatch(/no intelligence/i);
  });

  it('writes a userExplanation and skips on subsequent run', async () => {
    makeInitiative('a');
    const intel = new StubIntelligence(
      'SUMMARY: A nice plain summary.\nSIGNAL: A nice plain signal explanation.',
    );
    const explainer = new InitiativeExplainer({ tracker, intelligence: intel });
    const r1 = await explainer.run();
    expect(intel.calls).toBe(1);
    expect(r1.applied).toHaveLength(1);
    const stored = tracker.get('a')!.userExplanation;
    expect(stored?.summary).toBe('A nice plain summary.');
    expect(stored?.signalText).toBe('A nice plain signal explanation.');

    const r2 = await explainer.run();
    expect(intel.calls).toBe(1); // no extra call — cache hit
    expect(r2.applied).toHaveLength(0);
    expect(r2.skipped[0]?.reason).toMatch(/fresh/);
  });

  it('recomputes when force:true is passed', async () => {
    makeInitiative('a');
    const intel = new StubIntelligence('SUMMARY: First.\nSIGNAL: Sig.');
    const explainer = new InitiativeExplainer({ tracker, intelligence: intel });
    await explainer.run();
    expect(intel.calls).toBe(1);
    await explainer.run({ force: true });
    expect(intel.calls).toBe(2);
  });

  it('returns null from explainOne when no signal block parses', async () => {
    const ini = makeInitiative('b');
    const intel = new StubIntelligence('completely unparseable text without labels');
    const explainer = new InitiativeExplainer({ tracker, intelligence: intel });
    const result = await explainer.explainOne(ini, null);
    expect(result).toBeNull();
    expect(tracker.get('b')!.userExplanation).toBeUndefined();
  });

  it('caps recomputes per run via maxPerRun', async () => {
    for (let i = 0; i < 4; i++) makeInitiative(`ini-${i}`);
    const intel = new StubIntelligence('SUMMARY: x.\nSIGNAL: y.');
    const explainer = new InitiativeExplainer({ tracker, intelligence: intel, maxPerRun: 2 });
    const result = await explainer.run();
    expect(result.applied).toHaveLength(2);
    expect(result.skipped.some((s) => /cap reached/.test(s.reason))).toBe(true);
  });
});
