# claude.com in the link-safety allowlist

<!-- bump: patch -->

## What Changed

The pre-messaging convergence check's `url_provenance` allowlist now trusts
`claude.com` alongside the already-listed `claude.ai`, `anthropic.com`, and
`docs.anthropic.com`. The same domain was added to both copies that must agree:
the primary script (`src/templates/scripts/convergence-check.sh`) and the
can't-find-template fallback in `PostUpdateMigrator.getConvergenceCheckInline()`.
This stops the grounding-before-messaging hook from false-flagging Claude
subscription OAuth login links (which live on `claude.com`) as possibly-fabricated.

## Evidence

Found during live subscription enrollment (topic 20905): driving a fresh Claude
login produces a sign-in URL on `claude.com`, and delivering it tripped the
`URL_PROVENANCE` gate because `claude.com` was absent from the allowlist while its
sibling `claude.ai` was present.

Reproduction — pipe an outbound message containing a `claude.com` link through the
gate:
- **Before:** `echo 'Sign in: https://claude.com/oauth/authorize?code=abc' | bash
  .instar/scripts/convergence-check.sh` → exit 1, output contains `URL_PROVENANCE`
  (so the link had to be wrapped in a private view to be sent).
- **After:** same input → exit 0, no `URL_PROVENANCE` flag.

A sibling test still proves a genuinely fabricated domain (`fabricated-domain.xyz`)
is flagged, so only this one first-party domain was loosened. Locked in by a new
`convergence-check.test.ts` case.

## What to Tell Your User

When I send you a Claude sign-in link to enroll a subscription account, it now goes
to you directly. Before, my own link-safety check mistook the official claude.com
sign-in page for a possibly-made-up address and made me wrap it in a private page
first — that false alarm is gone.

## Summary of New Capabilities

- **claude.com is a trusted domain** in the pre-messaging link-safety check — Claude
  OAuth login links deliver directly instead of being flagged as unfamiliar.
- Existing agents get it automatically (the updater re-writes the deployed script
  from the template on every update); no separate migration.
