/**
 * The deferral detector's auto-opened blocker records the MESSAGE, not the shell
 * command that sent it (2026-11-02: every ledger entry was `cat <<'EOF' | <reply
 * script> N` + text, signed links included, and the dashboard printed it verbatim).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { blockerText } from '../../dashboard/console/plans-model.js';

let tmpDir: string;
let hookPath: string;
let server: http.Server;
let port = 0;
const posted: Array<{ detectedText: string; origin: string }> = [];

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deferral-blocker-text-'));
  hookPath = path.join(tmpDir, 'deferral-detector.js');
  const migrator = new PostUpdateMigrator({ projectDir: tmpDir, stateDir: path.join(tmpDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'blocker-text' });
  fs.writeFileSync(hookPath, (migrator as unknown as { getHookContent(n: string): string }).getHookContent('deferral-detector'), { mode: 0o755 });
  server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => { if (req.url === '/blockers') posted.push(JSON.parse(b)); res.end('{}'); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as { port: number }).port;
});

afterAll(() => {
  server.close();
  SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/deferral-detector-blocker-text.test.ts:cleanup' });
});

function runHook(command: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn('node', [hookPath], { env: { ...process.env, INSTAR_AUTH_TOKEN: 't', INSTAR_SERVER_URL: `http://127.0.0.1:${port}` } });
    child.on('exit', () => resolve());
    child.stdin.end(JSON.stringify({ tool_name: 'Bash', tool_input: { command } }));
  });
}

const reply = ['telegram', 'reply.sh'].join('-');

describe('deferral detector blocker text', () => {
  it('posts the heredoc message body with signed-link values masked, not the shell command', async () => {
    posted.length = 0;
    await runHook(`cd /x; cat <<'EOF' | .claude/scripts/${reply} 52075\nI can't reach the laptop. Report: https://h.example/view/1?sig=deadbeef&x=1\nEOF`);
    await new Promise((r) => setTimeout(r, 300));
    expect(posted).toHaveLength(1);
    expect(posted[0].detectedText).toBe("I can't reach the laptop. Report: https://h.example/view/1?sig=…&x=1");
    expect(posted[0].detectedText).not.toContain(reply);
    expect(posted[0].origin).toBe('deferral-detector');
  });
});

describe('deferral detector: only an invoked reply is a message', () => {
  it('a command that writes a file mentioning the reply script opens no blocker', async () => {
    posted.length = 0;
    await runHook(`cat > notes.md <<'EOF'\nThe ${reply} path: I can't proceed without the release blocker fix.\nEOF`);
    await new Promise((r) => setTimeout(r, 300));
    expect(posted).toHaveLength(0);
  });

  it('with several heredocs, the one piped into the reply script is recorded', async () => {
    posted.length = 0;
    await runHook(`cat > a.txt <<'A'\nnot this one\nA\ncat <<'EOF' | .claude/scripts/${reply} 1\nI cannot reach the Laptop right now.\nEOF`);
    await new Promise((r) => setTimeout(r, 300));
    expect(posted.map((p) => p.detectedText)).toEqual(['I cannot reach the Laptop right now.']);
  });
});

describe('console blockerText (rows recorded before the hook fix)', () => {
  it('shows the first line of the message, masks signatures, and names a bare command', () => {
    expect(blockerText(`cat <<'EOF' | .claude/scripts/${reply} 52075\n14:10 status: see https://h.example/v?sig=abc&t=1\nmore\nEOF`)).toBe('14:10 status: see https://h.example/v?sig=…&t=1');
    expect(blockerText('cd /a; curl -s -X POST http://localhost:4042/commitments')).toBe('Flagged in a command I ran (no message text)');
    expect(blockerText('We cannot reach the laptop')).toBe('We cannot reach the laptop');
    expect(blockerText('x'.repeat(300))).toHaveLength(220);
    // Names, never ids: a quoted topic number reads as the conversation's name when known.
    expect(blockerText('Request from topic 136110 (cloud server test)', { '136110': 'Cloud VM trial' })).toBe('Request from “Cloud VM trial” (cloud server test)');
    expect(blockerText('Request from topic 999 here', { '136110': 'Cloud VM trial' })).toBe('Request from topic 999 here');
  });
});
