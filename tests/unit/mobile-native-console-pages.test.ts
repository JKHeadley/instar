/**
 * The trimmed answers for the native console pages and file browser
 * (docs/specs/mobile-native-console-pages.md): field by field, plain words, off and failed reads told
 * apart, secret-shaped names hidden, and long text bounded before it is scrubbed.
 */
import { describe, it, expect } from 'vitest';
import {
  summarizeIdeas, summarizePace, summarizeDevelopment, summarizeMaturation, summarizeFolder, summarizeFile,
  phoneFileText, secretShaped, showsText, MAX_FILE_CHARS, MAX_LINE_CHARS, MAX_FEATURES,
} from '../../src/server/mobileConsolePagesRoutes.js';

const FAKE_KEY = 'ghp_' + 'Q'.repeat(36);
const ok = (body: unknown) => ({ status: 200, body });

describe('summarizeIdeas', () => {
  const body = {
    neverRun: false, funnel: { seen: 5, verified: 2, decided: 1, adopted: 0, bands: { now: 1 } }, proposals: [{ repo: 'a/b' }], lastTickError: 'boom /Users/x/y',
    ideas: [
      { id: 'i2', band: 'watch', claim: 'Later', project: 'p', bandReason: 'young', effectClass: 'nope' },
      { id: 'i1', band: 'now', claim: `Do it ${FAKE_KEY}`, project: 'p', bandReason: 'clear', effectClass: 'additive-dark', goal: { costOfNotAdopting: 'slow' }, evidence: 'raw-secret' },
      { id: 'i3', band: 'made-up', claim: 'Dropped' },
    ],
    watchlist: [{ id: 'w', repo: 'a/b', stalled: true, lastError: 'token leak' }, { id: 'x', repo: 'c/d', lastCheckedAt: '2026-11-01T00:00:00Z' }, { id: 'y', repo: 'e/f' }],
  };
  it('ranks by band, keeps only listed fields, and scrubs', () => {
    const r = summarizeIdeas(ok(body)) as any;
    expect(r.headline).toBe('1 idea is ready to act on.');
    expect(r.ideas.map((i: any) => i.band)).toEqual(['now', 'watch']);
    expect(r.ideas[0].riskWords).toBe('New and off by default');
    expect(r.ideas[1].riskWords).toBe('Risk not judged yet');
    expect(r.projects.map((p: any) => p.line)).toEqual(['Stalled after three failed weeks.', 'Checked 2026-11-01.', 'Not checked yet.']);
    const text = JSON.stringify(r);
    for (const leak of [FAKE_KEY, 'raw-secret', 'boom', 'token leak', '"i1"']) expect(text).not.toContain(leak);
  });
  it('says when it is off, and tells a failed read apart', () => {
    expect(summarizeIdeas({ status: 503, body: {} }).state).toBe('off');
    expect(summarizeIdeas({ status: 0, body: null }).state).toBe('unavailable');
    expect(summarizeIdeas(ok({})).state).toBe('unavailable');
    expect((summarizeIdeas(ok({ ...body, neverRun: true })) as any).headline).toBe('The weekly review has not run yet.');
  });
});

