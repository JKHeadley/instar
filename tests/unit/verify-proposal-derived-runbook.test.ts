/**
 * Unit tests for the S-3 commit-time promotion gate
 * (`skills/instar-dev/scripts/verify-proposal-derived-runbook.mjs`).
 *
 * Covers SELF-HEALING-REMEDIATOR-V2-SPEC §A11, §A22, §A32, §A41, §A48,
 * §A57 Tier-3 (S-3).
 *
 * Strategy: pure-Node fs scaffolding in an OS tmpdir, real Ed25519
 * keypairs generated in-test, ESM dynamic import of the script. No
 * shell-out, no git invocation — the gate operates on a file list, so
 * the test injects file lists directly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const MOD_REL = '../../skills/instar-dev/scripts/verify-proposal-derived-runbook.mjs';

type Verifier = (input: { repoRoot: string; files: string[] }) => {
  ok: boolean;
  reason?: string;
  file?: string;
};

let verifyProposalDerivedRunbooks: Verifier;

beforeEach(async () => {
  const mod = await import(MOD_REL);
  verifyProposalDerivedRunbooks = mod.verifyProposalDerivedRunbooks;
});

/* ────────────────────────────────────────────────────────────────────────
 * Helpers
 * ──────────────────────────────────────────────────────────────────────── */

function makeTmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promotion-gate-test-'));
  fs.mkdirSync(path.join(dir, 'src/remediation/runbooks'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.instar/remediation'), { recursive: true });
  return dir;
}

interface RunbookOpts {
  proposalId?: string;
  producingAgentId?: string;
}

function writeRunbook(repoRoot: string, name: string, opts: RunbookOpts = {}): string {
  const rel = `src/remediation/runbooks/${name}.ts`;
  const lines: string[] = [];
  if (opts.proposalId) {
    lines.push(`export const __proposalDerivedFrom = '${opts.proposalId}';`);
  }
  if (opts.producingAgentId) {
    lines.push(`export const __producingAgentId = '${opts.producingAgentId}';`);
  }
  lines.push('export const runbook = { id: "test" };');
  fs.writeFileSync(path.join(repoRoot, rel), lines.join('\n'));
  return rel;
}

interface ProposalOpts {
  proposalId: string;
  producingAgentId: string;
  emittedAt?: string;
  privateKey?: crypto.KeyObject; // when present, signs the canonical payload
  forceSignature?: string; // override the signature with a bad one
}

function writeProposal(
  repoRoot: string,
  machineId: string,
  opts: ProposalOpts,
): string {
  const dir = path.join(repoRoot, `.instar/remediation/proposals-${machineId}`);
  fs.mkdirSync(dir, { recursive: true });

  const emittedAt = opts.emittedAt ?? '2026-05-13T18:00:00.000Z';
  const proposal: Record<string, unknown> = {
    proposalId: opts.proposalId,
    producingAgentId: opts.producingAgentId,
    emittedAt,
    clusterSignature: 'sig-abc',
    fleetScope: 'machine',
  };

  let signature: string | undefined;
  if (opts.privateKey) {
    const canonical = [
      `proposalId=${opts.proposalId}`,
      `producingAgentId=${opts.producingAgentId}`,
      `emittedAt=${emittedAt}`,
    ].join('\n');
    signature = crypto.sign(null, Buffer.from(canonical, 'utf8'), opts.privateKey).toString('base64');
  }
  if (opts.forceSignature !== undefined) {
    signature = opts.forceSignature;
  }
  if (signature !== undefined) {
    proposal.producingAgentIdSignature = signature;
  }

  const filePath = path.join(dir, `${opts.proposalId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(proposal, null, 2));
  return filePath;
}

function writePubkey(repoRoot: string, agentId: string, publicKey: crypto.KeyObject): void {
  const dir = path.join(repoRoot, '.instar/remediation/agent-pubkeys');
  fs.mkdirSync(dir, { recursive: true });
  const pem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
  fs.writeFileSync(path.join(dir, `${agentId}.pem`), pem);
}

/* ────────────────────────────────────────────────────────────────────────
 * Cases
 * ──────────────────────────────────────────────────────────────────────── */

describe('verifyProposalDerivedRunbooks — S-3 commit-time promotion gate', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = makeTmpRepo();
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(repoRoot, {
      recursive: true,
      force: true,
      operation: 'tests/unit/verify-proposal-derived-runbook.test.ts:afterEach',
    });
  });

  it('1. runbook without __proposalDerivedFrom → passes through', () => {
    const rel = writeRunbook(repoRoot, 'plain-runbook'); // no consts
    const r = verifyProposalDerivedRunbooks({ repoRoot, files: [rel] });
    expect(r.ok).toBe(true);
    expect(r.reason).toMatch(/no-proposal-derived-runbooks-or-all-verified/);
  });

  it('2. runbook with __proposalDerivedFrom matching existing proposal + agent id → passes', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const proposalId = 'prop-aaa';
    const agentId = 'echo';
    writeProposal(repoRoot, 'machine-1', { proposalId, producingAgentId: agentId, privateKey });
    writePubkey(repoRoot, agentId, publicKey);
    const rel = writeRunbook(repoRoot, 'derived-ok', {
      proposalId,
      producingAgentId: agentId,
    });

    const r = verifyProposalDerivedRunbooks({ repoRoot, files: [rel] });
    expect(r.ok).toBe(true);
  });

  it('3. runbook with __proposalDerivedFrom but no __producingAgentId → fails', () => {
    const proposalId = 'prop-bbb';
    writeProposal(repoRoot, 'machine-1', { proposalId, producingAgentId: 'echo' });
    const rel = writeRunbook(repoRoot, 'no-agent-id', { proposalId });

    const r = verifyProposalDerivedRunbooks({ repoRoot, files: [rel] });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/missing-producing-agent-id/);
    expect(r.file).toBe(rel);
  });

  it('4. runbook with __proposalDerivedFrom pointing to non-existent proposal → fails', () => {
    const rel = writeRunbook(repoRoot, 'phantom-proposal', {
      proposalId: 'prop-ghost',
      producingAgentId: 'echo',
    });
    // No proposal JSON written.

    const r = verifyProposalDerivedRunbooks({ repoRoot, files: [rel] });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/proposal-not-found/);
    expect(r.file).toBe(rel);
  });

  it('5. runbook with __producingAgentId whose signature doesn\'t verify against the proposal → fails', () => {
    const { privateKey: wrongKey } = crypto.generateKeyPairSync('ed25519');
    const { publicKey: realPub } = crypto.generateKeyPairSync('ed25519');
    const proposalId = 'prop-ccc';
    const agentId = 'echo';
    // Sign the canonical payload with WRONG key — pubkey on disk won't verify.
    writeProposal(repoRoot, 'machine-1', {
      proposalId,
      producingAgentId: agentId,
      privateKey: wrongKey,
    });
    writePubkey(repoRoot, agentId, realPub);
    const rel = writeRunbook(repoRoot, 'bad-sig', {
      proposalId,
      producingAgentId: agentId,
    });

    const r = verifyProposalDerivedRunbooks({ repoRoot, files: [rel] });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/signature-verify-failed/);
    expect(r.file).toBe(rel);
  });

  it('6. multiple runbooks, first proposal-derived failure short-circuits', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const proposalIdOk = 'prop-good';
    const agentId = 'echo';
    writeProposal(repoRoot, 'machine-1', {
      proposalId: proposalIdOk,
      producingAgentId: agentId,
      privateKey,
    });
    writePubkey(repoRoot, agentId, publicKey);

    const passingRel = writeRunbook(repoRoot, 'ok-one', {
      proposalId: proposalIdOk,
      producingAgentId: agentId,
    });
    const failingRel = writeRunbook(repoRoot, 'bad-two', {
      proposalId: 'prop-missing',
      producingAgentId: agentId,
    });
    const trailingRel = writeRunbook(repoRoot, 'never-checked'); // would pass

    const r = verifyProposalDerivedRunbooks({
      repoRoot,
      files: [passingRel, failingRel, trailingRel],
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/proposal-not-found/);
    expect(r.file).toBe(failingRel);
  });

  it('producing-agent-id mismatch between runbook and proposal → fails', () => {
    const proposalId = 'prop-mismatch';
    writeProposal(repoRoot, 'machine-1', {
      proposalId,
      producingAgentId: 'echo',
    });
    const rel = writeRunbook(repoRoot, 'mismatch', {
      proposalId,
      producingAgentId: 'imposter',
    });

    const r = verifyProposalDerivedRunbooks({ repoRoot, files: [rel] });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/producing-agent-id-mismatch/);
  });

  it('proposal exists but lacks producingAgentId field → fails', () => {
    const proposalId = 'prop-no-agent';
    // Write proposal JSON manually without producingAgentId.
    const dir = path.join(repoRoot, '.instar/remediation/proposals-machine-1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${proposalId}.json`),
      JSON.stringify({ proposalId, emittedAt: '2026-05-13T18:00:00.000Z' }, null, 2),
    );
    const rel = writeRunbook(repoRoot, 'agent-missing-in-proposal', {
      proposalId,
      producingAgentId: 'echo',
    });

    const r = verifyProposalDerivedRunbooks({ repoRoot, files: [rel] });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/proposal-missing-agent-id/);
  });

  it('no-pubkey on disk → passes (defers to CI gate) even when signature is present', () => {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const proposalId = 'prop-no-pubkey';
    const agentId = 'echo';
    writeProposal(repoRoot, 'machine-1', {
      proposalId,
      producingAgentId: agentId,
      privateKey,
    });
    // NO pubkey written.
    const rel = writeRunbook(repoRoot, 'no-pubkey', {
      proposalId,
      producingAgentId: agentId,
    });

    const r = verifyProposalDerivedRunbooks({ repoRoot, files: [rel] });
    expect(r.ok).toBe(true);
  });

  it('proposal without signature field → passes (signature is optional at commit-time)', () => {
    const proposalId = 'prop-unsigned';
    const agentId = 'echo';
    writeProposal(repoRoot, 'machine-1', {
      proposalId,
      producingAgentId: agentId,
    });
    const rel = writeRunbook(repoRoot, 'unsigned', {
      proposalId,
      producingAgentId: agentId,
    });

    const r = verifyProposalDerivedRunbooks({ repoRoot, files: [rel] });
    expect(r.ok).toBe(true);
  });

  it('non-runbook paths in file list are ignored', () => {
    const rel = writeRunbook(repoRoot, 'ok-one'); // plain
    const r = verifyProposalDerivedRunbooks({
      repoRoot,
      files: [rel, 'src/server/foo.ts', 'docs/README.md', 'scripts/bar.js'],
    });
    expect(r.ok).toBe(true);
  });

  it('proposal stored under a different machineId directory still resolves', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const proposalId = 'prop-other-machine';
    const agentId = 'echo';
    // Two unrelated proposal dirs to confirm scanning works.
    fs.mkdirSync(path.join(repoRoot, '.instar/remediation/proposals-unused-machine'), { recursive: true });
    writeProposal(repoRoot, 'second-machine-xyz', {
      proposalId,
      producingAgentId: agentId,
      privateKey,
    });
    writePubkey(repoRoot, agentId, publicKey);
    const rel = writeRunbook(repoRoot, 'cross-machine', {
      proposalId,
      producingAgentId: agentId,
    });

    const r = verifyProposalDerivedRunbooks({ repoRoot, files: [rel] });
    expect(r.ok).toBe(true);
  });
});
