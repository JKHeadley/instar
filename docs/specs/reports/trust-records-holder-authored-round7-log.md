# trust-records-holder-authored — round 7 log (2026-11-18, the one extra round; cut)

Authorized by the Chief of Staff's brief (2026-11-18 02:35 PST, topic 143781): one more round with the same reviewers on the round-6 hand-over fixes; if it finds new hand-over blockers, do not patch, cut to the smallest safe form.

Reviewers: the same three internal lenses (security + adversarial; integration + scalability; decision-completeness + lessons), claude-opus-5-5. The round-1..6 subagents ended with the previous session, so the same lenses were re-briefed with their round-6 findings to mark, rather than replaced by new lenses. External: codex-cli gpt-6-astra (ok, MINOR ISSUES); clean-door claude-code claude-fable-5-2 (ok, SERIOUS ISSUES). Standards-Conformance Gate: ran (2 flags, as round 6: Trust Is Earned by Work = item a; A Dark Feature Guards Nothing = item b). Spec hash at review: e02def1d.

Round-6 findings: othersImported resolved (all); wake window resolved or partly; device withdrawal and hand-back lowering partly (the round-6 rules work only with a current epoch view and a shared device id).

New design findings on the hand-over path (deduplicated, 7):
1. A forged high epoch in a peer key makes withdrawal and ask-first denial permanent (security, fable).
2. Same-epoch narrowing from a standby traps the holder's later re-grant for the whole term; "above W" / "W or lower" off by one (security, integration).
3. No rule fixes which epoch a lagging standby writes, so the narrowing misses the holder's records (security, decision-completeness).
4. Device withdrawal subject `deviceId` is a random per-machine id, so a revoked phone approves again after a hand-back (integration).
5. An automatic own change (`revoked`, `default`, `route`) lifts the hand-back ask-first (codex, decision-completeness).
6. The decision-7 epoch filter, read literally, now kills own acceptances and changes too, contradicting decision 4 (decision-completeness, codex).
7. Mixed-version pools: older-build changes carry no epoch and never trigger the hand-back rule (fable).
Also: "fresh view after wake" leaves the waiting approval undecided and needs a defined detector (fable, decision-completeness).

New design finding elsewhere (all five reviewers in substance): the round-6 "pre-build changes judged by today's rule among themselves" re-opens the forged re-validation (a no-epoch `change` reusing the anchor id with a far-future `at` brings an ended legacy grant back), against rule 3. This is a peer GRANT.

Outcome: CUT, per the brief. No patch to the round-6 rules. The spec now has no hand-over path: grants count only where written and only inside the writer's current run of the lease (every epoch from the grant's epoch to now held by this machine, from a local held-epoch set; never an epoch read from a peer record); peer records narrow by id only; peer changes are never read (levels, legacy and the autonomy profile use own current-run changes only, own stream order, no payload time). Removed: lastForeignEpoch, gap rule, same-epoch contest hook, fresh-view-after-wake, peer-epoch withdrawal rule, peer-change ask-first, pre-build ordering rule, owner forgery notice. The cut form was not reviewed again (no further round is authorized); each removed finding is closed by removal, not by new mechanism, and the integration point that a standby may write grant records is folded in (a run includes the grant's own epoch).

Convergence-tag counts (decision-completeness, round 7, pre-cut): 14 frontloaded decisions, 20 cheap tags, 3 contested cleared.

Left behind (precision, for the build): legacyImportedAnywhere excludes this machine by transport writer; new keys for change/acceptance writes that have none today; device-acceptance lock keys keep their suffix after the epoch; the outsideRun ask reason added to AskReason and askSentence; an ask while the run is broken does not send a duplicate card if one is open.

Standards-Conformance Gate on the cut form: 2 flags. Attributed Statements: answered with the message-store pointer for the 02:35 brief (the 01:45 brief has no store record and stays quoted). Maturation Path: option 11(b) "ignore fleet-wide from merge" skips the rungs; it is the protective direction and is the operator's choice, named in the approval request with that consequence.
