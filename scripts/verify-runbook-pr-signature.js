#!/usr/bin/env node
/**
 * verify-runbook-pr-signature.js — C-1 pre-merge gate implementation.
 *
 * Implements SELF-HEALING-REMEDIATOR-V2-SPEC.md §A22 (different-principal
 * verification of proposal-derived runbook PRs), §A41 (Telegram
 * countersignature payload binding + user_id principal), §A32 (proposal-PR
 * identity), §A50 (workflow templated on `worktree-trailer-sig-check.yml`).
 *
 * Verification policy (one of):
 *
 *   1. GPG-signed HEAD commit by a key registered in the
 *      `.github/keyrings/runbook-approvers.gpg` keyring whose author email
 *      differs from any agent identity declared in the proposal JSON.
 *
 *   2. Telegram-countersigned approval block in the PR body, of shape:
 *
 *        <!-- telegram-approval -->
 *        proposalId: <id>
 *        runbookId: <id>
 *        action: approved
 *        userId: <integer>
 *        messageId: <id>
 *        signedAt: <ISO>
 *        signature: <base64>
 *        <!-- /telegram-approval -->
 *
 *      Signature is verified against the pinned principal Telegram-session
 *      pubkey at `.github/keyrings/telegram-principal-pub.pem`.
 *
 * Scope:
 *   - PRs touching no files under `src/remediation/runbooks/` PASS THROUGH.
 *   - PRs touching non-proposal-derived runbooks (no `__proposalDerivedFrom`
 *     const in any touched runbook source file) PASS THROUGH.
 *   - PRs touching proposal-derived runbooks MUST satisfy (1) OR (2).
 *
 * Pure Node, no deps beyond `node:crypto` / `node:fs` / `node:child_process`.
 *
 * Invocation shape (used both by the workflow and by unit tests):
 *
 *   verifyRunbookPrSignature({
 *     repoRoot,             // string — checked-out repo root
 *     changedFiles,         // string[] — file paths relative to repoRoot
 *     prBody,               // string — full PR body (markdown)
 *     headCommitInfo,       // { sha, authorEmail, gpgGoodsig?, gpgFingerprint? }
 *     keyringPath,          // optional override for runbook-approvers.gpg
 *     telegramPubkeyPath,   // optional override for telegram-principal-pub.pem
 *     watermarkStore,       // { has(key): bool, add(key): void } — message-id replay store
 *   }) → { ok: true } | { ok: false, reason: string }
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const RUNBOOK_PATH_PREFIX = 'src/remediation/runbooks/';
const PROPOSAL_MARKER = '__proposalDerivedFrom';
const TELEGRAM_BLOCK_OPEN = '<!-- telegram-approval -->';
const TELEGRAM_BLOCK_CLOSE = '<!-- /telegram-approval -->';

/**
 * Detect whether any touched runbook source file is proposal-derived.
 * Convention: proposal-derived runbooks contain a top-level
 *   const __proposalDerivedFrom = '<proposalId>';
 * declaration that the SystemReviewer-driven `/instar-dev` path emits.
 */
export function findProposalDerivedRunbooks(repoRoot, changedFiles) {
  const proposalDerived = [];
  for (const rel of changedFiles) {
    if (!rel.startsWith(RUNBOOK_PATH_PREFIX)) continue;
    if (!rel.endsWith('.ts') && !rel.endsWith('.js')) continue;
    const abs = path.join(repoRoot, rel);
    let content;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      // Deleted file or unreadable — skip.
      continue;
    }
    // Look for the const declaration, tolerating quoting variants.
    const re = new RegExp(`(?:const|let|var)\\s+${PROPOSAL_MARKER}\\s*=\\s*['"\`]([^'"\`]+)['"\`]`);
    const m = content.match(re);
    if (m) proposalDerived.push({ file: rel, proposalId: m[1] });
  }
  return proposalDerived;
}

/**
 * Extract the Telegram approval block from a PR body. Returns the parsed
 * fields plus the canonical-form payload-to-verify (everything except the
 * signature line, in declaration order).
 */
export function parseTelegramApprovalBlock(prBody) {
  if (typeof prBody !== 'string') return null;
  const openIdx = prBody.indexOf(TELEGRAM_BLOCK_OPEN);
  const closeIdx = prBody.indexOf(TELEGRAM_BLOCK_CLOSE);
  if (openIdx === -1 || closeIdx === -1 || closeIdx < openIdx) return null;

  const inner = prBody
    .slice(openIdx + TELEGRAM_BLOCK_OPEN.length, closeIdx)
    .trim();

  const fields = {};
  const lines = inner.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim();
    fields[key] = val;
  }

  const required = ['proposalId', 'action', 'userId', 'messageId', 'signedAt', 'signature'];
  for (const k of required) {
    if (!fields[k]) return null;
  }

  // Canonical payload: every declared field except `signature`, joined as
  // `key=value\n` in fixed order. The signing side MUST produce the same
  // canonical string.
  const order = ['proposalId', 'runbookId', 'action', 'userId', 'messageId', 'signedAt'];
  const canonicalLines = [];
  for (const k of order) {
    if (fields[k] !== undefined) canonicalLines.push(`${k}=${fields[k]}`);
  }
  const canonical = canonicalLines.join('\n');

  return { fields, canonical };
}

