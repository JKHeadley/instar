import { describe, it, expect } from 'vitest';

/**
 * Tests for OrphanProcessReaper.isClaudeCodeProcess fix.
 *
 * The bug: grep -i '[c]laude' matches ANY process with "claude" as a substring
 * in its path (e.g., /agents/demiclaude/server), and isClaudeCodeProcess()
 * used command.includes('claude') which also matched substrings.
 *
 * Since isClaudeCodeProcess is private, we test via the class's public scan()
 * by mocking shellExec. For now, test the regex logic directly.
 */

describe('OrphanProcessReaper — isClaudeCodeProcess logic', () => {
  // Replicate the fixed logic for direct testing
  function isClaudeCodeProcess(command: string): boolean {
    const helperProcesses = [
      'cloudflared', 'caffeinate', 'tee', 'tail', 'cat', 'grep',
    ];
    const cmdTrimmed = command.trimStart();
    for (const helper of helperProcesses) {
      if (cmdTrimmed.startsWith(helper)) return false;
    }

    const claudeBinaryPattern = /(^|\/)claude(\s|$)/;
    const claudeNodePattern = /@anthropic-ai\/claude-code|claude-code\/cli/;

    if (claudeBinaryPattern.test(command) || claudeNodePattern.test(command)) {
      const exclusions = [
        'claude-in-chrome', 'claude-mcp', 'playwright-mcp',
        'mcp-remote', 'exa-mcp', 'payments-mcp',
      ];
      return !exclusions.some(e => command.includes(e));
    }

    return false;
  }

  it('matches claude binary directly', () => {
    expect(isClaudeCodeProcess('claude --print "hello"')).toBe(true);
  });

  it('matches claude via full path', () => {
    expect(isClaudeCodeProcess('/usr/local/bin/claude --print "test"')).toBe(true);
  });

  it('matches @anthropic-ai/claude-code', () => {
    expect(isClaudeCodeProcess('node /home/.npm/node_modules/@anthropic-ai/claude-code/cli.js')).toBe(true);
  });

  it('rejects cloudflared (false positive from demiclaude path)', () => {
    expect(isClaudeCodeProcess('cloudflared tunnel --url http://localhost:3030')).toBe(false);
  });

  it('rejects node server in claude-containing path', () => {
    expect(isClaudeCodeProcess('node /home/agents/demiclaude/server/dist/index.js')).toBe(false);
  });

  it('rejects caffeinate helper', () => {
    expect(isClaudeCodeProcess('caffeinate -i')).toBe(false);
  });

  it('rejects MCP servers', () => {
    expect(isClaudeCodeProcess('/usr/local/bin/claude-in-chrome --mcp')).toBe(false);
  });

  it('rejects grep for claude (self-referential)', () => {
    expect(isClaudeCodeProcess('grep -i claude /var/log/messages')).toBe(false);
  });

  it('rejects path that merely contains claude as substring', () => {
    expect(isClaudeCodeProcess('/opt/preclaude/bin/server start')).toBe(false);
  });
});
