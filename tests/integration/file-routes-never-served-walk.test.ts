// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
// safe-git-allow: test file — `git init` / `git check-ignore` on a throwaway fixture repo (read-only ignore probes; nothing destructive).
/**
 * §5.4 — a walk that can DISAGREE with the list
 * (docs/specs/a2a-single-agent-identity.md §5.4, AC7; Tier 2).
 *
 * The §5.1 list is only as good as its coverage. This test does not trust the
 * list: it boots a fixture agent home through the REAL init path, pairs it to
 * a stub sibling with the REAL sealer + installer so the agent identity lands
 * the way `instar pair` lands it, drives every other in-tree key-file producer
 * (invitation secret, signed-invitation state, inbound-delivery HMAC key,
 * bind-token secret, dedicated SSH keys, headless key vault, relay tokens,
 * manifest key, pairing session), then WALKS `.instar/` for anything that
 * looks like key material — mode 0600, a JSON document carrying a
 * `privateKey`/`secretKey` field, or a name matching `*.key`, `*.secret`,
 * `*hmac*`, `*.enc`, `*token*` — and asserts each hit is refused by
 * read/download/list/link over the real routes, excluded from a real backup
 * snapshot, gitignored (real `git check-ignore`) and classified never-sync.
 *
 * A new key file the list does not cover FAILS THE BUILD here. A 0600 file
 * that is provably NOT key material (asserted in-test: JSON with no private
 * field) is allowed through by name, so the exception cannot rot into hiding
 * a key.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import express from 'express';
import request from 'supertest';
import { initProject } from '../../src/commands/init.js';
import { createFileRoutes, isNeverServed } from '../../src/server/fileRoutes.js';
import {
  sealIdentityForJoiner,
  installAgentIdentityFromPairing,
  fingerprintOf,
  type HandoverTranscript,
} from '../../src/core/AgentIdentityHandover.js';
import { generateIdentityKeyPair } from '../../src/threadline/ThreadlineCrypto.js';
import { InvitationManager } from '../../src/threadline/InvitationManager.js';
import { SecureInvitationManager } from '../../src/threadline/SecureInvitation.js';
import { loadOrCreateDeliveryHmacKey } from '../../src/core/InboundDeliveryStore.js';
import { ensureBindTokenSecret } from '../../src/core/conversationBindToken.js';
import { MachineSshIdentity } from '../../src/core/MachineSshIdentity.js';
import { WorktreeKeyVault } from '../../src/core/WorktreeKeyVault.js';
import { ManifestIntegrity } from '../../src/security/ManifestIntegrity.js';
import { PairingSessionStore } from '../../src/core/PairingSessionStore.js';
import { RemediationKeyVault } from '../../src/remediation/RemediationKeyVault.js';
import { TelemetryAuth } from '../../src/monitoring/TelemetryAuth.js';
import { writeFileAtomicOwnerOnly } from '../../src/identity/IdentityKeyFile.js';
import { BackupManager } from '../../src/core/BackupManager.js';
import { FileClassifier } from '../../src/core/FileClassifier.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const NAME_PREDICATE = /(\.key$|\.secret$|hmac|\.enc$|token)/i;

/**
 * 0600 files a real init / provisioning produces that are NOT key material.
 * Each carries the predicate that PROVES it (re-run on the live bytes before
 * it is excused) — a file that stops satisfying its predicate fails the walk
 * like any other.
 */
