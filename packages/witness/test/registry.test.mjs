// The registry client (publish / lookup / get / stats) against a local fake HTTP
// server. The rule under test: the server is never the authority. Everything it
// returns is re-verified here, and everything it merely asserts is labelled so.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createBinding, createRecord, createRevocation, generateWitnessKey, didKeyFromPublicKey,
  bindingHash, recordHash, registryBase, registryRequest, assessLookupPage, DEFAULT_REGISTRY,
} from '../dist/index.js';
import { run } from '../dist/cli.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');

// ── fixtures ────────────────────────────────────────────────────────────

/** An agent with a did:key name (its Threadline key), a Witness key, and a seq-0 binding. */
function issuer() {
  const threadline = generateWitnessKey(); // any Ed25519 pair serves as a Threadline key
  const witness = generateWitnessKey();
  const did = didKeyFromPublicKey(threadline.publicKey);
  const binding = createBinding({ agent: did, threadline, witness });
  return { did, threadline, witness, binding, bindingHash: bindingHash(binding) };
}

const SUBJECT = 'did:web:api.moltbridge.ai:agents:dawn';

function record(who, overrides = {}) {
  return createRecord({
    issuer: who.did, subject: SUBJECT, claim: 'collaborated', context: 'Built the registry client together',
    evidence: ['threadline:thread-3e84d9ed'], confidence: 90, ...overrides,
  }, who.witness);
}

/** A server row for a record signed under `who`. */
function row(who, rec, extra = {}) {
  return { recordHash: recordHash(rec), record: rec, bindingHash: who.bindingHash, ...extra };
}

/** A fake registry. `routes` maps "METHOD /path" (path without query) to a handler (req, body, url) → [status, json|string]. */
function fakeRegistry(routes) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const key = `${req.method} ${url.pathname}`;
      const bodyText = Buffer.concat(chunks).toString('utf8');
      seen.push({ key, url, body: bodyText ? JSON.parse(bodyText) : undefined });
      const handler = routes[key] ?? routes[`${req.method} *`];
      if (!handler) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"no route"}'); return; }
      const out = handler(req, seen[seen.length - 1].body, url, res);
      if (out === undefined) return; // handler wrote the response itself
      const [status, payload] = out;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      servers.push(server);
      resolve({ base, seen, server });
    });
  });
}
const servers = [];
after(() => { for (const s of servers) s.close(); });

function spawnCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function files(...objs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'witness-registry-'));
  return objs.map((o, i) => { const f = path.join(dir, `f${i}.json`); fs.writeFileSync(f, JSON.stringify(o)); return f; });
}

// ── publish ─────────────────────────────────────────────────────────────

test('publish verifies locally FIRST: a record that fails here is never sent', async () => {
  const me = issuer();
  const other = issuer();
  const rec = record(other); // signed by another agent, presented with my binding
  const { base, seen } = await fakeRegistry({ 'POST /witness/records': () => [201, { ok: true, recordHash: 'x' }] });
  const [recFile, bFile] = files(rec, me.binding);
  await assert.rejects(run(['publish', recFile, '--binding', bFile, '--registry', base]), /refusing to publish.*does not verify locally.*issuer is not the agent this binding names/);
  assert.equal(seen.length, 0, 'nothing was sent');
});

test('publish posts {record, binding}, checks the server\'s recordHash against its own, and reports registered', async () => {
  const me = issuer();
  const rec = record(me);
  const hash = recordHash(rec);
  const { base, seen } = await fakeRegistry({
    'POST /witness/records': (req, body) => [201, { ok: true, recordHash: recordHash(body.record), registered: true }],
  });
  const [recFile, bFile] = files(rec, me.binding);
  const out = await run(['publish', recFile, '--binding', bFile, '--registry', base]);
  assert.deepEqual(out, { ok: true, recordHash: hash, duplicate: false, registered: true, registry: base });
  assert.equal(seen.length, 1);
  assert.deepEqual(Object.keys(seen[0].body).sort(), ['binding', 'record']);
  assert.deepEqual(seen[0].body.record, rec);
  assert.deepEqual(seen[0].body.binding, me.binding);
  assert.equal(seen[0].url.pathname, '/witness/records');
});

test('publish fails loudly when the server\'s recordHash is not the local one', async () => {
  const me = issuer();
  const rec = record(me);
  const { base } = await fakeRegistry({ 'POST /witness/records': () => [201, { ok: true, recordHash: 'f'.repeat(64), registered: true }] });
  const [recFile, bFile] = files(rec, me.binding);
  await assert.rejects(run(['publish', recFile, '--binding', bFile, '--registry', base]), (err) => {
    assert.match(err.message, /registry reports recordHash f{64} but the record hashes to [0-9a-f]{64} here/);
    assert.match(err.message, /Not treating it as published/);
    return true;
  });
});

