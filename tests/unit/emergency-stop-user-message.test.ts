/**
 * Unit: the text a PERSON is shown after an emergency stop tells the truth in
 * all three states — no session, stopped, and tried-to-stop-but-could-not.
 *
 * W26 lane 1 addendum. Both stop paths used to branch this text on whether a
 * session NAME resolved, so a failed kill still told the operator
 * "Session terminated." while the API said killed:false. The helper is the one
 * source both paths read; the adapter test below drives the conversational
 * path end-to-end through processUpdate and reads what was sent.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  emergencyStopOutcome,
  emergencyStopUserMessage,
  EMERGENCY_STOP_USER_MESSAGES,
} from '../../src/messaging/shared/emergencyStopUserMessage.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const SESSION = 'echo-topic-4242-worker';

describe('emergencyStopUserMessage — three states, three truths', () => {
  it('no session bound → "No active session to stop." regardless of the kill flag', () => {
    expect(emergencyStopOutcome(null, false)).toBe('no-session');
    expect(emergencyStopOutcome(undefined, true)).toBe('no-session');
    expect(emergencyStopOutcome('', true)).toBe('no-session');
    expect(emergencyStopUserMessage(null, true)).toBe('No active session to stop.');
  });

  it('session bound + kill landed → terminated', () => {
    expect(emergencyStopOutcome(SESSION, true)).toBe('killed');
    expect(emergencyStopUserMessage(SESSION, true)).toMatch(/^Session terminated\./);
  });

  it('session bound + kill did NOT land → says still running AND that the stop was recorded, never "terminated"', () => {
    expect(emergencyStopOutcome(SESSION, false)).toBe('kill-failed');
    const msg = emergencyStopUserMessage(SESSION, false);
    expect(msg).not.toMatch(/terminated/i);
    expect(msg).toMatch(/still running/i);
    expect(msg).toMatch(/recorded/i);
  });

  it('an unset/non-boolean outcome never reads as success', () => {
    // A truthy-but-not-true value (e.g. a stray object or 1) is NOT a kill.
    expect(emergencyStopOutcome(SESSION, 1 as unknown as boolean)).toBe('kill-failed');
    expect(emergencyStopOutcome(SESSION, undefined as unknown as boolean)).toBe('kill-failed');
  });

  it('every message is plain English — no session names, paths, or identifiers', () => {
    for (const msg of Object.values(EMERGENCY_STOP_USER_MESSAGES)) {
      expect(msg).not.toContain(SESSION);
      expect(msg).not.toMatch(/\.instar|\/Users\/|tmux|\.local\.md|topic \d+/i);
    }
  });
});

describe('TelegramAdapter conversational emergency-stop — the user is told the truth', () => {
  let tmpDir: string;
  let adapter: TelegramAdapter;
  let sent: string[];

  function textUpdate(topic: number, text: string) {
    return {
      update_id: 1,
      message: {
        message_id: 1,
        message_thread_id: topic,
        date: Math.floor(Date.now() / 1000),
        text,
        from: { id: 4242, first_name: 'Op', username: 'op' },
        chat: { id: -1001, type: 'supergroup' },
      },
    };
  }

  function writeAutonomousJob(topic: number): string {
    const dir = path.join(tmpDir, 'autonomous');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${topic}.local.md`);
    fs.writeFileSync(
      file,
      `---\nactive: true\npaused: false\nreport_topic: "${topic}"\nstarted_at: "2026-08-24T00:00:00.000Z"\n---\n\nlive notes\n`,
    );
    return file;
  }

  async function stop(topic: number, killOutcome: boolean): Promise<void> {
    (adapter as unknown as { topicToSession: Map<number, string> }).topicToSession.set(topic, SESSION);
    adapter.onSentinelKillSession = () => killOutcome;
    adapter.onSentinelIntercept = async () => ({
      category: 'emergency-stop' as const,
      action: { type: 'kill' },
      reason: 'stop everything',
    });
    await (adapter as unknown as { processUpdate: (u: unknown) => Promise<void> }).processUpdate(
      textUpdate(topic, 'stop everything'),
    );
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-stop-user-msg-'));
    sent = [];
    // Tokenless adapter: no polling — but processUpdate runs. Capture what the
    // person in the topic would have been sent.
    adapter = new TelegramAdapter({ token: '' } as never, tmpDir);
    adapter.sendToTopic = async (_topic: number, text: string) => { sent.push(text); };
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'emergency-stop-user-message:cleanup' });
  });

  it('kill landed → the person is told "Session terminated."', async () => {
    const topic = 4242;
    const file = writeAutonomousJob(topic);
    await stop(topic, true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^Session terminated\./);
    expect(fs.readFileSync(file, 'utf8')).toMatch(/^active: false$/m); // record preserved
  });

  it('kill FAILED → the person is told the session is still running and the stop was recorded — never "terminated"', async () => {
    const topic = 4243;
    const file = writeAutonomousJob(topic);
    await stop(topic, false);
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toMatch(/terminated/i);
    expect(sent[0]).toMatch(/still running/i);
    expect(sent[0]).toMatch(/recorded/i);
    expect(sent[0]).not.toContain(SESSION);
    // The half that already worked keeps working alongside the failure.
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toMatch(/^active: false$/m);
  });
});
