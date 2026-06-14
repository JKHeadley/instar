/**
 * Tests for the Telegram.Lifeline self-heal pathway.
 *
 * Covers two paired files:
 *  1. DegradationReporter.clearByFeature — new method that removes events
 *     in-memory and from degradations.json on disk, returning the count cleared.
 *  2. TelegramAdapter.apiCall — self-heal block calls clearByFeature after a
 *     successful sendMessage/sendChatAction to lifelineTopicId.
 *
 * The static-analysis tests read the TS source as a string so they remain
 * fast and require no live Telegram credentials. Behavioral tests use the
 * real DegradationReporter class with a temp directory.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const DEGRADATION_REPORTER_SRC = path.join(process.cwd(), 'src/monitoring/DegradationReporter.ts');
const TELEGRAM_ADAPTER_SRC = path.join(process.cwd(), 'src/messaging/TelegramAdapter.ts');

// ── Static analysis: DegradationReporter ─────────────────────────────────────

describe('DegradationReporter — clearByFeature (static analysis)', () => {
  const src = fs.readFileSync(DEGRADATION_REPORTER_SRC, 'utf-8');

  it('exports a public clearByFeature method with the right signature', () => {
    expect(src).toMatch(/clearByFeature\(feature:\s*string\):\s*number/);
  });

  it('filters this.events by feature', () => {
    const methodStart = src.indexOf('clearByFeature(feature: string)');
    const methodEnd = src.indexOf('\n  /**', methodStart + 1);
    const method = src.slice(methodStart, methodEnd > -1 ? methodEnd : undefined);

    expect(method).toContain('this.events.filter');
    expect(method).toContain('e.feature !== feature');
  });

  it('deletes from lastAlertTime when events are cleared', () => {
    const methodStart = src.indexOf('clearByFeature(feature: string)');
    const methodEnd = src.indexOf('\n  /**', methodStart + 1);
    const method = src.slice(methodStart, methodEnd > -1 ? methodEnd : undefined);

    expect(method).toContain('this.lastAlertTime.delete(feature)');
  });

  it('persists the filtered array to degradations.json', () => {
    const methodStart = src.indexOf('clearByFeature(feature: string)');
    const methodEnd = src.indexOf('\n  /**', methodStart + 1);
    const method = src.slice(methodStart, methodEnd > -1 ? methodEnd : undefined);

    expect(method).toContain('degradations.json');
    expect(method).toContain('fs.writeFileSync');
    expect(method).toContain('e.feature !== feature');
  });

  it('returns the count of cleared events', () => {
    const methodStart = src.indexOf('clearByFeature(feature: string)');
    const methodEnd = src.indexOf('\n  /**', methodStart + 1);
    const method = src.slice(methodStart, methodEnd > -1 ? methodEnd : undefined);

    expect(method).toContain('return cleared');
  });

  it('contains the render dedupe regex that prevents "Using Using ..."', () => {
    // The narrativeFor static method should check whether the fallback string
    // already starts with "Using " before prepending it.
    const narrativeStart = src.indexOf('static narrativeFor(');
    const narrativeEnd = src.indexOf('\n  /**', narrativeStart + 1);
    const narrative = src.slice(narrativeStart, narrativeEnd > -1 ? narrativeEnd : undefined);

    expect(narrative).toMatch(/\/\^using\\s\/i\.test/);
  });
});

// ── Static analysis: TelegramAdapter ─────────────────────────────────────────

describe('TelegramAdapter — apiCall lifeline self-heal (static analysis)', () => {
  const src = fs.readFileSync(TELEGRAM_ADAPTER_SRC, 'utf-8');

  it('calls clearByFeature in the apiCall success path', () => {
    // The call must appear after `if (!data.ok)` and before the final `return data.result`
    const apiCallStart = src.lastIndexOf('private async apiCall(');
    const apiCallEnd = src.indexOf('\n}', apiCallStart);
    const method = src.slice(apiCallStart, apiCallEnd > -1 ? apiCallEnd : undefined);

    expect(method).toContain("clearByFeature('Telegram.Lifeline')");
  });

  it("only triggers for sendMessage and sendChatAction methods", () => {
    const apiCallStart = src.lastIndexOf('private async apiCall(');
    const apiCallEnd = src.indexOf('\n}', apiCallStart);
    const method = src.slice(apiCallStart, apiCallEnd > -1 ? apiCallEnd : undefined);

    expect(method).toContain("method === 'sendMessage' || method === 'sendChatAction'");
  });

  it('guards on lifelineTopicId being non-null', () => {
    const apiCallStart = src.lastIndexOf('private async apiCall(');
    const apiCallEnd = src.indexOf('\n}', apiCallStart);
    const method = src.slice(apiCallStart, apiCallEnd > -1 ? apiCallEnd : undefined);

    expect(method).toContain('lifelineId != null');
  });

  it('checks that the thread ID matches the lifeline topic', () => {
    const apiCallStart = src.lastIndexOf('private async apiCall(');
    const apiCallEnd = src.indexOf('\n}', apiCallStart);
    const method = src.slice(apiCallStart, apiCallEnd > -1 ? apiCallEnd : undefined);

    expect(method).toContain('threadId === lifelineId');
  });

  it('wraps the self-heal block in try/catch for best-effort semantics', () => {
    const apiCallStart = src.lastIndexOf('private async apiCall(');
    const apiCallEnd = src.indexOf('\n}', apiCallStart);
    const method = src.slice(apiCallStart, apiCallEnd > -1 ? apiCallEnd : undefined);

    expect(method).toMatch(/self-heal best-effort/);
  });

  it('uses DegradationReporter already imported at top of file (no dynamic import)', () => {
    // DegradationReporter must be a static import
    const importSection = src.slice(0, src.indexOf('export class TelegramAdapter'));
    expect(importSection).toContain("import { DegradationReporter }");
    // And no dynamic import inside apiCall
    const apiCallStart = src.lastIndexOf('private async apiCall(');
    const apiCallEnd = src.indexOf('\n}', apiCallStart);
    const method = src.slice(apiCallStart, apiCallEnd > -1 ? apiCallEnd : undefined);
    expect(method).not.toContain('await import(');
  });
});

// ── Behavioral: clearByFeature ────────────────────────────────────────────────

describe('DegradationReporter.clearByFeature — behavior', () => {
  let tmpDir: string;

  beforeEach(() => {
    DegradationReporter.resetForTesting();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'degradation-clear-'));
  });

  afterEach(() => {
    DegradationReporter.resetForTesting();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/degradation-reporter-lifeline-self-heal.test.ts' });
  });

  it('returns 0 when no events match', () => {
    const reporter = DegradationReporter.getInstance();
    reporter.configure({ stateDir: tmpDir, agentName: 'test', instarVersion: '0.0.0' });

    const cleared = reporter.clearByFeature('Telegram.Lifeline');
    expect(cleared).toBe(0);
  });

  it('removes matching events from memory and returns count', () => {
    const reporter = DegradationReporter.getInstance();
    reporter.configure({ stateDir: tmpDir, agentName: 'test', instarVersion: '0.0.0' });

    reporter.report({
      feature: 'Telegram.Lifeline',
      primary: 'Lifeline topic',
      fallback: 'No fallback available',
      reason: 'Topic unreachable',
      impact: 'Lifeline degraded',
    });
    reporter.report({
      feature: 'OtherFeature',
      primary: 'Something else',
      fallback: 'Something else fallback',
      reason: 'Other reason',
      impact: 'Other impact',
    });

    expect(reporter.getEvents()).toHaveLength(2);

    const cleared = reporter.clearByFeature('Telegram.Lifeline');
    expect(cleared).toBe(1);
    expect(reporter.getEvents()).toHaveLength(1);
    expect(reporter.getEvents()[0]!.feature).toBe('OtherFeature');
  });

  it('removes cleared feature events from degradations.json on disk', () => {
    const reporter = DegradationReporter.getInstance();
    reporter.configure({ stateDir: tmpDir, agentName: 'test', instarVersion: '0.0.0' });

    reporter.report({
      feature: 'Telegram.Lifeline',
      primary: 'Lifeline topic',
      fallback: 'No fallback available',
      reason: 'Unreachable',
      impact: 'Lifeline degraded',
    });

    const filePath = path.join(tmpDir, 'degradations.json');
    expect(fs.existsSync(filePath)).toBe(true);

    const before = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Array<{ feature: string }>;
    expect(before.some(e => e.feature === 'Telegram.Lifeline')).toBe(true);

    reporter.clearByFeature('Telegram.Lifeline');

    const after = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Array<{ feature: string }>;
    expect(after.some(e => e.feature === 'Telegram.Lifeline')).toBe(false);
  });

  it('is idempotent — second clear on the same feature returns 0', () => {
    const reporter = DegradationReporter.getInstance();
    reporter.configure({ stateDir: tmpDir, agentName: 'test', instarVersion: '0.0.0' });

    reporter.report({
      feature: 'Telegram.Lifeline',
      primary: 'Lifeline topic',
      fallback: 'No fallback',
      reason: 'Down',
      impact: 'Lifeline degraded',
    });

    reporter.clearByFeature('Telegram.Lifeline');
    const second = reporter.clearByFeature('Telegram.Lifeline');
    expect(second).toBe(0);
  });
});

// ── narrativeFor dedupe ───────────────────────────────────────────────────────

describe('DegradationReporter.narrativeFor — render dedupe', () => {
  it('does not prepend "Using" when fallback already starts with "Using"', () => {
    const narrative = DegradationReporter.narrativeFor({
      feature: 'Test',
      primary: 'Primary',
      fallback: 'Using the backup channel',
      reason: 'Primary unavailable',
      impact: 'Slightly delayed delivery',
      timestamp: new Date().toISOString(),
      reported: false,
      alerted: false,
    });

    expect(narrative).not.toMatch(/using using/i);
    expect(narrative).toContain('Using the backup channel');
  });

  it('prepends "Using" when fallback does not start with "Using"', () => {
    const narrative = DegradationReporter.narrativeFor({
      feature: 'Test',
      primary: 'Primary',
      fallback: 'the backup channel',
      reason: 'Primary unavailable',
      impact: 'Slightly delayed delivery',
      timestamp: new Date().toISOString(),
      reported: false,
      alerted: false,
    });

    expect(narrative).toMatch(/Using the backup channel/);
  });
});
