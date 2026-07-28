#!/usr/bin/env node
/**
 * check-spec-review-link.mjs — backstop for the spec-review ELI16-tunnel-link
 * requirement.
 *
 * The sanctioned path (skills/spec-converge/scripts/publish-spec-review.mjs)
 * guarantees a verified ELI16 tunnel link. This is the belt-and-suspenders:
 * if a spec-review message is sent by hand WITHOUT going through that script,
 * this detects "looks like a spec for review, but no rendered link" and warns,
 * so the inconsistency can't slip through silently.
 *
 * Warn-only by design (signal, not a hard block) — it never eats the message;
 * it reminds. Invoked from the outbound messaging gate (convergence-check.sh).
 *
 * Reads the candidate message on stdin. Exits 0 always; prints a one-line
 * reminder to stderr when the message looks like an un-linked spec review.
 */

/**
 * True when the text looks like a SPEC delivered for review but carries no
 * rendered (tunnel /view) link the operator can actually open. Pure — testable.
 *
 * Deliberately NARROW (this blocks the send, so false-positives are costly):
 * it fires only when a spec is unambiguously being handed over for review —
 * a `docs/specs/*.md` reference, or a GitHub PR mentioned together with the
 * word "spec" — in an explicit review/approval handoff, with no `/view/` link.
 * An ordinary code-PR mention ("review PR #500", "merging #670, CI green")
 * does NOT fire.
 */
export function messageLacksReviewLink(text) {
  if (!text) return false;
  const refsSpecFile = /docs\/specs\/[^\s)]+\.md/i.test(text);
  const refsPr = /github\.com\/[^\s)]+\/pull\/\d+/i.test(text);
  const mentionsSpec = /\bspec(s|ification)?\b/i.test(text);
  // Is a SPEC being handed over? (a spec file, or a PR explicitly about a spec)
  const isSpecHandoff = refsSpecFile || (refsPr && mentionsSpec);
  if (!isSpecHandoff) return false;
  // ...in an explicit review/approval handoff...
  const reviewHandoff = /\b(review|approv\w*|sign[- ]?off|take a look|for your|ready for)\b/i.test(text);
  if (!reviewHandoff) return false;
  // ...but there is no rendered view link to read it.
  const hasViewLink = /\/view\/[0-9a-f-]{8,}/i.test(text);
  return !hasViewLink;
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  readStdin().then(text => {
    if (messageLacksReviewLink(text)) {
      process.stderr.write(
        '[spec-review-link] This looks like a spec handed over for review but has no rendered ELI16 tunnel link. ' +
          'Deliver it via skills/spec-converge/scripts/publish-spec-review.mjs so the link is rendered + verified before it sends.\n',
      );
      process.exit(1);
    }
    process.exit(0);
  });
}
