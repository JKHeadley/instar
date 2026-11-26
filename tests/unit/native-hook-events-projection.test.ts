/**
 * Native hook events — projection (typed, bounded schema), redaction, the
 * admission guard and the bounded drain queue
 * (docs/specs/native-hook-events.md D1).
 *
 * Acceptance criteria covered: 5 (a credential spanning the 200-character
 * boundary is redacted), 5a/5b at the unit level (no command text or
 * tool_response survives projection; a malformed allowed field is dropped and
 * counted; the queue holds at most 1,000 and counts overflow; admission
 * refuses non-loopback peers before any body is read).
 */
import { describe, it, expect } from 'vitest';
import {
  projectNativeHookEvent,
  redactThenTail,
  NativeHookEventIngest,
  NATIVE_HOOK_QUEUE_MAX,
} from '../../src/monitoring/NativeHookEvents.js';

const H = { instarSessionId: 'f3bb3b14-5a75-4f2d-9812-1ab7ac8e212c', instarSession: 'echo-topic-1' };
const CSID = '2c1f7a9e-0b1d-4c55-9a55-0f7e2d3b8c11';

describe('projectNativeHookEvent', () => {
  it('keeps only the schema fields from a real PostToolUse body: no tool_response, no command text', () => {
    const raw = {
      hook_event_name: 'PostToolUse',
      session_id: CSID,
      transcript_path: '/home/u/.claude/projects/-p/x.jsonl',
      cwd: '/home/u/proj',
      permission_mode: 'bypassPermissions',
      tool_name: 'Bash',
      tool_input: { command: 'git commit -m "secret plan" && echo sk-ant-api03-' + 'x'.repeat(50), description: 'commit' },
      tool_response: { stdout: 'A'.repeat(100_000), stderr: '', interrupted: false },
      tool_use_id: 'toolu_1',
    };
    const { event, malformedFields } = projectNativeHookEvent(raw, H);
    expect(malformedFields).toBe(0);
    expect(event).toEqual({
      event: 'PostToolUse',
      session_id: CSID,
      instar_session_id: H.instarSessionId,
      instar_session: 'echo-topic-1',
      tool_name: 'Bash',
      cwd: '/home/u/proj',
      transcript_path: '/home/u/.claude/projects/-p/x.jsonl',
      is_git_commit: true,
    });
    const s = JSON.stringify(event);
    expect(s).not.toContain('secret plan');
    expect(s).not.toContain('tool_response');
    expect(s).not.toContain('AAAA');
  });

  it('maps tool_input.file_path / path to file_path for Write/Edit', () => {
    expect(projectNativeHookEvent({ hook_event_name: 'PostToolUse', session_id: CSID, tool_name: 'Edit', tool_input: { file_path: '/p/a.ts', old_string: 'x', new_string: 'y' } }, H).event?.file_path).toBe('/p/a.ts');
    expect(projectNativeHookEvent({ hook_event_name: 'PostToolUse', session_id: CSID, tool_name: 'Glob', tool_input: { path: '/p', pattern: '*' } }, H).event?.file_path).toBe('/p');
  });

  it('a non-commit Bash command yields is_git_commit:false', () => {
    expect(projectNativeHookEvent({ hook_event_name: 'PostToolUse', session_id: CSID, tool_name: 'Bash', tool_input: { command: 'ls -la' } }, H).event?.is_git_commit).toBe(false);
  });

  it('keeps the SubagentStop / SessionEnd / PreCompact / TaskCompleted fields their consumers read', () => {
    const stop = projectNativeHookEvent({ hook_event_name: 'SubagentStop', session_id: CSID, agent_id: 'a-1', agent_type: 'Explore', agent_transcript_path: '/t/a.jsonl', last_assistant_message: 'done' }, H).event!;
    expect(stop).toMatchObject({ event: 'SubagentStop', agent_id: 'a-1', agent_type: 'Explore', agent_transcript_path: '/t/a.jsonl', last_assistant_message: 'done' });
    expect(projectNativeHookEvent({ hook_event_name: 'SessionEnd', session_id: CSID, reason: 'clear' }, H).event?.reason).toBe('clear');
    expect(projectNativeHookEvent({ hook_event_name: 'PreCompact', session_id: CSID, trigger: 'auto', custom_instructions: 'x' }, H).event).toMatchObject({ trigger: 'auto' });
    const task = projectNativeHookEvent({ hook_event_name: 'TaskCompleted', session_id: CSID, task_id: 't-9', task_subject: 'Ship it', task_description: 'long description' }, H).event!;
    expect(task).toMatchObject({ task_id: 't-9', task_subject: 'Ship it' });
    expect(task).not.toHaveProperty('task_description');
  });

  it('criterion 5b (unit): a malformed allowed field is dropped and counted, not stored', () => {
    const { event, malformedFields } = projectNativeHookEvent({
      hook_event_name: 'SessionEnd', session_id: CSID, reason: { nested: 'object' }, tool_name: 'x'.repeat(10 * 1024), cwd: 'relative/path',
    }, H);
    expect(event).not.toBeNull();
    expect(event).not.toHaveProperty('reason');
    expect(event).not.toHaveProperty('tool_name');
    expect(event).not.toHaveProperty('cwd');
    expect(malformedFields).toBe(3);
  });

  it('a key field failing its bound drops the whole event', () => {
    expect(projectNativeHookEvent({ hook_event_name: 'Notification', session_id: CSID }, H).event).toBeNull();
    expect(projectNativeHookEvent({ hook_event_name: 'Stop', session_id: 'bad id with spaces' }, H).event).toBeNull();
    expect(projectNativeHookEvent({ hook_event_name: 'Stop', session_id: CSID }, { instarSessionId: '' }).event).toBeNull();
    expect(projectNativeHookEvent({ hook_event_name: 'WorktreeCreate', session_id: CSID }, H).event).toBeNull();
  });

  it('criterion 5: a credential spanning the 200-character boundary is redacted (redact on the full text, then tail)', () => {
    const key = 'sk-ant-api03-' + 'Q'.repeat(60);
    // Place the key so it straddles the start of the kept 200-char tail.
    const tailLen = 200;
    const suffix = 'z'.repeat(tailLen - 30);
    const msg = 'prefix '.repeat(10) + key + ' ' + suffix;
    // Sanity: a naive truncate-then-redact would keep a fragment the patterns cannot recognise.
    const naive = msg.slice(msg.length - tailLen);
    expect(naive).toContain('QQQQ');
    const out = redactThenTail(msg);
    expect(out.length).toBeLessThanOrEqual(tailLen);
    expect(out).not.toMatch(/Q{8,}/);
    const ev = projectNativeHookEvent({ hook_event_name: 'Stop', session_id: CSID, last_assistant_message: msg }, H).event!;
    expect(ev.last_assistant_message).toBe(out);
    // The failure marker at the END of a message survives (HelperWatchdog reads it).
    const rl = projectNativeHookEvent({ hook_event_name: 'SubagentStop', session_id: CSID, agent_id: 'a', last_assistant_message: 'x'.repeat(5000) + ' API Error: 429 rate limit' }, H).event!;
    expect(rl.last_assistant_message).toMatch(/429 rate limit$/);
  });
});

