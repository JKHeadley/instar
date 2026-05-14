/**
 * Unit tests for the C-1 pre-merge gate (`scripts/verify-runbook-pr-signature.js`).
 *
 * Covers SELF-HEALING-REMEDIATOR-V2-SPEC §A22, §A32, §A41, §A50.
 *
 * Strategy: real Ed25519 keypair generated in-test, real fs scaffolding
 * in an OS tmpdir, no shell-out. The script is loaded directly via ESM
 * dynamic import.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// Dynamic import keeps the .js path stable across TS resolution.
const MOD_REL = '../../scripts/verify-runbook-pr-signature.js';

type Verifier = (input: unknown) => { ok: boolean; reason?: string; [k: string]: unknown };
let verifyRunbookPrSignature: Verifier;
let parseTelegramApprovalBlock: (s: string) => unknown;

beforeEach(async () => {
  const mod = await import(MOD_REL);
  verifyRunbookPrSignature = mod.verifyRunbookPrSignature;
  parseTelegramApprovalBlock = mod.parseTelegramApprovalBlock;
});

/* ────────────────────────────────────────────────────────────────────────
 * Helpers
 * ──────────────────────────────────────────────────────────────────────── */

function makeTmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runbook-gate-test-'));
  fs.mkdirSync(path.join(dir, 'src/remediation/runbooks'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.github/keyrings'), { recursive: true });
  return dir;
}

function writeRunbook(repoRoot: string, name: string, opts: { proposalId?: string; producingAgentEmail?: string } = {}): string {
  const rel = `src/remediation/runbooks/${name}.ts`;
  const lines: string[] = [];
  if (opts.proposalId) {
    lines.push(`export const __proposalDerivedFrom = '${opts.proposalId}';`);
  }
  if (opts.producingAgentEmail) {
    lines.push(`export const __producingAgentEmail = '${opts.producingAgentEmail}';`);
  }
  lines.push('export const runbook = { id: "test" };');
  fs.writeFileSync(path.join(repoRoot, rel), lines.join('\n'));
  return rel;
}

function makeKeypair() {
  return crypto.generateKeyPairSync('ed25519');
}

function signCanonical(privateKey: crypto.KeyObject, fields: Record<string, string>): string {
  const order = ['proposalId', 'runbookId', 'action', 'userId', 'messageId', 'signedAt'];
  const lines: string[] = [];
  for (const k of order) {
    if (fields[k] !== undefined) lines.push(`${k}=${fields[k]}`);
  }
  const canonical = lines.join('\n');
  const sig = crypto.sign(null, Buffer.from(canonical, 'utf8'), privateKey);
  return sig.toString('base64');
}

function makeTelegramBlock(fields: Record<string, string>): string {
  const order = ['proposalId', 'runbookId', 'action', 'userId', 'messageId', 'signedAt', 'signature'];
  const lines: string[] = ['<!-- telegram-approval -->'];
  for (const k of order) {
    if (fields[k] !== undefined) lines.push(`${k}: ${fields[k]}`);
  }
  lines.push('<!-- /telegram-approval -->');
  return lines.join('\n');
}

function writePubkey(repoRoot: string, pubKey: crypto.KeyObject): void {
  const pem = pubKey.export({ type: 'spki', format: 'pem' }) as string;
  fs.writeFileSync(path.join(repoRoot, '.github/keyrings/telegram-principal-pub.pem'), pem);
}

function writeApproverFingerprint(repoRoot: string, fingerprint: string): void {
  const content = `# test keyring sidecar\nfingerprint: ${fingerprint}\n`;
  fs.writeFileSync(path.join(repoRoot, '.github/keyrings/runbook-approvers.gpg'), content);
}

function makeWatermarkStore() {
  const set = new Set<string>();
  return {
    has: (k: string) => set.has(k),
    add: (k: string) => { set.add(k); },
    _size: () => set.size,
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * Cases
 * ──────────────────────────────────────────────────────────────────────── */

describe('verifyRunbookPrSignature — C-1 gate', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = makeTmpRepo();
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(repoRoot, {
      recursive: true,
      force: true,
      operation: 'tests/unit/verify-runbook-pr-signature.test.ts:afterEach',
    });
  });

  it('1. PR with no runbook changes → passes through', () => {
    const r = verifyRunbookPrSignature({
      repoRoot,
      changedFiles: ['src/some-other-area/foo.ts', 'docs/README.md'],
      prBody: '',
    });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('no-runbook-changes');
  });

  it('2. PR with non-proposal-derived runbook → passes through', () => {
    const rel = writeRunbook(repoRoot, 'plain-runbook'); // no __proposalDerivedFrom
    const r = verifyRunbookPrSignature({
      repoRoot,
      changedFiles: [rel],
      prBody: '',
    });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('non-proposal-derived');
  });

  it('3. PR with proposal-derived runbook + valid Telegram signature → passes', () => {
    const { privateKey, publicKey } = makeKeypair();
    writePubkey(repoRoot, publicKey);
    const rel = writeRunbook(repoRoot, 'derived-ok', { proposalId: 'prop-123' });

    const fields = {
      proposalId: 'prop-123',
      runbookId: 'derived-ok',
      action: 'approved',
      userId: '987654321',
      messageId: 'msg-001',
      signedAt: '2026-05-13T18:00:00.000Z',
    };
    const sig = signCanonical(privateKey, fields);
    const body = `Some PR description.\n\n${makeTelegramBlock({ ...fields, signature: sig })}\n`;

    const r = verifyRunbookPrSignature({
      repoRoot,
      changedFiles: [rel],
      prBody: body,
      watermarkStore: makeWatermarkStore(),
    });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('telegram-countersigned');
  });

  it('4. PR with proposal-derived runbook + invalid signature → fails', () => {
    const { publicKey } = makeKeypair();
    const { privateKey: otherPriv } = makeKeypair(); // different key — forgery
    writePubkey(repoRoot, publicKey);
    const rel = writeRunbook(repoRoot, 'derived-badsig', { proposalId: 'prop-456' });

    const fields = {
      proposalId: 'prop-456',
      runbookId: 'derived-badsig',
      action: 'approved',
      userId: '987654321',
      messageId: 'msg-002',
      signedAt: '2026-05-13T18:01:00.000Z',
    };
    const sig = signCanonical(otherPriv, fields); // signed with wrong key
    const body = makeTelegramBlock({ ...fields, signature: sig });

    const r = verifyRunbookPrSignature({
      repoRoot,
      changedFiles: [rel],
      prBody: body,
      watermarkStore: makeWatermarkStore(),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('telegram-signature-invalid');
  });

  it('5. PR with proposal-derived runbook + replayed messageId → fails (watermark)', () => {
    const { privateKey, publicKey } = makeKeypair();
    writePubkey(repoRoot, publicKey);
    const rel = writeRunbook(repoRoot, 'derived-replay', { proposalId: 'prop-789' });

    const fields = {
      proposalId: 'prop-789',
      runbookId: 'derived-replay',
      action: 'approved',
      userId: '987654321',
      messageId: 'msg-already-seen',
      signedAt: '2026-05-13T18:02:00.000Z',
    };
    const sig = signCanonical(privateKey, fields);
    const body = makeTelegramBlock({ ...fields, signature: sig });
    const wm = makeWatermarkStore();
    // Pre-seed the watermark (simulating a previously-merged PR with this key).
    wm.add('prop-789:msg-already-seen');

    const r = verifyRunbookPrSignature({
      repoRoot,
      changedFiles: [rel],
      prBody: body,
      watermarkStore: wm,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^telegram-block-replay/);
  });

  it('6. PR with GPG-signed commit by approver → passes', () => {
    const rel = writeRunbook(repoRoot, 'gpg-good', { proposalId: 'prop-gpg-1' });
    // Approver fingerprint: 40 hex chars.
    const fp = 'AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555';
    writeApproverFingerprint(repoRoot, fp);

    const r = verifyRunbookPrSignature({
      repoRoot,
      changedFiles: [rel],
      prBody: 'PR body with no Telegram block.',
      headCommitInfo: {
        sha: 'deadbeef',
        authorEmail: 'approver@example.com',
        gpgGoodsig: true,
        gpgFingerprint: fp,
      },
    });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('gpg-signed-by-approver');
  });

  it('7. PR with GPG-signed commit by NON-approver → fails', () => {
    const rel = writeRunbook(repoRoot, 'gpg-bad', { proposalId: 'prop-gpg-2' });
    const approverFp = 'AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555';
    const intruderFp = 'FFFF9999EEEE8888DDDD7777CCCC6666BBBB5555';
    writeApproverFingerprint(repoRoot, approverFp);

    const r = verifyRunbookPrSignature({
      repoRoot,
      changedFiles: [rel],
      prBody: '',
      headCommitInfo: {
        sha: 'cafebabe',
        authorEmail: 'intruder@example.com',
        gpgGoodsig: true,
        gpgFingerprint: intruderFp,
      },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^gpg-fingerprint-not-in-approver-keyring/);
  });

  it('parseTelegramApprovalBlock returns null on missing required fields', () => {
    // No signature → null
    const body = `<!-- telegram-approval -->\nproposalId: x\naction: approved\nuserId: 1\nmessageId: m\nsignedAt: t\n<!-- /telegram-approval -->`;
    expect(parseTelegramApprovalBlock(body)).toBeNull();
  });
});
