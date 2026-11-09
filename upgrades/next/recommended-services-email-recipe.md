# Upgrade Guide — recommended-services-email-recipe

## What Changed

An agent can now email its owner, and only its owner (`docs/specs/backup-email-sending.md`). It is the `email-v1` recommended-services recipe, dark behind `recommendedServices.provingRecipes` until its live proof; the catalog's Email row now describes the three account choices (a free Resend account opened in the person's name, their own Gmail or iCloud through an app password, or a mailbox they give the agent) and names its backup as exercised (the report comes to the conversation instead).

The owner types the one address mail may ever go to on the Services confirm page; it is stored in the vault, and the yes row carries a keyed hash of it and the email timezone (`recipientHash`, `timezone`). The setup session stores the credential through `POST /recommended-services/email/key` (a JSON body that may never carry a recipient), sends a proof email with `POST /recommended-services/:id/prove`, and in shapes A and C the owner enters its six-digit code on the confirm page (`POST /recommended-services/email/code`, PIN). Email is "working" only after that.

Jobs gain `deliver`: `["email"]` emails the report the job would have sent to its topic, `["telegram", "email"]` does both. It never makes a quiet job loud, and script jobs refuse it. The body is the job's final message from its transcript. Every email row is durable (`state/email-outbox/`, replicated as the new `email-outbox-record` kind), written in the same bookkeeping as the run, which records `emailOutboxId`; a reconciliation sweep catches a crash in between. Refused, unsure or not-set-up emails come to the topic with one plain line. Only the lease holder sends; a standby forwards over the new signed `email-send-forward` mesh command. A session sends a one-off with `POST /email/send-to-owner` and its bind token. `GET /email/outbox` lists rows (hashes only), `GET /recommended-services/email/status` shows the state and today's budget. New dependency: `nodemailer` 10.2.1 (pinned). Key recipes (Jev, voice, GitHub) are now re-checked once a day after they pass, as copy recipes already were; an outage never takes a pass away. The `deliver` field in an AGENT.md job needs this version or later (an older version withholds that job); in `jobs.json` it is ignored by older versions.

## What to Tell Your User

I can email you now, once you say yes and we set it up: only you, at the address you type, nobody else ever. You choose the account: a free one I open in your name, your own Gmail or iCloud, or a mailbox you give me. Then any job you like can send its report to your inbox, and if an email doesn't go through, the report comes here instead. This is being proven on a test agent first, so it isn't offered yet.

## Summary of New Capabilities

| Capability | How to Use |
|---------|-----------|
| Email reports from jobs | `"deliver": ["email"]` on a job in jobs.json |
| One-off email to the owner | `POST /email/send-to-owner` from a session |
| Email status and budget | `GET /recommended-services/email/status` |
| Email outbox | `GET /email/outbox` |

## Evidence

Unit: `tests/unit/email-core.test.ts`, `email-transports.test.ts`, `email-outbox.test.ts`, `email-opt-in.test.ts`, `email-service.test.ts` (every outbox transition, both fallback deadlines, breaker, budget, lease, recovery, relay, the 24-hour breaker and resume, drain, guard, proof per shape, paced checkpoint), `email-recipe.test.ts`, `JobScheduler-email.test.ts`. Integration: `tests/integration/recommended-services-email.test.ts` (shapes A, B and C through the real routes and transports). E2E: `tests/e2e/email-sending-lifecycle.test.ts` (AgentServer wiring alive, a scheduled report through the real scheduler and transport, and the drill: email switched off, the report arrives in the job's topic with its line). Live proof: recorded in the PR.
