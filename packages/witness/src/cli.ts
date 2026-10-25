#!/usr/bin/env node
/**
 * `witness` — the standalone command line for agents that do not run Instar
 * (for example an agent on threadline-mcp). It reads the agent's Threadline
 * identity file (~/.threadline/identity.json: base64 Ed25519 keys) and keeps its
 * own Witness key and local store in a separate directory.
 *
 *   witness init                      create the Witness key (once; never overwritten)
 *   witness bind --agent <did>        bind the Witness key to the Threadline key (both sign)
 *   witness sign --subject <did> --claim <claim> --context <text> [--evidence <item>]... [--confidence <0-100>]
 *   witness verify <record.json> --binding <binding.json> [--seal <file>]...
 *   witness seal-evidence <seal-file> [--party <id> --url <read-url>]   (SealKeeper form; provisional)
 *   witness seal-evidence <seal-file> [--url <where-to-fetch>]           (the v0 form, still accepted)
 *   witness export [--seal <file>]...  the binding chain, every record, and their SEAL bytes, as JSON
 *
 * Common options: --home <dir> (default $WITNESS_HOME or ~/.threadline/witness),
 * --identity <file> (default ~/.threadline/identity.json). Output is JSON on stdout;
 * errors go to stderr with exit code 1. Nothing is ever sent anywhere.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadOrCreateWitnessKey, KEY_FILE_NAME } from './keyfile.js';
import { publicKeyFromPrivate, type WitnessKeyPair } from './keys.js';
import { createBinding, verifyBinding, threadlineFingerprint, type KeyBinding } from './binding.js';
import { createRecord, verifyRecord, CLAIMS, type Claim } from './record.js';
import { WitnessStore } from './store.js';
import { publicKeyFromDidKey } from './didkey.js';
import {
  SEAL_LABELS_NOTE, SEAL_REFERENCE_PROVISIONAL_NOTE, checkSealBytes, formatSealkeeperReference,
  parseSealReference, sealReferencesIn, sha256Hex, type SealReference,
} from './seal.js';

const BINDING_FILE = 'binding.json';

class CliError extends Error {}

function fail(message: string): never {
  throw new CliError(message);
}

function defaultHome(): string {
  return process.env.WITNESS_HOME || path.join(os.homedir(), '.threadline', 'witness');
}

function defaultIdentity(): string {
  return path.join(os.homedir(), '.threadline', 'identity.json');
}

/** The Threadline identity as hex, checked for internal consistency. */
export function readThreadlineIdentity(file: string): { publicKey: string; privateKey: string; fingerprint: string } {
  if (!fs.existsSync(file)) fail(`no Threadline identity at ${file} (pass --identity)`);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    fail(`${file} is not JSON`);
  }
  const decode = (field: string): string => {
    const v = raw[field];
    if (typeof v !== 'string') fail(`${file}: missing ${field}`);
    const buf = /^[0-9a-f]{64}$/i.test(v) ? Buffer.from(v, 'hex') : Buffer.from(v, 'base64');
    if (buf.length !== 32) fail(`${file}: ${field} is not a 32-byte key`);
    return buf.toString('hex');
  };
  const publicKey = decode('publicKey');
  const privateKey = decode('privateKey');
  if (publicKeyFromPrivate(privateKey) !== publicKey) fail(`${file}: publicKey does not match privateKey`);
  const fingerprint = threadlineFingerprint(publicKey);
  if (typeof raw.agentId === 'string' && raw.agentId.toLowerCase() !== fingerprint) {
    fail(`${file}: agentId does not match publicKey`);
  }
  return { publicKey, privateKey, fingerprint };
}

function readJson(file: string, what: string): unknown {
  if (!fs.existsSync(file)) fail(`no ${what} at ${file}`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    fail(`${file} is not JSON`);
  }
}

function existingKey(home: string): WitnessKeyPair {
  if (!fs.existsSync(path.join(home, KEY_FILE_NAME))) fail(`no Witness key in ${home}; run "witness init" first`);
  return loadOrCreateWitnessKey(home).key;
}

