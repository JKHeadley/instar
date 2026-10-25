import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('lifeline queue reason wiring', () => {
  it('classifies healthy handoff failures separately from verified outages', () => {
    const source = fs.readFileSync(path.resolve('src/lifeline/TelegramLifeline.ts'), 'utf8');
    expect(source.match(/queueReason: 'healthy-forward-failed'/g)?.length).toBeGreaterThanOrEqual(1);
    expect(source.match(/queueReason: 'server-unhealthy'/g)?.length).toBeGreaterThanOrEqual(1);
    // Each media path uses the captured verdict for both persistence and ACK policy.
    expect(source.match(/serverWasHealthy \? 'healthy-forward-failed' : 'server-unhealthy'/g)?.length).toBe(4);
    expect(source).toContain('buildQueueDeliveryNotices(counts)');
  });
});