/**
 * Verify an Ed25519 signature over the canonical payload against the
 * pinned principal pubkey PEM. Returns true if valid.
 */
export function verifyTelegramSignature(canonical, signatureB64, pubkeyPem) {
  if (!pubkeyPem || !pubkeyPem.includes('BEGIN PUBLIC KEY')) return false;
  let pubKey;
  try {
    pubKey = crypto.createPublicKey(pubkeyPem);
  } catch {
    return false;
  }
  let sig;
  try {
    sig = Buffer.from(signatureB64, 'base64');
  } catch {
    return false;
  }
  try {
    return crypto.verify(null, Buffer.from(canonical, 'utf8'), pubKey, sig);
  } catch {
    return false;
  }
}

/**
 * Load the GPG approver keyring from the file at keyringPath. Returns
 * `{ fingerprints: string[] }` — the set of accepted long-form GPG
 * fingerprints. Comments (lines starting with `#`) and blank lines are
 * ignored; the file may also contain ASCII-armored key blocks, in which
 * case the workflow imports them into GNUPGHOME and resolves their
 * fingerprints out-of-band. This script accepts an optional sidecar
 * format `fingerprint: <40-hex>` per line for offline tests.
 */
export function loadApproverFingerprints(keyringPath) {
  if (!fs.existsSync(keyringPath)) return [];
  const raw = fs.readFileSync(keyringPath, 'utf8');
  const fps = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = t.match(/^fingerprint:\s*([0-9A-Fa-f]{40})$/);
    if (m) fps.push(m[1].toUpperCase());
  }
  return fps;
}

/**
 * Main entry. Returns `{ ok: true }` for a passing PR, or
 * `{ ok: false, reason }` with a diagnostic string for a blocked PR.
 */
export function verifyRunbookPrSignature(input) {
  const {
    repoRoot,
    changedFiles = [],
    prBody = '',
    headCommitInfo = null,
    keyringPath,
    telegramPubkeyPath,
    watermarkStore = null,
  } = input;

  // Step 1 — scope check. Any runbook changes at all?
  const runbookChanges = changedFiles.filter((f) => f.startsWith(RUNBOOK_PATH_PREFIX));
  if (runbookChanges.length === 0) {
    return { ok: true, reason: 'no-runbook-changes' };
  }

  // Step 2 — proposal-derived?
  const derived = findProposalDerivedRunbooks(repoRoot, changedFiles);
  if (derived.length === 0) {
    return { ok: true, reason: 'non-proposal-derived' };
  }
  const proposalIds = new Set(derived.map((d) => d.proposalId));

  // Step 3 — try Telegram countersignature path (A22 option 2 + A41).
  const block = parseTelegramApprovalBlock(prBody);
  if (block) {
    const { fields, canonical } = block;
    // Bind to one of the proposal-derived runbook IDs in this PR.
    if (!proposalIds.has(fields.proposalId)) {
      return {
        ok: false,
        reason: `telegram-block-proposal-id-mismatch (got ${fields.proposalId}, expected one of ${[...proposalIds].join(',')})`,
      };
    }
    // Action must be `approved` (or `approve`).
    if (fields.action !== 'approved' && fields.action !== 'approve') {
      return { ok: false, reason: `telegram-block-action-not-approved (got ${fields.action})` };
    }
    // Watermark check — replay of (proposalId, messageId) is rejected (A41).
    if (watermarkStore) {
      const key = `${fields.proposalId}:${fields.messageId}`;
      if (watermarkStore.has(key)) {
        return { ok: false, reason: `telegram-block-replay (proposalId=${fields.proposalId} messageId=${fields.messageId})` };
      }
    }
    // Load pubkey + verify Ed25519 sig over canonical payload.
    const pubPath = telegramPubkeyPath || path.join(repoRoot, '.github/keyrings/telegram-principal-pub.pem');
    let pem = '';
    try {
      pem = fs.readFileSync(pubPath, 'utf8');
    } catch {
      pem = '';
    }
    if (!pem.includes('BEGIN PUBLIC KEY')) {
      return { ok: false, reason: 'telegram-principal-pubkey-missing' };
    }
    const sigOk = verifyTelegramSignature(canonical, fields.signature, pem);
    if (!sigOk) {
      return { ok: false, reason: 'telegram-signature-invalid' };
    }
    // Mark watermark consumed.
    if (watermarkStore) {
      watermarkStore.add(`${fields.proposalId}:${fields.messageId}`);
    }
    return { ok: true, reason: 'telegram-countersigned', proposalId: fields.proposalId };
  }

  // Step 4 — try GPG-signed commit path (A22 option 1).
  if (headCommitInfo && headCommitInfo.gpgGoodsig && headCommitInfo.gpgFingerprint) {
    const kPath = keyringPath || path.join(repoRoot, '.github/keyrings/runbook-approvers.gpg');
    const approvers = loadApproverFingerprints(kPath);
    const fp = String(headCommitInfo.gpgFingerprint || '').toUpperCase();
    if (!approvers.includes(fp)) {
      return { ok: false, reason: `gpg-fingerprint-not-in-approver-keyring (fp=${fp})` };
    }
    // Different-principal check (A32 extension): if any derived runbook
    // declares a producingAgentId via a sibling JSON or const, the commit
    // author email must not match. For Tier-2 the agent identity is
    // declared as `__producingAgentId` in the runbook source.
    const conflict = findAgentEmailConflict(repoRoot, derived, headCommitInfo.authorEmail || '');
    if (conflict) {
      return { ok: false, reason: `different-principal-violation (${conflict})` };
    }
    return { ok: true, reason: 'gpg-signed-by-approver', proposalIds: [...proposalIds] };
  }

  return {
    ok: false,
    reason: 'no-valid-approval (need GPG-signed commit by approver OR Telegram countersignature block)',
  };
}

