// safe-git-allow: test-tmpdir-cleanup — afterEach removes this test's own mkdtemp sandbox HOME only.
/** Built CLI, real disposable repositories, local bare remotes, stubbed services.
 * No real tmux call is made. Do not run on hosts forbidding the e2e lane.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { git, install, seedKept, snapshot, keptNames, reviewNotice, backupNotice } from '../helpers/nuke-c-min.js';

const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const loader = fileURLToPath(new URL('../helpers/nuke-c-min-secret-loader.mjs', import.meta.url));
let home: string;
let bin: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zz-cmin-cli-')));
  bin = path.join(home, 'bin'); fs.mkdirSync(bin);
  function stub(name: string, script: string): void {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  }
  stub('claude', 'echo fixture');
  stub('gh', 'echo "sandbox: network remote forbidden" >&2; exit 99');
  stub('tmux', 'echo "no server running on fixture" >&2; exit 1');
  stub('launchctl', 'echo \'Could not find service "fixture" in domain for user gui: 501\' >&2; exit 113');
  stub('systemctl', 'printf "LoadState=not-found\\nActiveState=inactive\\nWorkingDirectory=\\nExecStart=\\nNeedDaemonReload=no\\n"');
  for (const name of ['plutil', 'security', 'bw', 'secret-tool']) stub(name, 'echo "sandbox: unexpected service invocation" >&2; exit 99');
  // Whitelist environment: no inherited agent identity, registry override, hooks,
  // Git config, NODE_OPTIONS, or tmux socket can escape this disposable home.
  env = {
    HOME: home, PATH: `${bin}:${process.env.PATH}`, TMPDIR: home,
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_STATE_HOME: path.join(home, '.local/state'),
    INSTAR_AUDIT_LOG_DIR: path.join(home, 'audit'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    NO_COLOR: '1', TERM: 'dumb', NODE_ENV: 'test',
  };
  expect(fs.existsSync(cli), 'e2e requires the current built CLI').toBe(true);
});
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

function run(args: string[], answer?: boolean): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--loader', loader, cli, ...args], { cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let sent = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`CLI timed out: ${output}`)); }, 30_000);
    const receive = (chunk: Buffer) => {
      output += chunk.toString();
      // Wait for the actual Inquirer prompt, not the earlier removal heading.
      if (answer !== undefined && !sent && output.includes('This cannot be undone.')) {
        sent = true;
        child.stdin.write(answer ? 'y\n' : 'n\n');
      }
    };
    child.stdout.on('data', receive); child.stderr.on('data', receive);
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, output }); });
  });
}
function repo(dir: string): void {
  install(dir); git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.instar/\n');
  fs.writeFileSync(path.join(dir, 'tracked'), 'existing');
  git(dir, 'add', '.gitignore', 'tracked'); git(dir, 'commit', '-qm', 'existing');
}
function orderedNotice(output: string, notice: string, confirmed: boolean): void {
  expect(output).toContain(notice);
  if (confirmed) expect(output.indexOf(notice)).toBeLessThan(output.indexOf('This cannot be undone.'));
}

describe('C-min shipped CLI confirmation and deletion', () => {
  it.each([false, true])('initializes through the CLI then confirms removal (standalone=%s)', async standalone => {
    const dir = standalone ? path.join(home, '.instar/agents/zz-cmin') : path.join(home, 'project');
    if (!standalone) fs.mkdirSync(dir);
    const initialized = await run(['init', ...(standalone ? ['zz-cmin', '--standalone'] : ['--dir', dir]), '--port', '49731', '--keep']);
    expect(initialized.code, initialized.output).toBe(0);
    expect(fs.existsSync(path.join(dir, '.instar/config.json'))).toBe(true);
    const before = snapshot(dir);
    const removed = await run(['nuke', ...(standalone ? ['zz-cmin'] : ['--here', '--dir', dir])], true);
    expect(removed.code, removed.output).toBe(0);
    orderedNotice(removed.output, standalone ? backupNotice : reviewNotice, true);
    if (standalone) expect(fs.existsSync(dir)).toBe(false);
    else {
      expect(snapshot(dir)).toEqual(before);
      expect(fs.existsSync(path.join(dir, '.instar'))).toBe(false);
    }
  });
  it.each(['cancel', 'confirm', 'skip'])('--here %s preserves all project artifacts', async mode => {
    const dir = path.join(home, 'project'); repo(dir); seedKept(dir);
    git(dir, 'add', ...keptNames); git(dir, 'commit', '-qm', 'project files');
    fs.appendFileSync(path.join(dir, 'CLAUDE.md'), 'dirty user instructions');
    const before = snapshot(dir);
    const index = fs.readFileSync(path.join(dir, '.git/index'));
    const { code, output } = await run(['nuke', '--here', '--dir', dir, ...(mode === 'skip' ? ['--yes'] : [])], mode === 'skip' ? undefined : mode === 'confirm');
    expect(code).toBe(0);
    expect(snapshot(dir)).toEqual(before);
    expect(fs.readFileSync(path.join(dir, '.git/index'))).toEqual(index);
    expect(fs.existsSync(path.join(dir, '.instar'))).toBe(mode === 'cancel');
    orderedNotice(output, reviewNotice, mode !== 'skip');
    expect(output.split(reviewNotice)).toHaveLength(mode === 'cancel' ? 2 : 3);
    for (const name of keptNames) expect(output.split(`  - ${name}`)).toHaveLength(mode === 'cancel' ? 2 : 3);
  });
  it.each(['cancel', 'confirm', 'skip'])('standalone %s warns before confirmation and preserves existing commits only', async mode => {
    const dir = path.join(home, '.instar/agents/zz-cmin'); repo(dir);
    const remote = path.join(home, 'remote.git'); git(home, 'init', '--bare', remote);
    git(dir, 'remote', 'add', 'origin', remote); git(dir, 'push', '-u', 'origin', 'HEAD');
    fs.writeFileSync(path.join(dir, 'tracked'), 'existing unpushed');
    git(dir, 'add', 'tracked'); git(dir, 'commit', '-qm', 'existing unpushed');
    const head = git(dir, 'rev-parse', 'HEAD').trim();
    const branch = git(dir, 'branch', '--show-current').trim();
    const remoteBefore = git(remote, 'rev-parse', branch).trim();
    git(dir, 'config', 'status.showUntrackedFiles', 'no');
    // Stale metadata with identical contents: status would refresh the index
    // absent --no-optional-locks. The only dirty file is untracked/non-ignored.
    fs.utimesSync(path.join(dir, 'tracked'), new Date(0), new Date(0));
    fs.writeFileSync(path.join(dir, 'untracked'), 'never committed');
    const index = fs.readFileSync(path.join(dir, '.git/index'));
    const { code, output } = await run(['nuke', 'zz-cmin', ...(mode === 'skip' ? ['--yes'] : [])], mode === 'skip' ? undefined : mode === 'confirm');
    expect(code).toBe(0);
    orderedNotice(output, backupNotice, mode !== 'skip');
    orderedNotice(output, 'Uncommitted changes are present.', mode !== 'skip');
    expect(fs.existsSync(dir)).toBe(mode === 'cancel');
    if (mode === 'cancel') {
      expect(fs.readFileSync(path.join(dir, '.git/index'))).toEqual(index);
      expect(git(remote, 'rev-parse', branch).trim()).toBe(remoteBefore);
    } else {
      expect(git(remote, 'rev-parse', branch).trim()).toBe(head);
      expect(git(remote, 'ls-tree', '-r', '--name-only', branch)).not.toContain('untracked');
      expect(output).toContain('Git push succeeded. Uncommitted changes are NOT in the backup.');
      expect(output.lastIndexOf('Git push succeeded')).toBeGreaterThan(output.indexOf('has been removed.'));
    }
  });
  it('push failure is nonfatal and never claims a successful backup', async () => {
    const dir = path.join(home, '.instar/agents/zz-cmin'); repo(dir);
    git(dir, 'remote', 'add', 'origin', path.join(home, 'missing-remote.git'));
    const { code, output } = await run(['nuke', 'zz-cmin', '--yes']);
    expect(code).toBe(0); expect(fs.existsSync(dir)).toBe(false);
    expect(output).toContain('Could not push existing commits. Uncommitted changes are NOT in the backup.');
    expect(output).not.toMatch(/Git push succeeded|final backup|cloud backup/);
  });
  it('shipped nested-home teardown check refuses before deletion', async () => {
    const dir = path.join(home, 'project'); repo(dir); seedKept(dir);
    install(path.join(dir, '.instar/agents/zz-foreign'));
    const before = snapshot(dir);
    const { code, output } = await run(['nuke', '--here', '--dir', dir, '--yes']);
    expect(code).toBe(1); expect(output).toContain('Refusing');
    expect(snapshot(dir)).toEqual(before);
    expect(fs.existsSync(path.join(dir, '.instar/config.json'))).toBe(true);
  });
});
