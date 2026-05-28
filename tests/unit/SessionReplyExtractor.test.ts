/**
 * Tier-1 unit tests for SessionReplyExtractor — pulling the final assistant
 * message out of a completed mentee session's transcript (the robust reply
 * capture that replaces the racy tmux-pane read).
 */
import { describe, it, expect } from 'vitest';
import { extractCodexFinalMessage, extractClaudeFinalMessage } from '../../src/monitoring/SessionReplyExtractor.js';

describe('extractCodexFinalMessage', () => {
  it('prefers task_complete.last_agent_message (the canonical final reply)', () => {
    const rollout = [
      '{"type":"session_meta","payload":{"id":"x"}}',
      '{"type":"event_msg","payload":{"type":"agent_message","message":"intermediate"}}',
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"item text"}]}}',
      '{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"FINAL clean reply"}}',
    ].join('\n');
    expect(extractCodexFinalMessage(rollout)).toBe('FINAL clean reply');
  });

  it('falls back to the last agent_message event when no task_complete', () => {
    const rollout = [
      '{"type":"event_msg","payload":{"type":"agent_message","message":"first"}}',
      '{"type":"event_msg","payload":{"type":"agent_message","message":"second (latest)"}}',
    ].join('\n');
    expect(extractCodexFinalMessage(rollout)).toBe('second (latest)');
  });

  it('falls back to the last assistant response_item when no agent_message/task_complete', () => {
    const rollout = [
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"assistant reply"}]}}',
      '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"text","text":"a user msg"}]}}',
    ].join('\n');
    expect(extractCodexFinalMessage(rollout)).toBe('assistant reply');
  });

  it('joins multi-block assistant content', () => {
    const rollout = '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"line1"},{"type":"output_text","text":"line2"}]}}';
    expect(extractCodexFinalMessage(rollout)).toBe('line1\nline2');
  });

  it('returns null for empty / no-assistant content + tolerates malformed lines', () => {
    expect(extractCodexFinalMessage('')).toBeNull();
    expect(extractCodexFinalMessage('not json\n{bad\n{"type":"session_meta","payload":{"id":"x"}}')).toBeNull();
  });

  it('ignores empty task_complete + uses the real one', () => {
    const rollout = [
      '{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"  "}}',
      '{"type":"event_msg","payload":{"type":"agent_message","message":"real reply"}}',
    ].join('\n');
    expect(extractCodexFinalMessage(rollout)).toBe('real reply');
  });
});

describe('extractClaudeFinalMessage', () => {
  it('extracts the last assistant text block (top-level type:assistant)', () => {
    const jsonl = [
      '{"type":"user","message":{"content":[{"type":"text","text":"prompt"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"first answer"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"final answer"}]}}',
    ].join('\n');
    expect(extractClaudeFinalMessage(jsonl)).toBe('final answer');
  });

  it('handles string content + role-shaped rows', () => {
    const jsonl = [
      '{"role":"assistant","content":"string reply"}',
    ].join('\n');
    expect(extractClaudeFinalMessage(jsonl)).toBe('string reply');
  });

  it('joins multi-block assistant content + skips non-text blocks', () => {
    const jsonl = '{"type":"assistant","message":{"content":[{"type":"text","text":"part1"},{"type":"tool_use","name":"x"},{"type":"text","text":"part2"}]}}';
    expect(extractClaudeFinalMessage(jsonl)).toBe('part1\npart2');
  });

  it('returns null when no assistant turns + tolerates malformed lines', () => {
    expect(extractClaudeFinalMessage('')).toBeNull();
    expect(extractClaudeFinalMessage('{"type":"user","message":{"content":"hi"}}\nbad line')).toBeNull();
  });
});