/**
 * If the runbook source declares a `__producingAgentId` const (set by the
 * proposal pipeline), and the commit author email matches that agent's
 * declared identity, refuse.
 */
function findAgentEmailConflict(repoRoot, derived, authorEmail) {
  const ae = authorEmail.toLowerCase();
  if (!ae) return null;
  for (const { file } of derived) {
    let content;
    try {
      content = fs.readFileSync(path.join(repoRoot, file), 'utf8');
    } catch {
      continue;
    }
    const m = content.match(/__producingAgentEmail\s*=\s*['"`]([^'"`]+)['"`]/);
    if (m && m[1].toLowerCase() === ae) {
      return `commit author ${authorEmail} matches __producingAgentEmail in ${file}`;
    }
  }
  return null;
}

// ─── CLI entry ──────────────────────────────────────────────────────────

function fromGithubEnv() {
  // Used by the workflow: read everything from GITHUB_* env + a JSON
  // payload file passed as argv[2].
  const repoRoot = process.cwd();
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) {
    throw new Error('GITHUB_EVENT_PATH not set or missing');
  }
  const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  const pr = event.pull_request || {};
  const prBody = pr.body || '';
  // Changed files come from the workflow step that runs
  // `git diff --name-only base..head` and writes them line-by-line.
  const changedFilesPath = process.env.CHANGED_FILES_PATH;
  let changedFiles = [];
  if (changedFilesPath && fs.existsSync(changedFilesPath)) {
    changedFiles = fs
      .readFileSync(changedFilesPath, 'utf8')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const headCommitInfoPath = process.env.HEAD_COMMIT_INFO_PATH;
  let headCommitInfo = null;
  if (headCommitInfoPath && fs.existsSync(headCommitInfoPath)) {
    try {
      headCommitInfo = JSON.parse(fs.readFileSync(headCommitInfoPath, 'utf8'));
    } catch {
      headCommitInfo = null;
    }
  }
  return { repoRoot, prBody, changedFiles, headCommitInfo };
}

// Only run as CLI when invoked directly (not when imported by tests).
const isMain = (() => {
  try {
    const mainArg = process.argv[1] ? path.resolve(process.argv[1]) : '';
    return mainArg && (mainArg.endsWith('verify-runbook-pr-signature.js') || mainArg.endsWith('verify-runbook-pr-signature.mjs'));
  } catch {
    return false;
  }
})();

if (isMain) {
  try {
    const { repoRoot, prBody, changedFiles, headCommitInfo } = fromGithubEnv();
    const result = verifyRunbookPrSignature({
      repoRoot,
      prBody,
      changedFiles,
      headCommitInfo,
    });
    if (result.ok) {
      console.log(`[runbook-pr-gate] PASS: ${result.reason}`);
      process.exit(0);
    } else {
      console.error(`[runbook-pr-gate] BLOCK: ${result.reason}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`[runbook-pr-gate] ERROR: ${err.message}`);
    process.exit(1);
  }
}
