/**
 * xdrive.sh and xdrive-provision.sh with stub commands on PATH, and the Secret Drop helper's --browser
 * mode against a real local HTTP server. What needs a real X server is in the spec's live gate.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SRC = path.resolve('src/templates/scripts');

function homeWithScripts(): string {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xw-')));
  const browser = path.join(home, '.instar/scripts/browser');
  fs.mkdirSync(browser, { recursive: true });
  for (const name of ['xdrive.sh', 'x-drive.py', 'xdrive-provision.sh']) fs.copyFileSync(path.join(SRC, 'browser', name), path.join(browser, name));
  fs.copyFileSync(path.join(SRC, 'secret-drop-retrieve.mjs'), path.join(home, '.instar/scripts/secret-drop-retrieve.mjs'));
  return home;
}
function stubs(home: string, map: Record<string, string>): string {
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const [name, body] of Object.entries(map)) fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  return bin;
}
function wrapper(home: string, args: string[], env: Record<string, string> = {}, linux = true) {
  const bin = stubs(home, linux ? { uname: 'echo Linux' } : { uname: 'echo Darwin' });
  return spawnSync(path.join(home, '.instar/scripts/browser/xdrive.sh'), args, {
    encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ...env },
  });
}

describe('xdrive.sh refusals before anything runs', () => {
  it('names the right tool on the wrong platform', () => {
    const r = wrapper(homeWithScripts(), ['url'], {}, false);
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/^ERR use-ndrive/);
  });

  it('refuses WSL with Windows underneath', () => {
    const home = homeWithScripts();
    stubs(home, { 'powershell.exe': 'exit 0' });
    expect(wrapper(home, ['url']).stdout).toMatch(/^ERR use-ndrive/);
  });

  it('refuses an unknown command and text on argv', () => {
    expect(wrapper(homeWithScripts(), ['nope']).status).toBe(64);
    const r = wrapper(homeWithScripts(), ['type', 'hunter2']);
    expect(r.status).toBe(64);
    expect(r.stdout).not.toContain('hunter2');
  });

  it('refuses every command under the --run marker, and typesecret without --browser', () => {
    for (const cmd of ['type', 'typesecret', 'url']) {
      expect(wrapper(homeWithScripts(), [cmd], { XD_SECRET_RUN: '1' }).stdout, cmd).toMatch(/^ERR use-secret-drop-browser/);
    }
    expect(wrapper(homeWithScripts(), ['typesecret', 'a.test']).stdout).toMatch(/^ERR use-secret-drop-browser/);
  });

  it('logs one content-free line per call, refusals included', () => {
    const home = homeWithScripts();
    wrapper(home, ['type', 'hunter2']);
    const log = fs.readFileSync(path.join(home, '.instar/logs/normal-chrome-browser.jsonl'), 'utf8');
    expect(JSON.parse(log.trim())).toMatchObject({ via: 'xdrive', cmd: 'type', exit: 64 });
    expect(log).not.toContain('hunter2');
  });
});

describe('the Secret Drop helper', () => {
  let server: http.Server;
  let port = 0;
  let consumed: string[] = [];
  const submissions: Record<string, unknown> = {
    browser: { values: { password: 'S3cret!' }, browserHost: 'accounts.example.com' },
    plain: { values: { password: 'S3cret!' } },
  };
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '', 'http://x');
      const token = url.pathname.split('/').pop() ?? '';
      if (url.searchParams.get('consume') === 'true') consumed.push(token);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(submissions[token] ?? {}));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => { server.close(); });

  function helper(home: string, args: string[]): Promise<{ code: number | null; out: string; err: string }> {
    return new Promise((resolve) => {
      const child = spawn('node', ['.instar/scripts/secret-drop-retrieve.mjs', ...args], {
        cwd: home, env: { PATH: process.env.PATH ?? '', INSTAR_AUTH_TOKEN: 't', INSTAR_PORT: String(port) },
      });
      let out = ''; let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('close', (code) => resolve({ code, out, err }));
    });
  }
  /** Replaces xdrive.sh with a recorder of its argv, env marker and stdin. */
  function recorder(home: string, exit: number) {
    const file = path.join(home, 'called.txt');
    fs.writeFileSync(path.join(home, '.instar/scripts/browser/xdrive.sh'),
      `#!/bin/bash\n{ echo "args=$*"; echo "marker=$XD_SECRET_BROWSER"; echo "stdin=$(cat)"; } > ${file}\nexit ${exit}\n`, { mode: 0o755 });
    return file;
  }

  it('passes the stored host and the value on stdin, and consumes on exit 0', async () => {
    consumed = [];
    const home = homeWithScripts();
    const file = recorder(home, 0);
    const r = await helper(home, ['browser', 'password', '--browser']);
    expect(r.code).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe('args=typesecret accounts.example.com\nmarker=1\nstdin=S3cret!\n');
    expect(consumed).toEqual(['browser']);
    expect(r.out + r.err).not.toContain('S3cret!');
  });

  it('keeps the submission when typing fails', async () => {
    consumed = [];
    const home = homeWithScripts();
    recorder(home, 2);
    expect((await helper(home, ['browser', 'password', '--browser'])).code).toBe(2);
    expect(consumed).toEqual([]);
  });

  it('refuses every other exit for a browser password, and a stray --consume destroys nothing', async () => {
    consumed = [];
    for (const args of [['browser', 'password'], ['browser', 'password', '--consume'], ['browser', 'password', '--run', '--', 'cat']]) {
      const r = await helper(homeWithScripts(), args);
      expect(r.code, args.join(' ')).toBe(1);
      expect(r.out).toBe('');
    }
    expect(consumed).toEqual([]);
  });

  it('shows no length for a browser password', async () => {
    const r = await helper(homeWithScripts(), ['browser', '--names']);
    expect(r.err).toContain('password');
    expect(r.err).not.toContain('length');
  });

  it('reads no helper flag after --, which belongs to the --run command', async () => {
    consumed = [];
    const r = await helper(homeWithScripts(), ['plain', 'password', '--run', '--', 'sh', '-c', 'cat >/dev/null; exit 3', '--browser', '--consume']);
    expect(r.code).toBe(3);
    expect(consumed).toEqual([]);
  });

  it('refuses --browser on a request with no browserHost', async () => {
    const r = await helper(homeWithScripts(), ['plain', 'password', '--browser']);
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
  });

  it('leaves plain retrieval and --consume working, and marks --run children', async () => {
    consumed = [];
    const home = homeWithScripts();
    expect((await helper(home, ['plain', 'password'])).out).toBe('S3cret!');
    expect(consumed).toEqual([]);
    expect((await helper(home, ['plain', 'password', '--consume'])).out).toBe('S3cret!');
    expect(consumed).toEqual(['plain']);
    const marker = await helper(home, ['plain', 'password', '--run', '--', 'sh', '-c', 'echo "$XD_SECRET_RUN"']);
    expect(marker.out.trim()).toBe('1');
  });
});

