#!/usr/bin/env node
/**
 * verify-proposal-derived-runbook.mjs — S-3 commit-time promotion-gate.
 *
 * Implements SELF-HEALING-REMEDIATOR-V2-SPEC.md §A11, §A22, §A32, §A41, §A48,
 * and §A57 Tier-3 (S-3): the /instar-dev side of the proposal-derived runbook
 * promotion gate. Pairs with C-1's PR-merge-time CI gate.
 *
 * Scope:
 *   - Operates on a list of files (--files <csv>) presumed to be staged in
 *     the current commit, OR on a comma-separated list passed to the API.
 *   - Looks at `src/remediation/runbooks/*.{ts,js}` ONLY. All other paths
 *     pass through.
 *
 * Decision tree (short-circuits on first failure):
 *   1. Runbook has no `__proposalDerivedFrom` const → pass through.
 *   2. Runbook declares `__proposalDerivedFrom = '<id>'` but no proposal JSON
 *      exists at `.instar/remediation/proposals-*\/<id>.json` → BLOCK
 *      (`proposal-not-found`).
 *   3. Runbook has `__proposalDerivedFrom` but no matching
 *      `__producingAgentId` const → BLOCK (`missing-producing-agent-id`).
 *   4. Proposal JSON's `producingAgentId` differs from the runbook's
 *      `__producingAgentId` → BLOCK (`producing-agent-id-mismatch`).
 *   5. Proposal carries a `producingAgentIdSignature` field whose Ed25519
 *      signature does not verify against the bundled public key at
 *      `.instar/remediation/agent-pubkeys/<agentId>.pem` → BLOCK
 *      (`signature-verify-failed`).
 *      (If the pubkey file is absent, the gate defers to C-1's pre-merge
 *      check rather than block — proposal-pubkey distribution is fleet
 *      infrastructure that may post-date this commit. Other fields are
 *      still validated.)
 *
 * Why commit-time AND PR-merge-time?
 *   The CI gate (C-1) is the authoritative check. This S-3 gate catches
 *   author mistakes BEFORE a PR is pushed — runbook source that names a
 *   non-existent proposal, source emitted without the producing-agent-id
 *   annotation, etc. The check is fast, local, and pure-Node.
 *
 * Pure Node, zero deps beyond `node:crypto` / `node:fs` / `node:path`.
 *
 * CLI:
 *   node skills/instar-dev/scripts/verify-proposal-derived-runbook.mjs \
 *       --files src/remediation/runbooks/foo.ts,src/remediation/runbooks/bar.ts
 *
 *   Exit 0 — pass (no proposal-derived runbooks, or all checks passed).
 *   Exit 1 — block; reason printed to stderr.
 *
 * API:
 *   import { verifyProposalDerivedRunbooks } from './verify-proposal-derived-runbook.mjs';
 *   const result = verifyProposalDerivedRunbooks({
 *     repoRoot: '/path/to/repo',
 *     files: ['src/remediation/runbooks/foo.ts', ...],
 *   });
 *   // → { ok: true, reason: '...' } | { ok: false, reason: '...', file?: string }
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNBOOK_PATH_PREFIX = 'src/remediation/runbooks/';
const PROPOSAL_MARKER = '__proposalDerivedFrom';
const AGENT_ID_MARKER = '__producingAgentId';

const PROPOSAL_ID_RE = new RegExp(
  `(?:const|let|var|export\\s+const|export\\s+let|export\\s+var)\\s+${PROPOSAL_MARKER}\\s*=\\s*['"\`]([^'"\`]+)['"\`]`,
);
const AGENT_ID_RE = new RegExp(
  `(?:const|let|var|export\\s+const|export\\s+let|export\\s+var)\\s+${AGENT_ID_MARKER}\\s*=\\s*['"\`]([^'"\`]+)['"\`]`,
);

/**
 * Extract the proposalId and producingAgentId (if any) from a runbook
 * source file. Returns null when the file isn't proposal-derived.
 */
