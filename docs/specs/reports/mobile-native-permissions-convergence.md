# Convergence Report — Native Permission slips and What I'm allowed to do, with Face ID-confirmed writes

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier external pass ran through the agent's codex CLI on every round that changed the spec body (rounds 1–5; the first round-1 attempt from the agent-home build resolved a retired model name and failed with `model_not_found`, and was re-run from the worktree build, which resolves `gpt-6-astra`). Gemini is not authed on this machine (`gemini-not-authed`). The Anthropic clean-door family answered `override-not-frontier` and did not review.

## ELI10 Overview

The Instar iPhone app gets its first two screens that can change something, not just show it. **Permission slips** lists requests from agents that are waiting for your approval ("Let Sam deploy to production for 1 hour.") and the slips that are active; you can approve or decline a waiting request. **What I'm allowed to do** lists the agent's feature switches; you can turn one on or off.

In the console each of these needs your dashboard PIN, because the agent itself holds the ordinary access token and must never be able to approve for you. On the phone, each change instead needs a fresh Face ID (or passcode) check by a key locked in the phone's secure chip, over a one-time code from the server that names exactly that change: which request and what it grants, which switch and which way, and for a decline the reason. The server then runs the console's own code, writes the console's own records, and adds which phone did it.

The phone gets nothing the PIN-confirmed console does not have: no revoking or granting slips, no hand-written slips, no approving requests held on other machines, and if no PIN is set at all, nothing. It ships live only on the development agent and dark on the fleet until a real-phone run proves the per-action Face ID prompt.

## Original vs Converged

- **What you approve is what you saw.** At first the signature named only the request id. An agent that can edit its own request file could have swapped the details between your screen and your tap. Now the signature names the hash of the exact proposal you saw, re-checked on the very proposal being approved.
- **Consent you agree to is consent you saw.** Turning some features on records written consent to what they share. At first the phone recorded that consent after showing only "Turn on X?". Now the phone shows the same disclosure as the console (what is shared, where it goes, how to undo), and signs its hash.
- **Dark on the fleet.** The first draft read the switch as "on unless turned off"; it now follows the development-agent gate, consistently in every check.
- **Stricter transport.** Changes are accepted only over the machine's own secure front or loopback, the rule the console sign-in already uses.
- **Multi-machine.** Waiting requests, slips and switches from your other machines are shown read-only and named; only this machine's can be changed here.
- **No stale authority.** A switch that waits behind another one re-checks, right before it runs, that the phone is still the owner's, the feature still on and a PIN still set.
- **Nothing hidden in the records.** Every refusal is audited; a raw Slack id never reaches the phone; a request whose person is not a registered name can only be declined there; a lost answer is shown as "may have happened", never retried by itself.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | security/adversarial/lessons, scale/integration/decision, codex | 9 | 12 | proposal-hash binding, flag consistency (dev gate), local-TLS transport, enrolment availability (`enrol-off`), peer row identity and totals, no read cache, shared switch chain, offWarning, audit text keeps `authorizedBy <ownerDisplay>`, Slack-id-free headline |
| 2 | codex; Standards-Conformance Gate | 4 | 1 | authority re-check inside the switch chain, lost-answer handling, features proxied-on-read, audit of every refusal |
| 3 | internal (all lenses), codex | 3 | 12 | consent disclosure bound into turn-on, full gate re-check (PIN too), unnamed grantee read-only for approve, physical-device check before graduation |
| 4 | internal (all lenses: 0 design), codex | 1 | 9 | challenge body carries `disclosureHash` (code already did) |
| 5 | codex | 0 (one finding labelled design asked for a field that exists: `stateWords` is the notice sentence; clarified) | 2 | wording only |

Standards-Conformance Gate: round 1 ran (3 flags: maturation path, multi-machine, never-silently-cut; all addressed); round 2 ran (2 flags: multi-machine for features, refusal conservation; both addressed); later rounds not re-run (changes were inside already-flagged areas).

