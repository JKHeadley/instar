/**
 * Tests for unanswered message detection logic used in:
 * - compaction-recovery.sh (post-compaction context injection)
 * - telegram-topic-context.sh (per-message UserPromptSubmit hook)
 *
 * The core algorithm: walk through messages in order, tracking consecutive
 * user messages without agent responses. Whatever is left pending at the
 * end are the unanswered messages.
 */

import { describe, it, expect } from 'vitest';

// Pure function that mirrors the Python detection logic in the hooks.
// This is the canonical implementation — hooks replicate it in Python/bash.
function detectUnansweredMessages(
  messages: Array<{ text: string; fromUser: boolean; timestamp?: string }>,
): Array<{ text: string; fromUser: boolean; timestamp?: string }> {
  let pendingUser: typeof messages = [];
  for (const m of messages) {
    const text = m.text?.trim();
    if (!text) continue;
    if (m.fromUser) {
      pendingUser.push(m);
    } else {
      pendingUser = [];
    }
  }
  return pendingUser;
}

describe('Unanswered message detection', () => {
  it('returns empty when agent responded to all messages', () => {
    const msgs = [
      { text: 'Hello', fromUser: true, timestamp: '2026-03-07T01:00' },
      { text: 'Hi there!', fromUser: false, timestamp: '2026-03-07T01:01' },
    ];
    expect(detectUnansweredMessages(msgs)).toEqual([]);
  });

  it('detects single unanswered user message', () => {
    const msgs = [
      { text: 'Hello', fromUser: true, timestamp: '2026-03-07T01:00' },
      { text: 'Hi there!', fromUser: false, timestamp: '2026-03-07T01:01' },
      { text: 'Can you help me?', fromUser: true, timestamp: '2026-03-07T01:02' },
    ];
    const result = detectUnansweredMessages(msgs);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('Can you help me?');
  });

  it('detects multiple consecutive unanswered messages', () => {
    const msgs = [
      { text: 'Done with implementation', fromUser: false, timestamp: '2026-03-07T01:00' },
      { text: 'I think the scope is wrong', fromUser: true, timestamp: '2026-03-07T01:10' },
      { text: 'Hello, please respond', fromUser: true, timestamp: '2026-03-07T01:20' },
    ];
    const result = detectUnansweredMessages(msgs);
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('I think the scope is wrong');
    expect(result[1].text).toBe('Hello, please respond');
  });

  it('resets on agent response between user messages', () => {
    const msgs = [
      { text: 'First question', fromUser: true, timestamp: '2026-03-07T01:00' },
      { text: 'Answer to first', fromUser: false, timestamp: '2026-03-07T01:01' },
      { text: 'Second question', fromUser: true, timestamp: '2026-03-07T01:02' },
      { text: 'Answer to second', fromUser: false, timestamp: '2026-03-07T01:03' },
    ];
    expect(detectUnansweredMessages(msgs)).toEqual([]);
  });

  it('skips empty messages', () => {
    const msgs = [
      { text: 'Agent said something', fromUser: false, timestamp: '2026-03-07T01:00' },
      { text: '', fromUser: true, timestamp: '2026-03-07T01:01' },
      { text: '  ', fromUser: true, timestamp: '2026-03-07T01:02' },
    ];
    expect(detectUnansweredMessages(msgs)).toEqual([]);
  });

  it('handles all-user messages', () => {
    const msgs = [
      { text: 'First', fromUser: true, timestamp: '2026-03-07T01:00' },
      { text: 'Second', fromUser: true, timestamp: '2026-03-07T01:01' },
      { text: 'Third', fromUser: true, timestamp: '2026-03-07T01:02' },
    ];
    const result = detectUnansweredMessages(msgs);
    expect(result).toHaveLength(3);
  });

  it('handles all-agent messages', () => {
    const msgs = [
      { text: 'First', fromUser: false, timestamp: '2026-03-07T01:00' },
      { text: 'Second', fromUser: false, timestamp: '2026-03-07T01:01' },
    ];
    expect(detectUnansweredMessages(msgs)).toEqual([]);
  });

  it('handles empty messages array', () => {
    expect(detectUnansweredMessages([])).toEqual([]);
  });

  it('reproduces the original bug scenario', () => {
    // This is the exact scenario from the Dawn incident:
    // - Agent finished implementing (3 messages)
    // - User sent clarification (unanswered)
    // - User sent follow-up "please respond" (unanswered)
    // - Agent responded with generic "Hey! What's up?" (incoherent)
    const msgs = [
      { text: 'Done! Coherence detection implemented.', fromUser: false, timestamp: '2026-03-07T01:13' },
      { text: 'Done! Message Coherence Detection is implemented.', fromUser: false, timestamp: '2026-03-07T01:13' },
      { text: 'Coherence detection is implemented and build passes.', fromUser: false, timestamp: '2026-03-07T01:13' },
      { text: "I'm confused the chat planner is used for outside Dawn. I'm talking about inside Dawn through telegram", fromUser: true, timestamp: '2026-03-07T01:24' },
      { text: 'Hello, please respond here', fromUser: true, timestamp: '2026-03-07T01:32' },
    ];
    const result = detectUnansweredMessages(msgs);
    expect(result).toHaveLength(2);
    expect(result[0].text).toContain("I'm confused");
    expect(result[1].text).toBe('Hello, please respond here');
  });

  it('correctly handles agent response after unanswered messages clearing the queue', () => {
    // After the bug scenario, if the agent responds, detection should clear
    const msgs = [
      { text: 'Some implementation done', fromUser: false, timestamp: '2026-03-07T01:13' },
      { text: 'Scope seems wrong', fromUser: true, timestamp: '2026-03-07T01:24' },
      { text: 'Hello?', fromUser: true, timestamp: '2026-03-07T01:32' },
      { text: "You're right, let me fix the scope", fromUser: false, timestamp: '2026-03-07T01:33' },
    ];
    expect(detectUnansweredMessages(msgs)).toEqual([]);
  });
});
