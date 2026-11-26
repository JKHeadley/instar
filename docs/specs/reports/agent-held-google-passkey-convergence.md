# Convergence Report — Agent-Held Google Passkeys

**Spec:** [docs/specs/agent-held-google-passkey.md](../agent-held-google-passkey.md)
**Slug:** `agent-held-google-passkey`
**Converged at:** 2026-09-22 (PDT), round 10, under the operator's 80/20 convergence standard (see Verdict)
**Iterations:** 10

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier outside review ran through the agent's codex CLI in every one of the 10 rounds (all
`ok`). Its verdict moved from SERIOUS in the early rounds to MINOR in rounds 5 and 9. In the later
rounds it went back to SERIOUS, mostly by repeating three architecture preferences that are recorded
below as deliberately not adopted. Gemini was not signed in on this machine and was not used.

## ELI10 Overview

AI subscriptions like Claude and Codex sign out every so often, and most of our accounts sign in
through Google. This spec turns a method we proved live on 7 accounts × 3 machines into a proper
Instar feature. A person signs the agent into each Google account once per machine. While signed in,
the agent creates its OWN passkey on that account (an extra key; the person's password, passkeys and
two-step settings are untouched). From then on the agent can sign itself back in from an empty
browser, and because Claude and Codex both accept "signed in with Google", one key repairs both.

It matters because re-signing accounts by hand is a recurring chore, and today's working version is a
set of scripts that store the keys less safely than this design (copied to every machine, readable by
ordinary tools). The feature adds proper custody, per-account permission grants, revocation, health
checks, safe cross-machine behaviour, and clean migration of today's keys, without breaking the
sign-ins that work now.

The main trade-offs, stated in the spec itself: the key is software, not hardware, so any program
running as the agent's own user could in principle read it. The real fix is a separate locked-down
signing process, which is required before other people's agents get the feature. It also depends on
Google continuing to accept this kind of passkey, so there is a pool-wide suspension, an operator kill
switch, and a fallback to the existing repair methods if Google stops.

## Original vs Converged

- **Where keys live.** Originally the keys went in the shared secret store under an email-based name.
  Review showed that name would break on the dots in email addresses, would leak the keys to other
  machines through secret sync, and would let any agent session read them with the ordinary secret
  tool. Now they live in their own encrypted file that older versions and ordinary tools never see.
- **Honesty about the key.** Originally the spec called the key "unphishable" and "smaller than a
  password". Now it says plainly that the key is exportable software that opens the whole Google
  account. It names the same-user risk as an accepted risk, and the operator ratified running it on
  our own machines before the locked-down signing process exists (FD16, option A).
- **Proving a key works.** Originally "ready" meant Claude's page loaded. Review showed that could pass
  with the wrong account, or with no passkey used at all. Now a proof must start signed out, observe
  the passkey actually being used, and read the exact signed-in email on Google's own page.
- **Grants and revokes across machines.** Originally grants replicated between machines as if they
  carried authority, and revokes could quietly expire. Now authority is local to each machine;
  revokes are signed, crash-safe, re-delivered with backoff and a breaker, and never silently lost.
  A lost machine becomes a high-severity item asking the operator to remove the key on Google.
- **Google-side removal.** A mid-review attempt to let the agent remove its own key on Google's page
  was rolled back: that list mixes the person's own passkeys in with the agent's, with no reliable
  identifier. Removal stays a short manual step with a direct link.
- **Failure behaviour.** Originally a Google rejection was treated as a security incident needing
  re-enrollment. That would have forced the person to sign in again on every account if Google
  changed its policy. Now there is a recoverable rejected state, a bounded pool-wide suspension with
  canaries, a Google risk-page budget, a kill switch that is cheap to pull, and an approval-only
  fallback to the existing repair methods.
- **Today's keys.** Originally the lock-down would have cut off the running scripts before anyone
  chose what to do with each key. Now spreading stops first, reads keep working, and the operator
  decides key by key.

## Iteration Summary

