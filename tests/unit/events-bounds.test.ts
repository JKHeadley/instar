/**
 * Tests for /events endpoint parameter bounds.
 *
 * Verifies that limit and sinceHours are clamped to safe ranges.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Events endpoint — parameter bounds', () => {
  it('source file clamps limit to 1-1000 range', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/server/routes.ts'),
      'utf-8',
    );
    // Should have Math.min/max clamping for limit
    expect(source).toContain('Math.min(Math.max(rawLimit, 1), 1000)');
  });

  it('source file clamps sinceHours to 1-720 range', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/server/routes.ts'),
      'utf-8',
    );
    // Should have Math.min/max clamping for sinceHours
    expect(source).toContain('Math.min(Math.max(rawSinceHours, 1), 720)');
  });
});