describe('summarizePace', () => {
  it('writes one plain line a queue, drops idle ones and names who did not answer', () => {
    const r = summarizePace(ok({
      sources: [{ machine: 'Laptop', ok: false }, { machine: 'Mac Studio', ok: true }],
      queues: [
        { id: 'a', label: 'Feedback fixes', verdict: 'falling-behind', inflowPerDay: 19.4, outflowPerDay: 0.04, open: 3, machine: 'Mac Studio', machineId: 'm_secret' },
        { id: 'b', label: 'Sorting', verdict: 'catching-up', inflowPerDay: 2, outflowPerDay: 4, open: 1, daysToClear: 2.5 },
        { id: 'c', label: 'People', verdict: 'falling-behind', inflowPerDay: 1, outflowPerDay: 0, open: 1, bottleneck: { kind: 'person' } },
        { id: 'd', label: 'Pile', verdict: 'holding', inflowPerDay: 0, outflowPerDay: 0, open: 4 },
        { id: 'e', label: 'Idle', verdict: 'holding', inflowPerDay: 0, outflowPerDay: 0, open: 0 },
      ],
    })) as any;
    expect(r.rows.map((x: any) => x.line)).toEqual([
      'Feedback fixes: 19 a day in, 0 done — falling behind',
      'Sorting: 2 a day in, 4 done — catching up, about 2.5 days to clear',
      'People: 1 a day in, 0 done — waiting on you',
      'Pile: nothing came in or got done this week; 4 still open',
    ]);
    expect(r.rows.map((x: any) => x.tone)).toEqual(['attn', 'ok', 'muted', 'ok']);
    expect(r.headline).toBe('1 queue is falling behind; 1 queue is waiting on you.');
    expect(r.unread).toEqual(['Laptop']);
    expect(JSON.stringify(r)).not.toContain('m_secret');
  });
  it('a queue past the row cap still reaches the headline, and an unmeasured one is not called healthy', () => {
    const fine = Array.from({ length: 45 }, (_, i) => ({ id: `q${i}`, label: 'Q', verdict: 'holding', inflowPerDay: 1, outflowPerDay: 1 }));
    const r = summarizePace(ok({ queues: [...fine, { id: 'z', label: 'Z', verdict: 'falling-behind', inflowPerDay: 5, outflowPerDay: 0 }] })) as any;
    expect(r.rows).toHaveLength(40);
    expect(r.truncated).toBe(true);
    expect(r.headline).toBe('1 queue is falling behind.');
    expect(r.rows[0].line).toContain('Z:');
    expect((summarizePace(ok({ queues: [{ id: 'p', label: 'P', verdict: 'holding', open: 1, bottleneck: { kind: 'person' } }] })) as any).headline).toBe("1 queue can't be told yet.");
    const u = summarizePace(ok({ queues: [{ id: 'a', label: 'A', verdict: 'unknown', open: 2 }] })) as any;
    expect(u.headline).toBe("1 queue can't be told yet.");
    expect(u.rows[0].line).toBe('A: can’t tell yet');
    expect((summarizePace(ok({ queues: [{ id: 'b', label: 'B', verdict: 'holding', open: 1 }] })) as any).rows[0].tone).toBe('unknown');
  });
  it('the headline says every worry at once', () => {
    const r = summarizePace(ok({ queues: [
      { id: 'a', label: 'A', verdict: 'falling-behind', inflowPerDay: 2, outflowPerDay: 0 },
      { id: 'p', label: 'P', verdict: 'falling-behind', inflowPerDay: 1, outflowPerDay: 0, bottleneck: { kind: 'person' } },
      { id: 'u', label: 'U', verdict: 'unknown', open: 1 },
    ] })) as any;
    expect(r.headline).toBe("1 queue is falling behind; 1 queue is waiting on you; 1 queue can't be told yet.");
  });
  it('work waiting on a person is said, not hidden behind an all clear', () => {
    const r = summarizePace(ok({ queues: [{ id: 'p', label: 'P', verdict: 'falling-behind', inflowPerDay: 1, outflowPerDay: 0, bottleneck: { kind: 'person' } }] })) as any;
    expect(r.headline).toBe('1 queue is waiting on you.');
  });
  it('all clear is scoped to the machines that answered', () => {
    const r = summarizePace(ok({ sources: [{ machine: 'Laptop', ok: false }], queues: [{ id: 'a', label: 'Q', verdict: 'holding', inflowPerDay: 1, outflowPerDay: 1 }] })) as any;
    expect(r.headline).toBe('Nothing is falling behind on the machines that answered.');
  });
  it('says when it is off or unread', () => {
    expect(summarizePace({ status: 503, body: {} }).state).toBe('off');
    expect(summarizePace({ status: 429, body: {} }).state).toBe('unavailable');
  });
});

