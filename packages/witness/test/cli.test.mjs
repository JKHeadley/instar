// The standalone `witness` CLI, run as a real process against a threadline-mcp
// identity file (base64 Ed25519 keys, as ~/.threadline/identity.json holds them).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBinding } from '../dist/index.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');

function threadlineIdentity(dir, { agentId } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
  const file = path.join(dir, 'identity.json');
  fs.writeFileSync(file, JSON.stringify({
    agentId: agentId ?? pub.subarray(0, 16).toString('hex'),
    publicKey: pub.toString('base64'),
    privateKey: priv.toString('base64'),
    createdAt: new Date().toISOString(),
  }));
  return { file, fingerprint: pub.subarray(0, 16).toString('hex'), publicKeyHex: pub.toString('hex') };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'witness-cli-'));
  const id = threadlineIdentity(dir);
  const home = path.join(dir, 'witness');
  const run = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args, '--home', home, '--identity', id.file], { encoding: 'utf8' });
    return { code: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr };
  };
  return { dir, id, home, run };
}

const AGENT = 'did:key:z6MkTrialAgent';
const PEER = 'did:web:api.moltbridge.ai:agents:dawn';

test('init creates a Witness key once, separate from the Threadline key, and never replaces it', () => {
  const { id, run, home } = setup();
  const first = run('init');
  assert.equal(first.code, 0);
  assert.equal(first.out.created, true);
  assert.notEqual(first.out.witnessPublicKey, id.publicKeyHex);
  const again = run('init');
  assert.equal(again.out.created, false);
  assert.equal(again.out.witnessPublicKey, first.out.witnessPublicKey);
  assert.equal(fs.statSync(path.join(home, 'witness-key.json')).mode & 0o777, 0o600);
});

test('bind ties the Witness key to the Threadline key, signed by both; a second bind is refused', () => {
  const { id, run } = setup();
  const { out: key } = run('init');
  const { code, out: binding } = run('bind', '--agent', AGENT);
  assert.equal(code, 0);
  assert.equal(binding.threadline_fingerprint, id.fingerprint);
  assert.equal(binding.witness_public_key, key.witnessPublicKey);
  assert.equal(verifyBinding(binding, id.fingerprint).ok, true);
  const again = run('bind', '--agent', AGENT);
  assert.equal(again.code, 1);
  assert.match(again.err, /already has a binding/);
});

test('sign makes a record that verify accepts against the binding; a changed record fails', () => {
  const { dir, run, home } = setup();
  run('init');
  run('bind', '--agent', AGENT);
  const signed = run('sign', '--subject', PEER, '--claim', 'collaborated', '--context', 'Paired over Threadline', '--evidence', 'threadline:thread-1', '--confidence', '90');
  assert.equal(signed.code, 0, signed.err);
  assert.equal(signed.out.record.issuer, AGENT);
  const recFile = path.join(dir, 'rec.json');
  fs.writeFileSync(recFile, JSON.stringify(signed.out.record));
  const ok = run('verify', recFile, '--binding', path.join(home, 'binding.json'));
  assert.deepEqual({ ok: ok.out.ok, expired: ok.out.expired }, { ok: true, expired: false });
  fs.writeFileSync(recFile, JSON.stringify({ ...signed.out.record, context: 'Something else' }));
  assert.equal(run('verify', recFile, '--binding', path.join(home, 'binding.json')).out.ok, false);
  assert.equal(run('export').out.records.length, 1);
});

test('sign refuses a different issuer, a hand-made revocation or SAS claim, and works only after bind', () => {
  const { run } = setup();
  run('init');
  assert.match(run('sign', '--subject', PEER, '--claim', 'completed', '--context', 'x').err, /run "witness bind" first/);
  run('bind', '--agent', AGENT);
  assert.match(run('sign', '--issuer', PEER, '--subject', PEER, '--claim', 'completed', '--context', 'x').err, /must be the bound agent/);
  assert.match(run('sign', '--subject', PEER, '--claim', 'verified-by-sas', '--context', 'x').err, /not issued by hand/);
  assert.match(run('sign', '--subject', PEER, '--claim', 'completed', '--context', 'x', '--confidence', '101').err, /0 to 100/);
});

test('an identity file whose agentId does not match its key is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'witness-cli-'));
  const id = threadlineIdentity(dir, { agentId: '0'.repeat(32) });
  const home = path.join(dir, 'witness');
  spawnSync(process.execPath, [CLI, 'init', '--home', home]);
  const r = spawnSync(process.execPath, [CLI, 'bind', '--agent', AGENT, '--home', home, '--identity', id.file], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /agentId does not match/);
});

test('seal-evidence carries the SEAL by hash plus where to fetch it, never inline', () => {
  const { dir, run } = setup();
  const seal = path.join(dir, 'seal.txt');
  fs.writeFileSync(seal, 'x'.repeat(4000)); // larger than one evidence item may be
  const r = run('seal-evidence', seal, '--url', 'https://sealkeeper.run/seal/abc');
  assert.deepEqual(r.out.evidence, [
    `seal:sha256:${crypto.createHash('sha256').update('x'.repeat(4000)).digest('hex')}`,
    'https://sealkeeper.run/seal/abc',
  ]);
  assert.match(run('seal-evidence', seal, '--url', 'http://plain.example').err, /https URL/);
});

test('an identity file whose private key belongs to a different public key is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'witness-cli-'));
  const id = threadlineIdentity(dir);
  const other = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
  const raw = JSON.parse(fs.readFileSync(id.file, 'utf8'));
  fs.writeFileSync(id.file, JSON.stringify({ ...raw, privateKey: other.toString('base64') }));
  const home = path.join(dir, 'witness');
  spawnSync(process.execPath, [CLI, 'init', '--home', home]);
  const r = spawnSync(process.execPath, [CLI, 'bind', '--agent', AGENT, '--home', home, '--identity', id.file], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /publicKey does not match privateKey/);
});
