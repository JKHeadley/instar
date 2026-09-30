# The feedback drain's readiness approval can be given from the dashboard

## What Changed

The operated feedback drain refuses every tick with 403 "current registered
readiness agent required" until an operator registers the readiness
authority, which is the record that says which model may decide which
feedback reports become work items. Registering was possible only through
the PIN-gated `POST /feedback-factory/readiness-authorities` with about a
dozen technical fields, and there was no screen for it. On the Mac Studio
this left 1,001 reports waiting.

- New read-only `GET /feedback-factory/readiness-authorities/proposal`
  (Bearer). The server computes every field the runtime later compares: the
  agent id (`projectName`, which the drain job sends), the drain's owner
  machine and epoch, the provider and model that the intelligence router
  would actually pick for the readiness call, and the prompt, schema and
  decision-point ids. Only the envelope can be edited: batch size (default
  50), daily spend cap (default $5), and token limit (default 1200). The
  response also carries the status (none / active / proposal-only /
  revoked), any plain-language blockers, and which action an Approve tap
  would perform.
- The existing PIN route now accepts `useProposal: true` for create and
  replace. When it is set, the server fills the binding fields from its own
  proposal and takes only the envelope from the request. It stays PIN-only
  and same-origin, and the agent still cannot register itself.
- New `IntelligenceRouter.previewPrimary()`, a read-only preview of the
  primary (framework, model) that `evaluate()` would choose. It follows the
  same enforced-nature or category logic.
- New dashboard card on the **Feedback Drain** tab: "Who decides which
  feedback becomes work". It shows a one-line status, a plain sentence
  ("…up to 50 reports per batch, at most $5 per day. Anything outside that
  comes to you."), an "Adjust limits" drawer, a PIN box, and Approve (or
  Restore / Save new limits) and Revoke buttons.
- CLAUDE.md template and migration: new "Feedback Readiness Authority
  (operator approval)" section, also mirrored to Codex/Gemini agents.

## Evidence

- `tests/integration/feedback-readiness-authority-routes.test.ts`, run
  against a real AgentServer over HTTP. The test reads the proposal, checks
  that a tick 403s, and checks that Bearer without a PIN and a wrong PIN are
  both refused. It then approves with the PIN while also sending
  attacker-supplied `agentId`/`provider`, which are ignored. The next tick
  returns 202 and the run succeeds. The arbiter is called once and its
  model check passes, so the authority stays `active`. It then revokes,
  confirms the tick 403s again, and confirms an out-of-range batch is
  refused.
- `tests/unit/intelligence-router-preview-primary.test.ts`: the preview
  equals what the real `evaluate()` reports through `onModel` in four modes:
  unconfigured, category override, enforced nature plan, and dryRun nature
  plan. It returns null when the routed framework is unavailable.
- `tests/unit/feedback-readiness-authority-proposal.test.ts` covers every
  status→action branch, the blockers and the envelope bounds. It also
  replays real recorded shapes from the Mac Studio's `feature-metrics.db`
  (221 codex-cli `gpt-6-astra` `capable` calls). An authority built from the
  proposal passes the real arbiter on that shape and is refused on the
  `gpt-5.6-sol` retirement-fallback shape.
- `tests/unit/feedback-readiness-authority-ui.test.ts`: covers the card's
  buttons per state, the request bodies (no binding fields are sent), the
  PIN and envelope submitted on Approve, and that values are rendered with
  textContent only. It also checks that the page mounts the card, imports
  the module, and renders the card on tab open but not on the 15-second
  poll.
- `tests/e2e/feedback-factory-drain-lifecycle.test.ts`: on the production
  init path the route answers 200, tracks the post-failover owner epoch,
  offers no Approve when no routed model exists, and refuses the new path
  without a PIN.

## What to Tell Your User

The feedback drain has been waiting for your go-ahead before it sorts
reports into work items. You can now give it from your phone: open the
dashboard, go to the Feedback Drain tab, and find the card "Who decides
which feedback becomes work". It says in one sentence what you're agreeing
to (by default, up to 50 reports per batch and at most $5 a day). Enter
your PIN and tap Approve. You can revoke it from the same card at any time.
I can't approve it myself.

## Summary of New Capabilities

- Dashboard → Feedback Drain → "Who decides which feedback becomes work":
  approve, change limits, restore or revoke the readiness authority with
  the PIN.
- `GET /feedback-factory/readiness-authorities/proposal`: the read-only
  answer to "what exactly would be approved, and why can't it be yet?"
