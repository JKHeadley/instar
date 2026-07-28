#!/usr/bin/env node
/**
 * stall-matrix-live-check.mjs — the deterministic non-hermetic checker for the
 * framework stall-coverage matrices (spec: framework-stall-coverage-matrix
 * §3.5 item 2b; Frontloaded Decisions 17, 19, 21).
 *
 * Driven by the `stall-matrix-live-check` job (weekly, tier-1 supervised,
 * enabled:false on the fleet — ON for the development agent). This script owns
 * 100% of the matrix parsing, loopback HTTP, dedup-keyed issue filing,
 * aggregation, and delivery — nothing is entrusted to an LLM prompt.
 *
 * What it checks over ALL matrices in docs/frameworks/ (the recurring live
 * checkpoint for the seed matrices, which never traverse an onboarding
 * transition):
 *   - closePath LIVENESS: a declared-gap / covered-dark row's closePath must
 *     resolve to an OPEN commitment (status pending|verified|violated,
 *     unexpired) or an open evolution action. 404/terminal = DEAD ref — a
 *     delivered commitment is a closed anchor, i.e. no anchor (§2.2).
 *   - guardKey/posture cross-check via GET /guards: covered ⇒ live;
 *     covered-dark ⇒ dark/dry-run NOT missing; `exempt:<id>` ⇒ vacuous.
 *   - the 45-day unreviewed-aging WARNING rung (§2.1 — the 60-day red is the
 *     hermetic CI ratchet's job, not this one's).
 *   - the §2.1 MINT flow for `pending-mint` rows: one idempotent
 *     framework-issue per seeded row (dedupKey
 *     `stallclass::<class>::<framework>::unreviewed`) + ONE aggregated open
 *     commitment per mint pass. The `pending-mint` → real-ref REWRITE is an
 *     ordinary PR — this script NEVER edits source (SourceTreeGuard posture).
 *
 * Offline tolerance: the server health probe runs FIRST; unreachable ⇒ a clear
 * 'ledger-unreachable' message and exit 2 with NO partial mints.
 *
 * Refusal hygiene (Decision 16): findings name class id + rule + the clamped
 * ref only — free-text matrix content is never echoed into payloads.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';

const MATRIX_SUFFIX = '-stall-coverage.md';
const FETCH_TIMEOUT_MS = 10_000;
const AGING_WARN_DAYS = 45;
const LIVE_STATES = new Set(['on-confirmed', 'on-unverified', 'on-stale']);
const REF_CLAMP = /^[A-Za-z0-9:_-]{1,64}$/;

function readAgentConfig(stateDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf-8'));
  } catch {
    return {};
  }
}

function resolveAuth(config) {
  // config.json may hold a secret-ref object instead of the literal token —
  // the env var is the sanctioned fallback for scripts.
  const fromConfig = typeof config.authToken === 'string' ? config.authToken : null;
  return fromConfig || process.env.INSTAR_AUTH_TOKEN || null;
}

async function loopback(base, auth, method, route, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}${route}`, {
      method,
      headers: {
        ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    let parsed = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    return { ok: res.ok, status: res.status, body: parsed };
  } catch {
    return { ok: false, status: 0, body: null };
  } finally {
    clearTimeout(timer);
  }
}

export function parseMatrixRows(text) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!fm) return [];
  let doc;
  try {
    doc = yaml.load(fm[1], { schema: yaml.JSON_SCHEMA });
  } catch {
    return [];
  }
  const rows = doc && Array.isArray(doc['stall-coverage']) ? doc['stall-coverage'] : [];
  return rows.filter((r) => r && typeof r === 'object' && !Array.isArray(r)).slice(0, 64);
}

export function commitmentIsOpen(c) {
  if (!c || typeof c !== 'object') return false;
  if (c.status !== 'pending' && c.status !== 'verified' && c.status !== 'violated') return false;
  if (typeof c.expiresAt === 'string' && c.expiresAt < new Date().toISOString()) return false;
  return true;
}

export function ageDays(seededAt, now = new Date()) {
  if (typeof seededAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(seededAt)) return null;
  return (Date.parse(now.toISOString().slice(0, 10)) - Date.parse(seededAt)) / 86_400_000;
}

async function main() {
  const repoRoot = process.cwd();
  const frameworksDir = path.join(repoRoot, 'docs', 'frameworks');
  if (!fs.existsSync(frameworksDir)) {
    console.log('stall-matrix-live-check: no docs/frameworks tree present — nothing to check (silent no-op).');
    return;
  }

  const stateDir = process.env.INSTAR_STATE_DIR || '.instar';
  const config = readAgentConfig(stateDir);
  const port = Number.isFinite(config.port) ? config.port : 4042;
  const auth = resolveAuth(config);
  const base = `http://127.0.0.1:${port}`;

  // ── Offline tolerance: health FIRST; unreachable ⇒ no partial mints. ──
  const health = await loopback(base, null, 'GET', '/health');
  if (health.status === 0) {
    console.error('stall-matrix-live-check: ledger-unreachable — the local server is not answering; no checks ran, no partial mints. Retry when the server is up.');
    process.exit(2);
  }

  // ONE /guards read feeds every matrix's posture cross-check.
  const guardsRes = await loopback(base, auth, 'GET', '/guards');
  const effectiveByKey = new Map();
  let guardsAvailable = false;
  if (guardsRes.ok && guardsRes.body && Array.isArray(guardsRes.body.guards)) {
    guardsAvailable = true;
    for (const g of guardsRes.body.guards) {
      if (typeof g.key === 'string' && typeof g.effective === 'string') effectiveByKey.set(g.key, g.effective);
    }
  }

  const findings = []; // { framework, classId, rule, ref? }
  const warnings = [];
  const mints = []; // { framework, classId, dedupKey }
  let evolutionActions;

  const files = fs.readdirSync(frameworksDir).filter((f) => f.endsWith(MATRIX_SUFFIX)).sort();
  for (const file of files) {
    const framework = file.slice(0, -MATRIX_SUFFIX.length);
    let text;
    try {
      text = fs.readFileSync(path.join(frameworksDir, file), 'utf-8');
    } catch {
      continue;
    }
    const rows = parseMatrixRows(text);
    for (const row of rows) {
      const classId = typeof row.class === 'string' ? row.class : null;
      if (!classId) continue;
      const status = row.status;
      const closePath = typeof row.closePath === 'string' ? row.closePath : '';

      // ── guardKey / posture cross-check (covered + covered-dark) ──
      if ((status === 'covered' || status === 'covered-dark') && typeof row.guardKey === 'string') {
        if (row.guardKey.startsWith('exempt:')) {
          // vacuous-with-reason — recorded, never a finding.
        } else if (!guardsAvailable) {
          warnings.push(`${framework} class '${classId}': guards inventory unavailable — posture unverified this pass`);
        } else {
          const effective = effectiveByKey.get(row.guardKey) ?? null;
          if (effective === null || effective === 'missing') {
            findings.push({ framework, classId, rule: 'guard-missing-from-inventory' });
          } else if (status === 'covered' && !LIVE_STATES.has(effective)) {
            findings.push({ framework, classId, rule: 'posture-contradicts-inventory' });
          }
        }
      }

      // ── 45-day unreviewed-aging warning rung (§2.1/Decision 19) ──
      const reason = typeof row.reason === 'string' ? row.reason : '';
      if (reason.includes('unreviewed')) {
        const days = ageDays(row.seededAt);
        if (days !== null && days >= AGING_WARN_DAYS) {
          findings.push({ framework, classId, rule: 'unreviewed-aging-45d' });
        }
      }

      // ── pending-mint flow (§2.1) — idempotent by dedupKey ──
      if (closePath === 'pending-mint') {
        mints.push({
          framework,
          classId,
          dedupKey: `stallclass::${classId}::${framework}::unreviewed`,
        });
        continue; // a pending-mint row has no real ref to liveness-check yet
      }

      // ── closePath liveness (declared-gap + covered-dark) ──
      if ((status === 'declared-gap' || status === 'covered-dark') && closePath) {
        if (!REF_CLAMP.test(closePath)) {
          findings.push({ framework, classId, rule: 'closepath-charset-invalid' });
          continue;
        }
        if (/^CMT-/i.test(closePath)) {
          const res = await loopback(base, auth, 'GET', `/commitments/${encodeURIComponent(closePath)}`);
          if (!res.ok && res.status !== 404) {
            // Transport failure OR any non-404 HTTP error (500/401/…) — the
            // ledger could not answer. Retryable, NEVER classified dead-ref.
            console.error(`stall-matrix-live-check: ledger-unreachable mid-pass (HTTP ${res.status || 'transport'}) — stopping without partial delivery.`);
            process.exit(2);
          }
          if (res.status === 404 || !commitmentIsOpen(res.body)) {
            findings.push({ framework, classId, rule: 'closepath-dead-ref', ref: closePath });
          }
        } else if (/^ACT-/i.test(closePath)) {
          if (evolutionActions === undefined) {
            const res = await loopback(base, auth, 'GET', '/evolution/actions');
            if (!res.ok) {
              // Dead-for-ACT means a SUCCESSFUL list lacking the id — any
              // failure here is retryable ledger-unreachable, not evidence.
              console.error(`stall-matrix-live-check: ledger-unreachable mid-pass (HTTP ${res.status || 'transport'}) — stopping without partial delivery.`);
              process.exit(2);
            }
            evolutionActions = Array.isArray(res.body) ? res.body : (res.body && Array.isArray(res.body.actions) ? res.body.actions : []);
          }
          const open = evolutionActions.some(
            (a) => a && a.id === closePath && (a.status === 'pending' || a.status === 'in_progress'),
          );
          if (!open) findings.push({ framework, classId, rule: 'closepath-dead-ref', ref: closePath });
        } else {
          findings.push({ framework, classId, rule: 'closepath-unresolvable-ref', ref: closePath });
        }
      }
    }
  }

  // ── Mint pass: one framework-issue per seeded row + ONE aggregated commitment ──
  let minted = 0;
  for (const m of mints) {
    const res = await loopback(base, auth, 'POST', '/framework-issues/observe', {
      framework: m.framework,
      bucket: 'instar-integration-gap',
      severity: 'medium',
      title: `stall-class '${m.classId}' auto-seeded declared-gap (unreviewed) for ${m.framework}`,
      dedupKey: m.dedupKey,
      evidence: `docs/frameworks/${m.framework}${MATRIX_SUFFIX} (pending-mint row)`,
    });
    if (res.ok) minted++;
    else warnings.push(`mint failed for ${m.dedupKey} (HTTP ${res.status})`);
  }
  if (mints.length > 0) {
    const classes = [...new Set(mints.map((m) => `${m.framework}:${m.classId}`))];
    const commitRes = await loopback(base, auth, 'POST', '/commitments', {
      userRequest: `Review the auto-seeded stall-class rows (${classes.slice(0, 20).join(', ')}${classes.length > 20 ? ', …' : ''}) and rewrite their pending-mint closePaths to the real refs via an ordinary PR.`,
      agentResponse: 'stall-matrix-live-check filed the idempotent framework-issues for every pending-mint row; the ref rewrite is owed within the job cadence (spec §2.1).',
      type: 'follow-up',
    });
    if (!commitRes.ok) warnings.push(`aggregated mint commitment failed (HTTP ${commitRes.status})`);
  }

  // ── ONE aggregated attention item on failures (never one per row) ──
  if (findings.length > 0) {
    const lines = findings
      .slice(0, 30)
      .map((f) => `- ${f.framework} class '${f.classId}' — ${f.rule}${f.ref ? ` (${f.ref})` : ''}`);
    // Dedup: attention items are id-keyed (an existing id is returned, never
    // re-posted) — one item per distinct flagged SET; an unchanged re-run of
    // the same findings can never repeat the item.
    const findingsSetHash = createHash('sha256')
      .update(JSON.stringify(findings.map((f) => `${f.framework}:${f.classId}:${f.rule}:${f.ref ?? ''}`).sort()))
      .digest('hex');
    await loopback(base, auth, 'POST', '/attention', {
      id: `stall-live-check-${findingsSetHash.slice(0, 24)}`,
      title: `Stall-coverage live check: ${findings.length} finding(s) across ${files.length} matrices`,
      body:
        'The weekly non-hermetic stall-coverage validation found rows whose live state contradicts the matrix (dead closePath refs, guard-posture contradictions, 45-day unreviewed aging):\n' +
        lines.join('\n') +
        (findings.length > 30 ? `\n…and ${findings.length - 30} more` : '') +
        '\nSpec: docs/specs/framework-stall-coverage-matrix.md §2.2/§3.5.',
      priority: 'medium',
      source: 'stall-matrix-live-check',
    });
  }

  console.log(
    `stall-matrix-live-check: matrices=${files.length} findings=${findings.length} mints=${minted}/${mints.length} warnings=${warnings.length}`,
  );
  for (const w of warnings) console.log(`stall-matrix-live-check: warning — ${w}`);
}

const isDirect = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isDirect) {
  main().catch((err) => {
    console.error(`stall-matrix-live-check: fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  });
}
