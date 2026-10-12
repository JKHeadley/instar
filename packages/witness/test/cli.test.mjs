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
import { verifyBinding, createBinding, createRecord, generateWitnessKey, didKeyFromPublicKey, publicKeyFromDidKey } from '../dist/index.js';

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

const AGENT = 'did:web:example.com:agents:trial'; // did:key gets its own tests below
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

// ── did:key: the issuer name IS the Threadline identity key (Echo's review of 0e488e16) ──

// An independent base58btc (BigInt) so the encoder is not only checked against itself.
function base58BigInt(bytes) {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = BigInt('0x' + Buffer.from(bytes).toString('hex'));
  let out = '';
  while (n > 0n) { out = A[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = '1' + out; else break; }
  return out;
}

test('did:key encodes Ed25519 as multicodec 0xed01 + base58btc, and round-trips', () => {
  for (let i = 0; i < 25; i++) {
    const pub = crypto.randomBytes(32).toString('hex');
    const did = didKeyFromPublicKey(pub);
    assert.match(did, /^did:key:z6Mk/); // every Ed25519 did:key starts with z6Mk
    assert.equal(did, 'did:key:z' + base58BigInt(Buffer.concat([Buffer.from([0xed, 0x01]), Buffer.from(pub, 'hex')])));
    assert.equal(publicKeyFromDidKey(did), pub);
  }
  assert.equal(publicKeyFromDidKey('did:key:z6MkTrialAgent'), null);
  assert.equal(publicKeyFromDidKey('did:web:example.com'), null);
});

function didKeySetup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'witness-cli-'));
  const id = threadlineIdentity(dir);
  const home = path.join(dir, 'witness');
  const did = didKeyFromPublicKey(id.publicKeyHex);
  const run = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args, '--home', home, '--identity', id.file], { encoding: 'utf8' });
    return { code: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr };
  };
  return { dir, id, home, did, run };
}

test('verify accepts a record whose did:key issuer IS the binding\'s Threadline key, and says it checked', () => {
  const { dir, home, did, run } = didKeySetup();
  run('init');
  assert.equal(run('bind', '--agent', did).code, 0);
  const signed = run('sign', '--subject', PEER, '--claim', 'collaborated', '--context', 'Paired over Threadline');
  const recFile = path.join(dir, 'rec.json');
  fs.writeFileSync(recFile, JSON.stringify(signed.out.record));
  const v = run('verify', recFile, '--binding', path.join(home, 'binding.json'));
  assert.equal(v.out.ok, true);
  assert.match(v.out.issuerKeyCheck, /^checked/);
});

test('a forged binding under someone else\'s did:key is refused, even though its own signatures are valid', () => {
  const { dir, did } = didKeySetup(); // the victim's did:key
  // The attacker makes a binding with THEIR keys but the victim's name, and signs a record.
  const attackerTl = generateWitnessKey(); // any Ed25519 pair works as a Threadline key here
  const attackerWitness = generateWitnessKey();
  const forged = createBinding({ agent: did, threadline: attackerTl, witness: attackerWitness });
  assert.equal(verifyBinding(forged).ok, true); // internally consistent, which is the trap
  const record = createRecord({ issuer: did, subject: PEER, claim: 'completed', context: 'forged', confidence: 100 }, attackerWitness);
  const bFile = path.join(dir, 'forged-binding.json');
  const rFile = path.join(dir, 'forged-record.json');
  fs.writeFileSync(bFile, JSON.stringify(forged));
  fs.writeFileSync(rFile, JSON.stringify(record));
  const r = spawnSync(process.execPath, [CLI, 'verify', rFile, '--binding', bFile], { encoding: 'utf8' });
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, false);
  assert.match(out.reason, /not the key the issuer did:key names/);
});

test('verify on a did:web issuer says the binding\'s key was NOT checked offline', () => {
  const { dir, run, home } = setup();
  run('init');
  run('bind', '--agent', AGENT);
  const signed = run('sign', '--subject', PEER, '--claim', 'completed', '--context', 'x');
  const recFile = path.join(dir, 'rec.json');
  fs.writeFileSync(recFile, JSON.stringify(signed.out.record));
  assert.match(run('verify', recFile, '--binding', path.join(home, 'binding.json')).out.issuerKeyCheck, /^NOT checked/);
});

test('bind refuses a did:key that names a different key than this agent\'s Threadline key', () => {
  const { run } = didKeySetup();
  run('init');
  const other = didKeyFromPublicKey(crypto.randomBytes(32).toString('hex'));
  const r = run('bind', '--agent', other);
  assert.equal(r.code, 1);
  assert.match(r.err, /does not name this agent's Threadline identity key/);
});
