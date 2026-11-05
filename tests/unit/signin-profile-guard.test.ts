import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { signinProfileGuardHook, assertNotSigninProfile } from '../../src/core/SigninProfileGuard.js';
import { ChromeCdpReloginBrowser } from '../../src/core/ChromeCdpReloginBrowser.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
let root: string, profile: string, registry: string, script: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'signin-guard-'));
  profile = path.join(root, '.instar/state/playwright-profiles/dawn-google');
  registry = path.join(root, '.instar/state/playwright-profiles.json');
  fs.mkdirSync(path.dirname(profile), { recursive: true });
  fs.writeFileSync(registry, JSON.stringify({ profiles: [{ id: 'dawn-google', userDataDir: profile, accounts: [{ service: 'google' }] }] }));
  script = path.join(root, 'guard.cjs'); fs.writeFileSync(script, signinProfileGuardHook());
});
afterEach(() => SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'test:signin-guard-cleanup' }));
function run(tool_name: string, tool_input: unknown) {
  return spawnSync(process.execPath, [script], { input: JSON.stringify({ tool_name, tool_input, cwd: root }), encoding: 'utf8',
    env: { ...process.env, INSTAR_AGENT_HOME: root, INSTAR_PROJECT_DIR: root }, timeout: 3000 });
}
describe('registered sign-in browser guard', () => {
  it.each(['Bash', 'functions.exec_command'])('refuses Playwright and CDP for %s before any profile is created', tool => {
    for (const command of [`node -e "chromium.launchPersistentContext('${profile}')"`, `chrome --remote-debugging-port=9222 --user-data-dir=${profile}`]) {
      const result = run(tool, { command, cmd: command });
      expect(result.stderr).toContain('registered-signin-profile-automation-refused'); expect(result.status).toBe(2);
      expect(fs.existsSync(profile)).toBe(false);
    }
  });
  it('inspects the source of a launched script, matching the incident command', () => {
    fs.writeFileSync(path.join(root, 'dawn.mjs'), `import { chromium } from 'playwright'; chromium.launchPersistentContext('${profile}');`);
    expect(run('Bash', { command: 'node dawn.mjs whoami' }).status).toBe(2);
  });
  it('checks nested Codex execution and direct browser profile arguments', () => {
    expect(run('functions.exec', `await tools.exec_command({cmd: "chrome --remote-debugging-pipe --user-data-dir=${profile}"})`).status).toBe(2);
    expect(run('mcp__playwright__browser_launch', { userDataDir: profile }).status).toBe(2);
  });
  it.each(['.mcp.json', '.claude/settings.json'])('refuses implicit MCP use when %s binds a sign-in profile', file => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), JSON.stringify({ mcpServers: { playwright: { args: ['--user-data-dir', profile] } } }));
    expect(run('mcp__playwright__browser_snapshot', {}).status).toBe(2);
  });
  it('resolves symlink aliases before deciding', () => {
    fs.mkdirSync(profile); const alias = path.join(root, 'innocent'); fs.symlinkSync(profile, alias);
    expect(run('Bash', { command: `chrome --remote-debugging-pipe --user-data-dir=${alias}` }).status).toBe(2);
  });
  it('allows disposable tests, normal Chrome repair, source edits, and registry reads', () => {
    expect(run('Bash', { command: 'node -e "chromium.launchPersistentContext(\'/tmp/disposable\')"' }).status).toBe(0);
    expect(run('Bash', { command: 'chrome-js.sh dawn-google document.title https://accounts.google.com' }).status).toBe(0);
    expect(run('apply_patch', `chromium.launchPersistentContext('${profile}')` ).status).toBe(0);
    expect(run('Bash', { command: 'cat .instar/state/playwright-profiles.json' }).status).toBe(0);
    expect(run('Bash', { command: `open -na Chrome --args --user-data-dir=${profile}` }).status).toBe(0);
    expect(run('Bash', { command: `chrome-js.sh ${profile} document.title` }).status).toBe(0);
    expect(run('Bash', { command: `cat ${profile}/Default/Preferences` }).status).toBe(0);
  });
  it('fails closed for browser operations on corrupt registry while leaving repair and edits available', () => {
    fs.writeFileSync(registry, '{');
    expect(run('mcp__playwright__browser_snapshot', {}).status).toBe(2);
    expect(run('Bash', { command: 'chrome-js.sh dawn-google document.title' }).status).toBe(0);
    expect(run('apply_patch', {}).status).toBe(0);
  });
  it('refuses production CDP before mutating a registered profile', async () => {
    const browser = new ChromeCdpReloginBrowser({ userDataDir: profile, chromePath: process.execPath });
    await expect(browser.open('https://accounts.google.com')).rejects.toThrow('signin-profile-automation-refused');
    expect(fs.existsSync(profile)).toBe(false);
  });
  it('rechecks registration and aliases at use time', () => {
    const alias = path.join(root, '.instar/state/playwright-profiles/alias');
    fs.mkdirSync(profile); fs.symlinkSync(profile, alias);
    expect(() => assertNotSigninProfile(alias)).toThrow('signin-profile-automation-refused');
    fs.writeFileSync(registry, JSON.stringify({ profiles: [] }));
    expect(() => assertNotSigninProfile(alias)).not.toThrow();
  });
});

