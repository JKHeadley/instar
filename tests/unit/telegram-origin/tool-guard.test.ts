import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { originToolGuardHook } from '../../../src/messaging/telegram-origin/OriginToolGuard.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { temporaryState } from '../../helpers/telegramOriginStore.js';
let root: string, script: string;
beforeEach(() => {
  root = temporaryState(); script = path.join(root, 'guard.js');
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(script, originToolGuardHook());
  fs.mkdirSync(path.join(root, '.instar/state'), { recursive: true });
  fs.writeFileSync(path.join(root, '.instar/state/playwright-profiles.json'), JSON.stringify({ profiles: [{
    executionOwner: 'telegram-origin-broker', userDataDir: '/private/managed-telegram' }] }));
});
afterEach(() => SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'test:origin-tool-guard:cleanup' }));
function run(tool_name: string, tool_input: object | string) {
  return spawnSync(process.execPath, [script], { input: JSON.stringify({ tool_name, tool_input }), encoding: 'utf8',
    env: { ...process.env, INSTAR_PROJECT_DIR: root }, timeout: 3000 });
}
describe('installed Telegram origin tool guard', () => {
  it.each(['/usr/bin/curl', 'command curl', 'TOKEN=fixture curl', 'env TOKEN="fixture value" /usr/bin/curl', 'exec /usr/bin/curl'])('blocks ordinary shell invocation %s but permits its read-only equivalent', prefix => {
    expect(run('functions.exec_command', { cmd: `${prefix} https://api.telegram.org/bot123:fixture/sendMessage -d text=hello` }).status).toBe(2);
    expect(run('functions.exec_command', { cmd: `${prefix} https://api.telegram.org/bot123:fixture/getMe` }).status).toBe(0);
  });
  it('inspects literal nested shell commands without blocking source-edit tools', () => {
    expect(run('functions.exec', 'await tools.exec_command({cmd: "command curl https://api.telegram.org/bot123:fixture/sendMessage"})').status).toBe(2);
    expect(run('functions.exec', {code: 'await tools.exec_command({cmd: "curl https://api.telegram.org/bot123:fixture/getMe"})'}).status).toBe(0);
    expect(run('functions.exec', 'await tools.apply_patch("curl https://api.telegram.org/bot123:fixture/sendMessage")').status).toBe(0);
  });
  it.each(['Bash', 'functions.exec_command'])('blocks direct Bot writes through %s while keeping read-only API calls available', tool => {
    const key = tool === 'Bash' ? 'command' : 'cmd';
    expect(run(tool, { [key]: 'curl -X POST https://api.telegram.org/bot123:fixture/sendMessage -d text=hello' }).status).toBe(2);
    expect(run(tool, { [key]: 'curl https://api.telegram.org/bot123:fixture/getMe' }).status).toBe(0);
    expect(run(tool, { [key]: 'cat message.txt | .instar/scripts/telegram-reply.sh 42' }).status).toBe(0);
  });
  it('blocks unrecorded Telegram MCP and managed-browser writes without interfering with unrelated browsing', () => {
    expect(run('mcp__telegram__send_message', { text: 'hello' }).status).toBe(2);
    expect(run('mcp__playwright__browser_navigate', { url: 'https://web.telegram.org/k/' }).status).toBe(2);
    expect(run('Bash', { command: 'chromium --user-data-dir=/private/managed-telegram' }).status).toBe(2);
    expect(run('mcp__playwright__browser_navigate', { url: 'about:blank' }).status).toBe(0);
    expect(run('mcp__telegram__get_updates', {}).status).toBe(0);
  });
  it('keeps editing and searching source code available even when it describes Telegram sends', () => {
    expect(run('apply_patch', { patch: 'fetch("https://api.telegram.org/bot123:fixture/sendMessage")' }).status).toBe(0);
    expect(run('Bash', { command: 'rg sendMessage src/messaging' }).status).toBe(0);
  });
});
