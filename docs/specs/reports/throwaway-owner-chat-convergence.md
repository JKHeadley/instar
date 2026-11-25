# Convergence Report — A stand-in owner chat for throwaway agents

**Spec:** [docs/specs/throwaway-owner-chat.md](../throwaway-owner-chat.md)
**Slug:** `throwaway-owner-chat`
**Converged at:** 2026-11-21 (round 6 of 6, the Tier-2 cap)
**Iterations:** 6
**Final-round design findings:** internal reviewer 0; cross-model reviewer 4, of which 2 were fixed in place after the round, 1 was rejected on the merits with the internal reviewer concurring, and 1 was already covered by the end-to-end test (details below).

## Cross-model review: codex-cli:gpt-6.2-astra

A real GPT-tier external pass ran through the agent's codex CLI on every one of the six rounds (status `ok` each time). Gemini was not authed on this machine (`gemini-not-authed`); the Anthropic clean-door reader was available but not used, and it never counts as a cross-model pass anyway. The internal reviewers ran as Claude subagents on the authoring session's model (claude-opus-5-5) in every round: three subagents in round 1 covering two lenses each, two in round 2, and from round 3 on one subagent covering all six lenses.

## ELI10 Overview

When you make a phone able to approve things for your agent, the agent proves it is really you by sending a code and Approve / Decline buttons to your private Telegram chat. The new phone screens for those steps (adding approvers, removing one, recovering after losing every phone that could approve) have never been tried against a running agent, because the only Telegram owner we have is Justin, and every practice run would land in his real chat and tie his real account to a test agent.

This spec adds a pretend owner chat that exists only on a throwaway test agent. The agent keeps the codes and buttons in a small file on its own computer, and a test on that same computer reads the codes and presses the buttons. The presses go through exactly the same approval code a real Telegram tap uses, so the test exercises the real server logic. It switches on only when the agent's folder really sits in a temporary folder with an expiring throwaway record, the agent has no chat app, no owner, no earlier owner key, no paired device and no other computer, and someone asked for it in the settings. If any of those stops being true, it turns itself off for good and cancels what it was carrying.

The trade-off is honesty about what a run proves: it proves the app screens and the server agree end to end, but not that real Telegram delivers and renders the messages, nor that a real iPhone stores its keys properly. Two real passes (one on real Telegram, one on a real device) stay required before the identity work merges.

## Original vs Converged

- **Originally**, a sandboxed `$HOME` counted as "created as a throwaway". **Now** only the folder's real location counts (symlinks resolved), because whoever starts a process chooses `$HOME`, so a real agent started with a fake HOME and one config edit would have qualified.
- **Originally**, the bar for the test routes was "the bearer token plus loopback". **Now** it is the master token exactly, no device header, no Origin header and the server's own localhost address. The auth layer also accepts a paired phone's signature and dashboard sessions, so the phone under test could otherwise have approved its own pairing.
- **Originally**, "no real owner" was one vague sentence. **Now** it is an explicit list: any messaging entry (even disabled), a running adapter, a configured owner id, a verified operator, an owner introducer, an owner-record enrolment from before the first build (bound to the genesis the stand-in adopts), a device paired before the first build, and another agent home on the computer sharing this machine identity (a copy of a real agent moved into a temp folder).
- **Originally**, switching off only made the routes answer 410. **Now** it records "off" first, presses Decline on every live approval button through the production decline path, runs shut-off steps the identity pieces register, refuses machine pairing for the life of the home in both directions, and does the same sweep at the next boot if it was refused there. A read failure only suspends one use instead of switching off for good, and a failed read can never flip the agent to dashboard approval.
- **Originally**, the stand-in "plugged into the Telegram handlers". **Now** there is one named owner-chat seam that Telegram and the stand-in both satisfy, because on main all the handlers hung off the Telegram adapter, which a throwaway with no adapter does not have. The words a person sees after a tap moved into one shared module both use, so they cannot drift. The owner id sentinel `-1` was dropped (it collided with the "held" message id and would have looked like a real person to the people registry).
- **Originally**, the log kept the newest 500 lines. **Now** nothing is ever evicted (an evicted message could be a live Approve); a byte budget refuses new work instead, each tap or command records an intent before its handler and its result after, and message sizes follow Telegram's own limits.
- A **claim boundary** was added: what a stand-in run proves, what it does not, and the two residual real passes, each on its own throwaway.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | security, adversarial, integration, scalability, decision-completeness, lessons-aware, codex | 19 (deduplicated to 11) | 12 | Condition 2 location-only; master-bearer route gate; explicit condition 3 list; enrolment across restarts; shut-off clears in-flight work; pairing refused; owner-chat seam; no owner id; claim boundary; no eviction; posture key |
| 2 | security/adversarial/scalability, integration/decision/lessons, codex | 11 (deduplicated to 8) | 9 | Copy-of-real-agent check; boot-time sweep; only `md:d:` pressed plus piece hooks; dropped extra callback slot; `setRecoveryChat` in 3d's list; outcome-exact button rules; GET re-checked; lifetime pairing refusal both ways; unsure vs off; byte budget |
| 3 | all-lens internal, codex | 5 | 7 | Real-path temp check (symlink); empty device registry at first build; restart-sweep claim corrected; rollback tears down homes first; 64 KiB reserve before handlers |
| 4 | all-lens internal, codex | 4 | 6 | Owner presence stays true while unsure; boot-unsure mounts routes; per-flow sweep outcome stated; intent-before-handler log entries |
| 5 | codex (internal: 0) | 4 (2 adopted, 1 already true, 1 rejected) | 5 | Command intent and input bound; pairing refused while not off; cursor stated; reserve vs synchronous handlers |
| 6 | codex (internal: 0) | 4 (2 fixed after the round, 1 rejected, 1 already covered) | 5 | Unreadable other identity is unsure; 24 KiB per-message cap under the reserve; CLI vs route refusal wording; e2e scope stated |