test('publish prints the server\'s 422 reason unchanged (and the process exits 1)', async () => {
  const me = issuer();
  const rec = record(me);
  const reason = "issuer is not the binding's key";
  const { base } = await fakeRegistry({ 'POST /witness/records': () => [422, { ok: false, reason }] });
  const [recFile, bFile] = files(rec, me.binding);
  await assert.rejects(run(['publish', recFile, '--binding', bFile, '--registry', base]), new RegExp(`registry refused the record: ${reason.replace(/[']/g, "\\'")}$`));
  // spawn, not spawnSync: the fake server lives on this event loop, so a blocking wait would starve it.
  const r = await spawnCli(['publish', recFile, '--binding', bFile, '--registry', base]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.ok(r.stderr.includes(reason), r.stderr);
});

test('publish reports a 200 duplicate as duplicate:true, not an error', async () => {
  const me = issuer();
  const rec = record(me);
  const { base } = await fakeRegistry({ 'POST /witness/records': (req, body) => [200, { ok: true, recordHash: recordHash(body.record), duplicate: true }] });
  const [recFile, bFile] = files(rec, me.binding);
  const out = await run(['publish', recFile, '--binding', bFile, '--registry', base]);
  assert.equal(out.ok, true);
  assert.equal(out.duplicate, true);
  assert.equal(out.registered, false);
});

test('publish treats any other status as a failure and names it', async () => {
  const me = issuer();
  const rec = record(me);
  const { base } = await fakeRegistry({ 'POST /witness/records': () => [500, 'boom'] });
  const [recFile, bFile] = files(rec, me.binding);
  await assert.rejects(run(['publish', recFile, '--binding', bFile, '--registry', base]), /registry answered 500 to publish: boom/);
});

// ── lookup ──────────────────────────────────────────────────────────────

test('lookup re-verifies every record: genuine → verified, tampered → failed(reason), lapsed → expired; each line leads with the issuer', async () => {
  const a = issuer();
  const b = issuer();
  const good = record(a);
  const tampered = { ...record(b), context: 'Something the issuer never signed' };
  const past = new Date(Date.now() - 10 * 86_400_000);
  const lapsed = record(a, { issuedAt: past, validUntil: new Date(past.getTime() + 86_400_000) });
  const { base, seen } = await fakeRegistry({
    'GET /witness/records': () => [200, {
      records: [row(a, good), row(b, tampered), row(a, lapsed)],
      bindings: { [a.bindingHash]: a.binding, [b.bindingHash]: b.binding },
      revocations: [],
    }],
  });
  const out = await run(['lookup', '--subject', SUBJECT, '--registry', base]);
  assert.equal(seen[0].url.searchParams.get('subject'), SUBJECT);
  assert.equal(out.count, 3);
  assert.deepEqual(out.counts, { verified: 1, failed: 1, expired: 1 });
  const [r1, r2, r3] = out.records;
  assert.equal(r1.status, 'verified');
  assert.equal(r1.issuer, a.did);
  assert.ok(r1.line.startsWith(`${a.did} verified`), r1.line);
  assert.equal(r1.recordHash, recordHash(good));
  assert.equal(r2.status, 'failed');
  assert.equal(r2.reason, 'bad signature');
  assert.ok(r2.line.startsWith(`${b.did} failed (bad signature)`), r2.line);
  assert.equal(r3.status, 'expired');
  assert.ok(r3.line.startsWith(`${a.did} expired`), r3.line);
  // The server's own statements are carried as its word, separately from the verdict.
  assert.equal(r1.unverified.recordHash, recordHash(good));
  assert.equal(r1.unverified.bindingHash, a.bindingHash);
  assert.match(out.note, /re-verified on this machine/);
});

test('lookup: a record whose binding is missing, mis-filed, or for another agent is failed', async () => {
  const a = issuer();
  const stranger = issuer();
  const rec = record(a);
  const { base } = await fakeRegistry({
    'GET /witness/records': () => [200, {
      records: [
        row(a, rec, { bindingHash: 'a'.repeat(64) }),               // not in the map
        row(a, rec, { bindingHash: stranger.bindingHash }),         // somebody else's binding
        { recordHash: recordHash(rec), record: rec, bindingHash: 'b'.repeat(64) }, // filed under the wrong hash
      ],
      bindings: { [stranger.bindingHash]: stranger.binding, ['b'.repeat(64)]: a.binding },
    }],
  });
  const out = await run(['lookup', '--issuer', a.did, '--registry', base]);
  assert.deepEqual(out.records.map((r) => r.status), ['failed', 'failed', 'failed']);
  assert.match(out.records[0].reason, /not in the response/);
  assert.match(out.records[1].reason, /issuer is not the agent this binding names/);
  assert.match(out.records[2].reason, /does not hash to the name the server filed it under/);
});

test('lookup: a server recordHash that does not match the record makes the row failed', async () => {
  const a = issuer();
  const rec = record(a);
  const { base } = await fakeRegistry({
    'GET /witness/records': () => [200, { records: [row(a, rec, { recordHash: '0'.repeat(64) })], bindings: { [a.bindingHash]: a.binding } }],
  });
  const out = await run(['lookup', '--issuer', a.did, '--registry', base]);
  assert.equal(out.records[0].status, 'failed');
  assert.match(out.records[0].reason, /server's recordHash does not match the record/);
  assert.equal(out.records[0].recordHash, recordHash(rec), 'the local hash is still reported');
});

test('lookup honours revokedBy only when the revocation itself verifies and comes from the same issuer', async () => {
  const a = issuer();
  const imposter = issuer();
  const rec = record(a);
  const hash = recordHash(rec);
  const realRevocation = createRevocation(rec, 'withdrawn', a.witness);
  const forgedRevocation = { ...createRevocation(rec, 'forged', a.witness), context: 'tampered' }; // fails verify
  // Someone else's revocation naming a's record: valid signature, wrong issuer.
  const strangerRevocation = createRecord({ issuer: imposter.did, subject: SUBJECT, claim: 'revoked', context: 'not mine to revoke', confidence: 100, revokes: hash }, imposter.witness);
  const bindings = { [a.bindingHash]: a.binding, [imposter.bindingHash]: imposter.binding };
  const cases = {
    forged: { rows: [row(a, rec, { revokedBy: recordHash(forgedRevocation) })], revocations: [row(a, forgedRevocation)] },
    stranger: { rows: [row(a, rec, { revokedBy: recordHash(strangerRevocation) })], revocations: [row(imposter, strangerRevocation)] },
    asserted_only: { rows: [row(a, rec, { revokedBy: 'c'.repeat(64) })], revocations: [] },
    real: { rows: [row(a, rec, { revokedBy: recordHash(realRevocation) })], revocations: [row(a, realRevocation)] },
    real_but_server_silent: { rows: [row(a, rec)], revocations: [row(a, realRevocation)] },
  };
  let current = 'forged';
  const { base } = await fakeRegistry({ 'GET /witness/records': () => [200, { records: cases[current].rows, bindings, revocations: cases[current].revocations }] });
  const one = async (name) => { current = name; return (await run(['lookup', '--issuer', a.did, '--registry', base])).records[0]; };

  const forged = await one('forged');
  assert.equal(forged.status, 'verified');
  assert.equal(forged.revokedBy, undefined, 'a revocation that fails verify is not honoured');
  assert.equal(forged.unverified.revokedBy, recordHash(forgedRevocation));
  assert.match(forged.unverified.revocationRefused, /revocation: bad signature/);
  assert.ok(!forged.line.includes('revoked-by'), forged.line);

  const stranger = await one('stranger');
  assert.equal(stranger.revokedBy, undefined, 'a revocation from another issuer is not honoured');
  assert.match(stranger.unverified.revocationRefused, /not from the record's issuer/);

  const asserted = await one('asserted_only');
  assert.equal(asserted.revokedBy, undefined);
  assert.match(asserted.unverified.revocationRefused, /not in the response/);

  const real = await one('real');
  assert.equal(real.revokedBy, recordHash(realRevocation));
  assert.ok(real.line.includes(`revoked-by ${recordHash(realRevocation).slice(0, 12)}`), real.line);
  assert.equal(real.unverified.revocationRefused, undefined);

  const silent = await one('real_but_server_silent');
  assert.equal(silent.revokedBy, recordHash(realRevocation), 'a verified same-issuer revocation counts even if the server did not say revokedBy');
});

test('lookup passes limit and cursor to the server and `next` back out as the cursor', async () => {
  const a = issuer();
  const { base, seen } = await fakeRegistry({
    'GET /witness/records': (req, body, url) => [200, { records: [], bindings: {}, revocations: [], ...(url.searchParams.get('cursor') ? {} : { next: 'page-2-token' }) }],
  });
  const first = await run(['lookup', '--issuer', a.did, '--limit', '25', '--registry', base]);
  assert.equal(seen[0].url.searchParams.get('limit'), '25');
  assert.equal(seen[0].url.searchParams.get('cursor'), null);
  assert.equal(first.next, 'page-2-token');
  const second = await run(['lookup', '--issuer', a.did, '--cursor', first.next, '--registry', base]);
  assert.equal(seen[1].url.searchParams.get('cursor'), 'page-2-token');
  assert.equal(second.next, undefined, 'no next on the last page');
  await assert.rejects(run(['lookup', '--issuer', a.did, '--limit', '201', '--registry', base]), /--limit must be an integer from 1 to 200/);
  await assert.rejects(run(['lookup', '--registry', base]), /needs --subject/);
});

// ── get ─────────────────────────────────────────────────────────────────

test('get re-verifies the one record and refuses a record that is not the hash asked for', async () => {
  const a = issuer();
  const rec = record(a);
  const other = record(a, { context: 'a different statement' });
  const hash = recordHash(rec);
  const { base, seen } = await fakeRegistry({
    'GET *': (req, body, url) => {
      const asked = url.pathname.split('/').pop();
      if (asked === hash) return [200, { recordHash: hash, record: rec, bindingHash: a.bindingHash, binding: a.binding }];
      if (asked === recordHash(other)) return [200, { recordHash: hash, record: rec, bindingHash: a.bindingHash, bindings: { [a.bindingHash]: a.binding } }]; // a consistent row, for the wrong hash
      return [404, { error: 'not found' }];
    },
  });
  const out = await run(['get', hash, '--registry', base]);
  assert.equal(seen[0].url.pathname, `/witness/records/${hash}`);
  assert.equal(out.status, 'verified');
  assert.equal(out.recordHash, hash);
  assert.equal(out.issuer, a.did);
  const wrong = await run(['get', recordHash(other), '--registry', base]);
  assert.equal(wrong.status, 'failed');
  assert.match(wrong.reason, /different record than the one asked for/);
  await assert.rejects(run(['get', 'd'.repeat(64), '--registry', base]), /has no record d{64}/);
  await assert.rejects(run(['get', 'nope', '--registry', base]), /64 hex characters/);
});

// ── stats ───────────────────────────────────────────────────────────────

test('stats prints the server\'s answer as-is', async () => {
  const stats = { issuers: 3, records: 12, firstSeen: [{ did: 'did:key:z6MkOutside', at: '2026-10-26T00:00:00.000Z' }] };
  const { base } = await fakeRegistry({ 'GET /witness/stats': () => [200, stats] });
  assert.deepEqual(await run(['stats', '--registry', base]), stats);
});

// ── transport bounds ────────────────────────────────────────────────────

test('the registry URL must be https except for localhost, and the default is DEFAULT_REGISTRY', () => {
  assert.equal(registryBase().origin, new URL(DEFAULT_REGISTRY).origin);
  assert.match(DEFAULT_REGISTRY, /^https:\/\//);
  assert.equal(registryBase('http://127.0.0.1:9999').origin, 'http://127.0.0.1:9999');
  assert.throws(() => registryBase('http://registry.example.com'), /must be an https URL/);
  assert.throws(() => registryBase('https://user:pw@registry.example.com'), /bare origin/);
  assert.throws(() => registryBase('not a url'), /not a URL/);
});

test('an oversized response is refused before it is parsed', async () => {
  const { base } = await fakeRegistry({ 'GET /witness/stats': () => [200, JSON.stringify({ pad: 'x'.repeat(5000) })] });
  await assert.rejects(registryRequest(registryBase(base), '/witness/stats', { maxBytes: 1000 }), /response too large/);});

test('a registry that never answers times out instead of hanging', async () => {
  const { base } = await fakeRegistry({ 'GET /witness/stats': () => undefined /* never responds */ });
  await assert.rejects(registryRequest(registryBase(base), '/witness/stats', { timeoutMs: 200 }), /did not answer within 200 ms/);
});

test('assessLookupPage tolerates a malformed page without throwing', () => {
  const out = assessLookupPage({ records: [{}, null, { record: 5 }], bindings: 'nope', revocations: 7, next: 42 });
  assert.equal(out.records.length, 3);
  assert.ok(out.records.every((r) => r.status === 'failed'));
  assert.equal(out.next, undefined);
});