describe('MCP startup protection', () => {
  it('checks startup even before any tool is called', async () => {
    const { assertBrowserMcpProfilesSafe } = await import('../../src/core/BrowserMcpProfileGuard.js');
    fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { playwright: { args: ['--user-data-dir', profile] } } }));
    expect(() => assertBrowserMcpProfilesSafe(root, 'codex-cli', path.join(root, 'codex'))).toThrow('managed-telegram-profile-private');
  });
  it('checks inherited Codex TOML and allows a disposable profile', async () => {
    const { assertBrowserMcpProfilesSafe } = await import('../../src/core/BrowserMcpProfileGuard.js');
    const home = path.join(root, 'codex'); fs.mkdirSync(home);
    const config = path.join(home, 'config.toml');
    fs.writeFileSync(config, `[mcp_servers.playwright]\ncommand = "npx"\nargs = ["--user-data-dir", "${profile}"]\n`);
    expect(() => assertBrowserMcpProfilesSafe(root, 'codex-cli', home)).toThrow('managed-telegram-profile-private');
    fs.writeFileSync(config, '[mcp_servers.playwright]\ncommand = "npx"\nargs = ["--user-data-dir", "/tmp/disposable"]\n');
    expect(() => assertBrowserMcpProfilesSafe(root, 'codex-cli', home)).not.toThrow();
  });
  it('protects an already registered built-in default Google profile before MCP startup', async () => {
    const { assertBrowserMcpProfilesSafe } = await import('../../src/core/BrowserMcpProfileGuard.js');
    fs.writeFileSync(registry, JSON.stringify({ profiles: [{ id: 'default', userDataDir: null, accounts: [{ service: 'google' }] }] }));
    fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { safe: { command: 'npx', args: ['@playwright/mcp', '--user-data-dir', '/tmp/disposable'] }, playwright: { command: 'npx', args: ['@playwright/mcp'] } } }));
    expect(() => assertBrowserMcpProfilesSafe(root, 'codex-cli', path.join(root, 'codex'))).toThrow('managed-telegram-profile-private');
  });
  it('refuses Windows profile paths without relying on their profile IDs', () => {
    const windowsDir = 'C:\\Users\\agent\\Signin';
    fs.writeFileSync(registry, JSON.stringify({ profiles: [{ id: 'dawn-google', userDataDir: profile, windowsUserDataDir: windowsDir, accounts: [{ service: 'google' }] }] }));
    expect(run('Bash', { command: `chrome.exe --remote-debugging-port=9222 --user-data-dir="${windowsDir}"` }).status).toBe(2);
  });
});
