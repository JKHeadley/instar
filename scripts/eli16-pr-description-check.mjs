#!/usr/bin/env node
/**
 * ELI16-on-every-PR gate (team standard, 2026-06-05).
 *
 * Every PR's DESCRIPTION must carry a plain-English ELI16 overview — because the
 * PR description is what a reviewer reads and approves when they open the link.
 * The ELI16 *file* (docs/specs/<slug>.eli16.md) remains the durable companion;
 * this gate enforces that the OVERVIEW is also in the PR BODY so it is front and
 * centre at review time. (Justin, 2026-06-05: "when I click on the link, that's
 * what I'm going to see and read and approve.")
 *
 * Pure check — `checkPrDescriptionEli16({ body, title, authorType })` — plus a
 * CLI wrapper that judges the LIVE PR (re-read from the GitHub API via PR_NUMBER +
 * GITHUB_TOKEN; falls back to PR_BODY / PR_TITLE / PR_AUTHOR_TYPE from the event
 * payload only when that read fails — see resolvePrFields) and exits 0 when an ELI16 overview is present (or the PR is exempt),
 * 1 with actionable guidance when it is missing.
 */

/** Minimum plain-English content under the ELI16 heading — a real overview, not a one-liner. */
export const MIN_ELI16_DESCRIPTION_CHARS = 200;

/** A markdown heading (any level) whose text contains "ELI16" / "ELI-16" / "ELI 16". */
const ELI16_HEADING = /^[ \t]*#{1,6}[ \t]+.*ELI[ \t-]?16/im;

/**
 * @param {{ body?: string|null, title?: string|null, authorType?: string|null }} pr
 * @returns {{ ok: boolean, exempt?: string, reason?: string, chars?: number, min?: number }}
 */
export function checkPrDescriptionEli16(pr) {
  const title = String(pr?.title ?? '');
  // Exempt the genuinely-automated PRs: bot authors + the release-cut commit.
  if (String(pr?.authorType ?? '') === 'Bot') return { ok: true, exempt: 'bot-author' };
  if (/^chore:\s*release\b/i.test(title)) return { ok: true, exempt: 'release-cut' };

  const body = String(pr?.body ?? '');
  const m = ELI16_HEADING.exec(body);
  if (!m) return { ok: false, reason: 'no-eli16-heading' };

  // Content under the ELI16 heading, up to the next heading.
  const after = body.slice(m.index + m[0].length);
  const section = after.split(/\n[ \t]*#{1,6}[ \t]/)[0];
  const content = section.replace(/<!--[\s\S]*?-->/g, '').trim();
  if (content.length < MIN_ELI16_DESCRIPTION_CHARS) {
    return { ok: false, reason: 'eli16-too-short', chars: content.length, min: MIN_ELI16_DESCRIPTION_CHARS };
  }
  return { ok: true };
}

/**
 * Resolve the PR fields to judge. The event payload is FROZEN at the moment the
 * run was triggered, so a re-run of an old run would re-judge an old body and
 * could produce a stale red after the description was fixed (PR #2059, LRN-035).
 * We therefore re-read the LIVE PR from the GitHub API and only fall back to the
 * payload values when that read is impossible or fails.
 *
 * @param {{ env?: Record<string, string|undefined>, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<{ pr: { body: string|null, title: string|null, authorType: string|null }, source: 'api'|'payload', fallbackReason?: string }>}
 */
export async function resolvePrFields(opts = {}) {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const payload = {
    body: env.PR_BODY ?? null,
    title: env.PR_TITLE ?? null,
    authorType: env.PR_AUTHOR_TYPE ?? null,
  };
  const repo = env.GITHUB_REPOSITORY;
  const number = env.PR_NUMBER;
  const token = env.GITHUB_TOKEN;
  // Only inside a GitHub Actions run: a local caller (e.g. `instar dev:preflight
  // --body <file>`) must judge the body it passed, even if its shell happens to
  // carry PR_NUMBER / GITHUB_REPOSITORY / GITHUB_TOKEN.
  if (env.GITHUB_ACTIONS !== 'true') {
    return { pr: payload, source: 'payload', fallbackReason: 'not-in-github-actions' };
  }
  if (!repo || !number || !/^\d+$/.test(String(number)) || typeof fetchImpl !== 'function') {
    return { pr: payload, source: 'payload', fallbackReason: 'missing-repo-number-or-fetch' };
  }
  const apiBase = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
  try {
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'instar-eli16-pr-gate' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetchImpl(`${apiBase}/repos/${repo}/pulls/${number}`, { headers });
    if (!res || !res.ok) {
      return { pr: payload, source: 'payload', fallbackReason: `http-${res?.status ?? 'none'}` };
    }
    const live = await res.json();
    if (!live || typeof live !== 'object' || typeof live.title !== 'string') {
      return { pr: payload, source: 'payload', fallbackReason: 'unexpected-response' };
    }
    return {
      pr: { body: live.body ?? '', title: live.title, authorType: live.user?.type ?? null },
      source: 'api',
    };
  } catch (err) {
    return { pr: payload, source: 'payload', fallbackReason: `fetch-error: ${err?.message ?? err}` };
  }
}

// ── CLI (used by .github/workflows/eli16-pr-gate.yml) ─────────────────
const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  const resolved = await resolvePrFields();
  console.log(
    `ELI16 gate: source=${resolved.source}` +
      (resolved.fallbackReason ? ` (live PR read unavailable: ${resolved.fallbackReason}; judging the event payload)` : ''),
  );
  const res = checkPrDescriptionEli16(resolved.pr);
  if (res.ok) {
    console.log(
      res.exempt
        ? `ELI16 gate: exempt (${res.exempt}).`
        : 'ELI16 gate: OK — the PR description includes an ELI16 overview.',
    );
    process.exit(0);
  }
  const detail =
    res.reason === 'eli16-too-short'
      ? ` (found an ELI16 heading but only ${res.chars} chars of content; need >= ${res.min}).`
      : '.';
  console.error(
    `ELI16 gate FAILED: this PR's description has no plain-English ELI16 overview${detail}\n\n` +
      `Team standard (2026-06-05): every PR description must include an "## ELI16 — <one line>" section ` +
      `that explains the change for a non-expert — because the PR description is what the reviewer reads ` +
      `and approves when they open the link. Add it to the PR body (copy from your ` +
      `docs/specs/<slug>.eli16.md companion). Edit the PR description and this check will re-run.`,
  );
  process.exit(1);
}
