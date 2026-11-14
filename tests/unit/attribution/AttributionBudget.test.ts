import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AttributionBudget } from '../../../src/core/attribution/AttributionBudget.js';
import { PinStore } from '../../../src/core/attribution/PinStore.js';
import { mightCreditSomeone } from '../../../src/core/attribution/prefilter.js';
import type { SourceRef } from '../../../src/core/attribution/marker.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

describe('AttributionBudget', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attr-budget-')); });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/attribution/AttributionBudget.test.ts:cleanup' }); });

  it('keeps write and send apart, so sends cannot starve the write gate', () => {
    const budget = new AttributionBudget({ stateDir: dir, limits: { write: 1, send: 1 } });
    expect(budget.take('send')).toBe(true);
    expect(budget.take('send')).toBe(false);
    expect(budget.take('write')).toBe(true);
    expect(budget.take('write')).toBe(false);
    expect(budget.snapshot().counters.overBudget).toBe(2);
  });

  it('a restart does not reset the budget', () => {
    new AttributionBudget({ stateDir: dir, limits: { write: 1 } }).take('write');
    expect(new AttributionBudget({ stateDir: dir, limits: { write: 1 } }).take('write')).toBe(false);
  });

  it('the budget rolls at the date; the counters run on', () => {
    let now = new Date('2026-11-05T23:00:00Z');
    const budget = new AttributionBudget({ stateDir: dir, limits: { write: 1 }, now: () => now });
    budget.take('write');
    budget.count('hookTimeouts');
    now = new Date('2026-11-06T01:00:00Z');
    expect(budget.take('write')).toBe(true);
    expect(budget.snapshot().counters.hookTimeouts).toBe(1);
  });

  it('a corrupt file starts fresh rather than failing', () => {
    fs.mkdirSync(path.join(dir, 'attribution'));
    fs.writeFileSync(path.join(dir, 'attribution', 'budget.json'), '{oops');
    expect(new AttributionBudget({ stateDir: dir }).take('send')).toBe(true);
  });

  it('defaults to the spec\'s daily numbers', () => {
    expect(new AttributionBudget({ stateDir: dir }).snapshot().limits).toEqual({ write: 200, send: 300 });
  });
});

describe('PinStore', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attr-pins-')); });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/attribution/AttributionBudget.test.ts:cleanup' }); });
  const ref = (message: string): SourceRef => ({ channel: 'telegram', conversation: '1', message, date: '2026-10-08' });

  it('copies a row once, scrubbed, to a private file that survives a restart', () => {
    const store = new PinStore({ stateDir: dir, scrub: (t) => t.replace('secret', '[x]') });
    store.pin(ref('1'), { text: 'a secret' }, 'human');
    store.pin(ref('1'), { text: 'changed' }, 'human');
    const again = new PinStore({ stateDir: dir });
    expect(again.read(ref('1'))).toEqual({ text: 'a [x]' });
    expect(again.readPin(ref('1'))?.authorship).toBe('human');
    expect(again.size).toBe(1);
    expect(fs.statSync(path.join(dir, 'attribution', 'pins.jsonl')).mode & 0o777).toBe(0o600);
  });

  it('keeps only the words and what eligibility reads: a signed body or a text ref stays out', () => {
    const store = new PinStore({ stateDir: dir, scrub: (t) => t.replace('secret', '[x]') });
    store.pin(ref('1'), { text: 'a secret', role: 'operator', senderRole: 'owner', origin: { bodyB64: 'c2VjcmV0' }, textRef: { kind: 'inline', text: 'a secret' } }, undefined);
    expect(store.read(ref('1'))).toEqual({ text: 'a [x]', role: 'operator', senderRole: 'owner', origin: { present: true } });
    expect(fs.readFileSync(path.join(dir, 'attribution', 'pins.jsonl'), 'utf8')).not.toContain('secret');
  });

  it('nothing is evicted: past the memory limit an older pin reads from the file', () => {
    const store = new PinStore({ stateDir: dir, maxInMemory: 1 });
    store.pin(ref('1'), { text: 'old' }, undefined);
    store.pin(ref('2'), { text: 'new' }, undefined);
    expect(store.read(ref('1'))).toEqual({ text: 'old' });
    expect(store.size).toBe(2);
  });

  it('drops a pin from memory and from the file', () => {
    const store = new PinStore({ stateDir: dir });
    store.pin(ref('1'), { text: 'keep' }, undefined);
    store.pin(ref('2'), { text: 'gone' }, undefined);
    store.drop(ref('2'));
    expect(store.read(ref('2'))).toBeNull();
    expect(fs.readFileSync(path.join(dir, 'attribution', 'pins.jsonl'), 'utf8')).not.toContain('gone');
    expect(new PinStore({ stateDir: dir }).read(ref('1'))).toEqual({ text: 'keep' });
  });
});

describe('mightCreditSomeone', () => {
  it('passes a known name or a credit word, and skips the rest', () => {
    expect(mightCreditSomeone('Justin wants this', ['Justin'])).toBe(true);
    expect(mightCreditSomeone('he said so', [])).toBe(true);
    expect(mightCreditSomeone('we agreed', [])).toBe(true);
    expect(mightCreditSomeone('The build finished in 40s.', ['Justin'])).toBe(false);
  });
});