| Iteration | Reviewers who flagged design issues | Design findings | Precision findings | Spec sections changed |
|-----------|-------------------------------------|-----------------|--------------------|-----------------------|
| 1 | all 6 + external | 58 + 5 ext | 31 | full rewrite (v2) |
| 2 | all 6 + external | 37 + 6 ext | 41 | custody moved to separate file; migration ordering (v3) |
| 3 | all 6 + external | 18 + 5 ext | 47 | suspension, proofs, grants, mandate signing (v4) |
| 4 | all 6 + external | 17 + 4 ext | 37 | pool read path, outcome classes, revoke outbox |
| 5 | 5 of 6 (integration clean); external MINOR | 9 | 36 | canary authority, issuer ops, dark peers |
| 6 | 3 of 6 + external | 7 + 4 ext | 34 | Google removal reverted to operator; risk budget |
| 7 | 2 of 6 (+1 factual) + external | 6 | 31 | revoke durability, issuer checks at verification |
| 8 | 3 of 6 + external | 4 | 30 | degraded mode, revoke cutoff, issuer bootstrap |
| 9 | 2 of 6; external MINOR | 4 | 24 | crash-safe revoke ledger, kill switch, pool-condition table |
| 10 | 4 of 6 (1 each) + external | 4 | 23 | evidence scoping, kill-switch propagation, frames rule |

The Standards-Conformance Gate ran every round: round 1 had 4 flags, rounds 2–10 had 1–3 each. The
gate's recurring "Always Multi-Machine" flag was ruled correct-as-handled by the integration reviewer
each time, because per-machine custody is an operator-ratified exception (FD2) and the marker lint is
clean. Internal reviewers ran on claude-opus-5-5 throughout.

## Full Findings Catalog

The round-by-round finding counts and the change list for each revision are in the round log kept
during convergence (summarised in the table above). The spec's git history on branch
`spec/agent-held-google-passkey` records every revision, one commit per round. Selected
consequential findings:

- R1 security/adversarial/integration/scalability (independently): the email-based key path breaks on
  dots and bypasses the sync deny-list → dot-free hashed key, then a separate file.
- R1 security: generic secret reads expose the key → separate file invisible to ordinary tools.
- R1 lessons/adversarial/integration: cold proof never checks the account → identity read on
  Google's own page, later plus the observed-assertion requirement (R3).
- R2 adversarial/decision-completeness/security/lessons: the lock-down would break today's working
  scripts → spread stopped first, per-key operator choice.
- R2 integration/security: a mixed-version rollout would halt ALL secret sync → the receiver drops and
  audits prototype keys instead of rejecting the batch.
- R4 adversarial: treating a rejection as a security incident makes a Google policy change
  unrecoverable → a `credential-rejected` state, separate from `security`.
- R6 security/adversarial: agent-performed Google removal could delete the person's own passkey →
  reverted to operator removal.
- R8 security: cross-machine clock comparison in revoke cutoffs → per-target sequence numbers.
- R9 security: revoke apply was not crash-safe → received/applied ledger with a boot sweep.
- R10 integration: scoping graduation evidence by method would erase an account's bad history →
  only the success count is scoped.

## What was deliberately left behind

- **The outside reviewer's recurring architecture preferences** (rounds 6–10), considered and
  answered in the spec rather than adopted:
  - build the separate signing broker first. Deferred to before the fleet rung; the operator
    ratified hands-off use on our own machines before then (FD16).
  - collapse the multi-machine grant/revoke design into one workflow engine. Recorded in §17: this
    release reuses the parent's durable episode state machine, and consolidation belongs to the
    broker increment.
  - remove the AI supervisor from credential actions. Answered in §3.6: those actions have a
    deterministic floor, and the supervisor can only decline.
- **Precision items from round 10** that don't change what gets built: naming and cross-reference
  wording, extra rows for the tables in sections 10 and 11, and retention phrasing.

## Convergence Verdict

Converged at iteration 10 under the operator's 80/20 standard: stop when findings stop changing what
gets built. The skill's strict rule (two consecutive rounds with no design findings) was not met.
Round 10 still produced four narrow design points: evidence scoping, how the kill switch spreads and
who may pull it, and one over-strict frame rule. All four were fixed in the final revision. None
reopened an earlier decision. The design-finding count fell steadily, 58 → 37 → 18 → 17 → 9 → 7 → 6 →
4 → 4 → 4, and the last five rounds found only edges of the pieces added the round before. The
10-round cap was reached, so this is stated plainly rather than presented as a clean two-round pass.

Open questions: none. Frontloaded decisions: 21, including FD16, which the operator ratified.

The spec is ready for operator review and approval. Approving it means setting `approved: true` in
its frontmatter. After that, the /instar-dev build proceeds to the FD9 run boundary.
