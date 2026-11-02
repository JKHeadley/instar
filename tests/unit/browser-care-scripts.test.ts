/**
 * Browser-care helper scripts (docs/specs/machine-self-maintenance.md, Part B), run against a temp
 * agent home with stub `uname`, `ps`, `open` and `osascript` on PATH: no real Chrome, process table
 * or Apple Event is touched. The ledger is written in the shape the sweep reads, chrome-close.sh is
 * dry-run (it never signals a process), and the jail refuses anything outside the profiles folder.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installBrowserScripts, BROWSER_CARE_SCRIPT_NAMES } from '../../src/commands/init.js';
import { ledgerFileName } from '../../src/monitoring/machineMaintenance/BrowserCare.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { JSDOM } from 'jsdom';

const HAS_PY = fs.existsSync('/usr/bin/python3');
const TEMPLATE_DIR = path.resolve(process.cwd(), 'src/templates/scripts/browser');

let tmp: string; let home: string; let bin: string; let scripts: string;
const profile = (id: string) => path.join(home, '.instar', 'state', 'playwright-profiles', id);
const ledgerFile = (dir: string) => path.join(home, '.instar', 'state', 'browser-instances', ledgerFileName(dir));
function stub(name: string, body: string): void { fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 }); }
function run(script: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync('/bin/bash', [path.join(scripts, script), ...args], { encoding: 'utf-8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env } });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-browser-care-'));
  home = fs.realpathSync(tmp);
  bin = path.join(home, 'bin'); fs.mkdirSync(bin);
  installBrowserScripts(home);
  scripts = path.join(home, '.instar', 'scripts', 'browser');
});
afterEach(() => SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/browser-care-scripts.test.ts' }));

describe('install', () => {
  it('installs every browser-care helper executable and byte-identical', () => {
    for (const name of BROWSER_CARE_SCRIPT_NAMES) {
      expect(fs.statSync(path.join(scripts, name)).mode & 0o777).toBe(0o755);
      expect(fs.readFileSync(path.join(scripts, name))).toEqual(fs.readFileSync(path.join(TEMPLATE_DIR, name)));
    }
  });

  it('chrome-close.sh has no way to end a process in this release', () => {
    const src = fs.readFileSync(path.join(TEMPLATE_DIR, 'chrome-close.sh'), 'utf-8').split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
    expect(src).not.toMatch(/\bkill\b|pkill|killall|\bquit\b|osascript/);
  });

  it('chrome-unsaved.sh only reads: its page code assigns nothing on the page and sends no other event', () => {
    const src = fs.readFileSync(path.join(TEMPLATE_DIR, 'chrome-unsaved.sh'), 'utf-8');
    const check = /CHECK="([^"]*)"/.exec(src)![1];
    expect(check).not.toMatch(/\.(value|checked|textContent|innerHTML)\s*=[^=]|\.click\(|\.submit\(|\.focus\(|location\s*=/);
    expect(src.match(/fc\('CrSu'\),fc\('ExJa'\)/g)).toHaveLength(1);
  });
});

describe('chrome-unsaved.sh page check, run in a real DOM', () => {
  const check = /CHECK="([^"]*)"/.exec(fs.readFileSync(path.join(TEMPLATE_DIR, 'chrome-unsaved.sh'), 'utf-8'))![1].replace('$NONCE', 'N');
  const verdict = (html: string, act?: (d: Document) => void) => {
    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    act?.(dom.window.document);
    return dom.window.eval(check) as string;
  };

  it('no edits is no; typed text, a ticked box, a changed select and editable text are yes', () => {
    expect(verdict('<input value="a"><textarea>b</textarea><input type="checkbox" checked><select><option>1</option><option selected>2</option></select><input type="hidden" value="x">')).toBe('Nno');
    expect(verdict('<input value="a">', (d) => { (d.querySelector('input') as HTMLInputElement).value = 'typed'; })).toBe('Nyes');
    expect(verdict('<textarea></textarea>', (d) => { (d.querySelector('textarea') as HTMLTextAreaElement).value = 'draft'; })).toBe('Nyes');
    expect(verdict('<input type="checkbox">', (d) => { (d.querySelector('input') as HTMLInputElement).checked = true; })).toBe('Nyes');
    expect(verdict('<select><option selected>1</option><option>2</option></select>', (d) => { (d.querySelector('select') as HTMLSelectElement).selectedIndex = 1; })).toBe('Nyes');
    expect(verdict('<div contenteditable>hello</div>')).toBe('Nyes');
    expect(verdict('<div contenteditable="false">hello</div>')).toBe('Nno');
  });

  it('focus inside a frame is unreadable', () => {
    expect(verdict('<iframe></iframe>', (d) => { (d.querySelector('iframe') as HTMLIFrameElement).tabIndex = 0; (d.querySelector('iframe') as HTMLIFrameElement).focus(); })).toBe('Nunreadable');
  });
});

describe('the scripts refuse off macOS and outside the profiles folder', () => {
  it('exit 2 on Linux', () => {
    stub('uname', 'echo Linux');
    for (const name of ['chrome-close.sh', 'chrome-renew.sh', 'chrome-unsaved.sh']) {
      const r = run(name, ['someprofile']);
      expect(r.status, name).toBe(2);
      expect(r.stderr).toContain('ERR macos-only');
    }
  });

  it.skipIf(!HAS_PY)('refuse a profile outside the agent home and a ledger dir outside the profiles folder', () => {
    stub('uname', 'echo Darwin');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-outside-'));
    try {
      for (const name of ['chrome-close.sh', 'chrome-renew.sh', 'chrome-unsaved.sh']) {
        const r = run(name, [outside]);
        expect(r.status, name).toBe(64);
        expect(r.stderr).toContain('ERR profile-outside-agent-home');
      }
      const r = run('chrome-ledger.sh', ['launch', outside]);
      expect(r.status).toBe(64);
      expect(r.stderr).toContain('ERR ledger-dir-outside-profiles');
    } finally {
      SafeFsExecutor.safeRmSync(outside, { recursive: true, force: true, operation: 'tests/unit/browser-care-scripts.test.ts outside' });
    }
  });
});

describe.skipIf(!HAS_PY)('the ledger', () => {
  beforeEach(() => { stub('uname', 'echo Darwin'); stub('ps', 'true'); stub('open', 'true'); });

  it('chrome-launch.sh records the launch with session, topic, purpose and a declared lifetime', () => {
    const r = run('chrome-launch.sh', ['--new', '--purpose', 'usage page', '--ttl-minutes', '45', 'acct-a'], { INSTAR_SESSION_NAME: 'echo-topic-7', INSTAR_TELEGRAM_TOPIC: '7' });
    expect(r.status, r.stderr).toBe(0);
    const e = JSON.parse(fs.readFileSync(ledgerFile(profile('acct-a')), 'utf-8'));
    expect(e).toMatchObject({ userDataDir: profile('acct-a'), pid: null, sessionName: 'echo-topic-7', topicId: '7', purpose: 'usage page', ttlMinutes: 45, ttlDeclared: true, completedAt: null });
    expect(Date.parse(e.leaseUntil) - Date.parse(e.openedAt)).toBe(45 * 60_000);
  });

  it('without --ttl-minutes the lease is the default and not declared; a bad ttl is refused', () => {
    expect(run('chrome-launch.sh', ['--new', 'acct-b']).status).toBe(0);
    expect(JSON.parse(fs.readFileSync(ledgerFile(profile('acct-b')), 'utf-8'))).toMatchObject({ ttlMinutes: 120, ttlDeclared: false, purpose: null });
    const bad = run('chrome-launch.sh', ['--ttl-minutes', 'soon', 'acct-b']);
    expect(bad.status).toBe(64);
    expect(bad.stderr).toContain('ERR bad-ttl');
  });

  it('renew moves the lease; touch on a missing entry writes nothing', () => {
    run('chrome-launch.sh', ['--new', 'acct-c']);
    const file = ledgerFile(profile('acct-c'));
    const before = JSON.parse(fs.readFileSync(file, 'utf-8'));
    before.lastUsedAt = '2020-01-01T00:00:00.000Z'; before.leaseUntil = '2020-01-01T00:00:00.000Z';
    fs.writeFileSync(file, JSON.stringify(before));
    expect(run('chrome-renew.sh', ['acct-c']).stdout).toContain('renewed');
    const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(Date.parse(after.leaseUntil)).toBeGreaterThan(Date.now());
    fs.mkdirSync(profile('acct-d'), { recursive: true });
    expect(run('chrome-ledger.sh', ['touch', profile('acct-d')]).status).toBe(0);
    expect(fs.existsSync(ledgerFile(profile('acct-d')))).toBe(false);
  });

  it('chrome-close.sh --when-free records the completion signal and closes nothing', () => {
    run('chrome-launch.sh', ['--new', 'acct-e']);
    const r = run('chrome-close.sh', ['acct-e', '--when-free']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('recorded');
    expect(JSON.parse(fs.readFileSync(ledgerFile(profile('acct-e')), 'utf-8')).completedAt).not.toBeNull();
    const log = fs.readFileSync(path.join(home, 'logs', 'browser-care.jsonl'), 'utf-8');
    expect(JSON.parse(log.trim())).toMatchObject({ event: 'completion-recorded', dryRun: true, profile: '.instar/state/playwright-profiles/acct-e' });
  });

  it('chrome-close.sh reports a dry-run verdict from the tab check and never signals', () => {
    run('chrome-launch.sh', ['--new', 'acct-f']);
    const dir = profile('acct-f');
    stub('ps', `echo "4242 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${dir} about:blank"`);
    stub('kill', 'echo KILLED >&2; exit 99');
    fs.mkdirSync(path.join(home, 'nodl'));
    fs.writeFileSync(path.join(dir, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: path.join(home, 'nodl') } }));
    stub('osascript', 'echo "tab 1.1 no"; echo "tab 1.2 yes"; echo done');
    let r = run('chrome-close.sh', ['acct-f']);
    expect(r.stdout).toContain('would KEEP: a tab holds unsaved input');
    stub('osascript', 'echo "tab 1.1 no"; echo done');
    r = run('chrome-close.sh', ['acct-f']);
    expect(r.stdout).toContain('DRY-RUN: would close acct-f (pid 4242)');
    stub('osascript', 'echo done');
    expect(run('chrome-close.sh', ['acct-f']).stdout).toContain('could not be read');
    expect(r.stderr).not.toContain('KILLED');
  });

  it('chrome-close.sh and chrome-unsaved.sh never pick Chrome for Testing or an automation-driven Chrome on the same profile', () => {
    run('chrome-launch.sh', ['--new', 'acct-g']);
    const dir = profile('acct-g');
    stub('ps', [
      `echo "5001 /Users/x/Library/Caches/ms-playwright/chromium-1/chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing --user-data-dir=${dir}"`,
      `echo "5002 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-pipe --user-data-dir=${dir}"`,
    ].join('\n'));
    stub('osascript', 'echo OSASCRIPT-RAN >&2; echo done');
    expect(run('chrome-unsaved.sh', ['acct-g']).stdout.trim()).toBe('NO_PID');
    const r = run('chrome-close.sh', ['acct-g']);
    expect(r.stdout).toContain('not running');
    expect(r.stderr).not.toContain('OSASCRIPT-RAN');
  });
});