describe('NativeHookEventIngest queue', () => {
  it('criterion 5b (unit): at most 1,000 pending; the newest overflow is dropped and counted', () => {
    const scheduled: Array<() => void> = [];
    const ingest = new NativeHookEventIngest({ getAuthToken: () => 't', schedule: (fn) => scheduled.push(fn) });
    let processed = 0;
    ingest.setProcessor(() => { processed++; return true; });
    for (let i = 0; i < 5000; i++) {
      ingest.accept({ hook_event_name: 'PostToolUse', session_id: CSID, tool_name: 'Read' }, H);
    }
    expect(ingest.pending).toBe(NATIVE_HOOK_QUEUE_MAX);
    expect(ingest.counters.queueOverflow).toBe(4000);
    expect(ingest.counters.admitted).toBe(5000);
    // Drain: each turn handles at most 50 and yields.
    let turns = 0;
    while (scheduled.length > 0 && turns < 1000) { scheduled.shift()!(); turns++; }
    expect(processed).toBe(1000);
    expect(turns).toBeGreaterThanOrEqual(20);
    expect(ingest.counters.stored).toBe(1000);
  });

  it('a processor failure counts failedProcessing, never throws', () => {
    const scheduled: Array<() => void> = [];
    const ingest = new NativeHookEventIngest({ getAuthToken: () => 't', schedule: (fn) => scheduled.push(fn) });
    ingest.setProcessor(() => { throw new Error('boom'); });
    ingest.accept({ hook_event_name: 'Stop', session_id: CSID }, H);
    scheduled.shift()!();
    expect(ingest.counters.failedProcessing).toBe(1);
  });
});

