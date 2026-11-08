/**
 * What a degraded /health means for the person (docs/specs/mobile-health-issues.md): the declared table, the
 * safe default, and the summary, on both sides of each rule.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { HEALTH_RULES, HEALTH_APP_SCREENS, ruleFor, signalsFromHealth, summarizeHealth, isDeclaredAction, MAX_HEALTH_ISSUES } from '../../src/monitoring/healthIssues.js';

const ok = { status: 'ok', uptimeHuman: '2h' };
const degraded = { status: 'degraded', uptimeHuman: '2h' };
const ev = (feature: string, over: Record<string, unknown> = {}) => ({ feature, timestamp: '2026-11-05T10:00:00.000Z', narrative: `${feature} used a backup.`, ...over });

describe('the declared table', () => {
  it('every row names an impact, plain words, and declares its action or says there is none', () => {
    expect(HEALTH_RULES.length).toBeGreaterThanOrEqual(12);
    for (const r of HEALTH_RULES) {
      expect(['user-affecting', 'internal'], r.key).toContain(r.impact);
      expect(r.title.length, r.key).toBeGreaterThan(5);
      expect(r.detail.length, r.key).toBeGreaterThan(10);
      expect(r, r.key).toHaveProperty('action');
      expect(isDeclaredAction(r.action), r.key).toBe(true);
    }
  });

  it('no two rows claim one key', () => {
    const keys = HEALTH_RULES.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('an id that also means something the person must act on is not declared internal', () => {
    // Conflict and failure reports: left to the safe default, or declared as affecting the person.
    for (const id of ['GitSync.pull', 'GitSync.resolveLLMConflicts', 'GitSync.buildConflictFile', 'GitSync.lockfileRegeneration', 'Threadline.refuseDowngrade', 'Threadline.identity', 'Threadline.encryptToPinned', 'HandoffManager.pushAll', 'QuotaCollector.collect.oauth', 'QuotaTracker.remoteCheck']) expect(ruleFor(id), id).toBeNull();
    expect(ruleFor('SessionManager.verifyInjection.unsubmitted')?.impact).toBe('user-affecting');
    expect(ruleFor('SessionManager.verifyInjection')?.impact).toBe('internal');
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/core/SessionManager.ts'), 'utf8');
    expect(src.split("feature: 'SessionManager.verifyInjection.unsubmitted'").length - 1).toBe(2);
    expect(src.split("feature: 'SessionManager.verifyInjection',").length - 1).toBe(1);
  });

  it('every console page a row names is a registered console route', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../dashboard/console/console.js'), 'utf8');
    for (const r of HEALTH_RULES) {
      if (r.action?.console.startsWith('#/')) expect(src, r.key).toContain(`'${r.action.console.slice(2)}'`);
      else if (r.action) expect(fs.existsSync(path.resolve(__dirname, '../..', r.action.console.slice(1))), r.key).toBe(true);
    }
  });

  it('every app screen name is one the app declares', () => {
    expect([...HEALTH_APP_SCREENS].sort()).toEqual(['accounts', 'agents', 'desktop', 'machines', 'schedule', 'sessions']);
  });

  it('an exact id beats a family, and a family covers its members only', () => {
    expect(ruleFor('TelegramLifeline.restartStorm')?.impact).toBe('user-affecting');
    expect(ruleFor('unjustifiedStopGate.route')?.key).toBe('unjustifiedStopGate.*');
    expect(ruleFor('unjustifiedStopGateOther')).toBeNull();
    expect(ruleFor('health:llm:jev-load-assessment')?.impact).toBe('internal');
    expect(ruleFor('health:llm:outbound-review')).toBeNull();
    expect(ruleFor('health:llm:jev-memory-picker')).toBeNull();
  });
});

describe('signalsFromHealth reads every other reason /health degrades', () => {
  it('finds each, and only past its threshold', () => {
    const ids = (h: unknown) => signalsFromHealth(h).map((s) => s.id);
    expect(ids({ sessions: { current: 25, max: 25 } })).toEqual(['health:sessions-full']);
    expect(ids({ sessions: { current: 24, max: 25 } })).toEqual([]);
    expect(ids({ consecutiveJobFailures: 5 })).toEqual(['health:job-failures']);
    expect(ids({ consecutiveJobFailures: 4 })).toEqual([]);
    expect(ids({ claudeKey: { status: 'dead' } })).toEqual(['health:claude-key']);
    expect(ids({ claudeKey: { status: 'ok' } })).toEqual([]);
    expect(ids({ whatsapp: { state: 'disconnected' } })).toEqual(['health:whatsapp']);
    expect(ids({ whatsapp: { state: 'connected' } })).toEqual([]);
    expect(ids({ systemReview: { lastReview: { status: 'critical', failed: 3 } } })).toEqual(['health:system-review']);
    expect(ids({ systemReview: { lastReview: { status: 'degraded', failed: 1 } } })).toEqual([]);
    expect(ids({ llmReliability: { status: 'unavailable', components: [] } })).toEqual(['health:llm-unavailable']);
    expect(ids({ llmReliability: { status: 'ok', components: [] } })).toEqual([]);
    expect(ids({ llmReliability: { status: 'degraded', components: [{ feature: 'jev-load-assessment', errors: 28, realCalls: 97 }] } })).toEqual(['health:llm:jev-load-assessment']);
  });

  it('reads /health\'s real field names: every reason in the handler is accounted for', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/server/routes.ts'), 'utf8');
    const start = src.indexOf("router.get('/health', (req, res)");
    const handler = src.slice(start, src.indexOf("router.get('/health/degradations'", start));
    // A new reason means a new row here and in signalsFromHealth. The route still shows it as unnamed until then.
    expect(handler.match(/isDegraded = true/g)?.length).toBe(2);
    const first = /let isDegraded =([\s\S]*?);/.exec(handler)?.[1].replace(/\s+/g, ' ').trim();
    expect(first).toBe("sessionExhausted || totalFailures >= 5 || degradations.length > 0 || (llmReliability !== null && llmReliability.status !== 'ok') || activeClaudeKeyHealth()?.status()?.status === 'dead'");
  });
});

describe('summarizeHealth', () => {
  it('nothing wrong is healthy', () => {
    const s = summarizeHealth(ok, []);
    expect(s).toMatchObject({ verdict: 'healthy', headline: 'Healthy.', uptime: '2h', issues: [], truncated: false });
  });

  it('internal only reads as running normally, with the rows kept for the details', () => {
    const s = summarizeHealth(degraded, [ev('SessionManager.verifyInjection'), ev('SessionManager.verifyInjection'), ev('GitSync.gitHygiene')]);
    expect(s.verdict).toBe('running');
    expect(s.headline).toBe('Running normally.');
    expect(s.counts).toEqual({ userAffecting: 0, internal: 2, unclassified: 0 });
    expect(s.issues.find((i) => i.id === 'SessionManager.verifyInjection')?.count).toBe(2);
  });

  it('a user-affecting item is attention, leads the list and names itself', () => {
    const s = summarizeHealth(degraded, [ev('GitSync.gitHygiene'), ev('iMessage')]);
    expect(s.verdict).toBe('attention');
    expect(s.headline).toBe('iMessage isn’t connected.');
    expect(s.issues[0].id).toBe('iMessage');
  });

  it('an unknown id shows in the details and never reads as healthy or as running normally', () => {
    const s = summarizeHealth(degraded, [ev('SomethingNew.happened'), ev('GitSync.gitHygiene')]);
    // An unsorted item is a note on a running agent, never "can't tell" (Justin, 2026-11-07).
    expect(s.verdict).toBe('running');
    expect(s.headline).toBe('Running, with one note I haven’t sorted yet.');
    expect(s.headline).not.toMatch(/healthy|normally/i);
    expect(s.issues[0]).toMatchObject({ id: 'SomethingNew.happened', impact: 'unclassified', action: null });
    // Its own title names the part it is about; its words carried a code name, so they are left out.
    expect(s.issues[0].title).toBe('Something in my something new used a backup path');
    expect(s.issues[0].evidence).toBeNull();
  });

  it('an unknown id never shows the reporter\'s words as its title; they stay in the details', () => {
    const raw = 'threadline.encryptToPinned is enforce on a 5-machine agent, but multiMachine.stateSync.threadlinePairing.enabled is off';
    const [i] = summarizeHealth(degraded, [ev('Threadline.encryptToPinned', { narrative: raw })]).issues;
    expect(i.title).toBe('Messaging with other agents used a backup path');
    // Setting names are internal: never on the owner's screen, as the title or as its words.
    expect(i.evidence).toBeNull();
  });

  // ── Justin, 2026-11-06 22:49: two different rows, one title, and internal words ──
  it('two different unsorted problems get their own plain titles and plain words', () => {
    const s = summarizeHealth(degraded, [
      ev('feedback-execute:deps-unavailable', { impact: 'Feedback fixes wait; triage is unaffected.', narrative: 'Feedback fixes wait; triage is unaffected. I\'ll keep trying, but this may need a restart to fully resolve.' }),
      ev('StuckInputSentinel.recover', { impact: 'Recovery keypress sent (survives server restart); outcome observed on the following tick', narrative: 'Recovery keypress sent (survives server restart); outcome observed on the following tick. Using Persistent sentinel re-fires Enter after in-process verifyInjection window expired in the meantime — everything else is working fine.' }),
    ]);
    const byId = Object.fromEntries(s.issues.map((i) => [i.id, i]));
    expect(byId['feedback-execute:deps-unavailable'].title).toBe('Feedback fixes are waiting');
    expect(byId['feedback-execute:deps-unavailable'].evidence).toBe("Feedback fixes wait; triage is unaffected. I'll keep trying, but this may need a restart to fully resolve.");
    expect(byId['StuckInputSentinel.recover'].title).toBe('I pressed Enter for a stuck session');
    expect(byId['StuckInputSentinel.recover'].evidence).not.toMatch(/verifyInjection|sentinel|tick/i);
    // The "not sorted yet" line stays; the title is what changed.
    expect(byId['StuckInputSentinel.recover'].detail).toContain('I haven’t sorted this one yet');
  });

  it('an unknown part is named in plain words, a plain impact line can be its title, and no two rows share a title', () => {
    const s = summarizeHealth(degraded, [
      ev('BrandNewThing.a', { impact: 'Reports may arrive late', narrative: 'Reports may arrive late. Using the old path in the meantime — everything else is working fine.' }),
      ev('OtherNewThing.x', { impact: 'checkpoint_v2 failed for pid 4242' }),
      ev('OtherNewThing.y', { impact: 'checkpoint_v2 failed for pid 4243' }),
      ev('GitSync.pull'), ev('GitSync.push'),
    ]);
    const titles = s.issues.map((i) => i.title);
    expect(titles).toContain('Reports may arrive late');
    // The "Using … in the meantime" tail is dropped; the plain rest stays.
    expect(s.issues.find((i) => i.id === 'BrandNewThing.a')?.evidence).toBe('Reports may arrive late.');
    // A code-shaped impact never becomes a title: the part is named instead.
    expect(titles).toContain('Something in my other new thing used a backup path');
    expect(new Set(titles).size).toBe(titles.length);
    expect(titles).toContain('Background sync used a backup path');
    expect(titles.some((t) => /^Background sync used a backup path \(/.test(t))).toBe(true);
    for (const i of s.issues) expect(i.ask).toContain(i.title);
  });

  it('iMessage follows the present state, not the event window', () => {
    // Long after the event aged out, still down: still a problem, with its fix.
    const down = summarizeHealth(ok, [], { iMessage: 'down' });
    expect(down.verdict).toBe('attention');
    expect(down.issues[0]).toMatchObject({ id: 'iMessage', impact: 'user-affecting', action: { app: 'desktop' } });
    // A recent event while the adapter is connected, or iMessage is off: not a problem any more.
    for (const state of ['up', 'off'] as const) {
      const s = summarizeHealth(degraded, [ev('iMessage')], { iMessage: state });
      expect(s.issues).toEqual([]);
      expect(s.verdict).toBe('healthy');
    }
    // The event's words are kept as details, once, and no state supplied keeps the event path.
    const both = summarizeHealth(degraded, [ev('iMessage')], { iMessage: 'down' });
    expect(both.issues).toHaveLength(1);
    expect(both.issues[0].evidence).toContain('iMessage used a backup.');
    expect(summarizeHealth(degraded, [ev('iMessage')]).verdict).toBe('attention');
  });

  it('a reporter\'s internalOnly mark quietens an unnamed id, but never a declared row', () => {
    expect(summarizeHealth(degraded, [ev('SomethingNew.happened', { internalOnly: true })]).verdict).toBe('running');
    expect(summarizeHealth(degraded, [ev('iMessage', { internalOnly: true })]).verdict).toBe('attention');
  });

  it('many unsorted notes still read running, with a count; one that affects you raises it', () => {
    const s = summarizeHealth(degraded, [ev('New.a'), ev('New.b'), ev('New.c')]);
    expect(s.verdict).toBe('running');
    expect(s.headline).toBe('Running, with 3 notes I haven’t sorted yet.');
    expect(summarizeHealth(degraded, [ev('New.a'), ev('iMessage')]).verdict).toBe('attention');
  });

  it('degraded with nothing to explain it says so', () => {
    const s = summarizeHealth(degraded, []);
    expect(s.verdict).toBe('running');
    expect(s.issues[0].id).toBe('health:unnamed');
    // Only an unreadable /health answer is "can't tell", and it says why.
    const u = summarizeHealth(null, []);
    expect(u.verdict).toBe('unsure');
    expect(u.headline).toBe('I couldn’t read my own health just now.');
  });

  it('an LLM component outside the table is unclassified, with its numbers and no component name in the words', () => {
    const s = summarizeHealth({ ...degraded, llmReliability: { status: 'degraded', components: [{ feature: 'outbound-review', errors: 9, realCalls: 30 }] } }, []);
    expect(s.verdict).toBe('running');
    expect(s.issues[0].detail).toBe('9 of its last 30 calls failed in the past day.');
    expect(s.issues[0].title).not.toContain('outbound-review');
    expect(s.issues[0].ask).toContain('health:llm:outbound-review');
  });

  it('the Ask message names the problem and its reference', () => {
    const [i] = summarizeHealth(degraded, [ev('rope-health')]).issues;
    expect(i.ask).toContain('Coordination between machines hit a snag');
    expect(i.ask).toContain('rope-health');
    expect(i.action?.app).toBe('machines');
  });

  it('keeps the latest words of a repeated item', () => {
    const [i] = summarizeHealth(degraded, [ev('GitSync.gitHygiene', { narrative: 'old', timestamp: '2026-11-05T09:00:00.000Z' }), ev('GitSync.gitHygiene', { narrative: 'new', timestamp: '2026-11-05T11:00:00.000Z' })]).issues;
    expect(i.evidence).toBe('new');
    expect(i.lastAt).toBe('2026-11-05T11:00:00.000Z');
  });

  it('scrubs a secret out of the evidence and caps its length', () => {
    // A named row keeps its reporter's words, scrubbed and capped.
    const [i] = summarizeHealth(degraded, [ev('SessionManager.verifyInjection', { narrative: `token ghp_${'a'.repeat(36)} ${'z'.repeat(5000)}` })]).issues;
    expect(i.evidence).not.toContain('ghp_aaaa');
    expect(i.evidence!.length).toBeLessThanOrEqual(300);
    // An unnamed row never shows it either, whatever else it shows.
    const [u] = summarizeHealth(degraded, [ev('X.y', { narrative: `token ghp_${'a'.repeat(36)} ${'z'.repeat(5000)}` })]).issues;
    expect(u.evidence ?? '').not.toContain('ghp_aaaa');
    expect((u.evidence ?? '').length).toBeLessThanOrEqual(300);
  });

  it('never shows a local path', () => {
    const [i] = summarizeHealth(degraded, [ev('X.y', { narrative: 'Could not save /Users/x/.instar/identity.key.bak now' })]).issues;
    expect(i.evidence).toBe('Could not save a file on this machine now');
  });

  it('caps the list and says so', () => {
    const s = summarizeHealth(degraded, Array.from({ length: MAX_HEALTH_ISSUES + 3 }, (_, n) => ev(`New.thing${n}`)));
    expect(s.issues).toHaveLength(MAX_HEALTH_ISSUES);
    expect(s.truncated).toBe(true);
    expect(s.counts.unclassified).toBe(MAX_HEALTH_ISSUES + 3);
  });

  it('an event with no feature is still shown', () => {
    const s = summarizeHealth(degraded, [{ narrative: 'x' }]);
    expect(s.issues[0].impact).toBe('unclassified');
  });
});
