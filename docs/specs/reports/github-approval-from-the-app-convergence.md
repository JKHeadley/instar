# Convergence Report — Approve a code-owner pull request from the owner's phone, verified on GitHub

## Cross-model review: codex-cli:gpt-6.2-astra

A real GPT-tier external pass ran through the agent's codex CLI on all six rounds (status ok each round). Gemini was not authed on this machine (`gemini-not-authed`); the Anthropic clean-door reviewer was not run.

## ELI10 Overview

When a change touches a file only the owner may approve, the agent's "Needs you" list told the owner to approve on GitHub, but the phone had nothing to tap and the dashboard had no link. This spec makes the row carry the pull request's title, the protected files it changes, a GitHub link and the exact version, and lets the owner approve with Face ID in the Instar app. The agent then records the approval in the owner's own GitHub browser profile and only calls it done when GitHub shows a new approval by the owner at exactly that version.

It matters because it replaces a habit where the agent approved on a chat "yes" (not proof a person decided) with a tap only the owner's phone can make. The main tradeoff: a browser cannot tell GitHub "approve exactly this commit", so there is a sub-second window between the last version check and the click. That is covered by an immediate hold on the pull request if it ever happens, by the fact that a new version cannot merge until its own checks pass, and by a live proof on a throwaway repository that must pass before the feature is switched on.

## Original vs Converged

- Originally the console could approve with the dashboard PIN. Review showed any local agent session can read the PIN, so a PIN approval would let the agent approve a constitution change in the owner's name. The console route was removed; only the owner's Face ID tap approves.
- Originally the approve call waited up to two minutes. The app gives up after 30 seconds and the server cuts requests at 30 seconds, so it now answers within 25 seconds or says "still running", and the phone reads the result by attempt id.
- Originally any PR number could be approved. Now only the agent's own PRs whose changed files are owned by the owner under the CODEOWNERS file at the PR's base commit (last matching rule wins), judged live so it works whichever machine holds the merge lease.
- Originally the head was checked once before the browser opened. Now it is required at the challenge, stored with it, checked again by the script right before the click, and an approval that lands elsewhere puts the PR on hold.
- Originally a pre-existing older approval could be misreported; now only a NEW owner review counts. Attempts are durable, a restart kills any leftover approver (only while it is still the approver process) and settles the attempt from GitHub before a new tap runs.
- Added: pinned playwright-core only, vault and profile checks in availability, typed vault bindings, TOTP codes never reused, pending-review and two-factor-method stops, the awareness entry, and the gating live race proof.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | security, adversarial, integration, scalability, decision-completeness, lessons-aware, codex | 20 | 9 | PIN route dropped, 202 + polling, scope to owner PRs, HOLD, new-review-only, pinned playwright, availability checks, awareness |
| 2 | combined internal, codex | 9 | 4 | live owner-path precheck, head stored with challenge, vault bindings, per-profile lock, HOLD retry, TOTP step |
| 3 | combined internal, codex | 5 | 3 | agent-PR check, base-commit CODEOWNERS with last-match, full GET answer, race proof gate, split-machine posture |
| 4 | combined internal, codex | 6 | 3 | pending-review, hold stays until released, 2FA method stop, durable attempts + reconcile, CODEOWNERS search order |
| 5 | combined internal, codex | 5 | 3 | orphan approver killed before reconcile, verification-pending settled later, attempt ids, TOTP floor |
| 6 | combined internal, codex | 5 (2 accepted at cap) | 4 | settle every attempt before a new tap, pid + start-time checks, 25 s from arrival with a 10 s read deadline, CODEOWNERS `*` anchoring |

Internal reviewers ran as Claude subagents on the authoring session's model (claude-opus-5-5); round 1 used three subagents covering two perspectives each, rounds 2 to 6 one subagent covering all six perspectives. The Standards-Conformance Gate ran in round 1 (not degraded); its at-risk items (Judgment Within Floors, data cut, Verify the State, Know Your Principal, Mobile-Complete, Multi-Machine, Live-User-Channel Proof, Maturation Path) were folded into round 1's findings.