describe('summarizeDevelopment', () => {
  const watcher = ok({ episodes: [{ state: 'gave-up', headRefOid: 'sha-secret' }, { state: 'armed' }], stuckRed: [{ pr: 7, redForMs: 3 * 86_400_000, failingChecks: ['a', 'b'] }] });
  const verify = ok({ queue: [{ pr: 1 }, { pr: 0 }, { pr: 2 }], inFlight: { pr: 9, headSha: 'sha-secret' } });
  const triage = ok({ counts: { queued: 2, work: 3, hold: 4, ignored: 5, untriaged: 6 }, pausedBecause: null });
  it('counts shipping and feedback, with no heads or check names', () => {
    const r = summarizeDevelopment(watcher, verify, triage) as any;
    expect(r.headline).toBe('2 pull requests waiting for tests, 1 failing.');
    expect(r.shipping).toMatchObject({ waiting: 2, testingNow: 9, failing: 1, gaveUp: 1, held: false });
    expect(r.shipping.rows[0]).toMatchObject({ pr: 7, days: 3, checks: 2 });
    expect(r.feedback).toEqual({ queued: 2, work: 3, held: 4, ignored: 5, untriaged: 6, paused: false });
    expect(JSON.stringify(r)).not.toContain('sha-secret');
  });
  it('a part that fails reads as unknown, not zero; all failed is unavailable; a non-development agent is off', () => {
    const r = summarizeDevelopment({ status: 0, body: null }, verify, triage) as any;
    expect(r.shipping.failing).toBeNull();
    expect(r.shipping.gaveUp).toBeNull();
    expect(r.shipping.rows).toBeNull();
    expect(summarizeDevelopment({ status: 0, body: null }, ok({ queue: [] }), triage).tone).toBe('unknown');
    const failedVerify = summarizeDevelopment(watcher, { status: 500, body: { inFlight: { pr: 9 }, queue: [{ pr: 1 }], mainRedHold: { at: 1 } } }, triage) as any;
    expect(failedVerify.shipping).toMatchObject({ waiting: null, testingNow: null, held: null });
    const none = { status: 0, body: null };
    expect(summarizeDevelopment(none, none, none).state).toBe('unavailable');
    expect(summarizeDevelopment({ status: 503, body: {} }, { status: 503, body: {} }, none).state).toBe('off');
    expect((summarizeDevelopment({ status: 503, body: {} }, { status: 503, body: {} }, triage) as any).feedback.work).toBe(3);
    expect((summarizeDevelopment(watcher, ok({ queue: [], mainRedHold: { at: 1 } }), triage) as any).headline).toBe('Merging is on hold.');
  });
});

describe('summarizeMaturation', () => {
  const f = (id: string, verdict?: string) => ({ id, title: "A feature", owners: [{ facts: { path: '/Users/x' } }], ...(verdict ? { review: { verdict, area: 'Area', line: 'A line', evidence: 'evidence-secret', decision: 'decision-secret', nextStep: 'Next' } } : {}) });
  it('groups by the review verdict in plain words and keeps no setting ids or evidence', () => {
    const r = summarizeMaturation(ok({ reviewDate: '2026-11-02', features: [f('x.y', 'regressed'), f('b', 'live'), f('c', 'blind'), f('d')] })) as any;
    expect(r.headline).toBe('4 features: 1 working, 2 need attention.');
    expect(r.groups.map((g: any) => [g.id, g.count])).toEqual([['broken', 1], ['unmeasured', 1], ['working', 1], ['other', 1]]);
    expect(r.rows[3]).toMatchObject({ group: 'other', line: null });
    const text = JSON.stringify(r);
    for (const leak of ['x.y', 'evidence-secret', 'decision-secret', '/Users/x']) expect(text).not.toContain(leak);
  });
  it('bounds the rows, and says when the review cannot be read', () => {
    const r = summarizeMaturation(ok({ features: Array.from({ length: MAX_FEATURES + 5 }, (_, i) => f(`f${i}`, 'live')) })) as any;
    expect(r.rows).toHaveLength(MAX_FEATURES);
    expect(r.truncated).toBe(true);
    expect(r.groups).toEqual([{ id: 'working', label: 'Working', tone: 'ok', count: MAX_FEATURES + 5 }]);
    const late = summarizeMaturation(ok({ features: [...Array.from({ length: MAX_FEATURES + 5 }, (_, i) => f(`f${i}`, 'live')), f('z', 'regressed')] })) as any;
    expect(late.rows[0].group).toBe('broken');
    expect(r.headline).toBe(`${MAX_FEATURES + 5} features: ${MAX_FEATURES + 5} working, 0 need attention.`);
    expect((summarizeMaturation(ok({ features: [], sources: [{ machine: 'Laptop', ok: false }, { machine: 'Laptop', ok: false }, { machine: 'Mini', ok: true }] })) as any).unread).toEqual(['Laptop']);
    expect(summarizeMaturation(ok({ reviewState: 'unavailable', features: [] })).state).toBe('unavailable');
    expect(summarizeMaturation({ status: 503, body: {} }).state).toBe('off');
  });
});

