/**
 * Tier-1 unit tests for SessionReplyExtractor — pulling the final assistant
 * message out of a completed mentee session's transcript (the robust reply
 * capture that replaces the racy tmux-pane read).
 */
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { extractCodexFinalMessage, extractClaudeFinalMessage, findClaudeTranscriptShallow } from '../../src/monitoring/SessionReplyExtractor.js';

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

describe('findClaudeTranscriptShallow — depth-1 transcript locator (Stage-A capture fix)', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-projects-'));
  });
  afterEach(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('finds the transcript one level down (the real Claude layout: <projects>/<encoded-cwd>/<id>.jsonl)', () => {
    const cwdDir = path.join(root, '-Users-justin--instar-agents-echo');
    fs.mkdirSync(cwdDir, { recursive: true });
    const target = path.join(cwdDir, 'sess-abc-123.jsonl');
    fs.writeFileSync(target, '{"type":"assistant","message":{"content":"hi"}}');
    expect(findClaudeTranscriptShallow(root, 'sess-abc-123')).toBe(target);
  });

  it('finds the transcript at the projects root, too (defensive)', () => {
    const target = path.join(root, 'root-level-id.jsonl');
    fs.writeFileSync(target, '{}');
    expect(findClaudeTranscriptShallow(root, 'root-level-id')).toBe(target);
  });

  it('REGRESSION: still finds it at depth 1 amid a huge unrelated deep subtree (where the recursive walk gave up)', () => {
    // Build a deep unrelated subtree — the kind of structure that exhausted the
    // old recursive walk's 10k-step budget before it reached the real file.
    let deep = path.join(root, 'noise-cwd');
    fs.mkdirSync(deep, { recursive: true });
    for (let i = 0; i < 50; i++) {
      deep = path.join(deep, `nested-${i}`);
      fs.mkdirSync(deep);
    }
    // Many sibling encoded-cwd dirs, each with their own unrelated transcripts.
    for (let i = 0; i < 30; i++) {
      const d = path.join(root, `-Users-justin-other-project-${i}`);
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, `unrelated-${i}.jsonl`), '{}');
    }
    // The real one is at depth 1 in its own encoded-cwd dir.
    const cwdDir = path.join(root, '-Users-justin--instar-agents-echo');
    fs.mkdirSync(cwdDir);
    const target = path.join(cwdDir, 'the-real-session.jsonl');
    fs.writeFileSync(target, '{"type":"assistant","message":{"content":"found"}}');
    expect(findClaudeTranscriptShallow(root, 'the-real-session')).toBe(target);
  });

  it('does NOT descend into nested subdirs (a transcript buried >1 level deep is intentionally not matched)', () => {
    // Claude never writes here, so we must NOT pay the recursive-walk cost to find it.
    const buried = path.join(root, 'cwd', 'deeper');
    fs.mkdirSync(buried, { recursive: true });
    fs.writeFileSync(path.join(buried, 'buried-id.jsonl'), '{}');
    expect(findClaudeTranscriptShallow(root, 'buried-id')).toBeNull();
  });

  it('returns null on missing dir / empty inputs (no throw)', () => {
    expect(findClaudeTranscriptShallow(path.join(root, 'does-not-exist'), 'x')).toBeNull();
    expect(findClaudeTranscriptShallow('', 'x')).toBeNull();
    expect(findClaudeTranscriptShallow(root, '')).toBeNull();
  });
});