## Proportion

Tier 2; spec about 330 lines; 6 of 6 rounds used. The effort is in line with an action that records a durable approval in the owner's name on an external system.

## Left behind

- Accepted at the cap (codex, rounds 1 to 6): a browser submission cannot pass GitHub an explicit `commit_id`. Reason accepted: the last head check is immediately before the click; an approval that lands on another head is held at once (retried once, the owner told in plain words if the hold fails); a new head cannot merge before its own checks pass (minutes to about 45 minutes); and the switch is turned on only after the live race proof (Acceptance 8b) shows GitHub does not record the approval on a newer commit. If that proof fails, the switch stays off and only the links ship. Reported to the operator through the caller's handoff, since it is a security-relevant acceptance.
- Accepted at the cap (codex, rounds 3, 5, 6): when the merge lease is on another machine, the profile machine's rows may lag its own snapshot. The precheck is live, so a shown row is approvable, and every row carries the GitHub link. There is one profile machine today, which is also the serving machine.
- Codex round 6: carry the repository from row to challenge and pin a base...head comparison link. Not taken: the repository is fixed per agent (the watcher's configuration), and the head bound to the challenge refuses any version other than the one shown.
- Precision: the profile lock is taken only by this service (hand-run use is caught by Chrome's own profile lock as `profile-busy`).

## Full Findings Catalog

Round 1 (security/adversarial): PIN not proof of a human (DESIGN, resolved: route dropped); any PR number accepted (DESIGN, resolved: owner-path + agent PR scope); title-only summary (DESIGN, resolved: all owner files + link; head binding); browser head pinning (DESIGN, residual above); registry identity trust (DESIGN, resolved: CODEOWNERS owner check, review `user.login` match, script checks signed-in login); parallel owner-approval mechanism (DESIGN, resolved: the permissions-challenge gate is the same owner-phone presence gate account sign-in uses; the SEC-018 pending-card path is for agent-initiated handlers and is off by default); chat-yes basis (DESIGN, resolved: awareness says the tap replaces it); buildAction field, sign-in outcomes, timeout kill, cross-machine availability, profile lock (PRECISION, resolved).
Round 1 (integration/scalability): 120 s vs 30 s limits (DESIGN, resolved: 202 + GET); profile machine vs lease holder (DESIGN, resolved by live precheck + posture); app work unowned (DESIGN, resolved: the app build session owns it and set the contract); stale snapshot wastes Face ID (DESIGN, resolved: precheck at challenge); availability gaps (DESIGN, resolved); episode rows without head (DESIGN, resolved: link only); awareness file (DESIGN, resolved); test tiers (DESIGN, resolved in Acceptance); lock scope, config default, field list, row lingering (PRECISION).
Round 1 (decision-completeness/lessons): reuse the SEC-018 card (DESIGN, declined: the app session already builds against the dedicated route); app work route (DESIGN, resolved); PIN row (DESIGN, resolved); sync wait (DESIGN, resolved); missing head field (PRECISION, superseded by the gh re-read); wrong-head notice (DESIGN, resolved: HOLD + plain answer); owner identity definition, fixed limits, informed approval, switch timing, headless sign-in, gate traps (resolved).
Round 1 (codex): phone flow unspecified (resolved: the app owns its button against the shipped routes); commit binding (residual); playwright from npm cache (resolved); repo consistency (resolved: watcher repo first); pre-existing approval (resolved).
Rounds 2 to 6: as summarized in the Iteration Summary; each resolution is reflected in the spec text.

## Convergence verdict

Converged at the round cap (6). The last round's internal findings were all resolved in the spec and the draft implementation; two codex design items remain and are accepted above with reasons and a gating live proof. Spec is ready to approve and build.
