/**
 * Unit tests — resolveThreadlineMcpEntry.
 *
 * Single source of truth for an agent's Threadline MCP stdio launch
 * {command, args}, shared between ThreadlineBootstrap (config registration)
 * and the per-spawn Codex `-c` override (CODEX-MULTIAGENT-THREADLINE-SPEC).
 */

import { describe, it, expect } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { resolveThreadlineMcpEntry } from '../../src/threadline/mcpEntry.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('resolveThreadlineMcpEntry', () => {
  it('returns node + mcp-stdio-entry path + identity flags', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-entry-'));
    try {
      const entry = resolveThreadlineMcpEntry(dir, `${dir}/.instar`, 'echo');
      expect(entry.command).toBe('node');
      expect(entry.args[0]).toMatch(/mcp-stdio-entry\.js$/);
      expect(entry.args).toContain('--state-dir');
      expect(entry.args).toContain(`${dir}/.instar`);
      expect(entry.args).toContain('--agent-name');
      expect(entry.args).toContain('echo');
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/threadline-mcp-entry.test.ts:cleanup' });
    }
  });

  it('prefers the project-local instar install when present', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-entry-proj-'));
    const localEntry = path.join(dir, 'node_modules', 'instar', 'dist', 'threadline');
    fs.mkdirSync(localEntry, { recursive: true });
    fs.writeFileSync(path.join(localEntry, 'mcp-stdio-entry.js'), '// stub');
    try {
      const entry = resolveThreadlineMcpEntry(dir, `${dir}/.instar`, 'codey');
      expect(entry.args[0]).toBe(path.join(localEntry, 'mcp-stdio-entry.js'));
      expect(entry.args).toContain('codey');
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/threadline-mcp-entry.test.ts:cleanup' });
    }
  });

  it('distinct agents resolve distinct identity args (no collision)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-entry-multi-'));
    try {
      const echo = resolveThreadlineMcpEntry(dir, '/agents/echo/.instar', 'echo');
      const codey = resolveThreadlineMcpEntry(dir, '/agents/codey/.instar', 'instar-codey');
      expect(echo.args).toContain('echo');
      expect(echo.args).toContain('/agents/echo/.instar');
      expect(codey.args).toContain('instar-codey');
      expect(codey.args).toContain('/agents/codey/.instar');
      expect(echo.args).not.toEqual(codey.args);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/threadline-mcp-entry.test.ts:cleanup' });
    }
  });
});