Reviewer models: internal reviewers ran as Claude Opus 5.5 subagents (rounds 1, 3, 4); external codex-cli `gpt-6-astra` rounds 1–5.

## Proportion

Tier 2 (new authority from a phone; security-sensitive). Spec ~230 lines; server ~700 LOC new + ~120 changed; app ~650 LOC. 5 rounds of the 6-round cap. In line for a first write path.

## Left behind

- Duplicate `return` / ordering nits in `actionsState` vs the gate (bearer is checked before the feature switch in `actions`; display only).
- Refusals made by the device authenticator (MSP 403, 401, 429) are that layer's records, not in the phone audit file (stated in the spec).
- A phone switching route between challenge and post pays a second Face ID prompt (stated).
- `offWarning` list is a fixed rule (route-cutting or guard-removing switches); other consequences live in each feature's "how to undo".
- Approving an already-approved request returns `alreadyApproved` without the hash check (adds no authority; stated).
- The presence-key enrolment trust root (first enrolment wins; the server cannot see the key's access control) is the console ticket's; stated in §4, not changed here.
- Changing the PIN does not end a phone's authority; removing the phone does (stated in §3.5).
- The physical-device prompt check is a graduation requirement, recorded as unverified on hardware until run.

## Full Findings Catalog

Round 1 (internal security/adversarial/lessons): proposal not bound (design, fixed); flag contradiction (design, fixed); transport weaker than console-ticket (design, fixed); enrolment first-key-wins (design, accepted with stated trust root: the keys are bound to the app's code-signing identity, and code with that control can also read a typed PIN); local-state forgery (honest limit, stated); audit names person (precision, `personId` added); peer row trust (precision, keys machine-qualified, peer text capped); stolen-phone revoke race (precision, stated); tunnel self-lockout (precision, offWarning); L15 engagement (precision, cited in §4); reason hash definition (precision, raw UTF-8 bytes).
Round 1 (internal scale/integration/decision): audit text drops owner name (design, fixed); Slack id in headline (design, fixed); peer fan-out cache rule (design, decided: no cache, bucket bounds); split switch chain (design, fixed: shared); tunnel/guard switches (design, frontloaded 12); pending cap is 10 (fixed); cap stated twice (fixed); store write atomicity (stated: synchronous); locality wording (fixed); feature-read posture (later proxied); migration helper (added); dev-gate entry and decision rows (added).
Round 1 (codex): flag contradiction (dup); enrolment depends on console-ticket switch (design, `enrol-off`); peer aggregation contract (design, totals/`cantTell`/keys); cap and MSP wording (precision, fixed).
Round 2 (codex): queued switch stale authority (design, re-check); lost answers (design, `unknown` outcome); freshness overstated (precision, qualified). SCG: features machine-local (design, proxied-on-read); refusal conservation (design, every route refusal audited).
Round 3 (internal): consent recorded without disclosure (design, disclosure + hash). Precisions: order alignment, headline cap wording, id pattern lower-case, device id in switch context (added), re-check scope (PIN added), authenticator refusals (stated), featureEvidence on gate refusals (left), PIN change (stated), route change (stated), offWarning rule (stated), alreadyApproved (stated).
Round 3 (codex): re-check PIN (design, added); unnamed grantee approvable (design, approve withheld); physical-device check (precision, added to maturation).
Round 4 (internal): 0 design; precisions: switchable-before-disclosure order (fixed), consent sentence only with data (fixed), description fallback to name (fixed), numbering (fixed), dead code (checked), tests listed (written), second prompt on disclosure change (stated).
Round 4 (codex): challenge carries `disclosureHash` (spec fixed; code already did); data-implications wording (fixed); rollback of declines (fixed).
Round 5 (codex): notice sentence (clarified: `stateWords`); decline without hash (clarified); transport wording (fixed).

## Convergence verdict

Converged at round 5. The final round found nothing that changes what gets built; the items above are left behind with reasons. Spec is ready for approval.
