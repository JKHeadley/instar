#!/usr/bin/env node
/**
 * duplicate-build-start-gate.js — the duplicate-build guard's build-START
 * structural teeth (docs/specs/duplicate-build-guard.md §3.4, FD3).
 *
 * A repo-local dev-lifecycle PreToolUse hook (NOT a fleet-shipped template —
 * Migration Parity does not apply, spec §5) wired in this repo's own
 * .claude/settings.json on Write|Edit|MultiEdit. It fires on the FIRST
 * mutating write to any tracked repo path EXCEPT the trace/log/state paths
 * themselves, and BLOCKS that first write (exit 2) when the recorded
 * duplicate-build verdict is `likely-duplicate`/`verify` and no disposition
 * has been recorded — gating the first *implementation tool call*, not
 * turn-exit, so first-turn implementation can't slip past a Stop-event hook.
 *
 * Speed contract: the hook must NOT run the full scan on every tool call.
 * Run-once semantics via a worktree-local marker
 * (.instar/dup-build-gate.marker.json): once a build's verdict has been
 * evaluated-and-allowed, every later call is a single existsSync + exit 0.
 * The full check runs AT MOST once per worktree (and only when the instar-dev
 * build-start step didn't already run it and write the stub).
 *
 * FAIL-OPEN (§3.4/FD5): a hook crash, an unresolvable spec, or a hard check
 * error NEVER blocks — on a hard check error the hook writes the
 * `check-errored` auto-stub ({verdict:"check-errored", cause:"check-error",
 * decision:"proceed", reason:"auto: check errored (fail-open)"}) so the build
 * proceeds AND the precommit presence-backstop still finds the field.
 *
 * Disposition schema (§3.4 — so the gate is not a checkbox):
 *   { verdict, cause, decision: "proceed"|"abandon", reason, acknowledgedEvidenceIds[] }
 * A likely-duplicate proceed REQUIRES a non-empty reason AND ≥1
 * acknowledgedEvidenceId naming a concrete evidence entry.
 *
 * Off-switch: INSTAR_DUP_BUILD_CHECK=off (mirrors INSTAR_PRE_PUSH_SKIP).
 *
 * Exit codes (Claude Code PreToolUse contract):
 *   0 — allow the tool call
 *   2 — BLOCK the tool call (stderr is shown to the model)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
// The hook lives at <repo>/.claude/hooks/ — the repo root is two dirs up.
const HOOK_ROOT = path.resolve(path.dirname(__filename), '..', '..');

const MARKER_REL = path.join('.instar', 'dup-build-gate.marker.json');
const STUB_REL = path.join('.instar', 'dup-build-check.json');

// Paths whose writes never trigger the gate: the guard's own state, traces,
// logs, scratch — plus anything outside the repo. (Spec §3.4: "EXCEPT the
// trace/log/state paths themselves".)
const EXCLUDED_PREFIXES = [
  '.instar/', 'logs/', 'node_modules/', '.git/', 'scratchpad/', 'dist/',
];

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function isOff(env) {
  const v = String(env.INSTAR_DUP_BUILD_CHECK ?? '').toLowerCase();
  return v === 'off' || v === '0' || v === 'false';
}

function readJson(p) {
  try {
    const o = JSON.parse(fs.readFileSync(p, 'utf8'));
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}

function writeMarker(root, info) {
  try {
    fs.mkdirSync(path.join(root, '.instar'), { recursive: true });
    fs.writeFileSync(
      path.join(root, MARKER_REL),
      JSON.stringify({ allowedAt: new Date().toISOString(), ...info }, null, 2) + '\n',
    );
  } catch { /* marker is best-effort — worst case the stub is re-read next call */ }
}

function block(lines) {
  process.stderr.write(lines.join('\n') + '\n');
  process.exit(2);
}

