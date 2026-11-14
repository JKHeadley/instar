## Summary

Slice **3g** of native-conversation-base: `docs/specs/native-conversation-forwarded-advisory.md` (approved by Echo under the standing grant; no constitution change). The spec, its ELI16, its convergence report and the F1 evidence (`docs/specs/reports/ncb-f1-cause.md`) are copied unchanged from #3113.

**Based on slice 3a (#3102, branch `echo/ncb-3a-held-replies`) with `origin/main` merged in.** Once #3102 merges, this PR's diff shows only 3g. Slice 3b (#3092) is on main and untouched.

When the outbound check refuses a reply that is **in custody** (forwarded to the lease holder, or queued for recovery):
- **Item 1.** An allow-list classifies the refusal as `advisory`, `refused` or `retain`.
  - `refused` is positive only by a `RULE_DISPOSITIONS` key, a credential or loopback-link wall, a reasonless override, or a floor catch (`degradedToDeterministic`).
  - `CAPACITY_UNAVAILABLE`, `GATE_UNAVAILABLE`, `GATE_TIMEOUT` and unknown rules are `retain`.
  - Both `tone-gate-blocked` bodies now carry `failedClosed` / `degradedToDeterministic`.
- **Item 2.** The holder ends its own copy in the same conditional transition that records the verdict, and only then answers `policyRefusal` with `copyEnded: true`.
  - The transition requires no claim, no unresolved dispatch and no accepted part, and the first verdict wins.
  - The verdict is stored in a new `policy_verdict_json` column, which is never cleared.
- **Item 3.** The author's row keeps the verdict and leaves both delivery selections. A separate scan carries its line and deadline.
  - The receipt sends the verdict to the author only, never on a reader answer.
  - A `policyRefusal` without `copyEnded` (an older holder) is treated as custody.
- **Item 4.** One `advisory-line` per operation goes through 3a's `sessionLine`. It names the per-operation answer reference: the gate's `decisionRef`, or `op:<id>`.
- **Item 5.** One lookup serves local and forwarded rows. The session's answer supersedes the held row locally before anything is sent.
  - A forwarded answer is superseded, marked `outcome-unknown`, then submitted.
  - A closed answer sends nothing and gets the old reply's recorded outcome.
- **Item 6.** A holder-authored reply refused on recovery gets one definite line: "the outbound check refused it (`RULE`)… Rewrite it before sending again."
- **Item 7.** Counters on `/telegram/origins/status` and the federated `metrics` verb; two awareness sentences carried by `migrateClaudeMd`; a feature-ladder (maturation) row.

Second-pass review: an independent reviewer raised two concerns, both fixed with tests:
- A failed local supersede could leave a recoverable hold in memory.
- An inline verdict suppressed the deadline line.

The artifact is `upgrades/side-effects/ncb-3g-forwarded-advisory.md`.

## ELI16 — a tone suggestion on a held reply now reaches the session that wrote it

Before a reply goes out, a checker reads it. Sometimes it says "this could be better, here is a suggestion". If the reply is sent straight away, the session that wrote it sees the suggestion and decides what to do.

A reply that was waiting (handed to another machine to send, or queued for a retry) was handled differently. The checker's suggestion went nowhere. The reply sat there, got checked again and again, and could be dropped without anyone seeing it. That is what happened to a real reply on 2026-11-11. Worse, the machine that sends to Telegram could say "not sent" while still keeping its own copy, so the user might later get two versions.

Now:
- The machine holding the reply throws away its own copy at the same moment it writes down the suggestion.
- The session that wrote the reply gets one plain line: what the suggestion was, when the reply will expire, and how to answer.
- If the session sends a fixed version, or says "send it as written" with a reason, that answer replaces the waiting reply in one step, so the user gets exactly one message.
- If the session never answers, the reply simply expires.
- A hard "no" from the checker, such as a leaked password, ends the reply at once with one line saying so.
- A checker that was just busy or down still retries, exactly as before.

## Tests

- **Unit:** `tests/unit/telegram-origin/forwarded-advisory.test.ts` (19 tests: the classifier over every refusal body, the column across re-hold and restart, the fences, selections, receipts, the session line) and `tests/unit/telegram-origin-forwarded-advisory-migration.test.ts` (awareness, migration parity, wiring).
- **Integration:** `tests/integration/telegram-origin-forwarded-advisory.test.ts`. Two real runtimes run over the signed mesh, in 18 scenarios, and each asserts the Telegram dispatch count:
  - answers: comply, ack, an unflagged reply, a second answer with the same reference
  - silence until the deadline
  - synchronous and older-holder advisories
  - verdict classes: refused in custody, a capacity shed, no-rule vs a floor catch
  - concurrency: a submit/recovery race, answer vs expiry in both orders
  - visibility: the receipt withheld from readers
  - holder-authored replies, both refused and handed back
  - a lease change while held
  - a restart between the supersede and the submit
  - the two fixes from the review
- **E2E:** `tests/e2e/telegram-origin-forwarded-advisory-alive.test.ts`, on the production boot path:
  - the line goes through the injector
  - the status counters answer 200 and move
  - one send after the answer
  - the store migration adds the column to an existing database
- **Changed test:** `tests/integration/telegram-origin-routes.test.ts`. Its pacing test used an advisory as the "retry later" refusal. That is now a capacity shed (`retain`), because under 3g an advisory in custody must not be re-reviewed and sent.
- **Neighbours** (selected by the diff, plus the migrator tests): 673 unit files (2 environmental failures, both green on rerun: nodemailer link swept mid-run, a regex timing budget under load) and 104 integration files green; the 95 e2e neighbour files are reported in notes/ncb-3g-status.md

## UX Impact

Audience: agent sessions that write Telegram replies on a multi-machine agent, and the people reading those topics. First contact: a session whose held reply got a tone suggestion sees one line in its terminal. That line starts "Your reply ID was not sent. The outbound check has a suggestion". The user then receives exactly one version of that reply.

## Proportion

Tier 2. The change is 840 lines of source across 19 files, with 5 test files. The spec had already converged in 4 rounds before this build. The commit gate passed on the first attempt. One extra commit carries the status note and the final whole-PR trace.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