describe('xdrive-provision.sh', () => {
  const REAL_KEY = 'EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796';
  function setup(fingerprint: string) {
    const home = homeWithScripts();
    const calls = path.join(home, 'calls.txt');
    const bin = stubs(home, {
      sudo: `shift; echo "sudo $*" >> ${calls}; if [ "$1" = tee ]; then cat >/dev/null; fi; exit 0`,
      curl: `echo "curl $*" >> ${calls}; for a in "$@"; do last="$a"; done; : > "$last"`,
      gpg: `case "$*" in *--show-keys*) printf 'pub:-:4096:1:X:1:::-:::scSC::::::23::0:\\nfpr:::::::::${fingerprint}:\\n' ;; *--export*) echo key ;; esac; exit 0`,
      flock: 'exit 0',
      timeout: 'shift 2; exec "$@"',
    });
    const r = spawnSync(path.join(home, '.instar/scripts/browser/xdrive-provision.sh'), [home], {
      encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home },
    });
    const result = JSON.parse(fs.readFileSync(path.join(home, '.instar/state/xdrive/provision.json'), 'utf8'));
    return { r, result, calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '' };
  }

  it('runs the steps in order through sudo -n and ends ready', () => {
    const { result, calls } = setup(REAL_KEY);
    expect(result.status).toBe('ready');
    const order = ['dpkg --configure -a', 'tee /etc/default/google-chrome', 'curl', 'install -m 0644', 'tee /etc/apt/sources.list.d/google-chrome.list', 'apt-get -o DPkg::Lock::Timeout=300 update', 'DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 install'];
    const at = order.map((step) => calls.indexOf(step));
    expect(at.every((n) => n >= 0), calls).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(calls).toContain('google-chrome-stable');
  });

  it('stops before any install when the key fingerprint differs', () => {
    const { result, calls } = setup('0000000000000000000000000000000000000000');
    expect(result.status).toBe('failed: key');
    expect(calls).not.toContain('apt-get');
    expect(calls).not.toContain('sources.list.d');
  });
});
