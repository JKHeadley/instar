# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

- **An agent can no longer send you a Claude link.** A new `CLAUDE_LINK` check in the shipped pre-send gate (`src/templates/scripts/convergence-check.sh`) refuses any outbound message containing a `claude.ai` or `claude.com` URL. Those pages are private to whichever Claude account published them, so handing one to the operator asks them to sign in to an account they may not hold in order to read work their own agent produced. The message is returned to the agent with the reason, never dropped, and the agent is told to serve the content from agent-controlled ingress instead. `docs.anthropic.com` and `anthropic.com` are untouched.
- **A working Tailscale Funnel link is no longer refused.** `*.ts.net` joins `*.trycloudflare.com` in the `URL_PROVENANCE` trusted-host list. Both are agent-controlled ingress, not confabulated domains. Before this, an agent whose Cloudflare tunnel was down had no way to hand the operator a link at all: the one address that worked was rejected as an unfamiliar domain while the one the operator could not open was waved through, because `claude.ai` already sat in the trusted list.
- The `CLAUDE_LINK` pattern matches **with or without a scheme**, because chat clients auto-link a bare `claude.ai/code/artifact/abc` — the most likely real case, not an exotic one. A leading boundary class keeps look-alike hosts (`notclaude.ai`, `claude.ai.evil.com`) out, and an ordinary prose mention of the product ("I ran this on Claude Code") never matches.
- Both guards were applied by hand to one deployed agent and silently lost about 95 minutes later when `PostUpdateMigrator` re-deployed this template over them, which is always-overwrite by design. The operator's standing instruction simply stopped being enforced and nothing said so. Landing them in the template with a regression test is what makes them survive an update.

## What to Tell Your User

If I ever try to send you a Claude link, the message stops before it reaches you and I rewrite it to point somewhere you can actually open — you should never have to sign in to an account you may not even have just to read something I made for you. The trade is that I also can't quote a Claude address back at you if you send me one; I'll describe where it goes instead. Separately, links I serve from my own machine over Tailscale now go through normally, so if my usual tunnel is down I can still hand you something that works.

## Summary of New Capabilities

- `CLAUDE_LINK` check in the pre-send gate — refuses `claude.ai` / `claude.com` links in outbound messages.
- `*.ts.net` (Tailscale Funnel) trusted in `URL_PROVENANCE`, alongside the existing `*.trycloudflare.com`.

## Evidence

- `tests/unit/convergence-check-operator-reachable-links.test.ts`: 16 tests against the REAL shipped template. Covers both guards and, deliberately, both directions of each. Blocking side: artifact link, `claude.com`, `www.` prefix, scheme-less auto-linked form, bare host with no trailing slash, host with a query string. Non-blocking side: prose mention of the product, the two look-alike hosts, and Anthropic documentation links — the last is load-bearing for the over-block argument and was previously unpinned.
- Negative controls retained so the allowlist widening is shown not to have weakened the guard: a fabricated host and a look-alike suffix (`evil-notts.net`) must both still be refused.
- One test pins a **deliberate scope decision** rather than a behaviour: `randostranger.ts.net` passes, because the trust is suffix-wide and not limited to this agent's own tailnet. It is pinned so a later reader does not mistake the look-alike control for tighter coverage than exists. The narrower own-tailnet design, and why it was not taken, are recorded in the side-effects review.
- Breakage check: with the fix reverted, 5 of the original 9 cases fail — exactly the guard-covering ones. The 4 that still pass are guard-independent by design (bash syntax, the prose non-trigger, and the two negative controls). This was run rather than assumed, and the template was confirmed byte-identical after restoring.
- Second-pass review was required (outbound-messaging block/allow surface) and did **not** concur: it raised a severity-1 concern that the original signal-vs-authority argument rested on "the predicate is decidable", which is not the test the principle applies. Section 4 was rewritten onto scope (syntactic vs judgment) and asymmetric cost, three real under-blocks were fixed in code rather than documented away, and two divergent copies of this logic were added to the inventory. The full concern list and resolution table are in `upgrades/side-effects/convergence-check-operator-reachable-links.md`.
