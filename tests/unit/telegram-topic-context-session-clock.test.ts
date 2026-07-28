// safe-fs-allow: test file — tmpdir cleanup only.
/**
 * telegram-topic-context.sh — SESSION CLOCK query injection (Step 2 wiring integrity).
 *
 * The generated UserPromptSubmit hook must, after resolving PORT + AUTH_TOKEN +
 * TOPIC_ID, call emit-session-clock.sh in query mode so the clock surfaces on the
 * user's own turns too. Critically, the generated bash must be SYNTACTICALLY VALID
 * (a `\$` escaping slip in the TS template would brick the hook) — asserted via
 * `bash -n`. Spec: docs/specs/ROBUST-SESSION-TIME-AWARENESS-SPEC.md (Component 2).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-ttc-clock-')); });
afterEach(() => { SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/telegram-topic-context-session-clock.test.ts:cleanup' }); });

function genHook(): string {
  const m = new PostUpdateMigrator({ projectDir: tmp, stateDir: path.join(tmp, '.instar'), port: 4042, hasTelegram: true, projectName: 't' });
  return (m as unknown as { getTelegramTopicContextHook(): string }).getTelegramTopicContextHook();
}

describe('telegram-topic-context.sh — session-clock query injection', () => {
  it('the generated hook calls emit-session-clock.sh in query mode with PORT + AUTH + TOPIC + AGENT', () => {
    const hook = genHook();
    expect(hook).toContain('emit-session-clock.sh');
    expect(hook).toContain('query');
    // the call passes the resolved vars (literal in the generated bash)
    expect(hook).toMatch(/emit-session-clock\.sh"\s+query\s+"\$TOPIC_ID"\s+"\$PORT"\s+"\$AUTH_TOKEN"\s+"\$AGENT_ID"/);
    expect(hook).toContain('X-Instar-AgentId: ${AGENT_ID}');
    // still emits the absolute CURRENT TIME block (unchanged)
    expect(hook).toContain('CURRENT TIME');
  });

  it('the generated hook is syntactically valid bash (guards against a template-escaping slip)', () => {
    const hookPath = path.join(tmp, 'ttc.sh');
    fs.writeFileSync(hookPath, genHook());
    const check = spawnSync('bash', ['-n', hookPath], { encoding: 'utf-8' });
    expect(check.stderr || '').toBe('');
    expect(check.status).toBe(0);
  });
});
