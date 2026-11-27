/**
 * Unit: the command reporter's event name and session id, both copies of the script, the
 * server-side bounds on the fields it forwards (2026-11-21).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { boundCommandReporterPayload } from '../../src/monitoring/NativeHookEvents.js';

const initSource = fs.readFileSync(path.join(__dirname, '../../src/commands/init.ts'), 'utf8');

function migratorScript(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-reporter-unit-'));
  const m = new PostUpdateMigrator({ projectDir: root, stateDir: path.join(root, '.instar'), port: 4321, hasTelegram: false, projectName: 't' });
  return (m as unknown as { getHookEventReporterScript(): string }).getHookEventReporterScript();
}

describe('command hook reporter script', () => {
  it('names the event from hook_event_name and sends the instar session id (update copy)', () => {
    const s = migratorScript();
    expect(s).toContain('event: input.hook_event_name || input.hook_event ||');
    expect(s).toContain('instar_session_id: id(instarSid),');
  });
  it('the init copy carries the same two lines (new agents)', () => {
    expect(initSource).toContain('event: input.hook_event_name || input.hook_event ||');
    expect(initSource).toContain('instar_session_id: id(instarSid),');
  });
});

describe('boundCommandReporterPayload', () => {
  it('sets the route\'s session id over any payload value, and drops it when the route has none', () => {
    const p: Record<string, unknown> = { event: 'Stop', instar_session_id: 'forged' };
    boundCommandReporterPayload(p, 'inc-1');
    expect(p.instar_session_id).toBe('inc-1');
    const q: Record<string, unknown> = { event: 'Stop', instar_session_id: 'forged' };
    boundCommandReporterPayload(q, '');
    expect(q.instar_session_id).toBeUndefined();
  });
  it('keeps valid fields, drops ones that fail their bound, and tails long text to 200 characters', () => {
    const p: Record<string, unknown> = {
      event: 'SubagentStop', agent_id: 'agent-77', agent_type: 'Explore', task_id: 'bad id with spaces',
      agent_transcript_path: 'relative/path.jsonl', reason: 'x'.repeat(65), trigger: 'manual',
      last_assistant_message: 'a'.repeat(1000) + 'TAIL', task_subject: null, tool_name: 'Bash',
    };
    boundCommandReporterPayload(p, 'inc-1');
    expect(p.agent_id).toBe('agent-77');
    expect(p.agent_type).toBe('Explore');
    expect(p.trigger).toBe('manual');
    expect(p.task_id).toBeUndefined();
    expect(p.agent_transcript_path).toBeUndefined();
    expect(p.reason).toBeUndefined();
    expect(p.task_subject).toBeUndefined();
    expect(String(p.last_assistant_message).length).toBe(200);
    expect(String(p.last_assistant_message).endsWith('TAIL')).toBe(true);
    expect(p.tool_name).toBe('Bash'); // fields it does not name are untouched
  });
  it('keeps a valid tmux session name and redacts a credential that spans the 200-character cut', () => {
    const secret = 'sk-ant-api03-' + 'A'.repeat(90);
    const p: Record<string, unknown> = { event: 'Stop', instar_session: 'echo-topic-1', last_assistant_message: 'x'.repeat(150) + ' ' + secret + ' ' + 'y'.repeat(100) };
    boundCommandReporterPayload(p, 'inc-1');
    expect(p.instar_session).toBe('echo-topic-1');
    expect(String(p.last_assistant_message)).not.toContain('AAAAAAAAAAAAAAAAAAAA');
  });
});