async function main() {
  const env = process.env;
  if (isOff(env)) process.exit(0);

  const root = env.CLAUDE_PROJECT_DIR ? path.resolve(env.CLAUDE_PROJECT_DIR) : HOOK_ROOT;

  // ── HOT PATH: run-once marker → single existsSync + exit ──────────────────
  if (fs.existsSync(path.join(root, MARKER_REL))) process.exit(0);

  // Only the instar repo is in scope (the hook file ships in-tree, but a
  // stray CLAUDE_PROJECT_DIR must not arm the gate elsewhere).
  const pkg = readJson(path.join(root, 'package.json'));
  if (!pkg || pkg.name !== 'instar') process.exit(0);

  // ── Which file is being written? ───────────────────────────────────────────
  let input = null;
  try {
    input = JSON.parse(readStdin());
  } catch {
    process.exit(0); // unreadable hook input → fail-open
  }
  const filePath = input && input.tool_input && typeof input.tool_input.file_path === 'string'
    ? input.tool_input.file_path
    : null;
  if (!filePath) process.exit(0);
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(root, filePath);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) process.exit(0); // outside the repo
  const relNorm = rel.split(path.sep).join('/');
  if (EXCLUDED_PREFIXES.some((p) => relNorm.startsWith(p))) process.exit(0);

  // ── Read (or produce, once) the recorded verdict ───────────────────────────
  let lib = null;
  try {
    lib = await import(path.join(HOOK_ROOT, 'scripts', 'lib', 'duplicate-build-check.mjs'));
  } catch {
    // Library unimportable = hard check error → auto-stub + allow (§3.4).
    try {
      fs.mkdirSync(path.join(root, '.instar'), { recursive: true });
      fs.writeFileSync(path.join(root, STUB_REL), JSON.stringify({
        verdict: 'check-errored', cause: 'check-error', causes: ['check-error'],
        checkedAt: new Date().toISOString(),
        disposition: { decision: 'proceed', reason: 'auto: check errored (fail-open)', acknowledgedEvidenceIds: [], auto: true },
      }, null, 2) + '\n');
    } catch { /* ignore */ }
    writeMarker(root, { via: 'lib-unimportable' });
    process.exit(0);
  }

  let stub = lib.readStub(root);
  if (!stub || typeof stub.verdict !== 'string') {
    // No recorded verdict yet — the build-start step was skipped. Run the check
    // ONCE here (Structure > Willpower: the guard doesn't depend on the skill
    // prose having been followed). Only spec-driven builds are in scope: if no
    // spec is resolvable on this branch, this session isn't an instar-dev build
    // → allow + marker (the precommit spec-tag chain governs it anyway).
    const specPath = lib.resolveSpecForAdvisory(root);
    if (!specPath) {
      writeMarker(root, { via: 'no-spec-resolvable' });
      process.exit(0);
    }
    const record = lib.runDuplicateBuildCheck({ specPath, root, phase: 'build-start', env });
    stub = { ...record };
    if (record.verdict === 'check-errored') {
      stub.disposition = lib.checkErroredAutoStub().disposition;
    } else if (record.verdict === 'clear' || record.verdict === 'skipped') {
      stub.disposition = {
        decision: 'proceed', reason: `auto: verdict ${record.verdict}`,
        acknowledgedEvidenceIds: [], recordedAt: new Date().toISOString(), auto: true,
      };
    }
    try {
      lib.writeStub(root, stub);
    } catch { /* stub write best-effort; evaluation below still runs */ }
  }

  const v = stub.verdict;
  if (v === 'clear' || v === 'skipped' || v === 'check-errored') {
    writeMarker(root, { via: `verdict-${v}` });
    process.exit(0);
  }

  if (v === 'likely-duplicate' || v === 'verify') {
    const d = stub.disposition;
    const recordCmd =
      `node scripts/lib/duplicate-build-check.mjs --record-disposition --decision proceed ` +
      `--reason "<why this is not a duplicate>"` +
      (v === 'likely-duplicate' ? ` --ack <EV-id[,EV-id]>` : '');
    if (!d || (d.decision !== 'proceed' && d.decision !== 'abandon')) {
      const ev = (stub.evidence ?? []).slice(0, 5).map((e) => `  ${e.id} [${e.source}] ${e.detail}`);
      block([
        `duplicate-build gate: verdict is "${v}"${stub.cause ? ` (cause: ${stub.cause})` : ''} and no disposition is recorded — implementation writes are blocked until you decide proceed/abandon (docs/specs/duplicate-build-guard.md §3.4).`,
        ...(ev.length ? ['Evidence:', ...ev] : []),
        'Review the overlap, then record YOUR decision (you are the authority — the tool only records it):',
        `  ${recordCmd}`,
        'Or abandon this build if it IS a duplicate:',
        '  node scripts/lib/duplicate-build-check.mjs --record-disposition --decision abandon --reason "<duplicate of …>"',
      ]);
    }
    if (d.decision === 'abandon') {
      block([
        `duplicate-build gate: this build's recorded disposition is ABANDON (${d.reason ? `reason: ${String(d.reason).slice(0, 200)}` : 'no reason recorded'}).`,
        'Implementation writes stay blocked. If you decided to proceed after all, re-record:',
        `  ${recordCmd}`,
      ]);
    }
    if (v === 'likely-duplicate' && d.decision === 'proceed') {
      const reasonOk = typeof d.reason === 'string' && d.reason.trim().length > 0;
      const acks = Array.isArray(d.acknowledgedEvidenceIds)
        ? d.acknowledgedEvidenceIds.map((s) => String(s).trim()).filter(Boolean)
        : [];
      const evidenceIds = new Set((stub.evidence ?? []).map((e) => e.id));
      const ackOk = acks.length >= 1 && (evidenceIds.size === 0 || acks.some((a) => evidenceIds.has(a)));
      if (!reasonOk || !ackOk) {
        block([
          'duplicate-build gate: a likely-duplicate PROCEED requires a non-empty reason AND at least one acknowledgedEvidenceId naming the concrete overlap you judged non-duplicative (§3.4).',
          `Recorded: reason=${reasonOk ? 'ok' : 'MISSING'}, acknowledgedEvidenceIds=${acks.length ? acks.join(',') : 'MISSING'}`,
          'Re-record with:',
          `  ${recordCmd}`,
        ]);
      }
    }
    writeMarker(root, { via: `dispositioned-${v}-${d.decision}` });
    process.exit(0);
  }

  // Unknown verdict value → fail-open.
  writeMarker(root, { via: 'unknown-verdict' });
  process.exit(0);
}

main().catch(() => {
  // A hook crash NEVER blocks (§3.4).
  process.exit(0);
});
