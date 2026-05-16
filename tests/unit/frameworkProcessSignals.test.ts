/**
 * Unit tests — frameworkProcessSignals.
 *
 * Verifies the per-framework predicates the OrphanProcessReaper uses
 * to distinguish Claude vs Codex vs helper processes from a raw `ps`
 * command line.
 *
 * The original Claude-only test cases (from
 * tests/unit/OrphanProcessReaper.test.ts) are preserved as-is and
 * extended with parallel Codex cases.
 */

import { describe, it, expect } from 'vitest';
import {
  matchProcessSignal,
  listProcessSignals,
  getProcessSignal,
  listCommonHelperProcesses,
} from '../../src/monitoring/frameworkProcessSignals.js';

describe('frameworkProcessSignals', () => {
  describe('listProcessSignals', () => {
    it('enumerates every framework supported by the factory', () => {
      const frameworks = listProcessSignals().map(s => s.framework).sort();
      expect(frameworks).toEqual(['claude-code', 'codex-cli']);
    });

    it('every signal has a populated grep needle, binary pattern, and display name', () => {
      for (const signal of listProcessSignals()) {
        expect(signal.psGrepNeedle).toMatch(/^\[\w\]\w+$/);
        expect(signal.binaryPattern).toBeInstanceOf(RegExp);
        expect(signal.nodePattern).toBeInstanceOf(RegExp);
        expect(typeof signal.displayName).toBe('string');
        expect(signal.displayName.length).toBeGreaterThan(0);
      }
    });
  });

  describe('getProcessSignal', () => {
    it('returns the claude-code signal', () => {
      const s = getProcessSignal('claude-code');
      expect(s?.framework).toBe('claude-code');
      expect(s?.displayName).toBe('Claude');
    });

    it('returns the codex-cli signal', () => {
      const s = getProcessSignal('codex-cli');
      expect(s?.framework).toBe('codex-cli');
      expect(s?.displayName).toBe('Codex');
    });
  });

  describe('listCommonHelperProcesses', () => {
    it('includes the well-known helpers that share Claude-prefix paths', () => {
      const helpers = listCommonHelperProcesses();
      expect(helpers).toContain('cloudflared');
      expect(helpers).toContain('caffeinate');
      expect(helpers).toContain('grep');
    });
  });

  describe('matchProcessSignal — Claude (regression coverage)', () => {
    it('matches claude binary directly', () => {
      expect(matchProcessSignal('claude --print "hello"')?.framework).toBe('claude-code');
    });

    it('matches claude via full path', () => {
      expect(matchProcessSignal('/usr/local/bin/claude --print "test"')?.framework).toBe('claude-code');
    });

    it('matches @anthropic-ai/claude-code', () => {
      expect(matchProcessSignal('node /home/.npm/node_modules/@anthropic-ai/claude-code/cli.js')?.framework).toBe('claude-code');
    });

    it('rejects cloudflared (false positive from demiclaude path)', () => {
      expect(matchProcessSignal('cloudflared tunnel --url http://localhost:3030')).toBeNull();
    });

    it('rejects node server in claude-containing path', () => {
      expect(matchProcessSignal('node /home/agents/demiclaude/server/dist/index.js')).toBeNull();
    });

    it('rejects caffeinate helper', () => {
      expect(matchProcessSignal('caffeinate -i')).toBeNull();
    });

    it('rejects MCP servers', () => {
      expect(matchProcessSignal('/usr/local/bin/claude-in-chrome --mcp')).toBeNull();
    });

    it('rejects grep for claude (self-referential)', () => {
      expect(matchProcessSignal('grep -i claude /var/log/messages')).toBeNull();
    });

    it('rejects path that merely contains claude as substring', () => {
      expect(matchProcessSignal('/opt/preclaude/bin/server start')).toBeNull();
    });
  });

  describe('matchProcessSignal — Codex', () => {
    it('matches codex binary directly', () => {
      expect(matchProcessSignal('codex exec "summarize this"')?.framework).toBe('codex-cli');
    });

    it('matches codex via full path', () => {
      expect(matchProcessSignal('/usr/local/bin/codex --resume sess-1')?.framework).toBe('codex-cli');
    });

    it('matches @openai/codex npm path', () => {
      expect(matchProcessSignal('node /home/.npm/node_modules/@openai/codex/cli.js')?.framework).toBe('codex-cli');
    });

    it('matches codex-cli/cli path', () => {
      expect(matchProcessSignal('node /Users/x/.local/share/codex-cli/cli/index.js')?.framework).toBe('codex-cli');
    });

    it('rejects path that merely contains codex as substring (e.g., precodex)', () => {
      expect(matchProcessSignal('/opt/precodex/bin/server start')).toBeNull();
    });

    it('rejects codex MCP servers', () => {
      expect(matchProcessSignal('/usr/local/bin/codex-mcp serve')).toBeNull();
    });

    it('rejects vscode-codex helper', () => {
      expect(matchProcessSignal('node /opt/vscode-codex/helper.js')).toBeNull();
    });
  });

  describe('matchProcessSignal — mutual exclusion', () => {
    it('Claude commands do NOT match the codex framework', () => {
      const sig = matchProcessSignal('claude --print "hello"');
      expect(sig?.framework).not.toBe('codex-cli');
    });

    it('Codex commands do NOT match the claude-code framework', () => {
      const sig = matchProcessSignal('codex exec "do thing"');
      expect(sig?.framework).not.toBe('claude-code');
    });

    it('respects custom signal scope — only-Claude restriction', () => {
      const onlyClaude = listProcessSignals().filter(s => s.framework === 'claude-code');
      expect(matchProcessSignal('codex exec "x"', onlyClaude)).toBeNull();
    });
  });
});
