import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HumanAsDetectorLog, observeInboundMessage } from '../../src/monitoring/HumanAsDetectorLog.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('HumanAsDetectorLog', () => {
  let tmpDir: string;
  let log: HumanAsDetectorLog;

  beforeEach(() => {
    HumanAsDetectorLog.resetForTesting();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hadl-'));
    log = HumanAsDetectorLog.getInstance();
    log.configure({ stateDir: tmpDir, agentName: 'test-agent' });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/HumanAsDetectorLog.test.ts' });
    HumanAsDetectorLog.resetForTesting();
  });

  describe('classify (pure, deterministic)', () => {
    it('flags an explicit factual correction', () => {
      const v = log.classify("That's wrong, the X account was reinstated days ago.");
      expect(v).not.toBeNull();
      // staleness signal ("days ago" isn't matched, but "reinstated"/"that's wrong" is)
      expect(['factual-correction', 'staleness']).toContain(v!.category);
      expect(v!.confidence).toBe('medium'); // "that's wrong" (weight 3)
    });

    it('flags a self-contradiction', () => {
      const v = log.classify('You said the deadline was tomorrow but actually it already passed.');
      expect(v).not.toBeNull();
      expect(v!.category).toBe('contradiction');
      expect(v!.suspectedFailedLayer).toMatch(/CoherenceMonitor/);
    });

    it('flags staleness', () => {
      const v = log.classify('This is out of date — that was already fixed.');
      expect(v).not.toBeNull();
      expect(v!.category).toBe('staleness');
      expect(v!.confidence).toBe('medium'); // staleness rule (weight 3)
    });

    it('flags a meta-failure question', () => {
      const v = log.classify("Why didn't the system catch this before sending it to me?");
      expect(v).not.toBeNull();
      expect(v!.category).toBe('meta-failure');
      expect(v!.suspectedFailedLayer).toMatch(/coverage/);
    });

    it('reaches high confidence when multiple strong signals stack', () => {
      // contradiction (3) + "that's wrong" (3) = 6 → high
      const v = log.classify("You told me it shipped, but that's wrong.");
      expect(v).not.toBeNull();
      expect(v!.confidence).toBe('high');
      expect(v!.matchedSignals.length).toBeGreaterThanOrEqual(2);
    });

    it('does NOT flag a benign message', () => {
      expect(log.classify('Thanks, that looks great. Can you also add a chart?')).toBeNull();
      expect(log.classify('What time is the meeting tomorrow?')).toBeNull();
      expect(log.classify('')).toBeNull();
    });

    it('does NOT flag a lone weak "actually" signal', () => {
      // weight-1 only → below the threshold of 2
      expect(log.classify('Actually, I think a chart would be nice here.')).toBeNull();
    });

    it('is null-safe on non-string input', () => {
      // @ts-expect-error testing runtime guard
      expect(log.classify(null)).toBeNull();
      // @ts-expect-error testing runtime guard
      expect(log.classify(undefined)).toBeNull();
    });
  });

  describe('observe (records + persists)', () => {
    it('records a correction and writes JSONL', () => {
      const signal = log.observe({
        text: "That's incorrect — you said it was done but the record says otherwise.",
        source: 'telegram',
        topicId: 25726,
        messageId: 42,
      });
      expect(signal).not.toBeNull();
      expect(signal!.source).toBe('telegram');
      expect(signal!.topicId).toBe(25726);

      const file = path.join(tmpDir, 'metrics', 'human-as-detector.jsonl');
      expect(fs.existsSync(file)).toBe(true);
      const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
      expect(lines.length).toBe(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.agentName).toBe('test-agent');
      expect(parsed.category).toBeTruthy();
    });

    it('returns null and writes nothing for benign messages', () => {
      const signal = log.observe({ text: 'Sounds good, thanks!', source: 'telegram' });
      expect(signal).toBeNull();
      const file = path.join(tmpDir, 'metrics', 'human-as-detector.jsonl');
      expect(fs.existsSync(file)).toBe(false);
    });

    it('truncates long previews', () => {
      const long = "That's wrong. " + 'x'.repeat(500);
      const signal = log.observe({ text: long, source: 'telegram' });
      expect(signal!.messagePreview.length).toBeLessThanOrEqual(220);
    });

    it('appends multiple signals', () => {
      log.observe({ text: "That's wrong.", source: 'telegram' });
      log.observe({ text: 'This is out of date.', source: 'slack' });
      const file = path.join(tmpDir, 'metrics', 'human-as-detector.jsonl');
      const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
      expect(lines.length).toBe(2);
    });

    it('never throws even if stateDir is unset', () => {
      HumanAsDetectorLog.resetForTesting();
      const fresh = HumanAsDetectorLog.getInstance(); // no configure()
      expect(() => fresh.observe({ text: "That's wrong.", source: 'telegram' })).not.toThrow();
    });
  });

  describe('summarizeByLayer (heat map)', () => {
    it('groups signals by suspected failed layer, most-frequent first', () => {
      log.observe({ text: "That's wrong.", source: 'telegram' });
      log.observe({ text: "That's incorrect.", source: 'telegram' });
      log.observe({ text: 'This is out of date.', source: 'telegram' });

      const summary = log.summarizeByLayer();
      expect(summary.length).toBeGreaterThanOrEqual(2);
      // output-sanity layer fired twice, should rank first
      expect(summary[0].count).toBeGreaterThanOrEqual(summary[summary.length - 1].count);
      const total = summary.reduce((s, e) => s + e.count, 0);
      expect(total).toBe(3);
    });

    it('returns empty when nothing observed', () => {
      expect(log.summarizeByLayer()).toEqual([]);
    });
  });
});