function existingBinding(home: string): KeyBinding {
  const result = verifyBinding(readJson(path.join(home, BINDING_FILE), 'binding (run "witness bind" first)'));
  if (!result.ok) fail(`the saved binding is invalid: ${result.reason}`);
  return result.binding;
}

const SEALS_DIR = 'seals';

/**
 * A SEAL is never inline in a record (evidence items cap at 500 chars). With --party
 * it is referenced in SealKeeper's one-string form, `sealkeeper:seal:1:<party>:<sha256>:<url>`
 * (PROVISIONAL until SealKeeper confirms the reading); without, in the v0 form
 * `seal:sha256:<hex>` plus an optional URL. Either way only the hash is trusted.
 */
export function sealEvidence(sealBytes: Buffer, options: { url?: string; party?: string } = {}): string[] {
  const { url, party } = options;
  const sha256 = sha256Hex(sealBytes);
  if (party !== undefined) {
    if (!url) fail('--party needs --url: the sealkeeper:seal:1 form carries the SEAL read URL');
    try {
      return [formatSealkeeperReference({ party, sha256, url })];
    } catch (err) {
      fail(`cannot build the sealkeeper reference: ${(err as Error).message}`);
    }
  }
  const items = [`seal:sha256:${sha256}`];
  if (url) {
    if (!/^https:\/\/\S+$/.test(url) || url.length > 500) fail('--url must be an https URL of at most 500 characters');
    items.push(url);
  }
  return items;
}

