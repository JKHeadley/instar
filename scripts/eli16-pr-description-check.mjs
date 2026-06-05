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
 * CLI wrapper that reads PR_BODY / PR_TITLE / PR_AUTHOR_TYPE from env (set by the
 * workflow) and exits 0 when an ELI16 overview is present (or the PR is exempt),
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

// ── CLI (used by .github/workflows/eli16-pr-gate.yml) ─────────────────
const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  const res = checkPrDescriptionEli16({
    body: process.env.PR_BODY,
    title: process.env.PR_TITLE,
    authorType: process.env.PR_AUTHOR_TYPE,
  });
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