describe('files', () => {
  it('a folder lists files and folders, without anything whose name says it holds a secret', () => {
    const r = summarizeFolder(ok({ path: '.instar', entries: [
      { name: 'AGENT.md', type: 'file', size: 10, modified: '2026-11-01T00:00:00Z' }, { name: 'logs', type: 'directory' },
      { name: 'keys', type: 'directory' }, { name: 'codex-auth-backup-1', type: 'directory' }, { name: 'credential-locations.json', type: 'file' }, { name: 'odd', type: 'socket' },
    ] })) as any;
    expect(r.entries.map((e: any) => e.name)).toEqual(['AGENT.md', 'logs']);
  });
  it('hidden names do not use up the cap, and a local cut is reported', () => {
    const entries = [{ name: 'keys', type: 'directory' }, ...Array.from({ length: 500 }, (_, i) => ({ name: `f${i}`, type: 'file' }))];
    const r = summarizeFolder(ok({ entries })) as any;
    expect(r.entries).toHaveLength(500);
    expect(r.truncated).toBe(false);
    expect((summarizeFolder(ok({ entries: [...entries, { name: 'one-more', type: 'file' }] })) as any).truncated).toBe(true);
  });
  it('secretShaped reads each part of a path, and leaves ordinary words alone', () => {
    for (const p of ['.instar/keys/a.txt', 'x/my-token.txt', 'secrets', 'vault.json', 'a/private/b']) expect(secretShaped(p)).toBe(true);
    for (const p of ['docs/author.md', 'keyboard.md', 'src/tokenizer.ts', 'tokenization.md', 'notes.md', 'AGENT.md', '']) expect(secretShaped(p), p).toBe(false);
  });
  it('secretary and secretariat show; more credential names, and runs of capitals, are hidden', () => {
    for (const p of ['secretary.md', 'Secretary.md', 'secretariat.md', 'monkey.txt']) expect(secretShaped(p), p).toBe(false);
    for (const p of ['my-secrets.md', 'privkey', 'privkey.txt', 'pwd.txt', 'keyfile.json', 'keypair.json', 'server.ppk', 'krb5.keytab', 'backup.gpg', 'terraform.tfstate', 'wallet.dat', 'recovery-codes.txt', '.kube/config', '.docker/config.json', '.config/gh/hosts.yml', 'HMACKey.txt', 'JWTKey.txt', 'AWSKey.txt', 'tokenissuer.json']) expect(secretShaped(p), p).toBe(true);
  });
  it('only prose and source files show text', () => {
    for (const p of ['a.md', 'docs/A.TXT', 'b.rst', 'c.swift', 'd.ts', 'e.tsx', 'f.js', 'g.mjs', 'h.py', 'i.sh', 'j.css', 'k.html']) expect(showsText(p), p).toBe(true);
    for (const p of ['a.json', 'b.yaml', 'c.yml', 'd.toml', 'e.xml', 'f.ini', 'g.conf', 'h.env', 'i.log', 'j.jsonl', 'k.sql', 'l.plist', 'Dockerfile', '.md', 'x.md.bak', 'config']) expect(showsText(p), p).toBe(false);
  });
  it('names without delimiters, well-known credential files, and folded spellings are all hidden', () => {
    for (const p of ['apikey.txt', 'authToken.txt', 'oauth.json', 'tokens2.json', 'ClaudeCredentials.json', 'my secret.txt', 'accesskey', 'keystore', '.netrc', '.npmrc', '.pgpass', 'id_ecdsa', 'service-account.json', 'signingKey.txt', 'pass.txt']) expect(secretShaped(p), p).toBe(true);
    for (const p of ['.instar/Keys/signing.txt', 'toKen.json', 'my-\u017Fecret.txt', 'TOKEN.JSON', '\uFF4B\uFF45\uFF59\uFF53/a.txt', 'to\u200Bken.json', 'keys\\a.txt']) expect(secretShaped(p), p).toBe(true);
  });
  it('key shapes, labelled values and bearer headers are blanked in file text', async () => {
    const samples = [
      'sk-ant-api03-' + 'a'.repeat(30), 'sk-proj-' + 'b'.repeat(30), 'github_pat_' + 'C'.repeat(30), 'AIza' + 'D'.repeat(35),
      'Authorization: Bearer abc.def/ghi+jkl=', 'curl -H "Bearer abcdefghijkl"', '"secretKey": "value with spaces"',
      'aws_secret_access_key = wJalr/XUtnFEMI+K7MDENG', 'token=abc/def+ghi', "password: 'hunter2'",
    ];
    for (const s of samples) {
      const { text } = await phoneFileText(`before\n${s}\nafter`);
      const secret = s.match(/(?:abc\.def|value with|wJalr|abc\/def|hunter2|abcdefghijkl|sk-|github_pat_|AIza).*/)![0];
      expect(text, s).not.toContain(secret.slice(0, 12));
      expect(text, s).toContain('before');
      expect(text, s).toContain('after');
    }
  });
  it('a private key block and a value on the line after its label are hidden', async () => {
    const pem = (await phoneFileText('a\n-----BEGIN RSA PRIVATE KEY-----\nMIIEbody\nmore\n-----END RSA PRIVATE KEY-----\nz')).text;
    expect(pem).toBe('a\n[private key hidden]\nz');
    expect((await phoneFileText('-----BEGIN OPENSSH PRIVATE KEY-----\nMIIEbody')).text).toBe('[private key hidden]');
    expect((await phoneFileText('"k": "-----BEGIN PRIVATE KEY-----\\nMII\\n-----END PRIVATE KEY-----"')).text).toBe('"k": "[private key hidden]"');
    for (const label of ['password:', 'api_key =', 'client_secret: |', 'Password']) {
      const { text } = await phoneFileText(`${label}\n\n  hunter2value\nnext line`);
      expect(text, label).not.toContain('hunter2value');
      expect(text, label).toContain('next line');
    }
  });
  it('two keys glued on one line, and a key marker past the column cut, stay hidden', async () => {
    const glued = '-----BEGIN RSA PRIVATE KEY-----\nAAA\n-----END RSA PRIVATE KEY----------BEGIN RSA PRIVATE KEY-----\nFAKEVALUE9\n-----END RSA PRIVATE KEY-----\nafter';
    const g = (await phoneFileText(glued)).text;
    expect(g).not.toContain('FAKEVALUE9');
    expect(g).toContain('after');
    const late = (await phoneFileText(`${'x'.repeat(MAX_LINE_CHARS + 2058)} -----BEGIN RSA PRIVATE KEY-----\nFAKEVALUE9\n-----END RSA PRIVATE KEY-----`)).text;
    expect(late).not.toContain('FAKEVALUE9');
    const label = (await phoneFileText(`${'x'.repeat(MAX_LINE_CHARS + 2058)} password:\nFAKEVALUE9`)).text;
    expect(label).not.toContain('FAKEVALUE9');
  });
  it('when scrubbing shrinks the text, a token at a window cut still never shows, at either limit', async () => {
    const gh = 'ghp_' + 'Q'.repeat(36);
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${(`${'M'.repeat(64)}\n`).repeat(60)}-----END RSA PRIVATE KEY-----\n`;
    const window = MAX_FILE_CHARS + 2048;
    for (const keep of [5, 10, 23, 39]) {
      let s = pem;
      while (s.length < window - keep - 81) s += `${'p'.repeat(79)}\n`;
      s += `${'q'.repeat(window - keep - s.length - 1)} ${gh} tail`;
      expect((await phoneFileText(s)).text, String(keep)).not.toContain(gh.slice(0, keep));
      const big = 'sk-' + 'Y'.repeat(3000);
      const w = MAX_LINE_CHARS + 2048;
      const line = `${big} ${'r'.repeat(w - keep - 1 - big.length - 1)} ${gh} tail`;
      expect((await phoneFileText(line)).text, String(keep)).not.toContain(gh.slice(0, keep));
    }
  });
  it('every shared key shape is blanked', async () => {
    const samples = ['sk_live_' + 'e'.repeat(30), 'rk_live_' + 'e'.repeat(30), 'whsec_' + 'e'.repeat(30), `SG.${'f'.repeat(22)}.${'g'.repeat(33)}`, 'ya29.' + 'h'.repeat(30), 'pypi-' + 'i'.repeat(30), 'AGE-SECRET-KEY-' + 'J'.repeat(40), 'gsk_' + 'k'.repeat(30), 'xai-' + 'l'.repeat(30), 'dop_v1_' + 'a'.repeat(40), 'xsk-ant-' + 'm'.repeat(30), 'postgres://u:hunter2@db/x', 'https://' + 'n'.repeat(30) + '@github.com/a'];
    for (const s of samples) {
      const { text } = await phoneFileText(`a ${s} b`);
      expect(text, s).toContain('[hidden]');
      expect(text, s).not.toContain(s.includes('://') ? (s.includes('hunter2') ? 'hunter2' : 'nnnnnn') : s.slice(-10, -1));
    }
  });
  it('a value after its label goes, in the shapes source files use', async () => {
    const V = 'FAKEfake0123456789';
    for (const s of [`const password: string = "${V}";`, `password: str = "${V}"`, `password := "${V}"`, `'password' => '${V}',`, `setPassword("${V}")`, `mysql --password ${V}`, `<password>${V}</password>`, `{\\"api_key\\":\\"${V}\\"}`, `${'a'.repeat(45)}_password=${V}`, `password_${'a'.repeat(45)}=${V}`, `password = correct ${V}`, `export PASSWORD=$'${V}'`, `password = "${V}`]) {
      expect((await phoneFileText(s)).text, s).not.toContain(V);
    }
    expect((await phoneFileText(`${' '.repeat(10)}password:\n${' '.repeat(12)}${V}`)).text).not.toContain(V);
  });
  it('a secret crossing a cut is scrubbed before the cut, at the line limit and the file limit', async () => {
    const key = 'ghp_' + 'Z'.repeat(36);
    const line = await phoneFileText('x'.repeat(MAX_LINE_CHARS - 10) + ' ' + key);
    expect(line.text).not.toContain('ghp_');
    expect(line.text).not.toContain('ZZZZ');
    expect(line.cut).toBe(true);
    const filler = Array.from({ length: 40 }, () => 'y'.repeat(1630)).join('\n');
    const pad = MAX_FILE_CHARS - filler.length - 12;
    const whole = await phoneFileText(`${filler}\n${'y'.repeat(pad)} ${key} tail`);
    expect(whole.text).not.toContain('ZZZZ');
    expect(whole.text.length).toBeLessThanOrEqual(MAX_FILE_CHARS);
  });
  it('the viewer\'s refusals keep their meaning', async () => {
    expect(summarizeFolder({ status: 403, body: {} }).state).toBe('refused');
    expect((await summarizeFile({ status: 403, body: {} })).state).toBe('refused');
    expect((await summarizeFile({ status: 413, body: {} })).state).toBe('too-big');
    expect(summarizeFolder({ status: 404, body: { error: 'file viewer is disabled' } }).state).toBe('off');
    expect((await summarizeFile({ status: 404, body: { error: 'file viewer is disabled' } })).state).toBe('off');
    expect((await summarizeFile({ status: 404, body: { error: 'nope' } })).state).toBe('unavailable');
    expect((await summarizeFile(ok({ binary: true, path: 'a.png', size: 3 }))).state).toBe('binary');
  });
  it('a file is scrubbed and never reports editable', async () => {
    const r = await summarizeFile(ok({ path: 'a.md', content: `one\nkey ${FAKE_KEY}\n`, size: 9, editable: true })) as any;
    expect(r.text).not.toContain(FAKE_KEY);
    expect(r.cut).toBe(false);
    expect(r.editable).toBeUndefined();
  });
  it('long text is cut before it is scrubbed, so one huge line cannot stall the server', async () => {
    const started = Date.now();
    const one = await phoneFileText('a-'.repeat(300_000));
    expect(one.cut).toBe(true);
    expect(one.text.length).toBeLessThanOrEqual(MAX_LINE_CHARS + 1);
    const many = await phoneFileText(Array.from({ length: 100 }, () => 'a-'.repeat(999)).join('\n'));
    expect(many.text.length).toBeLessThanOrEqual(MAX_FILE_CHARS);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