Standards-Conformance Gate: ran every round (round 1: 7 flags; round 2: 7; round 3: 10; round 4: 7; round 5: 8; round 6: 5). Each flag was handed to the reviewers; the substantive ones (live-approval eviction, per-entry bounds, unsure-vs-off, provenance of `approvedVia`, multi-machine posture, residual real-channel proof) were adopted above, and the rest are in Left behind.

Externals were never delta-skipped: the spec body changed before every round.

## Proportion

Tier 2 (security-sensitive test fixture). The spec grew from 106 to about 175 lines; the build is about 700 lines of source and 600 of tests. Six of six rounds were used. That is in line for a security fixture whose entire point is being impossible to switch on for a real agent, but the cross-model reviewer kept raising long-tail ordering and capacity cases in the last two rounds, which is why the final round's two small fixes were applied without a seventh round.

## Left behind

- **Codex (rounds 1, 3, 5, 6): "created as a throwaway" should come from a launcher-injected fresh home, not from location plus config.** Rejected on the merits; the round-6 internal reviewer independently concurred. A home passes only with its real folder in a temp root, an expiring record, no owner enrolment and no device at first build, no machine identity shared with another agent home, no peer, no adapter, operator or introducer. A copy stripped until it passes has no owner authority left to copy back. Whoever starts a process controls a launcher just as they control `$HOME`, and a same-user process already holds the machine keys and bearer token; the spec states this limit plainly.
- **Codex round 6 #3 (lease):** the end-to-end test already drives redeem, the Approve tap and a signed device read showing `active`; the spec's test list now says so.
- **Codex rounds 4-5: race between first build and machine pairing.** Not reachable: the stand-in is built in the server constructor before the server listens, `/api/pair` is refused while the stand-in is not off, and a command-line join that registers a peer first makes condition 4 false so it never builds.
- **Truthful provenance of `approvedVia: 'telegram-dm'`** (gate, rounds 2, 4, 6): kept on purpose because the flow under test is the Telegram one; contained to a home that is never paired and is deleted after the run, and the stand-in log names every approval.
- **The 16 MiB budget, 64 KiB reserve, 24 KiB message cap and 200-entry page** (gate, Judgment Within Floors): resource budgets with wide margin, labelled as such in the spec, not derived floors; all refuse rather than evict.
- **Telegram counts UTF-16 units / 100 buttons** (gate): 4096 and 64 bytes are documented; 100 buttons is labelled observed.
- **A determined same-user process** can forge the stand-in's own state file or copy keys; out of what any file-based check can stop, and stated.
- **Moved (not copied) home with a stale registry path** (round 3): a moved home's original no longer exists to copy back into.
- **Per-use read cost** (rounds 3, 5): paid only on a throwaway that asked for it; stated in Observability.
- **Git-sync remote or backups on a throwaway** (round 3): the claim was softened to "never paired with another machine"; a throwaway is created without them.
- **Whole-flow metric of drills that reached their expected state** (gate, Observability): the run's report carries a PASS/FAIL row per screen (Frontloaded Decisions); the stand-in log is its evidence.
- **3a's first-approver message carries a Decline button no handler acts on** (round 2): a real 3a defect, outside this spec; to be reported to 3a's session in the build report.

