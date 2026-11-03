# Convergence Report — The console becomes the dashboard's front door, and a waiting phone's code gets its own page

## Cross-model review: codex-cli:gpt-6-astra

The external pass ran in all five rounds through the Codex CLI (gpt-6-astra) via `skills/spec-converge/scripts/cross-model-review.mjs`. Rounds 3 to 5 also had the page's source (`dashboard-pair/pair.js`) and the route module inlined, so their findings were about the code as well as the spec. Verdicts: minor, minor, serious, serious, minor.

## ELI10 Overview

Justin decided on 3 November that the new console should be what opens when you go to the dashboard, with the old one still reachable. He also wanted one direct link to a waiting phone's pairing code: type the PIN, see the code large, and tap Copy.

Now a plain `/dashboard` opens the console, and anything with a `?` (every older link to a particular tab) opens the old dashboard at `/dashboard/legacy`. A small separate page, `/dashboard/pair`, shows the code. It asks for the PIN on every visit and stores nothing. It wipes the code when the unlock runs out, and it runs under the strictest browser security rules the server has. The agent and the iPhone app both get the page's address from the pairing answers.

## Original vs Converged

- **Links that should open the new pages now do.** The pinned Telegram dashboard message's Sessions and Files links, and the hint for long pasted messages, now open console pages; originally they would have dropped people in the old dashboard. The installer's last line now names the code page instead of "open the dashboard and find Phones".
- **Security headers hold on every spelling.** The page sets all four dashboard headers itself (Express answers `/Dashboard/PAIR` too, and the header middleware only matched lowercase). That middleware now matches case-insensitively, which also closed an existing framing gap on a capitalised legacy address.
- **One address for the legacy page.** `/dashboard/legacy/` redirects to `/dashboard/legacy`, so relative links on it always resolve.
- **The code cannot outlive the unlock.** Originally codes were cleared only on a 403. Now one reset runs on any 403 from any call, at the session deadline (measured on the server's clock, with a margin), when a hidden page comes back after it, and before Copy, decline or remove. Answers from a reset session are dropped.
- **Nothing can wedge the page.** Every call reads its headers and body under one 15-second limit and one cancellation. The paired-phones list is a separate read, so it never holds a code back. A declined phone leaves at once. The PIN screen's own two calls are bounded too.
- **Clock skew.** A phone clock that is off no longer locks the page or keeps a code past the server's deadline.
- **Wording and precision.** The spec says where `approval` comes from; the rollback section says code-page links already handed out stop working; "any query string" became "a non-empty query string"; the expiry tolerance is stated.

## Iteration Summary

| Round | Reviewers | Design findings | Changes |
|---|---|---|---|
| 1 | internal (security, adversarial, integration, decision, migration) + codex | 1 blocker + 4 | install text; Telegram quick links and Drop Zone hint; four headers in the handlers; variant-test wording; migration ordering; session-expiry wipe; where `approval` comes from |
| 2 | internal (code + spec) + codex | 3 | phone clock skew; Copy deadline; legacy trailing slash; header middleware case; polling restart; "show every phone" without a reload; package-completeness guard |
| 3 | codex (with source) | 2 | one 403 rule for every call; the code renders before the paired-phones list; timeouts; cancellation on reset |
| 4 | codex (with source) | 1 | body read inside the time limit; refresh tied to its unlock |
| 5 | codex (with source) | 2 (small) | independent paired-phones read; declined phone stays gone; bounded unlock-check and unlock; "non-empty query" wording |

Internal reviewer model: claude-opus-5-5 subagents (rounds 1 and 2).

## Proportion

Tier 2, a spec of about 200 lines. Five of six rounds were used. That is a lot of review for a redirect and a small page. Rounds 3 to 5 reviewed the page's code directly and each found a narrower robustness gap in the same request lifecycle (time limits, cancellation, stale answers). Each was a real, testable defect, so each was fixed with a test. The findings shrank in size round by round.

## Left behind

- Round 5's two findings were fixed and tested, but not re-reviewed, at the orchestrator's direction (no round 6; cut to the smallest version that ships if rounds kept finding design problems). They were small hardening changes inside the same request wrapper, covered by new unit tests (independent paired-phones read, a declined phone staying gone, slow unlock and unlock-check).
- `GET /mobile/device` (the phone's own status read) does not carry `codePageUrl`, so an app that relaunches mid-pairing cannot get the link again from it. It is not needed for the flow the operator asked for; the app keeps the value from its redeem answer.

## Full Findings Catalog

Raw outputs: `astra-r1..r5.json` in the session scratchpad, and the two internal reviewer reports (round 1: 1 blocker, 3 design, 4 minor; round 2: 0 blockers, 2 design, 6 minor). Every finding was applied, apart from the one "left behind" item above.

## Convergence verdict

Converged at round 5 under the cap rule. No safety, security or data-loss finding remains open. The last round's verdict was MINOR ISSUES, and its two small design items were fixed with tests.