export function inspectRunbook(repoRoot, relPath) {
  const abs = path.join(repoRoot, relPath);
  let content;
  try {
    content = fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
  const propMatch = content.match(PROPOSAL_ID_RE);
  if (!propMatch) return null;
  const agentMatch = content.match(AGENT_ID_RE);
  return {
    file: relPath,
    proposalId: propMatch[1],
    producingAgentId: agentMatch ? agentMatch[1] : null,
  };
}

/**
 * Find the on-disk proposal JSON for a given proposalId. Per A14, proposals
 * live at `.instar/remediation/proposals-<machineId>/<proposalId>.json`.
 * Machine IDs are not known a priori at gate time, so we scan all
 * `proposals-*` directories. Returns the parsed JSON + the on-disk path,
 * or null when no proposal file is found.
 */
export function findProposalJson(repoRoot, proposalId) {
  const baseDir = path.join(repoRoot, '.instar/remediation');
  let entries;
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith('proposals-')) continue;
    const candidate = path.join(baseDir, entry.name, `${proposalId}.json`);
    if (fs.existsSync(candidate)) {
      try {
        const raw = fs.readFileSync(candidate, 'utf8');
        const parsed = JSON.parse(raw);
        return { proposal: parsed, path: candidate, machineDir: entry.name };
      } catch {
        // Malformed JSON — treat as not-found; the C-1 CI gate will reject
        // on its own pull-path. Authors should reproduce the proposal.
        return null;
      }
    }
  }
  return null;
}

/**
 * Verify the Ed25519 signature on a proposal's producingAgentId field.
 * The signature covers the canonical payload:
 *   `proposalId=<id>\nproducingAgentId=<agentId>\nemittedAt=<iso>`
 * (declared order; only the three fields the signature binds).
 *
 * Returns:
 *   - 'ok' — signature verified
 *   - 'no-signature' — proposal has no signature field (caller decides)
 *   - 'no-pubkey' — bundled pubkey file is absent (caller defers to CI)
 *   - 'invalid' — signature does not verify
 */
export function verifyProposalSignature(repoRoot, proposal) {
  const sigB64 = proposal.producingAgentIdSignature;
  if (!sigB64) return 'no-signature';
  const agentId = proposal.producingAgentId;
  if (!agentId) return 'invalid';

  const pubkeyPath = path.join(
    repoRoot,
    '.instar/remediation/agent-pubkeys',
    `${sanitizeAgentId(agentId)}.pem`,
  );
  if (!fs.existsSync(pubkeyPath)) {
    return 'no-pubkey';
  }
  let pem;
  try {
    pem = fs.readFileSync(pubkeyPath, 'utf8');
  } catch {
    return 'no-pubkey';
  }
  if (!pem.includes('BEGIN PUBLIC KEY')) return 'no-pubkey';

  let pubKey;
  try {
    pubKey = crypto.createPublicKey(pem);
  } catch {
    return 'invalid';
  }

  const canonical = [
    `proposalId=${proposal.proposalId ?? ''}`,
    `producingAgentId=${agentId}`,
    `emittedAt=${proposal.emittedAt ?? ''}`,
  ].join('\n');

  let sigBuf;
  try {
    sigBuf = Buffer.from(sigB64, 'base64');
  } catch {
    return 'invalid';
  }
  try {
    const ok = crypto.verify(null, Buffer.from(canonical, 'utf8'), pubKey, sigBuf);
    return ok ? 'ok' : 'invalid';
  } catch {
    return 'invalid';
  }
}