- **The `## Maturation plan` section was added after round 6** because the tag writer requires it (the draft had "Rollout and maturation" prose with the same content). It restates the draft's rollout text in the required fields and adds no behaviour; it was not reviewed by a further round.

## Full Findings Catalog

Round 1 (draft): sandboxed HOME accepted (security, decision, lessons: design); phone under test could self-approve via device/dashboard credentials (security, integration, decision, codex: design); condition 3 incomplete, missing disabled entries, promptGate, operators, owner-record semantics (security: design); "enrolled before the stand-in started" breaks on restart (security, integration, lessons: design); seam undefined, handlers only under `options.telegram`, `telegramOwnerPresent` false sends pairing to the dashboard (integration, codex, decision: design); adapter work outside the handler not reproduced (integration, codex: design); non-`md:` buttons (integration: design); `-1` sentinel collides with OWNER_DM_HELD and the people registry (security, integration: precision); shut-off leaves in-flight requests (security: design); a gained peer leaks state (security: design); posture key `test-fixture-locality` not in the taxonomy (integration: design); 500-line eviction and no per-entry bound (decision, gate: design); claim boundary missing, stand-in rehearsal is not real-client proof (lessons: design); condition 4 excludes 3a's multi-machine branches (lessons: precision, scoped out); recovery integration stops at Start (codex: design, moved to 3d's tests); loopback is not proof of untunnelled (security, gate: precision, reworded).

Round 2: copy of a real agent into temp (security: design); boot refusal skips the sweep (security: design); Decline undefined for non-`md:` buttons (security: design); extra-callback slot unused and 3a's dead button (integration: design); `setRecoveryChat` missing (integration, codex: design); button removal must follow outcome (integration: design); 3a claim not ended by the sweep (integration: design); GET not re-checked (codex: design); lifetime pairing (codex: design); 45 MB arithmetic wrong (security: precision); other `ownerDM` callers (security, integration: precision); outbound join (security: precision); residual pass on its own throwaway (security: precision); transient read shuts off for good (gate: design).

Round 3: temp check accepts a symlink (internal: design); pre-existing owner phones (codex: design); restart sweep vs memory-only nonces (codex: design, factual); rollback removes the pairing block (codex: design); budget partial results (codex: design); moved home, forged state, missing vs unreadable, cost, re-entrancy, sync/backup, `/api/pair` mounting (internal: precision).

Round 4: unsure flips the approval path to dashboard (internal, codex: design); boot-unsure routes (internal: precision, adopted); first-build vs pairing race (codex: rejected, unreachable); sweep semantics per flow (codex: design, stated); crash between handler and log (codex: design); cursor (codex: precision).

Round 5: command intent missing (internal: factual, fixed); creation history (codex: rejected); race (codex: partly adopted for the unsure-boot window); command input bound (codex: adopted); cursor (codex: already true, stated).

Round 6: creation history (codex: rejected, internal concurred); unreadable other identity should be unsure (codex: fixed after the round); lease not established (codex: already covered by e2e); reserve has no proven upper bound over button labels (codex: fixed after the round with a 24 KiB per-message cap); CLI refusal wording (internal: precision, fixed); reply over budget (internal: precision, fixed).

## Experience fit

Source: the Chief of Staff's decision (agent message 1d8498bd). The person's outcome is approver screens proven without involving Justin, and without the proof being overstated. Contrast: a demo-bot run through the Playwright Telegram profile would prove real Telegram but bind Justin's real account to every drill; a stand-in run asks nothing of him but proves only the app and server half. The design takes the stand-in for the many destructive drills and keeps one real-Telegram pass and one real-device pass, each tracked, so the person gets both speed and an honest claim. Evidence limit: no run has happened yet; the fit is judged on the design.

## Convergence verdict

Converged at round 6 of 6. The internal all-lens reviewer found no design-class issue in rounds 5 and 6. The cross-model reviewer's last-round findings were either fixed in place (two small, mechanical fixes made after the round, with no seventh review round because of the cap), already covered, or rejected on the merits with the internal reviewer concurring; none is an open safety or security finding. The spec is ready to approve and build.
