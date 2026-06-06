/**
 * Wiring integrity: the live-tail version gate (the 2026-06-05 event-loop-stall
 * fix) must be wired in server.ts — the LiveTailSource construction has to pass
 * getTopicVersion through to the adapter's getTopicContentVersion. The gate is a
 * pure unit (LiveTailSource skips unchanged topics); without this dep wired, the
 * source falls back to pre-fix behavior — serializing EVERY topic's history on
 * EVERY tick — and the fix is "constructed but inert", the exact failure mode
 * the Testing Integrity Standard calls out. The handoff path must also force
 * (bypass gate + backoff) or a mid-backoff topic silently drops from handoffs.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('server-boot wiring: live-tail version gate', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf-8');

  it('passes the adapter version signal into the LiveTailSource construction', () => {
    const idx = src.indexOf('new LiveTailSource({');
    expect(idx).toBeGreaterThan(0);
    const block = src.slice(idx, idx + 1200);
    expect(block).toContain('getTopicVersion: (topic) => telegram.getTopicContentVersion(Number(topic))');
  });

  it('the handoff boot wiring forces its flush (bypasses gate + backoff)', () => {
    const wiring = fs.readFileSync(path.join(process.cwd(), 'src/core/handoffSentinelBootWiring.ts'), 'utf-8');
    expect(wiring).toContain('pushTick({ force: true })');
  });
});
