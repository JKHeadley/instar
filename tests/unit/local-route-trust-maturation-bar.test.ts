/**
 * Local-route trust — the maturation evidence and the next rung's bar
 * (CMT-1141; docs/specs/local-route-trust-maturation-bar.eli16.md).
 *
 * Rows are built by the same function the route uses, written by a real
 * FeatureEvidenceLog, and read with the REAL metric refs from
 * src/data/feature-ladders.json through the real LadderEvidenceReader.
 */

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  LOCAL_TRUST_ALLOWED_WINDOW_MS,
  LOCAL_TRUST_WOULD_REFUSE_WINDOW_MS,
  localRouteTrustEvidence,
  localRouteTrustSubject,
  type LocalRouteTrustVerdict,
} from '../../src/threadline/localRouteTrust.js';
import { FeatureEvidenceLog, FEATURE_EVIDENCE_FILE } from '../../src/monitoring/FeatureEvidenceLog.js';
import { readJsonlQueries, type JsonlQuery } from '../../src/monitoring/LadderEvidenceReader.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { parseLadderRegistry } from '../../src/monitoring/MaturationLadder.js';

const FEATURE = 'threadline.localRouteTrust';
const DAY = 86_400_000;

const v = (over: Partial<LocalRouteTrustVerdict> = {}): LocalRouteTrustVerdict => ({
  level: 'untrusted', operation: 'message', allowed: false, identitySource: 'none', fingerprint: null, ...over,
});

type LadderMetric = { id: string; role: string; ref: JsonlQuery['ref']; direction: 'at-least' | 'at-most'; threshold: number; minSamples: number };
const ladder = JSON.parse(fs.readFileSync(path.join(__dirname, '../../src/data/feature-ladders.json'), 'utf-8')) as {
  entries: Array<{ id: string; rungs: Record<string, { metrics: LadderMetric[] }> }>;
};
const entry = ladder.entries.find(e => e.id === FEATURE)!;
const metric = (id: string) => entry.rungs['dev-agent-live'].metrics.find(m => m.id === id)!;

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) SafeFsExecutor.safeRmSync(r, { recursive: true, force: true, operation: 'local-route-trust-maturation-bar.test' }); });

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lrt-bar-'));
  roots.push(root);
  let t = Date.parse('2026-11-11T12:00:00Z');
  const log = new FeatureEvidenceLog({ projectDir: root, machine: 'm', instarVersion: '0.0.0', now: () => (t += 1000) });
  const decide = (sender: string, verdict: LocalRouteTrustVerdict, dryRun = true) => {
    const ev = localRouteTrustEvidence(sender, verdict, dryRun);
    return log.record(FEATURE, ev.input)!;
  };
  const grade = (eventId: string, outcome: 'right' | 'wrong') =>
    log.record(FEATURE, { kind: 'outcome', reason: 'would-refuse', outcome, gradesEventId: eventId, gradedBy: 'test' });
  const read = async (id: string) => {
    const m = metric(id);
    const now = t + 1000;
    const out = await readJsonlQueries(root, [{ key: id, ref: m.ref, sinceMs: now - 14 * DAY, direction: m.direction }], now);
    const r = out.get(id)!;
    const pass = r.value === null || r.samples < m.minSamples ? null
      : m.direction === 'at-least' ? r.value >= m.threshold : r.value <= m.threshold;
    return { ...r, pass };
  };
  const rows = () => fs.readFileSync(path.join(root, FEATURE_EVIDENCE_FILE), 'utf-8').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>);
  return { decide, grade, read, rows };
}

