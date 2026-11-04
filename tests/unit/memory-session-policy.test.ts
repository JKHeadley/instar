import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildMemorySessionSettings, memorySessionAllowedTools, applyMemorySessionLaunch, moveInboundFilesIntoScope,
} from '../../src/core/memorySessionPolicy.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const paths = {
  agentHome: '/u/.instar/agents/luna',
  scopeDir: '/u/.instar/memory-scopes/luna/person-abc',
  homeDir: '/u',
  agentHomeEntries: ['.instar', '.claude', 'CLAUDE.md', 'notes.md'],
  replyScripts: ['/u/.instar/agents/luna/.instar/scripts/slack-reply.sh'],
  tempRoots: ['/tmp', '/private/tmp'],
};
type S = { autoMemoryDirectory: string; permissions: { deny: string[] }; sandbox: Record<string, any> };
const settings = () => buildMemorySessionSettings(paths) as unknown as S;

describe('buildMemorySessionSettings', () => {
  it('uses the scope folder for auto-memory', () => {
    expect(settings().autoMemoryDirectory).toBe(paths.scopeDir);
  });
  it('writes absolute rules with the double-slash prefix a real session honours', () => {
    expect(settings().permissions.deny).toContain('Read(//u/.instar/agents/luna/.instar/**)');
    for (const rule of settings().permissions.deny) expect(rule).toMatch(/^(Read|Edit|Write)\(\/\//);
  });
  it('denies every top-level entry except what CLAUDE.md loading needs', () => {
    const deny = settings().permissions.deny;
    expect(deny).toContain('Read(//u/.instar/agents/luna/notes.md)');
    expect(deny).not.toContain('Read(//u/.instar/agents/luna/CLAUDE.md)');
    expect(deny).not.toContain('Read(//u/.instar/agents/luna/.claude/**)');
    expect(deny).not.toContain('Read(//u/.instar/agents/luna)');
  });
  it('keeps files that load for everyone or run outside the sandbox unwritable', () => {
    const deny = settings().permissions.deny;
    for (const f of ['CLAUDE.md', 'AGENT.md', '.claude/**']) {
      expect(deny).toContain(`Write(//u/.instar/agents/luna/${f})`);
      expect(deny).toContain(`Edit(//u/.instar/agents/luna/${f})`);
    }
  });
  it('refuses to run without a sandbox, or to step outside one', () => {
    const { sandbox } = settings();
    expect(sandbox.enabled).toBe(true);
    expect(sandbox.failIfUnavailable).toBe(true);
    expect(sandbox.allowUnsandboxedCommands).toBe(false);
  });
  it('denies the whole home and temp roots to the shell and re-allows an exact list', () => {
    const fs = settings().sandbox.filesystem;
    expect(fs.denyRead).toEqual(expect.arrayContaining(['/u', '/tmp', '/private/tmp']));
    expect(fs.allowRead).toEqual([paths.scopeDir, ...paths.replyScripts]);
    expect(fs.allowWrite).toEqual([paths.scopeDir]);
  });
  it('reaches the local server but no tmux socket', () => {
    const net = settings().sandbox.network;
    expect(net.allowedDomains).toContain('localhost');
    expect(net.allowUnixSockets).toEqual([]);
  });
});

describe('memorySessionAllowedTools', () => {
  it('limits file tools to the scope folder', () => {
    const tools = memorySessionAllowedTools(paths.scopeDir);
    expect(tools).toContain(`Read(/${paths.scopeDir}/**)`);
    expect(tools).not.toContain('Read');
    expect(tools).not.toContain('Grep');
    expect(tools).not.toContain('Glob');
  });
});

describe('applyMemorySessionLaunch', () => {
  it('drops the bypass and adds the confined form', () => {
    const argv = ['claude', '--dangerously-skip-permissions', '--model', 'x'];
    applyMemorySessionLaunch(argv, '/s/settings.json', paths.scopeDir);
    expect(argv).not.toContain('--dangerously-skip-permissions');
    expect(argv).toEqual(expect.arrayContaining(['--permission-mode', 'dontAsk', '--settings', '/s/settings.json', '--strict-mcp-config']));
  });
  it('puts the form before -p when present', () => {
    const argv = ['claude', '--dangerously-skip-permissions', '-p', 'hello'];
    applyMemorySessionLaunch(argv, '/s/settings.json', paths.scopeDir);
    expect(argv.slice(-2)).toEqual(['-p', 'hello']);
  });
});

describe('moveInboundFilesIntoScope', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-inbox-'));
    fs.mkdirSync(path.join(dir, 'scope', 'inbox'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'inbound'));
    fs.writeFileSync(path.join(dir, 'inbound', 'a.txt'), 'made-up');
    fs.writeFileSync(path.join(dir, 'other.txt'), 'someone else');
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/memory-session-policy.test.ts' }));
  const roots = () => [path.join(dir, 'inbound')];

  it('copies a named file and points the text at the copy', () => {
    const out = moveInboundFilesIntoScope(`see ${dir}/inbound/a.txt now`, path.join(dir, 'scope'), roots());
    expect(out).toBe(`see ${dir}/scope/inbox/a.txt now`);
    expect(fs.readFileSync(path.join(dir, 'scope/inbox/a.txt'), 'utf8')).toBe('made-up');
  });
  it('will not follow a typed path out of the inbound folder', () => {
    const typed = `read ${dir}/inbound/../other.txt`;
    expect(moveInboundFilesIntoScope(typed, path.join(dir, 'scope'), roots())).toBe(typed);
    expect(fs.existsSync(path.join(dir, 'scope/inbox/other.txt'))).toBe(false);
  });
  it('leaves text alone when the file does not exist or the path is elsewhere', () => {
    const typed = `${dir}/inbound/none.txt and ${dir}/other.txt`;
    expect(moveInboundFilesIntoScope(typed, path.join(dir, 'scope'), roots())).toBe(typed);
  });
});