const NOT_KEY_MATERIAL_0600 = new Map<string, (text: string) => boolean>([
  // Signing-key EPOCH history: public verification material only
  // (IdentitySigningKeyEpoch — "private keys never enter history").
  ['.instar/state/identity-epochs.json', (t) => { try { JSON.parse(t); } catch { return false; } return !hasPrivateField(t); }],
  // Telemetry installation id: a bare UUID (TelemetryAuth); the secret beside it IS listed.
  ['.instar/telemetry/install-id', (t) => /^[0-9a-f-]{36}\s*$/i.test(t)],
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function hasPrivateField(text: string): boolean {
  try {
    const seen = new Set<string>();
    JSON.parse(text, (k, v) => { seen.add(k); return v; });
    return ['privateKey', 'secretKey', 'privateKeyPem', 'seed'].some((k) => seen.has(k));
  } catch {
    return false;
  }
}

describe('§5.4 behavioural walk — every key-bearing file a real init + pair produces is covered', () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let agentDir: string;
  let stateDir: string;
  let app: express.Express;
  let hits: string[] = [];
  const agentName = 'walk-' + crypto.randomBytes(3).toString('hex');

  beforeAll(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'never-served-walk-'));
    prevHome = process.env.HOME;
    process.env.HOME = tmpHome;

    // 1. The REAL init path (standalone → ~/.instar/agents/<name>/ under the redirected HOME).
    await initProject({ name: agentName, standalone: true, port: 4199, skipPrereqs: true });
    agentDir = path.join(tmpHome, '.instar', 'agents', agentName);
    stateDir = path.join(agentDir, '.instar');
    expect(fs.existsSync(path.join(stateDir, 'config.json'))).toBe(true);

    // 2. Pair to a STUB SIBLING with the real sealer + installer: the sibling
    //    holds the agent identity; this machine joins and receives it sealed
    //    to its ephemeral X25519 key — exactly what `instar pair` lands.
    const sibling = generateIdentityKeyPair();
    const siblingPub = sibling.publicKey.toString('base64');
    const siblingPriv = sibling.privateKey.toString('base64');
    const joinerEnc = crypto.generateKeyPairSync('x25519');
    const joinerEncPubB64 = joinerEnc.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const joinerEncPrivPem = joinerEnc.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const transcript: HandoverTranscript = {
      pairingSessionId: 'ps_' + crypto.randomBytes(4).toString('hex'),
      joinerMachineId: 'm_joiner',
      joinerEncryptionPublicKey: joinerEncPubB64,
      agentName,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const fingerprint = fingerprintOf(siblingPub);
    const sealed = sealIdentityForJoiner({
      payload: {
        identity: { publicKey: siblingPub, privateKey: siblingPriv, createdAt: new Date().toISOString() },
        provenance: {
          schemaVersion: 1, origin: 'minted-standalone', rootFingerprint: fingerprint,
          machineId: 'm_sibling', createdAt: new Date().toISOString(), producedBy: 'test-stub-sibling',
        },
      },
      transcript,
      identityFingerprint: fingerprint,
    });
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) throw new Error('seal failed');
    const installed = installAgentIdentityFromPairing({
      envelope: sealed.envelope, stateDir, expected: transcript,
      encryptionPrivateKeyPem: joinerEncPrivPem, pinnedFingerprint: fingerprint,
    });
    expect(installed).toEqual({ ok: true, fingerprint });
    expect(fs.existsSync(path.join(stateDir, 'identity.json'))).toBe(true);
    // The pairing session record the real `instar pair` writes (0600).
    new PairingSessionStore(stateDir).save({
      code: 'PAIR-CODE', createdAt: new Date().toISOString(), failedAttempts: 0, maxAttempts: 3, expiryMs: 60_000, consumed: false,
    } as never);

    // 3. Every other in-tree producer of key-bearing files.
    new InvitationManager({ stateDir });                                    // threadline/invitation-secret.key
    const si = new SecureInvitationManager(stateDir);                       // threadline/secure-invitations.json
    const tok = si.create(fingerprint, sibling.privateKey);
    expect(si.revoke(tok.tokenId)).toBe(true);                                   // persists the state file
    loadOrCreateDeliveryHmacKey(stateDir);                                  // state/inbound-delivery.hmac-key
    ensureBindTokenSecret(stateDir);                                        // state/conversation-bind-token.secret
    new ManifestIntegrity(path.join(stateDir, 'state')).ensureKey();        // state/.manifest-key (init already did; same dir every production caller uses)
    new MachineSshIdentity(stateDir, agentName, 'm_joiner').ensure();       // machine-ssh/ (real ssh-keygen)
    await new WorktreeKeyVault({ stateDir, headlessAllowed: true, forceBackend: 'flatfile', passphraseResolver: () => 'walk-passphrase' }).loadOrInit(); // local-state/keys.enc
    await RemediationKeyVault.forStateDir(stateDir, { forceBackend: 'env-passphrase', passphraseResolver: () => 'walk-passphrase' }); // remediation-keys.age
    new TelemetryAuth(stateDir).provision();                                 // telemetry/local-secret (+ install-id, a bare UUID)
    // relay-tokens.json: HandshakeManager persists it through this exact
    // writer at the end of a confirmed handshake; the shape is its own.
    writeFileAtomicOwnerOnly(path.join(stateDir, 'relay-tokens.json'), JSON.stringify({
      peer: { token: crypto.randomBytes(32).toString('hex'), establishedAt: new Date().toISOString(), theirIdentityPub: siblingPub },
    }, null, 2));
    // The legacy routing mirror an older install carries (same private key,
    // written by the single owner-only writer) and the operator-provisioned
    // listener HMAC key the daemon reads (no in-tree generator).
    writeFileAtomicOwnerOnly(path.join(stateDir, 'threadline', 'identity.json'), fs.readFileSync(path.join(stateDir, 'identity.json'), 'utf8'));
    writeFileAtomicOwnerOnly(path.join(stateDir, 'threadline', 'inbox-hmac.key'), crypto.randomBytes(32).toString('hex') + '\n');
    // The operator audit surfaces that must STAY servable.
    fs.writeFileSync(path.join(stateDir, 'threadline', 'conversations.json'), '{"conversations":[]}\n');

    // 4. The real routes over the fixture home (default config: allowedPaths ['./']).
    const raw = JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf8'));
    const config = { ...raw, projectDir: agentDir, stateDir, port: 0 } as unknown as InstarConfig;
    app = express();
    app.use(express.json());
    app.use(createFileRoutes({ config }));

    // 5. The walk.
    hits = walk(stateDir).filter((f) => {
      const mode = fs.statSync(f).mode & 0o777;
      const base = path.basename(f);
      const text = fs.readFileSync(f, 'utf8');
      const rel = path.relative(agentDir, f);
      const excuse = NOT_KEY_MATERIAL_0600.get(rel);
      if (mode === 0o600 && excuse) {
        // Excused ONLY while its own predicate proves it is not key material.
        expect(excuse(text), `${rel} excused as non-key but no longer satisfies its proof predicate`).toBe(true);
        return NAME_PREDICATE.test(base);
      }
      return mode === 0o600 || NAME_PREDICATE.test(base) || (base.endsWith('.json') && hasPrivateField(text));
    }).map((f) => path.relative(agentDir, f));
  });

  afterAll(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    SafeFsExecutor.safeRmSync(tmpHome, { recursive: true, force: true, operation: 'tests/integration/file-routes-never-served-walk.test.ts' });
  });

  it('the walk finds the files the spec names (the walk is not blind)', () => {
    for (const expected of [
      '.instar/identity.json',
      '.instar/threadline/identity.json',
      '.instar/threadline/inbox-hmac.key',
      '.instar/threadline/invitation-secret.key',
      '.instar/threadline/secure-invitations.json',
      '.instar/state/inbound-delivery.hmac-key',
      '.instar/relay-tokens.json',
      '.instar/local-state/keys.enc',
      '.instar/state/conversation-bind-token.secret',
      '.instar/state/.manifest-key',
      '.instar/machine/signing-key.pem',
      '.instar/remediation-keys.age',
      '.instar/telemetry/local-secret',
    ]) {
      expect(hits, expected).toContain(expected);
    }
    expect(hits.some((h) => h.startsWith('.instar/machine-ssh/'))).toBe(true);
  });

  it('every hit is never-served by the list', () => {
    const uncovered = hits.filter((rel) => !isNeverServed(rel));
    expect(uncovered, `key-bearing files the list does not cover — add them to src/core/keyMaterialPaths.ts`).toEqual([]);
  });

  it('every hit is refused by read/download/link and omitted from its parent listing (real routes)', async () => {
    for (const rel of hits) {
      const bytes = fs.readFileSync(path.join(agentDir, rel), 'utf8');
      const probe = bytes.trim().slice(0, 24);
      for (const route of ['/api/files/read', '/api/files/download', '/api/files/link']) {
        const res = await request(app).get(route).query({ path: rel });
        expect(res.status, `${route} ${rel}`).toBe(403);
        if (probe.length >= 8) expect(res.text ?? '', `${route} ${rel} leaked bytes`).not.toContain(probe);
      }
      const parent = path.dirname(rel);
      const list = await request(app).get('/api/files/list').query({ path: parent });
      if (list.status === 200) {
        expect(list.body.entries.map((e: { name: string }) => e.name), `list ${parent} shows ${rel}`).not.toContain(path.basename(rel));
      } else {
        expect(list.status, `list ${parent}`).toBe(403);
      }
    }
  });

  it('every hit is excluded from a real backup snapshot, even when includeFiles names it', () => {
    const entries = hits.map((rel) => path.relative(stateDir, path.join(agentDir, rel)));
    const warn = console.warn;
    console.warn = () => {};
    try {
      const snapshot = new BackupManager(stateDir, { includeFiles: ['AGENT.md', ...entries] }).createSnapshot('manual');
      expect(snapshot.files).toContain('AGENT.md');
      for (const e of entries) expect(snapshot.files, e).not.toContain(e);
      const snapDir = path.join(stateDir, 'backups');
      const copied = walk(snapDir).map((f) => path.basename(f));
      for (const e of entries) expect(copied, `${e} copied into a snapshot`).not.toContain(path.basename(e));
    } finally {
      console.warn = warn;
    }
  });

  it('every hit is gitignored in the fixture home (real git check-ignore over the init-written .gitignore)', () => {
    execFileSync('git', ['-C', agentDir, 'init', '-q']);
    const notIgnored = hits.filter((rel) => {
      try { execFileSync('git', ['-C', agentDir, 'check-ignore', '-q', rel]); return false; } catch { return true; }
    });
    expect(notIgnored, 'key-bearing files git would commit').toEqual([]);
  });

  it('every hit is classified never-sync', () => {
    const classifier = new FileClassifier({ projectDir: agentDir });
    const syncable = hits.filter((rel) => classifier.classify(rel).strategy !== 'never-sync');
    expect(syncable, 'key-bearing files git-sync would replicate').toEqual([]);
  });

  it('the operator audit surface next to the keys still serves (no over-block)', async () => {
    const res = await request(app).get('/api/files/read').query({ path: '.instar/threadline/conversations.json' });
    expect(res.status).toBe(200);
    const agentMd = await request(app).get('/api/files/read').query({ path: '.instar/AGENT.md' });
    expect(agentMd.status).toBe(200);
  });
});