describe('local-route trust — evidence rows', () => {
  it('a would-refuse keeps the sender and why, as a fired row with a top-level subject', () => {
    const ev = localRouteTrustEvidence('drill-sender', v(), true);
    expect(ev.windowMs).toBe(LOCAL_TRUST_WOULD_REFUSE_WINDOW_MS);
    expect(ev.input).toMatchObject({
      kind: 'fired', reason: 'would-refuse', subject: 'name:drill-sender',
      context: { sender: 'drill-sender', level: 'untrusted', operation: 'message', identitySource: 'none', dryRun: true, refuseReason: 'untrusted-may-not-message' },
    });
  });

  it('an allowed decision is hourly and has no refuse reason', () => {
    const ev = localRouteTrustEvidence('peer', v({ level: 'verified', allowed: true, identitySource: 'registry', fingerprint: 'a'.repeat(32) }), true);
    expect(ev.windowMs).toBe(LOCAL_TRUST_ALLOWED_WINDOW_MS);
    expect(ev.input).toMatchObject({ kind: 'fired', reason: 'allowed', subject: `fp:${'a'.repeat(32)}` });
    expect(ev.input.context.refuseReason).toBeUndefined();
  });

  it('refusing a registry-known agent stays the harm row (error), dry-run and enforcing', () => {
    const reg = v({ identitySource: 'registry', fingerprint: 'b'.repeat(32) });
    expect(localRouteTrustEvidence('p', reg, true).input).toMatchObject({ kind: 'error', reason: 'would-refuse-registered-sender' });
    expect(localRouteTrustEvidence('p', reg, false).input).toMatchObject({ kind: 'error', reason: 'refuse-registered-sender' });
  });

  it('the subject is the fingerprint when there is one, else the log-safe claimed name', () => {
    expect(localRouteTrustSubject('x', v({ fingerprint: 'c'.repeat(32) }))).toBe(`fp:${'c'.repeat(32)}`);
    expect(localRouteTrustSubject('evil\nname\u001b', v())).toBe('name:evil?name?');
    const ev = localRouteTrustEvidence('evil\nname', v(), true);
    expect(ev.key.includes('\n')).toBe(false);
  });

  it('the evidence log writes subject at the top level', () => {
    const h = harness();
    h.decide('s1', v());
    expect(h.rows()[0]).toMatchObject({ featureId: FEATURE, kind: 'fired', reason: 'would-refuse', subject: 'name:s1' });
  });
});

describe('local-route trust — the next rung\'s bar (real ladder refs)', () => {
  it('the shipped ladder file still parses with the new bars (a bad entry blanks every feature)', () => {
    const r = parseLadderRegistry(fs.readFileSync(path.join(__dirname, '../../src/data/feature-ladders.json'), 'utf-8'));
    expect(r).toMatchObject({ ok: true });
  });

  it('the dev-agent-live rung carries the three new bars', () => {
    expect(metric('distinct-senders')).toMatchObject({ role: 'quality', direction: 'at-least', threshold: 3 });
    expect(metric('would-refuse')).toMatchObject({ role: 'quality', direction: 'at-least', threshold: 1 });
    expect(metric('would-refuse-graded-wrong')).toMatchObject({ role: 'harm', direction: 'at-most', threshold: 0 });
  });

  it('one verified sender, many times, is one sender: the bar is not met (today\'s state)', async () => {
    const h = harness();
    for (let i = 0; i < 12; i++) h.decide('peer', v({ level: 'verified', allowed: true, identitySource: 'registry', fingerprint: 'a'.repeat(32) }));
    expect(await h.read('distinct-senders')).toMatchObject({ value: 1, pass: null }); // too few senders to judge
    expect(await h.read('would-refuse')).toMatchObject({ value: 0, pass: false });
    expect(await h.read('would-refuse-graded-wrong')).toMatchObject({ value: null, pass: null });
  });

  it('three senders, a would-refuse graded right: every bar passes', async () => {
    const h = harness();
    h.decide('peer', v({ level: 'verified', allowed: true, identitySource: 'registry', fingerprint: 'a'.repeat(32) }));
    h.decide('other', v({ level: 'verified', allowed: true, identitySource: 'name' }));
    const refused = h.decide('stranger', v());
    h.grade(refused, 'right');
    expect(await h.read('distinct-senders')).toMatchObject({ value: 3, pass: true });
    expect(await h.read('would-refuse')).toMatchObject({ value: 1, pass: true });
    expect(await h.read('would-refuse-graded-wrong')).toMatchObject({ value: 0, samples: 1, pass: true });
  });

  it('a would-refuse graded wrong fails the harm bar; the last grade per event wins', async () => {
    const h = harness();
    const a = h.decide('stranger', v());
    const b = h.decide('stranger2', v());
    h.grade(a, 'right');
    h.grade(b, 'wrong');
    expect(await h.read('would-refuse-graded-wrong')).toMatchObject({ value: 0.5, pass: false });
    h.grade(b, 'right');
    expect(await h.read('would-refuse-graded-wrong')).toMatchObject({ value: 0, pass: true });
  });

  it('a grade that does not say reason would-refuse is not a would-refuse grade (reads as no evidence, never a pass)', async () => {
    const h = harness();
    h.decide('stranger', v());
    expect(await h.read('would-refuse-graded-wrong')).toMatchObject({ value: null, pass: null });
  });
});
