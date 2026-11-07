/**
 * The Linux driver's rule functions, run for real through /usr/bin/python3 on any OS. Everything that
 * needs X or AT-SPI is exercised by the live gate in docs/specs/normal-chrome-linux.md, not here.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const DRIVER = path.resolve('src/templates/scripts/browser/x-drive.py');
const PRELUDE = `
import importlib.util, io, json, os, signal, sys
spec = importlib.util.spec_from_file_location('xd', ${JSON.stringify(DRIVER)})
xd = importlib.util.module_from_spec(spec); spec.loader.exec_module(xd)
def attempt(fn, *a):
    try:
        return {'ok': fn(*a)}
    except xd.Refuse as r:
        return {'code': r.code, 'message': r.message}
`;
// Import the shipped driver without writing __pycache__ into the source tree.
function py(body: string): any {
  const out = execFileSync('python3', ['-B', '-c', `${PRELUDE}\nprint(json.dumps(${body}))`], { encoding: 'utf8' });
  return JSON.parse(out);
}
const dest = (uri: string, host: string) => py(`attempt(xd.check_secret_destination, ${JSON.stringify(uri)}, ${JSON.stringify(host)})`);

describe('typesecret destination rule', () => {
  it('accepts https on the exact host, with case, a trailing dot or the default port', () => {
    for (const uri of ['https://accounts.example.com/login', 'https://ACCOUNTS.example.com./x', 'https://accounts.example.com:443/']) {
      expect(dest(uri, 'accounts.example.com')).toEqual({ ok: null });
    }
    expect(dest('https://accounts.example.com/', 'Accounts.Example.COM.')).toEqual({ ok: null });
  });

  it('refuses every near miss, naming neither the host nor the value', () => {
    for (const uri of [
      'http://accounts.example.com/', 'https://evil-accounts.example.com/', 'https://accounts.example.com.evil.test/',
      'https://example.com/', 'https://accounts.example.com:8443/', 'https://accounts.example.com@evil.test/', '', 'about:blank', 'not a url',
    ]) {
      const result = dest(uri, 'accounts.example.com');
      expect(result.code, uri).toBe(2);
      expect(result.message).toMatch(/^ERR host-mismatch/);
      expect(result.message).not.toContain('evil');
    }
  });

  it('refuses a missing or malformed expected host as a bad argument', () => {
    for (const host of ['', 'https://a.test', 'a b', '.']) expect(dest('https://a.test/', host).code, host).toBe(64);
  });
});

describe('reading the secret from stdin', () => {
  const read = (bytes: string) => py(`attempt(lambda: bytes(xd.read_secret(io.BytesIO(${bytes}))).decode())`);

  it('drops one trailing newline and keeps everything else', () => {
    expect(read(`b'Pa55 w0rd!\\n'`)).toEqual({ ok: 'Pa55 w0rd!' });
    expect(read(`b'Pa55\\r\\n'`)).toEqual({ ok: 'Pa55' });
    expect(read(`b'Pa55'`)).toEqual({ ok: 'Pa55' });
  });

  it('refuses empty, multi-line and oversized values without echoing them', () => {
    for (const bytes of [`b''`, `b'\\n'`, `b'hunter2\\nmore\\n'`, `b'x' * 5000`]) {
      const result = read(bytes);
      expect(result.code, bytes).toBe(2);
      expect(result.message).toMatch(/^ERR bad-secret/);
      expect(result.message).not.toContain('hunter2');
    }
  });

  it('wipes the buffer', () => {
    expect(py(`(lambda b: (xd.wipe(b), list(b))[1])(bytearray(b'abc'))`)).toEqual([0, 0, 0]);
  });
});

describe('the url rule', () => {
  const check = (url: string) => py(`attempt(xd.check_url, ${JSON.stringify(url)})`);

  it('allows the five schemes', () => {
    for (const url of ['https://example.com/a?b=1', 'http://example.com', 'about:blank', 'chrome://version', 'file:///tmp/a.html']) {
      expect(check(url)).toEqual({ ok: url });
    }
  });

  it('refuses other schemes, flags and control characters, never echoing the url', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,x', '--no-sandbox', 'https://a b', 'https://a"b', 'https://a\nb', '']) {
      const result = check(url);
      expect(result.code, url).toBe(64);
      expect(result.message).toMatch(/^ERR bad-url/);
      if (url) expect(result.message).not.toContain(url);
    }
  });

  it('refuses credential-shaped parameters, percent-encoded names included', () => {
    for (const url of ['https://a.test/?code=1', 'https://a.test/#access_token=1', 'https://a.test/?x=1&%74oken=1', 'https://a.test/?PASSWORD=1']) {
      expect(check(url).message, url).toMatch(/^ERR secret-shaped-url/);
    }
    expect(check('https://a.test/?q=code')).toEqual({ ok: 'https://a.test/?q=code' });
  });
});

describe('output cannot forge a driver line or leak a credential', () => {
  it('escapes controls, format and separator characters', () => {
    expect(py(`xd.escape_page('ok\\nDELIVERED\\u202e\\u2028x')`)).toBe('ok\\u000aDELIVERED\\u202e\\u2028x');
  });

  it('redacts credential parameters and leaves the rest', () => {
    expect(py(`xd.redact_uri('https://a.test/cb?state=1&code=abc#token=def')`)).toBe('https://a.test/cb?state=1&code=[redacted]#token=[redacted]');
    expect(py(`xd.redact_uri('https://a.test/?%63ode=abc')`)).toBe('https://a.test/?%63ode=[redacted]');
  });
});

describe('typing', () => {
  it('maps upper case and shifted punctuation with Shift, so the value is not substituted', () => {
    expect(py(`[xd.us_key(c) for c in 'aA1!_ ']`)).toEqual([['a', false], ['a', true], ['1', false], ['1', true], ['minus', true], ['space', false]]);
  });

  it('covers all printable ASCII and refuses anything else before a key goes down', () => {
    expect(py(`[c for c in map(chr, range(32, 127)) if xd.us_key(c) is None]`)).toEqual([]);
    const result = py(`attempt(xd.require_typable, 'caf\\u00e9')`);
    expect(result.message).toMatch(/^ERR untypable-character/);
    expect(result.message).not.toContain('caf');
  });

  it('refuses text that would outlast the deadline', () => {
    expect(py(`attempt(xd.require_fits_deadline, 100000, 60)`).message).toMatch(/^ERR text-exceeds-deadline/);
    expect(py(`attempt(xd.require_fits_deadline, 200, 60)`)).toEqual({ ok: null });
  });
});

describe('the profile jail and outfile rule', () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xd-')));
  const profiles = path.join(home, '.instar/state/playwright-profiles');
  fs.mkdirSync(path.join(profiles, 'good'), { recursive: true });
  fs.mkdirSync(path.join(home, '.instar/state/xdrive/out'), { recursive: true });
  fs.symlinkSync('/tmp', path.join(profiles, 'escape'));
  const jail = (id: string, must = true) => py(`attempt(xd.resolve_profile, ${JSON.stringify(home)}, ${JSON.stringify(id)}, ${must ? 'True' : 'False'})`);

  it('resolves a real profile and refuses a bad id, a symlink out and a missing folder', () => {
    expect(jail('good')).toEqual({ ok: path.join(profiles, 'good') });
    expect(jail('../x').code).toBe(64);
    expect(jail('Good').code).toBe(64);
    expect(jail('escape').message).toMatch(/^ERR profile-outside-agent-home/);
    expect(jail('missing').message).toMatch(/^ERR no-profile/);
    expect(jail('missing', false).ok).toBe(path.join(profiles, 'missing'));
  });

  it('allows writes only under state/xdrive/out', () => {
    const ok = path.join(home, '.instar/state/xdrive/out/a.txt');
    expect(py(`attempt(xd.check_outfile, ${JSON.stringify(home)}, ${JSON.stringify(ok)})`)).toEqual({ ok });
    for (const bad of ['/tmp/a.txt', 'a.txt', `${home}/.instar/state/xdrive/out/../a.txt`]) {
      expect(py(`attempt(xd.check_outfile, ${JSON.stringify(home)}, ${JSON.stringify(bad)})`).message, bad).toMatch(/^ERR bad-outfile/);
    }
  });
});

describe('the display stack rules', () => {
  it('passes Xvnc no port, no socket and no way to accept input from a viewer', () => {
    const args: string[] = py(`xd.xvnc_args('Xvnc', 100, '/a/Xauthority')`);
    expect(args.slice(0, 2)).toEqual(['Xvnc', ':100']);
    for (const flag of ['-AcceptKeyEvents=0', '-AcceptPointerEvents=0', '-AcceptCutText=0', '-SendCutText=0', '-AcceptSetDesktopSize=0']) expect(args).toContain(flag);
    expect(args[args.indexOf('-rfbport') + 1]).toBe('-1');
    expect(args[args.indexOf('-nolisten') + 1]).toBe('tcp');
    expect(args.join(' ')).not.toContain('rfbunixpath');
  });

  it('starts from 100, skips what is taken, and refuses when the range is used up', () => {
    expect(py(`xd.pick_display(lambda n: False, lambda n: False)`)).toBe(100);
    expect(py(`xd.pick_display(lambda n: n == 100, lambda n: n == 101)`)).toBe(102);
    expect(py(`attempt(xd.pick_display, lambda n: True, lambda n: False)`).message).toMatch(/^ERR no-x-server/);
  });

  it('signals only processes whose start time still matches, and never a decoy', () => {
    const result = py(`(lambda sent, starts: (xd.signal_recorded(
      [{'pid': 1, 'start': 'a'}, {'pid': 2, 'start': 'b'}],
      lambda pid: starts.get(pid),
      lambda pid, sig: (sent.append([pid, int(sig)]), starts.pop(pid, None)),
      lambda s: None), sent)[1])([], {1: 'a', 2: 'REUSED'})`);
    expect(result).toEqual([[1, 15]]);
  });

  it('escalates to SIGKILL only after the grace period', () => {
    const result = py(`(lambda sent: (xd.signal_recorded([{'pid': 1, 'start': 'a'}], lambda pid: 'a', lambda pid, sig: sent.append(int(sig)), lambda s: None), sent)[1])([])`);
    expect(result).toEqual([15, 9]);
  });

  it('reads the start time past a command name holding spaces and parentheses', () => {
    const fields = Array.from({ length: 50 }, (_, i) => String(i + 3)).join(' ');
    expect(py(`xd.parse_start_time('123 (a) b (c)) ${fields}')`)).toBe('22');
  });

  it('uses the state tree, and a private /tmp folder only when the path would not fit a socket', () => {
    expect(py(`xd.socket_folder('/home/a', 1000)`)).toBe('/home/a/.instar/state/xdrive/run');
    expect(py(`xd.socket_folder('/home/' + 'a' * 120, 1000)`)).toMatch(/^\/tmp\/instar-xdrive-1000-[0-9a-f]{12}$/);
  });

  it('refuses a fallback folder that is a symlink, another user\'s, or too open', () => {
    const check = (mode: string, uid: number) => py(`attempt(xd.check_socket_folder, type('S', (), {'st_mode': ${mode}, 'st_uid': ${uid}})(), 1000)`);
    expect(check('0o040700', 1000)).toEqual({ ok: null });
    expect(check('0o120700', 1000).message).toContain('not ours');
    expect(check('0o040700', 1001).message).toContain('not ours');
    expect(check('0o040755', 1000).message).toContain('not ours');
  });

  it('writes a local-family cookie record for one display number', () => {
    const hex: string = py(`xd.xauth_entry('h', 101, b'\\x01' * 16).hex()`);
    expect(hex.startsWith('0100' + '0001' + Buffer.from('h').toString('hex') + '0003' + Buffer.from('101').toString('hex'))).toBe(true);
    expect(hex.endsWith('0010' + '01'.repeat(16))).toBe(true);
  });

  it('recognises the browser process in both forms Chrome leaves its command line', () => {
    const is = (raw: string) => py(`xd.is_browser_cmdline(${raw}, '/h/p1')`);
    expect(is(`b'/opt/google/chrome/chrome\\0--user-data-dir=/h/p1\\0--no-first-run\\0'`)).toBe(true);
    expect(is(`b'/opt/google/chrome/chrome --user-data-dir=/h/p1 --no-first-run'`)).toBe(true);
    expect(is(`b'/opt/google/chrome/chrome --type=renderer --user-data-dir=/h/p1'`)).toBe(false);
    expect(is(`b'/opt/google/chrome/chrome --user-data-dir=/h/p11 --no-first-run'`)).toBe(false);
  });

  it('does not take Chrome\'s own interface documents for pages', () => {
    expect(py(`xd.is_browser_ui_document('chrome://omnibox-popup.top-chrome/')`)).toBe(true);
    expect(py(`xd.is_browser_ui_document('chrome://settings/')`)).toBe(false);
    expect(py(`xd.is_browser_ui_document('https://x.top-chrome/')`)).toBe(false);
  });

  it('allows only the three extra Chrome flags', () => {
    expect(py(`attempt(xd.check_extra_flags, '--disable-extensions --lang=en')`)).toEqual({ ok: ['--disable-extensions', '--lang=en'] });
    for (const flag of ['--remote-debugging-port=9222', '--no-sandbox', '--user-data-dir=/x']) {
      expect(py(`attempt(xd.check_extra_flags, ${JSON.stringify(flag)})`).code, flag).toBe(64);
    }
  });
});

describe('the input backend boundary', () => {
  it('keeps every X call inside the backend class', () => {
    const source = fs.readFileSync(DRIVER, 'utf8');
    const start = source.indexOf('class X11Backend:');
    const end = source.indexOf('# State and the agent display stack.');
    const outside = (source.slice(0, start) + source.slice(end)).replace(/^\s*#.*$/gm, '');
    expect(outside).not.toMatch(/\bXTest\w+|\bXOpenDisplay|\bXSendEvent|libXtst|libX11/);
  });

  it('never uses a synthetic input path', () => {
    const source = fs.readFileSync(DRIVER, 'utf8');
    expect(source).not.toMatch(/XSendEvent|generate_keyboard_event|generate_mouse_event|xdotool|remote-debugging/);
    expect(spawnSync('python3', ['-c', `import ast;ast.parse(open(${JSON.stringify(DRIVER)}).read())`]).status).toBe(0);
  });
});