function sanitizeAgentId(agentId) {
  // Defensive: agent IDs are typed but we're touching the filesystem.
  // Strip anything that isn't an alphanumeric, dash, underscore, dot.
  return String(agentId).replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Main entry. Iterates the file list, short-circuits on first failure.
 */
export function verifyProposalDerivedRunbooks(input) {
  const { repoRoot, files = [] } = input;

  for (const rel of files) {
    if (!rel.startsWith(RUNBOOK_PATH_PREFIX)) continue;
    if (!rel.endsWith('.ts') && !rel.endsWith('.js')) continue;

    const inspection = inspectRunbook(repoRoot, rel);
    if (!inspection) continue; // Not proposal-derived — pass through.

    // Check 1: producing-agent-id annotation present?
    if (!inspection.producingAgentId) {
      return {
        ok: false,
        reason: `missing-producing-agent-id: runbook ${rel} declares ${PROPOSAL_MARKER}='${inspection.proposalId}' but no ${AGENT_ID_MARKER} const. The proposal pipeline must emit both consts together.`,
        file: rel,
      };
    }

    // Check 2: proposal JSON exists?
    const found = findProposalJson(repoRoot, inspection.proposalId);
    if (!found) {
      return {
        ok: false,
        reason: `proposal-not-found: runbook ${rel} claims derivation from proposal '${inspection.proposalId}', but no matching .instar/remediation/proposals-*/${inspection.proposalId}.json exists in this checkout. Either the proposal was deleted, or this runbook is fabricating a proposal reference.`,
        file: rel,
      };
    }

    // Check 3: producing-agent-id matches between proposal + runbook?
    const proposalAgent = found.proposal.producingAgentId;
    if (!proposalAgent) {
      return {
        ok: false,
        reason: `proposal-missing-agent-id: proposal '${inspection.proposalId}' (at ${path.relative(repoRoot, found.path)}) has no producingAgentId field. Proposals must record which agent emitted them.`,
        file: rel,
      };
    }
    if (proposalAgent !== inspection.producingAgentId) {
      return {
        ok: false,
        reason: `producing-agent-id-mismatch: runbook ${rel} declares ${AGENT_ID_MARKER}='${inspection.producingAgentId}' but proposal '${inspection.proposalId}' was emitted by '${proposalAgent}'.`,
        file: rel,
      };
    }

    // Check 4: proposal signature verifies?
    const sigResult = verifyProposalSignature(repoRoot, found.proposal);
    if (sigResult === 'invalid') {
      return {
        ok: false,
        reason: `signature-verify-failed: proposal '${inspection.proposalId}' carries a producingAgentIdSignature that does not verify against the bundled pubkey for agent '${proposalAgent}'.`,
        file: rel,
      };
    }
    // 'ok', 'no-signature', 'no-pubkey' all pass at commit-time:
    //   • 'ok' — strict pass.
    //   • 'no-signature' — proposal pipeline pre-dates signing; C-1 will
    //      enforce at PR-merge time once the proposal pipeline lands.
    //   • 'no-pubkey' — pubkey distribution is post-S-3 infrastructure;
    //      C-1 has fleet-wide visibility we lack here.
  }

  return { ok: true, reason: 'no-proposal-derived-runbooks-or-all-verified' };
}

// ─── CLI ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--files') {
      const val = argv[++i];
      if (val) args.files = val.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a.startsWith('--files=')) {
      args.files = a.slice('--files='.length).split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a === '--repo-root') {
      args.repoRoot = argv[++i];
    } else if (a.startsWith('--repo-root=')) {
      args.repoRoot = a.slice('--repo-root='.length);
    }
  }
  return args;
}

const isMain = (() => {
  try {
    const here = fileURLToPath(import.meta.url);
    const argv1 = process.argv[1] ? path.resolve(process.argv[1]) : '';
    return here === argv1;
  } catch {
    return false;
  }
})();

if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = args.repoRoot ? path.resolve(args.repoRoot) : process.cwd();
  if (args.files.length === 0) {
    // No files passed — nothing to check.
    console.log('[promotion-gate] PASS: no files provided');
    process.exit(0);
  }
  const result = verifyProposalDerivedRunbooks({ repoRoot, files: args.files });
  if (result.ok) {
    console.log(`[promotion-gate] PASS: ${result.reason}`);
    process.exit(0);
  }
  console.error('');
  console.error('╔════════════════════════════════════════════════════════════════════╗');
  console.error('║  /instar-dev promotion-gate — commit BLOCKED                       ║');
  console.error('╚════════════════════════════════════════════════════════════════════╝');
  console.error('');
  console.error(`Reason: ${result.reason}`);
  if (result.file) console.error(`File:   ${result.file}`);
  console.error('');
  console.error('See SELF-HEALING-REMEDIATOR-V2-SPEC.md §A11, §A22, §A32 for the gate rationale.');
  console.error('');
  process.exit(1);
}
