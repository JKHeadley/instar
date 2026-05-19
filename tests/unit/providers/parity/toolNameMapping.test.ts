/**
 * Unit tests for toolNameMapping.
 *
 * Spec: specs/instar-concepts/tool.md
 *
 * Covers: every canonical name has both Claude + Codex native renderings;
 * MCP-tool prefix handling on both frameworks; unknown canonical returns null
 * (hard error for caller, not silent drop).
 */

import { describe, it, expect } from 'vitest';
import {
  TOOL_NAME_MAPPING,
  renderCanonicalToolName,
  renderCanonicalToolList,
  listCanonicalToolNames,
} from '../../../../src/providers/parity/toolNameMapping.js';

describe('TOOL_NAME_MAPPING table', () => {
  it('has at least 12 canonical entries', () => {
    expect(TOOL_NAME_MAPPING.length).toBeGreaterThanOrEqual(12);
  });

  it('every entry has non-empty canonical + claude + codex fields', () => {
    for (const e of TOOL_NAME_MAPPING) {
      expect(e.canonical).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(e.claude.length).toBeGreaterThan(0);
      expect(e.codex.length).toBeGreaterThan(0);
    }
  });

  it('canonical names are unique', () => {
    const seen = new Set<string>();
    for (const e of TOOL_NAME_MAPPING) {
      expect(seen.has(e.canonical)).toBe(false);
      seen.add(e.canonical);
    }
  });

  it('Claude uses PascalCase for built-ins', () => {
    for (const e of TOOL_NAME_MAPPING) {
      expect(e.claude[0]).toMatch(/[A-Z]/);
    }
  });

  it('Codex uses snake_case for built-ins', () => {
    for (const e of TOOL_NAME_MAPPING) {
      expect(e.codex).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

describe('renderCanonicalToolName — built-ins', () => {
  it('renders read to framework-native', () => {
    expect(renderCanonicalToolName('read', 'claude-code')).toBe('Read');
    expect(renderCanonicalToolName('read', 'codex-cli')).toBe('view');
  });

  it('renders bash to framework-native', () => {
    expect(renderCanonicalToolName('bash', 'claude-code')).toBe('Bash');
    expect(renderCanonicalToolName('bash', 'codex-cli')).toBe('shell');
  });

  it('renders edit and write both to apply_patch on Codex', () => {
    expect(renderCanonicalToolName('edit', 'codex-cli')).toBe('apply_patch');
    expect(renderCanonicalToolName('write', 'codex-cli')).toBe('apply_patch');
    expect(renderCanonicalToolName('edit', 'claude-code')).toBe('Edit');
    expect(renderCanonicalToolName('write', 'claude-code')).toBe('Write');
  });

  it('returns null for unknown canonical names (hard error for caller)', () => {
    expect(renderCanonicalToolName('nonexistent', 'claude-code')).toBeNull();
    expect(renderCanonicalToolName('nonexistent', 'codex-cli')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(renderCanonicalToolName('', 'claude-code')).toBeNull();
  });
});

describe('renderCanonicalToolName — MCP tools', () => {
  it('renders mcp:server:tool to Claude double-underscore form', () => {
    expect(renderCanonicalToolName('mcp:github:list_issues', 'claude-code')).toBe(
      'mcp__github__list_issues',
    );
  });

  it('renders mcp:server:tool to Codex dotted form', () => {
    expect(renderCanonicalToolName('mcp:github:list_issues', 'codex-cli')).toBe(
      'mcp.github.list_issues',
    );
  });

  it('handles server names with hyphens', () => {
    expect(renderCanonicalToolName('mcp:claude-in-chrome:tabs_create', 'claude-code')).toBe(
      'mcp__claude-in-chrome__tabs_create',
    );
    expect(renderCanonicalToolName('mcp:claude-in-chrome:tabs_create', 'codex-cli')).toBe(
      'mcp.claude-in-chrome.tabs_create',
    );
  });

  it('handles tool names with hyphens and underscores', () => {
    expect(renderCanonicalToolName('mcp:fathom:get-meeting_summary', 'claude-code')).toBe(
      'mcp__fathom__get-meeting_summary',
    );
  });

  it('returns null for malformed mcp prefix (missing tool segment)', () => {
    expect(renderCanonicalToolName('mcp:github', 'claude-code')).toBeNull();
  });

  it('returns null for malformed mcp prefix (empty server)', () => {
    expect(renderCanonicalToolName('mcp::list_issues', 'claude-code')).toBeNull();
  });
});

describe('renderCanonicalToolList', () => {
  it('translates a list, surfacing unknowns as null', () => {
    const result = renderCanonicalToolList(
      ['read', 'bash', 'unknown', 'mcp:github:list_issues'],
      'claude-code',
    );
    expect(result).toEqual([
      { canonical: 'read', native: 'Read' },
      { canonical: 'bash', native: 'Bash' },
      { canonical: 'unknown', native: null },
      { canonical: 'mcp:github:list_issues', native: 'mcp__github__list_issues' },
    ]);
  });

  it('preserves order', () => {
    const input = ['glob', 'grep', 'read', 'edit'];
    const result = renderCanonicalToolList(input, 'codex-cli');
    expect(result.map((r) => r.canonical)).toEqual(input);
  });

  it('handles empty list', () => {
    expect(renderCanonicalToolList([], 'claude-code')).toEqual([]);
  });
});

describe('listCanonicalToolNames', () => {
  it('returns all canonical names in registration order', () => {
    const names = listCanonicalToolNames();
    expect(names.length).toBe(TOOL_NAME_MAPPING.length);
    expect(names[0]).toBe('read');
    expect(names).toContain('bash');
    expect(names).toContain('grep');
  });
});

describe('cross-framework coverage', () => {
  it('every canonical name resolves on every supported framework', () => {
    for (const canonical of listCanonicalToolNames()) {
      expect(renderCanonicalToolName(canonical, 'claude-code')).not.toBeNull();
      expect(renderCanonicalToolName(canonical, 'codex-cli')).not.toBeNull();
    }
  });
});