describe('observeInboundMessage — inbound-human gating (wiring integrity)', () => {
  let tmpDir: string;
  let log: HumanAsDetectorLog;

  beforeEach(() => {
    HumanAsDetectorLog.resetForTesting();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hadl-gate-'));
    log = HumanAsDetectorLog.getInstance();
    log.configure({ stateDir: tmpDir, agentName: 'test-agent' });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/HumanAsDetectorLog.test.ts' });
    HumanAsDetectorLog.resetForTesting();
  });

  it('observes an inbound human correction', () => {
    const signal = observeInboundMessage(log, {
      fromUser: true, text: "that's wrong", topicId: 5, messageId: 9,
    });
    expect(signal).not.toBeNull();
    expect(signal!.category).toBe('factual-correction');
    expect(signal!.topicId).toBe(5);
    expect(log.getRecent()).toHaveLength(1);
  });

  it('does NOT observe agent-authored messages', () => {
    const signal = observeInboundMessage(log, {
      fromUser: false, text: "that's wrong", topicId: 5,
    });
    expect(signal).toBeNull();
    expect(log.getRecent()).toHaveLength(0);
  });

  it('does NOT observe empty or textless entries', () => {
    expect(observeInboundMessage(log, { fromUser: true, text: '' })).toBeNull();
    expect(observeInboundMessage(log, { fromUser: true })).toBeNull();
    expect(log.getRecent()).toHaveLength(0);
  });

  it('returns null for an inbound human message that is not a correction', () => {
    const signal = observeInboundMessage(log, { fromUser: true, text: 'sounds good, thanks!' });
    expect(signal).toBeNull();
    expect(log.getRecent()).toHaveLength(0);
  });
});

describe('persistence privacy + restart hydration', () => {
  let tmpDir: string;

  beforeEach(() => {
    HumanAsDetectorLog.resetForTesting();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hadl-persist-'));
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/HumanAsDetectorLog.test.ts' });
    HumanAsDetectorLog.resetForTesting();
  });

  it('NEVER persists messagePreview to disk (the raw user words stay off the audit trail)', () => {
    const log = HumanAsDetectorLog.getInstance();
    log.configure({ stateDir: tmpDir, agentName: 'a' });
    log.observe({ text: "that's wrong — the key is sk-secret-xyz", source: 'telegram', topicId: 1 });

    const jsonl = fs.readFileSync(path.join(tmpDir, 'metrics', 'human-as-detector.jsonl'), 'utf-8').trim();
    const rec = JSON.parse(jsonl);
    expect(rec).not.toHaveProperty('messagePreview');
    expect(jsonl).not.toContain('sk-secret-xyz');
    // metadata IS persisted
    expect(rec.category).toBe('factual-correction');
    expect(rec.topicId).toBe(1);
    // but the live in-memory ring keeps the preview for this session's heat map
    expect(log.getRecent()[0].messagePreview).toContain('sk-secret-xyz');
  });

  it('hydrates the heat map from disk on a fresh instance (survives restart)', () => {
    const log1 = HumanAsDetectorLog.getInstance();
    log1.configure({ stateDir: tmpDir, agentName: 'a' });
    log1.observe({ text: "that's wrong", source: 'telegram', topicId: 1 });
    log1.observe({ text: 'this is out of date', source: 'telegram', topicId: 1 });
    expect(log1.getRecent()).toHaveLength(2);

    // Simulate a restart: brand-new singleton, same stateDir.
    HumanAsDetectorLog.resetForTesting();
    const log2 = HumanAsDetectorLog.getInstance();
    log2.configure({ stateDir: tmpDir, agentName: 'a' });

    // Heat map is restored from disk, not empty.
    expect(log2.getRecent().length).toBe(2);
    const layers = log2.summarizeByLayer();
    expect(layers.reduce((s, e) => s + e.count, 0)).toBe(2);
  });

  it('hydration is a safe no-op when no JSONL exists yet', () => {
    const log = HumanAsDetectorLog.getInstance();
    log.configure({ stateDir: tmpDir, agentName: 'a' });
    expect(log.getRecent()).toEqual([]);
    expect(log.summarizeByLayer()).toEqual([]);
  });
});
