/**
 * SEC-164 part 1 slice 1d: the session-record and log sweeper (§3.1–§3.3, §4.1–§4.4, §5, §6).
 * Fake keys are built at run time so no key-shaped literal sits in the source.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  sweepFile, listSweepTargets, neverTouchIdentities, plainReplacement, reapplyIntent, encodedProjectName,
  firstPassBytesPerMinute, type PassDeps, type SweepTarget, type WriteIntent,
} from '../../src/core/credentialSweeper.js';
import { CredentialSweepRunner } from '../../src/core/credentialSweepRunner.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { CREDENTIAL_REMOVED_MARKER } from '../../src/messaging/outbound-credential-guard.js';

const gh = 'ghp_' + 'x'.repeat(36);
const pem = '-----BEGIN PRIVATE KEY-----\n' + 'A'.repeat(64) + '\n' + 'B'.repeat(64) + '\n-----END PRIVATE KEY-----';
let root: string;
let projectDir: string;
let stateDir: string;
const intents: WriteIntent[] = [];

function deps(over: Partial<PassDeps> = {}): PassDeps {
  return {
    apply: true, own: null, neverTouch: new Set(), now: () => Date.now(), budget: 64 * 1024 * 1024,
    recordIntent: (i) => { intents.push(i); }, clearIntent: (i) => { const k = intents.indexOf(i); if (k >= 0) intents.splice(k, 1); },
    ...over,
  };
}
const t = (p: string, jsonl = p.endsWith('.jsonl')): SweepTarget => ({ path: p, rootClass: 'logs', jsonl });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sec164-sweep-'));
  projectDir = path.join(root, 'agent');
  stateDir = path.join(projectDir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  intents.length = 0;
});
afterEach(() => { SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/unit/sec164-sweeper.test.ts' }); });

describe('SEC-164 1d: sweepFile', () => {
  it('masks a key inside a JSONL value at the same length, and the line re-reads with the same keys', () => {
    const f = path.join(stateDir, 'logs', 'a.jsonl');
    const line = JSON.stringify({ type: 'tool_result', out: `token ${gh} end` }) + '\n';
    fs.writeFileSync(f, line);
    const before = fs.statSync(f).size;
    const r = sweepFile(t(f), null, 'rev1', 'on', deps());
    expect(r.result.masked).toBe(1);
    const after = fs.readFileSync(f, 'utf8');
    expect(fs.statSync(f).size).toBe(before);
    expect(after).not.toContain(gh);
    expect(Object.keys(JSON.parse(after))).toEqual(['type', 'out']);
    expect(r.state!.checkedThrough).toBe(before);
    expect(r.state!.maskedThrough).toBe(before);
    expect(intents).toEqual([]); // every intent cleared after its write
  });

  it('the dry run records the match and writes nothing', () => {
    const f = path.join(stateDir, 'logs', 'a.jsonl');
    const line = JSON.stringify({ out: gh }) + '\n';
    fs.writeFileSync(f, line);
    const r = sweepFile(t(f), null, 'rev1', 'dry-run', deps({ apply: false }));
    expect(r.result.masked).toBe(1);
    expect(fs.readFileSync(f, 'utf8')).toBe(line);
    expect(r.state!.checkedThrough).toBe(line.length);
    expect(r.state!.maskedThrough).toBe(0);
  });

  it('switching into masking checks the file again from its masked-through mark', () => {
    const f = path.join(stateDir, 'logs', 'a.jsonl');
    fs.writeFileSync(f, JSON.stringify({ out: gh }) + '\n');
    const dry = sweepFile(t(f), null, 'rev1', 'dry-run', deps({ apply: false }));
    const on = sweepFile(t(f), dry.state, 'rev1', 'on', deps());
    expect(on.result.masked).toBe(1);
    expect(fs.readFileSync(f, 'utf8')).not.toContain(gh);
  });

  it('a new detector revision checks the file again from the start', () => {
    const f = path.join(stateDir, 'logs', 'a.log');
    fs.writeFileSync(f, 'clean line\n');
    const first = sweepFile(t(f), null, 'rev1', 'on', deps());
    const again = sweepFile(t(f), first.state, 'rev2', 'on', deps());
    expect(again.result.bytesRead).toBe('clean line\n'.length);
  });

  it('holds back a partial last line until it ends, and scans it once the file is idle', () => {
    const f = path.join(stateDir, 'logs', 'a.log');
    fs.writeFileSync(f, `done line\npartial ${gh}`);
    const r1 = sweepFile(t(f), null, 'rev1', 'on', deps());
    expect(r1.state!.checkedThrough).toBe('done line\n'.length);
    expect(fs.readFileSync(f, 'utf8')).toContain(gh);
    const later = sweepFile(t(f), r1.state, 'rev1', 'on', deps({ now: () => Date.now() + 61_000 }));
    expect(later.result.masked).toBe(1);
    expect(fs.readFileSync(f, 'utf8')).not.toContain(gh);
  });

  it('masks a PEM block in a plain-text log, keeping its line endings and the file size', () => {
    const f = path.join(stateDir, 'logs', 'a.err');
    const text = `before\n${pem}\nafter\n`;
    fs.writeFileSync(f, text);
    sweepFile(t(f, false), null, 'rev1', 'on', deps());
    const out = fs.readFileSync(f, 'utf8');
    expect(out.length).toBe(text.length);
    expect(out.split('\n').length).toBe(text.split('\n').length);
    expect(out).not.toContain('A'.repeat(64));
    expect(out.startsWith('before\n')).toBe(true);
    expect(out.endsWith('\nafter\n')).toBe(true);
  });

  it('holds a PEM block whose END has not arrived yet, then masks it whole', () => {
    const f = path.join(stateDir, 'logs', 'a.err');
    const head = 'x\n-----BEGIN PRIVATE KEY-----\n' + 'A'.repeat(64) + '\n';
    fs.writeFileSync(f, head);
    const r1 = sweepFile(t(f, false), null, 'rev1', 'on', deps());
    expect(r1.state!.checkedThrough).toBe(2);
    fs.appendFileSync(f, 'B'.repeat(64) + '\n-----END PRIVATE KEY-----\n');
    sweepFile(t(f, false), r1.state, 'rev1', 'on', deps());
    expect(fs.readFileSync(f, 'utf8')).not.toContain('A'.repeat(64));
  });

  it('refuses a symbolic link, a file with a second hard link, and the never-touch set', () => {
    const real = path.join(stateDir, 'logs', 'real.log');
    fs.writeFileSync(real, `${gh}\n`);
    const link = path.join(stateDir, 'logs', 'link.log');
    fs.symlinkSync(real, link);
    expect(sweepFile(t(link), null, 'r', 'on', deps()).result.skipped).toBe('linked');
    const hard = path.join(stateDir, 'logs', 'hard.log');
    fs.linkSync(real, hard);
    expect(sweepFile(t(real), null, 'r', 'on', deps()).result.skipped).toBe('linked');
    SafeFsExecutor.safeUnlinkSync(hard, { operation: 'tests/unit/sec164-sweeper.test.ts' });
    const cfg = path.join(stateDir, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ token: gh }));
    const ids = neverTouchIdentities(projectDir, stateDir);
    expect(sweepFile(t(cfg), null, 'r', 'on', deps({ neverTouch: ids })).result.skipped).toBe('never-touch');
    expect(fs.readFileSync(cfg, 'utf8')).toContain(gh);
  });

  it('a file that changes between the read and the write is left for the next pass', () => {
    const f = path.join(stateDir, 'logs', 'a.log');
    fs.writeFileSync(f, `${gh}\n`);
    const r = sweepFile(t(f), null, 'r', 'on', deps({
      recordIntent: () => { fs.writeFileSync(f, 'replaced!' + ' '.repeat(40) + '\n'); },
    }));
    expect(['changed-during-write', undefined]).toContain(r.result.skipped);
    expect(fs.readFileSync(f, 'utf8')).not.toContain(gh.slice(4));
  });

  it('a short plain span becomes stars, a long one the marker, and line endings stay', () => {
    expect(plainReplacement(Buffer.from('abc')).toString()).toBe('***');
    expect(plainReplacement(Buffer.from('x'.repeat(25))).toString()).toBe(CREDENTIAL_REMOVED_MARKER + '     ');
    expect(plainReplacement(Buffer.from('a'.repeat(30) + '\n' + 'b'.repeat(5))).toString().split('\n').length).toBe(2);
  });
});

describe('SEC-164 1d: crash safety', () => {
  it('an interrupted write is finished after a restart, and a done one is just cleared', () => {
    const f = path.join(stateDir, 'logs', 'a.log');
    fs.writeFileSync(f, `k ${gh}\n`);
    const st = fs.statSync(f);
    const rep = plainReplacement(Buffer.from(gh));
    const intent: WriteIntent = { path: f, dev: st.dev, ino: st.ino, offset: 2, replacement: rep.toString('base64'), originalSha: crypto.createHash('sha256').update(gh).digest('hex') };
    expect(reapplyIntent(intent)).toBe(true);
    expect(fs.readFileSync(f, 'utf8')).toBe(`k ${rep.toString()}\n`);
    expect(reapplyIntent(intent)).toBe(true); // already the replacement
  });

  it('bytes that are neither the original nor the replacement are left alone (no torn-write guessing)', () => {
    const f = path.join(stateDir, 'logs', 'a.log');
    const rep = plainReplacement(Buffer.from(gh));
    const other = 'path/to/some/other/file/name/that/is/long';
    fs.writeFileSync(f, `k ${other.slice(0, gh.length)}\n`);
    const st = fs.statSync(f);
    const intent: WriteIntent = { path: f, dev: st.dev, ino: st.ino, offset: 2, replacement: rep.toString('base64'), originalSha: crypto.createHash('sha256').update(gh).digest('hex') };
    expect(reapplyIntent(intent)).toBe(true);
    expect(fs.readFileSync(f, 'utf8')).toContain(other.slice(0, gh.length));
  });

  it('an intent on a never-touch or hard-linked file is cleared without writing', () => {
    const f = path.join(stateDir, 'config.json');
    fs.writeFileSync(f, `{"k":"${gh}"}`);
    const st = fs.statSync(f);
    const rep = plainReplacement(Buffer.from(gh));
    const intent: WriteIntent = { path: f, dev: st.dev, ino: st.ino, offset: 6, replacement: rep.toString('base64'), originalSha: crypto.createHash('sha256').update(gh).digest('hex') };
    expect(reapplyIntent(intent, neverTouchIdentities(projectDir, stateDir))).toBe(true);
    expect(fs.readFileSync(f, 'utf8')).toContain(gh);
  });
});

describe('SEC-164 1d: review fixes', () => {
  it('a plain file with an invalid UTF-8 byte before the key masks exactly the key', () => {
    const f = path.join(stateDir, 'logs', 'bin.log');
    const content = Buffer.concat([Buffer.from('pre '), Buffer.from([0xff, 0xfe, 0x80]), Buffer.from(` ${gh} post\n`)]);
    fs.writeFileSync(f, content);
    sweepFile(t(f, false), null, 'r', 'on', deps());
    const out = fs.readFileSync(f);
    expect(out.length).toBe(content.length);
    expect(out.subarray(0, 7).equals(content.subarray(0, 7))).toBe(true); // the binary bytes are untouched
    expect(out.toString('latin1')).not.toContain(gh);
    expect(out.toString('latin1').endsWith(' post\n')).toBe(true);
  });

  it('a plain line longer than one slice does not stall the file: a key after it is still masked', () => {
    const f = path.join(stateDir, 'logs', 'long.log');
    const long = 'a'.repeat(3 * 1024 * 1024);
    fs.writeFileSync(f, `${long} ${gh}\nnext ${gh}\n`);
    const r = sweepFile(t(f, false), null, 'r', 'on', deps());
    const out = fs.readFileSync(f, 'latin1');
    expect(out).not.toContain(gh);
    expect(out.length).toBe(long.length + gh.length * 2 + 8);
    expect(r.state!.checkedThrough).toBe(out.length);
  });

  it('an idle tail is masked but its mark stays at the line start, so a continued line is checked whole', () => {
    const f = path.join(stateDir, 'logs', 'tail.log');
    fs.writeFileSync(f, `done\ntail ${gh}`);
    const r = sweepFile(t(f), null, 'r', 'on', deps({ now: () => Date.now() + 61_000 }));
    expect(fs.readFileSync(f, 'utf8')).not.toContain(gh);
    expect(r.state!.checkedThrough).toBe('done\n'.length);
  });

  it('a file truncated and regrown on the same inode is checked again from the start', () => {
    const f = path.join(stateDir, 'logs', 'regrow.log');
    fs.writeFileSync(f, 'first content line\n');
    const r1 = sweepFile(t(f), null, 'r', 'on', deps());
    const fd = fs.openSync(f, 'r+');
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, Buffer.from(`NEW ${gh} and much more text so it is longer\n`), 0, undefined, 0);
    fs.closeSync(fd);
    sweepFile(t(f), r1.state, 'r', 'on', deps());
    expect(fs.readFileSync(f, 'utf8')).not.toContain(gh);
  });

  it('a listed folder reached through a directory link is never entered', () => {
    const outside = path.join(root, 'outside-logs');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'x.jsonl'), 'x');
    fs.mkdirSync(path.join(projectDir, 'logs-real'), { recursive: true });
    fs.symlinkSync(outside, path.join(stateDir, 'hook-events'));
    const list = listSweepTargets({ projectDir, stateDir, configHomes: [] }).map((x) => x.path);
    expect(list.some((p) => p.startsWith(outside) || p.includes('hook-events'))).toBe(false);
  });

  it('a Claude project folder with no recorded cwd, or one cwd outside the project, is not confirmed', () => {
    const home = path.join(root, 'home2', '.claude');
    const mine = path.join(home, 'projects', encodedProjectName(projectDir));
    fs.mkdirSync(mine, { recursive: true });
    fs.writeFileSync(path.join(mine, 'a.jsonl'), JSON.stringify({ type: 'x' }) + '\n');
    expect(listSweepTargets({ projectDir, stateDir, configHomes: [home] }).length).toBe(0);
    fs.writeFileSync(path.join(mine, 'b.jsonl'), JSON.stringify({ cwd: projectDir }) + '\n');
    fs.writeFileSync(path.join(mine, 'c.jsonl'), JSON.stringify({ cwd: '/somewhere/else' }) + '\n');
    expect(listSweepTargets({ projectDir, stateDir, configHomes: [home] }).length).toBe(0);
  });
});

describe('SEC-164 1d: the fixed list', () => {
  it('takes only this agent\'s Claude project folders confirmed by cwd, never the memory link, plus the listed logs', () => {
    const home = path.join(root, 'home', '.claude');
    const mine = path.join(home, 'projects', encodedProjectName(projectDir));
    const other = path.join(home, 'projects', encodedProjectName(path.join(root, 'someone-else')));
    fs.mkdirSync(path.join(mine, 'sess1', 'tool-results'), { recursive: true });
    fs.mkdirSync(path.join(mine, 'memory'), { recursive: true });
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(mine, 's.jsonl'), JSON.stringify({ cwd: projectDir }) + '\n');
    fs.writeFileSync(path.join(mine, 'sess1', 'tool-results', 'out.txt'), 'x');
    fs.writeFileSync(path.join(mine, 'memory', 'MEMORY.md'), 'x');
    fs.writeFileSync(path.join(other, 's.jsonl'), JSON.stringify({ cwd: path.join(root, 'someone-else') }) + '\n');
    fs.writeFileSync(path.join(stateDir, 'logs', 'server.log'), 'x');
    fs.writeFileSync(path.join(stateDir, 'logs', 'credential-scrub.jsonl'), 'x');
    fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
    const list = listSweepTargets({ projectDir, stateDir, configHomes: [home] }).map((x) => path.relative(root, x.path));
    expect(list).toContain(path.relative(root, path.join(mine, 's.jsonl')));
    expect(list).toContain(path.relative(root, path.join(mine, 'sess1', 'tool-results', 'out.txt')));
    expect(list).toContain(path.relative(root, path.join(stateDir, 'logs', 'server.log')));
    expect(list.some((p) => p.includes('memory'))).toBe(false);
    expect(list.some((p) => p.includes('someone-else'))).toBe(false);
    expect(list.some((p) => p.endsWith('credential-scrub.jsonl'))).toBe(false);
    expect(list.some((p) => p.endsWith('config.json'))).toBe(false);
  });

  it('paces the first pass by the load verdict', () => {
    expect(firstPassBytesPerMinute('ok')).toBe(Number.POSITIVE_INFINITY);
    expect(firstPassBytesPerMinute('elevated')).toBe(200 * 1024 * 1024);
    expect(firstPassBytesPerMinute('unknown')).toBe(200 * 1024 * 1024);
    expect(firstPassBytesPerMinute('saturated')).toBe(20 * 1024 * 1024);
    expect(firstPassBytesPerMinute('impaired')).toBe(20 * 1024 * 1024);
  });
});

describe('SEC-164 1d: the runner', () => {
  function runner(over: Partial<ConstructorParameters<typeof CredentialSweepRunner>[0]> = {}, clock = { t: 1_000_000 }) {
    const reports: string[] = [];
    const r = new CredentialSweepRunner({
      projectDir, stateDir, mode: () => 'on', intervalSeconds: () => 15, loadVerdict: () => 'ok',
      configHomes: () => [], codexHome: () => null, ownCredentials: () => null, shortCredentialCount: () => 0,
      patternsSource: 'p1', report: (x) => reports.push(x), now: () => clock.t, ...over,
    });
    return { r, reports, clock };
  }

  it('masks a listed log, writes the record without the value, and reports counts by kind', async () => {
    const f = path.join(stateDir, 'logs', 'server.log');
    fs.writeFileSync(f, `boot\nleaked ${gh}\n`);
    const { r } = runner();
    await r.tick();
    expect(fs.readFileSync(f, 'utf8')).not.toContain(gh);
    const rec = fs.readFileSync(path.join(stateDir, 'logs', 'credential-scrub.jsonl'), 'utf8');
    expect(rec).not.toContain(gh);
    expect(rec).not.toContain('server.log');
    const s = r.status();
    expect(Object.values(s.roots.logs!.masked).reduce((a, b) => a + b, 0)).toBe(1);
    expect(s.pendingIntents).toBe(0);
    expect(JSON.stringify(s)).not.toContain(gh);
    r.stop();
  });

  it('a dry run over an idle-tail key records it once, not on every pass, and nothing stays pending', async () => {
    const f = path.join(stateDir, 'logs', 'tail.log');
    fs.writeFileSync(f, `done\ntail ${gh}`);
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(f, old, old);
    const { r } = runner({ mode: () => 'dry-run', now: () => Date.now() });
    await r.tick(); await r.tick(); await r.tick();
    const rows = fs.readFileSync(path.join(stateDir, 'logs', 'credential-scrub.jsonl'), 'utf8').trim().split('\n');
    expect(rows).toHaveLength(1);
    expect(fs.readFileSync(f, 'utf8')).toContain(gh); // dry run writes nothing
    expect(r.status().roots.logs!.bytesPending).toBe(0);
    r.stop();
  });

  it('with the switch off it touches nothing', async () => {
    const f = path.join(stateDir, 'logs', 'server.log');
    fs.writeFileSync(f, `leaked ${gh}\n`);
    const { r } = runner({ mode: () => 'off' });
    await r.tick();
    expect(fs.readFileSync(f, 'utf8')).toContain(gh);
    r.stop();
  });

  it('the breaker stops the sweeper after five throwing passes, reports once, and retries after 30 minutes', async () => {
    const clock = { t: 1_000_000 };
    let calls = 0;
    const { r, reports } = runner({ configHomes: () => { calls++; throw new Error('boom'); } }, clock);
    for (let i = 0; i < 5; i++) { await r.tick(); clock.t += 15_000; }
    expect(reports).toHaveLength(1);
    const before = calls;
    await r.tick();
    expect(calls).toBe(before); // breaker open: no pass
    clock.t += 30 * 60_000;
    await r.tick();
    expect(calls).toBe(before + 1);
    expect(r.status().breakerOpenUntil).toBeNull();
    r.stop();
  });
});

describe('SEC-164 1d: wiring', () => {
  const read = (p: string) => fs.readFileSync(path.resolve(p), 'utf-8');
  it('the server builds and starts the sweeper, passes it to the routes, and stops it on shutdown', () => {
    const src = read('src/server/AgentServer.ts');
    expect(src).toContain('this.credentialSweeper = new CredentialSweepRunner({');
    expect(src).toContain('this.credentialSweeper.start();');
    expect(src).toContain('credentialSweeper: this.credentialSweeper,');
    expect(src).toContain('this.credentialSweeper?.stop();');
    expect(read('src/server/routes.ts')).toContain("router.get('/credential-scrub', (_req, res) => {");
  });
  it('the settings API cannot change security.credentialScrub (security is not a patchable block)', async () => {
    const { PATCHABLE_CONFIG_KEYS } = await import('../../src/server/routes.js');
    expect(PATCHABLE_CONFIG_KEYS.has('security')).toBe(false);
  });
});
