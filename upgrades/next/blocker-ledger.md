# Upgrade Guide — Blocker Ledger (Autonomy Principles Enforcement, Piece 1)

<!-- bump: minor -->
<!-- Valid values: patch, minor, major -->

## What Changed

Adds the **Blocker Ledger** — the resolution-workflow + memory layer that completes Principle 1 ("almost every blocker is a false blocker — work it through"). The detection half already shipped (the `deferral-detector` hook, the B16_UNVERIFIED_WALL / B17_FALSE_BLOCKER message gates). This is the missing resolution half: a detected false-blocker becomes a *gated pipeline* — `candidate → authority-checked → access-requested → dry-run → live-run → resolved | true-blocker` — with structural evidence-of-work required at every terminal, built so the memory can never become a deferral-laundromat.

- A real, re-executable codified playbook (confined path, references the blocker id, links a *successful* live-run) is required to `resolve` — a one-line stub never closes the loop.
- A `true-blocker` (genuinely the user's) is the most-gated terminal: a closed-taxonomy reason (`operator-only-secret` / `operator-only-account` / `legal-billing-authorization` / `operator-judgment`), a recorded **failed self-fetch** (for the secret/account kinds — the self-fetch-first mandate) or failed dry-run, a post-attempt access-request to the user, AND a PASS from a Tier-1 LLM authority (the B17 pattern, fail-closed). It is stored as a **decaying hypothesis** ("recheck after <date>"), re-tested on a cadence; a re-walk requires NEW evidence and rubber-stamping the same reason escalates after N.

New API (`/blockers`, `/blockers/:id`, `POST /blockers`, `POST /blockers/:id/advance`, `POST /blockers/:id/settle`), a read-only dashboard "Blockers" tab, and an auto-open trigger in the `deferral-detector` hook so a detected false blocker lands in the ledger without the agent choosing to (Structure > Willpower).

Signal-vs-Authority compliant: the ledger RECORDS and STRUCTURES; it never blocks an outbound message (B16/B17 keep that authority). The one judgment it carries (the true-blocker settle) routes through the LLM authority.

⚗️ **Ships dark + experimental.** Default `monitoring.blockerLedger.enabled: false` → every `/blockers` route returns 503 and the dashboard tab shows "not turned on yet." Nothing changes for any agent until it is explicitly enabled.

## What to Tell Your User

- "I now have a Blocker Ledger that turns 'I'm blocked' from a dead-end into a worked pipeline. When I hit something that feels like a wall, it's logged and walked through: do I have the authority? do you? did I try it myself first? — and only what survives all of that, with a recorded reason, is a real blocker. It's off by default (experimental); say the word to turn it on."
- "A 'true blocker' I record isn't a 'stop trying' note — it's a hypothesis I re-test on a schedule, and I can't re-stamp it without new evidence."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Blocker Ledger (resolution pipeline + memory) | Enable `monitoring.blockerLedger.enabled: true`; then `GET /blockers`, `POST /blockers/:id/advance`, `POST /blockers/:id/settle` (Bearer + `X-Instar-Request: 1` on mutations) |
| Auto-open on detected false-blocker framing | Automatic — the `deferral-detector` hook opens a `candidate` entry (best-effort, non-blocking) |
| Dashboard "Blockers" tab | Read-only view of the pipeline; shows true-blockers as decaying hypotheses |
| Tier-1 B17 settle authority | The true-blocker settle judgment is an LLM authority that fails closed |

## Evidence

- Unit (35): gated state machine refuses skips; `resolved` refused without a successful, confined, id-referencing playbook; `true-blocker` refused without a taxonomy-matched reason + failed-attempt + post-attempt access-request + B17 pass; self-fetch-first mandate enforced; anti-laundering re-walk refuses no-new-evidence + escalates after N; injection-payload free-text stays inert in a data envelope; concurrent opens don't clobber; archival.
- Integration (7): routes 503 when dark, 200/201 when wired; full create→advance→settle over HTTP; mutations without `X-Instar-Request: 1` get 403; the settle writes an audit line to `logs/blocker-decisions.jsonl` with origin + gate hash.
- E2E (4): production init makes the feature ALIVE (200, not 503); dark by default; a blocker walked candidate→resolved persists across restart.
- `npx tsc --noEmit` exit 0. Independent second-pass review: concur (see `upgrades/side-effects/blocker-ledger.md`).
