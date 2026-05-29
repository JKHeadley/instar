import { describe, expect, it } from 'vitest';
import {
  normalizeAttentionPriority,
  normalizeAttentionStatus,
} from '../../src/server/attentionApi.js';

describe('attention API vocabulary normalization', () => {
  it('keeps canonical internal statuses unchanged', () => {
    expect(normalizeAttentionStatus('OPEN')).toBe('OPEN');
    expect(normalizeAttentionStatus('ACKNOWLEDGED')).toBe('ACKNOWLEDGED');
    expect(normalizeAttentionStatus('IN_PROGRESS')).toBe('IN_PROGRESS');
    expect(normalizeAttentionStatus('DONE')).toBe('DONE');
    expect(normalizeAttentionStatus('WONT_DO')).toBe('WONT_DO');
  });

  it('accepts documented and command-shaped status aliases', () => {
    expect(normalizeAttentionStatus('resolved')).toBe('DONE');
    expect(normalizeAttentionStatus('done')).toBe('DONE');
    expect(normalizeAttentionStatus('ack')).toBe('ACKNOWLEDGED');
    expect(normalizeAttentionStatus('in-progress')).toBe('IN_PROGRESS');
    expect(normalizeAttentionStatus('wontdo')).toBe('WONT_DO');
    expect(normalizeAttentionStatus('reopen')).toBe('OPEN');
  });

  it('normalizes documented priority aliases while storing canonical values', () => {
    expect(normalizeAttentionPriority(undefined)).toBe('NORMAL');
    expect(normalizeAttentionPriority('medium')).toBe('NORMAL');
    expect(normalizeAttentionPriority('normal')).toBe('NORMAL');
    expect(normalizeAttentionPriority('HIGH')).toBe('HIGH');
    expect(normalizeAttentionPriority('critical')).toBe('URGENT');
  });

  it('rejects unknown status and priority values', () => {
    expect(normalizeAttentionStatus('archived')).toBeNull();
    expect(normalizeAttentionPriority('later')).toBeNull();
  });
});