describe('admission guard (before any body is read)', () => {
  function run(opts: { remote: string; headers: Record<string, string> }) {
    const ingest = new NativeHookEventIngest({ getAuthToken: () => 'secret-token' });
    let status = 0;
    let nextCalled = false;
    let bodyRead = false;
    const req = {
      method: 'POST',
      socket: { remoteAddress: opts.remote },
      headers: Object.fromEntries(Object.entries(opts.headers).map(([k, v]) => [k.toLowerCase(), v])),
      // A refused loopback request is read and discarded (never parsed) before
      // it is answered; resume() delivers an empty body.
      listeners: {} as Record<string, () => void>,
      on(ev: string, fn: () => void) { bodyRead = true; this.listeners[ev] = fn; return this; },
      resume() { this.listeners.end?.(); return this; },
      destroy() { return this; },
    };
    const res = { status(c: number) { status = c; return this; }, json() { return this; }, end() { return this; } };
    ingest.admissionGuard()(req as never, res as never, () => { nextCalled = true; });
    return { ingest, status, nextCalled, bodyRead };
  }
  const ok = { Authorization: 'Bearer secret-token', 'X-Instar-Session-Id': 'sid-1' };

  it('a non-loopback peer gets 403', () => {
    const r = run({ remote: '192.168.1.20', headers: ok });
    expect(r.status).toBe(403);
    // Never parsed or dispatched (the body is read and discarded so the client sees the 403).
    expect(r.nextCalled).toBe(false);
    expect(r.ingest.counters.forbidden).toBe(1);
  });
  it('a forwarded header gets 403 even over loopback', () => {
    expect(run({ remote: '127.0.0.1', headers: { ...ok, 'Cf-Connecting-Ip': '1.2.3.4' } }).status).toBe(403);
    expect(run({ remote: '::1', headers: { ...ok, 'X-Forwarded-For': '1.2.3.4' } }).status).toBe(403);
  });
  it('an empty bearer (exactly "Bearer") or empty session header gets a quiet 204', () => {
    const a = run({ remote: '127.0.0.1', headers: { Authorization: 'Bearer', 'X-Instar-Session-Id': 'sid' } });
    expect(a.status).toBe(204);
    expect(a.ingest.counters.emptyCredential).toBe(1);
    expect(run({ remote: '127.0.0.1', headers: { Authorization: 'Bearer secret-token', 'X-Instar-Session-Id': '' } }).status).toBe(204);
  });
  it('a wrong token gets 401; an oversized Content-Length 413', () => {
    expect(run({ remote: '127.0.0.1', headers: { Authorization: 'Bearer nope', 'X-Instar-Session-Id': 's' } }).status).toBe(401);
    const big = run({ remote: '127.0.0.1', headers: { ...ok, 'Content-Length': String(5 * 1024 * 1024) } });
    expect(big.status).toBe(413);
    expect(big.ingest.counters.tooLarge).toBe(1);
  });
  it('a valid request passes through; an empty agent-id header is treated as absent', () => {
    const r = run({ remote: '::ffff:127.0.0.1', headers: { ...ok, 'Content-Length': '100', 'X-Instar-AgentId': '' } });
    expect(r.nextCalled).toBe(true);
    expect(r.ingest.bodySize.buckets.le1k).toBe(1);
  });
  it('the Bearer scheme is case-insensitive and "Bearerxyz" is not a bearer token; a chunked body is not counted as 0 bytes', () => {
    expect(run({ remote: '127.0.0.1', headers: { Authorization: 'bearer secret-token', 'X-Instar-Session-Id': 's' } }).nextCalled).toBe(true);
    expect(run({ remote: '127.0.0.1', headers: { Authorization: 'Bearersecret-token', 'X-Instar-Session-Id': 's' } }).status).toBe(401);
    const chunked = run({ remote: '127.0.0.1', headers: ok });
    expect(chunked.nextCalled).toBe(true);
    expect(Object.values(chunked.ingest.bodySize.buckets).reduce((a, b) => a + b, 0)).toBe(0);
  });
});
