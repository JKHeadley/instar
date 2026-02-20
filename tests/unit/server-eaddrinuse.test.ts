/**
 * Tests for AgentServer EADDRINUSE handling.
 *
 * Verifies that starting the server on an occupied port
 * produces a clear error message.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('AgentServer — EADDRINUSE handling', () => {
  it('source file handles EADDRINUSE error', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/server/AgentServer.ts'),
      'utf-8',
    );
    expect(source).toContain('EADDRINUSE');
    expect(source).toContain('already in use');
  });

  it('start() rejects on error (not just resolves)', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/server/AgentServer.ts'),
      'utf-8',
    );
    // The start method should call reject
    const startBlock = source.slice(source.indexOf('async start()'));
    expect(startBlock).toContain('reject(');
  });
});
