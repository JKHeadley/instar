/**
 * Verifies that PostUpdateMigrator inlines a current-time injection block
 * into both the SessionStart hook and the UserPromptSubmit (telegram-topic-
 * context) hook.
 *
 * Why this exists: Claude Code's harness injects currentDate (e.g.
 * "2026-05-21") into the agent's system prompt, but NOT current time of day.
 * Agents in long sessions then hallucinate clock times ("it's 2am" when it's
 * actually 5:45am) because they carry stale clock context. The structural
 * fix is to emit `date` output at session start and on every user prompt,
 * so the agent always has a fresh wall-clock anchor.
 *
 * These tests assert the inlined bash templates produce that block when
 * executed. Anything that quietly drops the block — e.g. a future refactor
 * that rewrites the hooks — should turn this test red.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';

const migrator = new PostUpdateMigrator({
  projectDir: '/tmp',
  stateDir: '/tmp/.instar',
  port: 4042,
  hasTelegram: false,
  projectName: 'test',
});

interface PrivateAccess {
  getSessionStartHook(): string;
  getTelegramTopicContextHook(): string;
}
const priv = migrator as unknown as PrivateAccess;

function runHookScript(script: string, opts: { stdin?: string; env?: Record<string, string> } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'instar-hook-test-'));
  const file = join(dir, 'hook.sh');
  writeFileSync(file, script, { mode: 0o755 });
  chmodSync(file, 0o755);
  const env = { ...process.env, CLAUDE_PROJECT_DIR: dir, ...opts.env };
  const out = execFileSync('bash', [file], {
    input: opts.stdin ?? '',
    env,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return out;
}

describe('PostUpdateMigrator — current-time injection in session-start hook', () => {
  const hook = priv.getSessionStartHook();

  it('inlines a date(1) call so the hook emits wall-clock time', () => {
    expect(hook).toMatch(/NOW=\$\(date \+/);
  });

  it('uses an ISO-style format string with timezone offset and abbreviation', () => {
    expect(hook).toContain("'%Y-%m-%d %H:%M:%S %z (%Z)'");
  });

  it('wraps the emission in a non-empty guard so a broken date(1) never injects "--- CURRENT TIME ---" with no value', () => {
    expect(hook).toMatch(/if \[ -n "\$NOW" \]/);
  });

  it('uses --- CURRENT TIME --- delimiters consistent with the rest of session-start', () => {
    expect(hook).toContain('--- CURRENT TIME ---');
    expect(hook).toContain('--- END CURRENT TIME ---');
  });

  it('instructs the agent to quote the wall-clock and not carry stale times', () => {
    expect(hook).toMatch(/do not carry stale clock times/i);
  });

  it('places the time block after === SESSION START === so it lands inside the session-start frame', () => {
    const sessionStart = hook.indexOf('=== SESSION START ===');
    const timeBlock = hook.indexOf('--- CURRENT TIME ---');
    expect(sessionStart).toBeGreaterThan(-1);
    expect(timeBlock).toBeGreaterThan(sessionStart);
  });

  it('places the time block BEFORE the TOPIC CONTEXT block so it appears near the top of the injected output', () => {
    const timeBlock = hook.indexOf('--- CURRENT TIME ---');
    const topicContext = hook.indexOf('TOPIC CONTEXT (loaded FIRST');
    expect(timeBlock).toBeGreaterThan(-1);
    expect(topicContext).toBeGreaterThan(-1);
    expect(timeBlock).toBeLessThan(topicContext);
  });

  it('executes end-to-end and emits a current-time block matching the expected shape', () => {
    const out = runHookScript(hook);
    expect(out).toContain('--- CURRENT TIME ---');
    expect(out).toContain('--- END CURRENT TIME ---');
    // Body line: ISO date + time + signed offset + (TZ abbrev)
    expect(out).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4} \([A-Z]{2,5}\)/);
  });
});

describe('PostUpdateMigrator — current-time injection in telegram-topic-context hook', () => {
  const hook = priv.getTelegramTopicContextHook();

  it('inlines a date(1) call so the hook emits wall-clock time on every user prompt', () => {
    expect(hook).toMatch(/NOW=\$\(date \+/);
  });

  it('uses the same ISO format as session-start for consistency', () => {
    expect(hook).toContain("'%Y-%m-%d %H:%M:%S %z (%Z)'");
  });

  it('emits the time block BEFORE the [telegram:N] early-exit so it fires for every UserPromptSubmit, not just telegram prompts', () => {
    const timeBlock = hook.indexOf('--- CURRENT TIME ---');
    const earlyExit = hook.indexOf('if [ -z "$TOPIC_ID" ]; then\n  exit 0');
    expect(timeBlock).toBeGreaterThan(-1);
    expect(earlyExit).toBeGreaterThan(-1);
    expect(timeBlock).toBeLessThan(earlyExit);
  });

  it('executes against a non-telegram prompt (no prefix) and still emits the time block', () => {
    const out = runHookScript(hook, { stdin: JSON.stringify({ prompt: 'plain CLI prompt with no telegram prefix' }) });
    expect(out).toContain('--- CURRENT TIME ---');
    expect(out).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4} \([A-Z]{2,5}\)/);
  });

  it('executes against a telegram-prefixed prompt and still emits the time block before bailing on missing config', () => {
    const out = runHookScript(hook, { stdin: JSON.stringify({ prompt: '[telegram:123] hello' }) });
    expect(out).toContain('--- CURRENT TIME ---');
  });
});
