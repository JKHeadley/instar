# Convergence Report — Message origin on every platform: Telegram, Slack and native app conversations

**Spec:** [docs/specs/message-origin-all-platforms.md](../message-origin-all-platforms.md)
**Slug:** `message-origin-all-platforms`
**Converged at:** 2026-11-03 (round cap reached)
**Iterations:** 3 (the operator's cap for this run)
**Final-round design findings:** 4 (1 internal, 3 cross-model). Each was resolved by a spec addition after round 3; no fourth round re-read those additions, because the run was capped at 3 rounds. Stated here so nobody reads this as a clean final pass.

## Cross-model review: codex-cli:gpt-6-astra

Round 1's external pass degraded (`error`): the installed reviewer resolved the `capable` tier to `gpt-5.5`, which the ChatGPT-account Codex surface no longer serves (`model_not_found`), on every pool account. Rounds 2 and 3 ran from this worktree's fresh build, which resolves to `gpt-6-astra`, and both returned real findings (`SERIOUS ISSUES`, folded in). Gemini was not authed (`gemini-not-authed`). The clean-door Claude reviewer was available but not used.

---

## ELI10 Overview

Justin asked that every message the agent sends say which machine, which "door" (Claude Code, Codex and so on) and which model wrote it: shown by default, hideable, and always recorded on every platform. Telegram already did this. This spec extends it to the Instar iPhone app's own conversations and to Slack, and makes all three show up on the phone.

For app conversations, each agent reply is stored with its origin in the same write, so a reply cannot exist without it. For Slack, every post, edit and file share writes a small origin record first; if that record cannot be written, the message is not sent, and a short pre-recorded notice tells the conversation, so the agent never goes silent. The phone's history reads now return an `origin` block on agent rows, plus the agent's current show/hide setting.

What it deliberately does not do: WhatsApp and iMessage are not covered (tracked as ACT-023), the app's own display and phone-only toggle are app work (ACT-179), app and Slack conversations follow the agent-wide setting rather than per-conversation overrides, and the constitution's rule (which names Telegram) is not edited; the proposed wording is in the spec for Justin.

## Original vs Converged

- **Originally:** the session was identified by a header the caller sent (`X-Instar-Session-Id`). **Now:** it is the session the already-verified conversation bind token names, and the origin credential counts only if it belongs to that session. Why: anyone holding the API token could have named another session.
- **Originally:** only the agent's own Slack replies could be refused, and only `chat.postMessage` was recorded. **Now:** every Slack post, edit, ephemeral and file share is recorded, every one needs its record, and reachability comes from a pre-recorded notice bound to each conversation. Why: the operator's word was "always"; an exemption for server notices contradicted it (cross-model), while refusing everything without a notice would have silenced the agent (internal).
- **Originally:** "not recorded" (`recorded: false`) covered every missing record. **Now:** `false` is used only where this machine wrote the message and has no record; everything this machine cannot know reads `null` with a reason. Why: rotation, archives and other machines made `false` a false statement.
- **Originally:** Telegram rows were looked up one by one through the shared store worker, with a full scan. **Now:** one batched, read-only, indexed lookup per page, bounded at 750 ms. Why: phone polling would have queued behind live sends.
- **Originally:** no Slack footer and a per-conversation Slack override. **Now:** Slack replies carry the same one-line footer as Telegram, escaped and checked by the credential wall; app and Slack use the agent-wide setting, which the agent changes in its own config. Why: the override lane does not work outside Telegram today, and "shown by default" means where Slack users read.
- **Added:** the ledger has an "unavailable" state that retries without a restart; posts and edits are kept apart; receipts are self-contained so rotation never splits a record; the index after rotation equals the one a restart builds.

## Iteration Summary

| Iteration | Reviewers who flagged design issues | Design findings | Precision findings | Spec sections changed |
|-----------|-------------------------------------|-----------------|---------------------|-----------------------|
| 1 | security, adversarial, integration, scalability, decision-completeness, lessons-aware; cross-model degraded (model retired) | 15 | 12 | §2, §3, §4, §5, decisions, posture, tests |
| 2 | integration/scalability (index), decision/lessons (3), cross-model (4) | 8 | 9 | §1, §2, §3, §4, §5, §8, posture |
| 3 | lessons/decision (ledger-unavailable state), cross-model (3) | 4 | 9 | §2, §3, §4, §5, §8, maturation plan, not-covered |

Standards-Conformance Gate: round 1 ran (2 flags: `recorded:false` semantics; Slack refusal vs reachability), plus a parent-fit verdict of "weak" because the parent standard names Telegram. Rounds 2 and 3: gate not re-run (the flags it raised were the subject of those rounds' reviewers).

Per-round internal reviewer model: the authoring session's model (claude-opus-5-5) for all subagents.

## Full Findings Catalog

**Round 1**
- DESIGN (security): caller-chosen session header → bind-token session identity.
- DESIGN (security/adversarial): Slack refusal silences notices and can split chunked sends → scoped refusal (later: all sends + pre-recorded notice).
- DESIGN (security, integration, lessons): `recorded:false` after rotation/archive/other machine → three-valued `recorded`.
- DESIGN (security): AsyncLocalStorage scope too wide → one call, own target.
- DESIGN (integration, lessons): `chat.update`, `chat.postEphemeral`, file uploads unrecorded → all recorded.
- DESIGN (scalability): per-row store lookups contend with sends → batched lookup.
- DESIGN (integration): join key missing chat → chat-scoped.
- DESIGN (lessons, integration): WhatsApp/iMessage unaddressed → tracked ACT-023.
- DESIGN (lessons): Slack-only agents never told of a refusal → in-conversation notice.
- DESIGN (lessons): Slack per-conversation override does not work → dropped.
- DESIGN (lessons): no Slack in-text footer → added.
- DESIGN (lessons): no tests/live-proof section, no off switch → §8, operator exception.
- DESIGN (integration): no machine-local marker → posture rewritten as proxied-on-read.
- MINOR: hostname wording, peer rows, field consistency checks, ledger mode/backup, header visibility, 503 vs 500 branch, `sessionProducer` fall-through, two display sources, migration parity (SHA history, template), health counters, parent-standard wording.

**Round 2**
- DESIGN (scalability): lookup used only the `transport` index prefix → new covering index.
- DESIGN (lessons): "ask the agent" had no write path for app/Slack → the agent sets its own config bits, read live.
- DESIGN (lessons): Slack miss inside the window could read `false` → never `false` for Slack.
- DESIGN (lessons): app-side display untracked → ACT-179.
- DESIGN (cross-model): automation exemption contradicts "always" → every send needs its record, pre-recorded notice.
- DESIGN (cross-model): `ts` not unique across channels; edits vs posts → `(channel, ts)`, revisions kept apart.
- DESIGN (cross-model): multi-call replies → one call per scope.
- DESIGN (cross-model): ledger durability and rotation → fsync, synchronous rotation, rebuild rule.
- MINOR: footer escaping/non-throwing, notice wording, single resolver, tier-word list, source refs not replicated, ACT-023 auto-expiry hold, legacy record without framework, phone toggle scope.

**Round 3**
- DESIGN (lessons): ledger cannot open / bad line → "unavailable" state with retry, never sticky, never throws.
- DESIGN (cross-model): reserved notices not bound to a destination → one reserve per conversation, per incarnation, never reused after restart.
- DESIGN (cross-model): live index vs restart index after rotation → self-contained receipts, one rebuild rule.
- DESIGN (cross-model): footer bypasses disclosure review → labels are operator-owned, credential wall on the footer, not the LLM tone review.
- MINOR: notice receipt carries channel; no notice for ephemeral/edit/file share; off switch only on a verified operator's instruction; Telegram miss reason `not-found`; `session-launch` label; `SlackLiveSender` out of scope; approval note names what is not covered; contradictory refusal test.

## Proportion

Tier 2 (new authority to refuse Slack sends; a fleet-wide recording change). Spec ~190 lines; 3 rounds of a 6-round Tier-2 cap, stopped at 3 by the operator's run cap.

## Left behind

- Round 3's four design findings were folded into the spec without a fourth review round (cap). The build implements them and the tests exercise each (ledger unavailable/retry, per-conversation reserve, rotation rebuild equality, footer credential check).
- Standards-Conformance Gate not re-run after round 1.
- Constitution wording for "every platform" is proposed, not applied (Justin's decision).
- WhatsApp and iMessage recording: ACT-023 (auto-expiry hold set). App display and phone toggle: ACT-179.

## Convergence Verdict

Stopped at round 3 under the operator's 3-round cap. Every finding raised in the three rounds is resolved in the spec; the four from the last round have not had a confirming read. The design adds no new authority beyond what Justin's 12:10 message asks for: the only refusal is "no origin record, no Slack send", taken from his "ALWAYS required to be recorded", with an operator-set exception. The constitution change stays his to approve.