/** Keeps a copy of the SEAL under its hash so `export` can carry it beside the record. */
function storeSealBytes(home: string, sealBytes: Buffer): { sha256: string; file: string } {
  const sha256 = sha256Hex(sealBytes);
  const dir = path.join(home, SEALS_DIR);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${sha256}.seal`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, sealBytes, { mode: 0o600, flag: 'wx' });
  return { sha256, file };
}

/** The stored SEAL for a hash, or undefined. A stored file that no longer hashes to its name is a refusal. */
function storedSealBytes(home: string, sha256: string): Buffer | undefined {
  const file = path.join(home, SEALS_DIR, `${sha256}.seal`);
  if (!fs.existsSync(file)) return undefined;
  const bytes = fs.readFileSync(file);
  if (sha256Hex(bytes) !== sha256) fail(`stored SEAL ${file} does not hash to its name; refusing to carry it`);
  return bytes;
}

function readSealFiles(files: string[] | undefined): Buffer[] {
  return (files ?? []).map((f) => {
    if (!fs.existsSync(f)) fail(`no SEAL file at ${f}`);
    return fs.readFileSync(f);
  });
}

/** What verify reports per SEAL reference: the hash verdict plus the honest status of the labels. */
function describeSeal(ref: SealReference, bytesChecked: boolean): Record<string, unknown> {
  if (ref.format === 'malformed') {
    return { reference: ref.reference, format: ref.format, reason: ref.reason, bytesChecked: false, provisional: true };
  }
  const base = { reference: ref.reference, format: ref.format, sha256: ref.sha256, bytesChecked, provisional: ref.provisional };
  if (ref.format === 'sealkeeper-v1') {
    return { ...base, party: ref.party, url: ref.url, trusted: ref.trusted, unverified: ref.unverified, labels: SEAL_LABELS_NOTE };
  }
  return base;
}

export function run(argv: string[]): unknown {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      home: { type: 'string' },
      identity: { type: 'string' },
      agent: { type: 'string' },
      issuer: { type: 'string' },
      subject: { type: 'string' },
      claim: { type: 'string' },
      context: { type: 'string' },
      evidence: { type: 'string', multiple: true },
      confidence: { type: 'string' },
      binding: { type: 'string' },
      url: { type: 'string' },
      party: { type: 'string' },
      seal: { type: 'string', multiple: true },
    },
  });
  const home = path.resolve(values.home ?? defaultHome());

  switch (command) {
    case 'init': {
      const { key, created } = loadOrCreateWitnessKey(home);
      return { created, home, witnessPublicKey: key.publicKey, keyId: key.keyId };
    }
    case 'bind': {
      if (!values.agent) fail('bind needs --agent <did:...>, the name records will use as issuer');
      if (fs.existsSync(path.join(home, BINDING_FILE))) {
        fail(`${home} already has a binding; changing keys needs a successor binding, which this tool does not make yet`);
      }
      const witness = existingKey(home);
      const threadline = readThreadlineIdentity(path.resolve(values.identity ?? defaultIdentity()));
      // A did:key name IS the agent's Threadline identity key (not its Witness key), so it
      // must be this agent's own key; otherwise verify would rightly refuse every record.
      if (values.agent.startsWith('did:key:')) {
        const named = publicKeyFromDidKey(values.agent);
        if (!named) fail('--agent is a did:key but not an Ed25519 one');
        if (named !== threadline.publicKey) fail('--agent did:key does not name this agent\'s Threadline identity key');
      }
      const binding = createBinding({ agent: values.agent, threadline, witness });
      const checked = verifyBinding(binding, threadline.fingerprint);
      if (!checked.ok) fail(`binding did not verify: ${checked.reason}`);
      // File first: if the store were written first and the file write failed, a re-run
      // would see no file and make a second seq-0 binding.
      const bindingFile = path.join(home, BINDING_FILE);
      fs.writeFileSync(bindingFile, JSON.stringify(binding, null, 2) + '\n', { flag: 'wx' });
      const added = new WitnessStore({ dir: path.join(home, 'store') }).addBinding(binding, { expectedFingerprint: threadline.fingerprint });
      if (added.status === 'rejected') {
        fs.rmSync(bindingFile, { force: true });
        fail(`store refused the binding: ${added.reason}`);
      }
      return binding;
    }
    case 'sign': {
      const binding = existingBinding(home);
      const key = existingKey(home);
      if (key.publicKey !== binding.witness_public_key) fail('the Witness key does not match the saved binding');
      const issuer = values.issuer ?? binding.agent;
      if (issuer !== binding.agent) fail(`--issuer must be the bound agent (${binding.agent})`);
      if (!values.subject) fail('sign needs --subject <did:...>');
      if (!values.claim || !(CLAIMS as readonly string[]).includes(values.claim)) fail(`--claim must be one of: ${CLAIMS.join(', ')}`);
      if (values.claim === 'revoked' || values.claim === 'verified-by-sas') fail(`--claim ${values.claim} is not issued by hand`);
      if (!values.context) fail('sign needs --context <what happened>');
      const confidence = values.confidence === undefined ? 100 : Number(values.confidence);
      if (!Number.isInteger(confidence) || confidence < 0 || confidence > 100) fail('--confidence must be an integer from 0 to 100');
      const record = createRecord({
        issuer, subject: values.subject, claim: values.claim as Claim, context: values.context,
        evidence: values.evidence ?? [], confidence,
      }, key);
      const added = new WitnessStore({ dir: path.join(home, 'store') }).add(record);
      if (added.status === 'rejected') fail(`store refused the record: ${added.reason}`);
      return { hash: added.hash, record };
    }
    case 'verify': {
      const file = positionals[0];
      if (!file) fail('verify needs a record file');
      if (!values.binding) fail('verify needs --binding <binding.json> naming the issuer\'s key');
      const b = verifyBinding(readJson(path.resolve(values.binding), 'binding'));
      if (!b.ok) return { ok: false, reason: `binding: ${b.reason}` };
      const record = readJson(path.resolve(file), 'record') as { issuer?: unknown };
      if (record.issuer !== b.binding.agent) return { ok: false, reason: 'the record\'s issuer is not the agent this binding names' };
      // A binding only names the issuer by string; anyone can make one with their own keys
      // under your name. For did:key the name IS the Threadline key, so check it offline.
      let issuerKeyCheck: string;
      if (b.binding.agent.startsWith('did:key:')) {
        const named = publicKeyFromDidKey(b.binding.agent);
        if (!named) return { ok: false, reason: 'the issuer is a did:key but not an Ed25519 one' };
        if (named !== b.binding.threadline_public_key) {
          return { ok: false, reason: 'the binding\'s Threadline key is not the key the issuer did:key names (a binding made by someone else)' };
        }
        issuerKeyCheck = 'checked: the issuer did:key is the binding\'s Threadline key';
      } else {
        issuerKeyCheck = 'NOT checked offline: a did:web issuer\'s key is in its did document, so this binding is only known to carry the issuer\'s name';
      }
      const verdict = verifyRecord(record, b.binding.witness_public_key);
      const evidence = Array.isArray((record as { evidence?: unknown }).evidence) ? (record as { evidence: string[] }).evidence : [];
      const refs = sealReferencesIn(evidence);
      const check = checkSealBytes(refs, readSealFiles(values.seal));
      if (check.unmatched.length) {
        return {
          ok: false,
          reason: `SEAL bytes do not match any SEAL reference in the record (sha256 ${check.unmatched.join(', ')})`,
          seals: refs.map((r) => describeSeal(r, false)),
        };
      }
      const seals = refs.map((r) => describeSeal(r, r.format !== 'malformed' && check.matched.has(r.sha256)));
      const provisional = refs.some((r) => r.provisional);
      return {
        ...verdict,
        threadlineFingerprint: b.binding.threadline_fingerprint,
        issuerKeyCheck,
        ...(refs.length ? { seals } : {}),
        ...(provisional ? { provisional: SEAL_REFERENCE_PROVISIONAL_NOTE } : {}),
      };
    }
    case 'seal-evidence': {
      const file = positionals[0];
      if (!file) fail('seal-evidence needs the SEAL file');
      if (!fs.existsSync(file)) fail(`no file at ${file}`);
      const bytes = fs.readFileSync(file);
      const evidence = sealEvidence(bytes, { url: values.url, party: values.party });
      const stored = storeSealBytes(home, bytes);
      const provisional = values.party !== undefined;
      return {
        evidence,
        sha256: stored.sha256,
        sealStored: stored.file,
        ...(provisional ? { provisional: SEAL_REFERENCE_PROVISIONAL_NOTE, labels: SEAL_LABELS_NOTE } : {}),
      };
    }
    case 'export': {
      const binding = existingBinding(home);
      const store = new WitnessStore({ dir: path.join(home, 'store') });
      const records = store.list({ issuer: binding.agent }).map((r) => r.record);
      // The SEAL bytes travel with the records, matched by hash: SealKeeper does not
      // serve past SEALs, so the URL in a reference returns the current SEAL, not this one.
      const refs = records.flatMap((r) => sealReferencesIn(r.evidence));
      const supplied = checkSealBytes(refs, readSealFiles(values.seal));
      if (supplied.unmatched.length) {
        fail(`--seal bytes do not match any SEAL referenced by an exported record (sha256 ${supplied.unmatched.join(', ')})`);
      }
      const seals: Record<string, { bytes: string; source: 'seal-file' | 'stored' }> = {};
      const sealsMissing: string[] = [];
      for (const ref of refs) {
        if (ref.format === 'malformed' || seals[ref.sha256]) continue;
        const fromFile = supplied.matched.get(ref.sha256);
        if (fromFile) { seals[ref.sha256] = { bytes: Buffer.from(fromFile).toString('base64'), source: 'seal-file' }; continue; }
        const stored = storedSealBytes(home, ref.sha256);
        if (stored) seals[ref.sha256] = { bytes: stored.toString('base64'), source: 'stored' };
        else sealsMissing.push(ref.sha256);
      }
      const provisional = refs.some((r) => r.provisional);
      return {
        binding, records, seals,
        ...(sealsMissing.length ? { sealsMissing } : {}),
        ...(provisional ? { provisional: SEAL_REFERENCE_PROVISIONAL_NOTE } : {}),
      };
    }
    default:
      fail(`unknown command "${command ?? ''}". Commands: init, bind, sign, verify, seal-evidence, export`);
  }
}

function isInvokedDirectly(): boolean {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname);
  } catch {
    return false; // an odd argv (a path that does not exist) never crashes an import
  }
}
const invokedDirectly = isInvokedDirectly();
if (invokedDirectly) {
  try {
    process.stdout.write(JSON.stringify(run(process.argv.slice(2)), null, 2) + '\n');
  } catch (err) {
    process.stderr.write(`witness: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
