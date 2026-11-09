# Convergence Report — The owner's phone opens Remote Desktop with Face ID, and can show the PIN

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier external pass ran through the agent's codex CLI on all six rounds; each round's spec body had changed, so none was delta-skipped. A clean-door Anthropic read (`claude-code:claude-opus-5-5`, booked separately, not cross-family) also ran on all six rounds. Gemini was detected but not authed (`gemini-not-authed`).

## ELI10 Overview

The Instar iPhone app asked for the dashboard PIN every time you opened Remote Desktop. But you already unlocked the app with Face ID, and the phone is your own paired device. Now the app asks for Face ID instead. The agent then gives the phone a 15-minute pass. The pass works only for Remote Desktop and only from that phone. It ends when you change the PIN, remove the phone, or turn the feature off. The phone is never given the agent's master key.

A browser still asks for the PIN, so the app gets a "Dashboard PIN" page. After Face ID it shows the PIN for the machine you are connected to, with a copy button that stays on this phone and clears after a minute. Wherever the agent has a private chat with you, it tells you there before showing the PIN, so a stolen phone can't read it silently. Agents without one show it with a plain note.

The trade-off: showing the PIN is a real step up in power, because the PIN works from any browser and leads to the agent's master key. The operator asked for it, so it ships only on development agents until it is proven. A safer "approve this browser from your phone" design is queued as a later work (feedback fb-51a654a6-270).

## Original vs Converged

- **The pass got narrower.** The first draft reused the dashboard's own "a human is here" session, which also unlocks feature switches, pairing codes and more. Review showed that was far broader than Remote Desktop. The converged design uses its own pass that only the desktop routes accept.
- **The phone never gets the master key.** The first draft handed the phone the API token, as the PIN unlock does. Now the phone signs each desktop call with its own key instead.
- **The pass is tied to the phone.** The first draft said "revoking the phone ends it", which was false. Now the pass is honoured only on requests signed by the phone that made it, and it ends within a second of the phone being removed.
- **The PIN reveal tells the owner.** The first draft had no notice. Now the owner is told first, wherever a private chat exists. A notice that fails blocks the reveal, and everything is re-checked after the wait. Where no chat exists, the reveal is honest about it rather than pretending to protect anything.
- **The real PIN, never a placeholder.** Review found the reveal could leak the "(check your config)" placeholder. Now only the exact value the browser's unlock checks is shown.
- **Hardening found in the code.** The registry read on every video frame was slow, so the owner check is now reused for a second. The app had a bug where the Face ID sheet itself would drop every answer. The app also had a redirect gap.
- **Proof stays off the operator's chat.** The live proof now runs on a throwaway agent with a test chat.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|---|---|---|---|---|
| 1 | security, adversarial, integration, lessons, decision-completeness, codex, clean-door | 17 | 14 | Desktop-only phone session; no API token; reveal notice; placeholder guard; maturation plan; markers; app wiring |
| 2 | integration, security, codex, clean-door | 9 | 12 | Caller binding; allowlist exactly the app's calls with three buckets; locked/settings dashboard-only; switch-off ends sessions; throwaway-agent proof |
| 3 | combined internal, codex, clean-door | 3 | 7 | Reveal notice must be confirmed (production ownerDM never fails); HTTPS-only app rule |
| 4 | codex, clean-door (internal: none) | 3 | 7 | Post-wait re-check; revealed PIN reaches the API token (stated); honest Telegram-free behaviour |
| 5 | combined internal, codex, clean-door | 4 | 6 | 1-second owner-check memo (sync disk read per frame); app drops late answers; stale statements fixed |
| 6 | combined internal, codex, clean-door | 4 | 8 | Face ID sheet inactive bug; redirects refused; HTTPS before the challenge; caller-binding ratchet test; threshold text |

**Standards-Conformance Gate, by round:**

| Round | Result |
|---|---|
| 1 | ran (2 flags) |
| 2 | ran (1 flag) |
| 3 | ran (2 flags) |
| 4 | ran (2 flags) |
| 5 | unavailable: server warming after a restart, then re-run with round 6 |
| 6 | ran (0 flags) |

**Models.** The internal reviewers ran on the authoring session's model, `claude-opus-5-5`, every round.

## Proportion

Tier 2. The spec is about 380 lines. The server change touches 8 modified files and adds 5, with tests. The app change touches 6 modified files and adds 3. All 6 rounds were used, which is the Tier-2 cap. That is in line with a security-sensitive authority change; most of the design findings were real code-level defects (production `ownerDM` never failing, a per-frame disk read, the Face ID inactive bounce), not wording.

## Left behind

**later work (feedback fb-51a654a6-270), queued:**

- A push notice for reveals on agents without Telegram, and relaying the notice through the Telegram-serving machine (feedback queue).
- API-token rotation from the dashboard, so the reveal notice can name it (feedback queue).
- A phone-approved browser sign-in (RFC 8628-style), which removes the need to reveal the PIN at all (proposal).

**Gaps already in the system, filed:**

- The console-ticket gate refuses without an audit row (feedback queue).
- `DirectDesktopAccess` labels phone-minted grants `dashboard-pin:<hash>` (feedback queue).

**Precision later work (feedback fb-51a654a6-270):**

- Reword the CLAUDE.md "never gets an operator session" line to "dashboard-wide" in place.
- Glossary lines for "signed Host", "front" and `validGrant`.
- Unify the expiry format on ISO.
- Include a reveal count in the next notice, so a thief's reveal inside the owner's 10-minute window shows up.

**Decided against, with reasons:**

- A biometry-only presence key: it would differ from every other presence use in the app and lock out owners without Face ID.
- The simpler "never block the reveal" rule: where a chat is reachable, a confirmed notice is cheap and is the owner's only live signal.
- Passing the request principal into the verifier: the `router.use('/desktop')` binding covers every entry, and a source ratchet test now fails the build if a phone session is ever verified outside it.

**Signal-only constitution flags, answered in the spec:**

- *An Instar Agent Is Always a Multi-Machine Entity*: the machine-local markers are `physical-credential-locality`, with reasons.
- *No Manual Work*: the Telegram-free path is the reveal itself, with `noticed: false`, not "ask the agent".

## Full Findings Catalog

These are summarized; the per-round reviewer outputs are in the session record.

**Security and adversarial.** These rounds found:

- the operator-session scope leak;
- false revocation claims;
- the API token surviving both PIN change and phone revocation;
- reveal escalation with no notice;
- the placeholder PIN leak;
- challenge-route gate circularity;
- the app-switcher snapshot;
- caller binding missing;
- the locked/settings scope;
- the per-frame disk read;
- notice delivery never failing in production;
- post-wait authorization drift;
- redirect forwarding.

All were resolved in the design and code.

**Integration.** These rounds found:

- the per-machine PIN claim, which was false under secret sync;
- missing issue wiring;
- the app's `DesktopAPI` contract;
- the front-machine claim;
- the grant outliving the session;
- missing registrations;
- the enrolment dependency on the console-ticket switch;
- the 20/12/240 buckets;
- the `isUnlocked` contract;
- the challenge→Face ID order;
- the ISO expiry parse bug, which predates this spec.

All were resolved.

**Lessons-aware.** These rounds found:

- the console-signin FD2/FD6 and permissions FD4 departures, now named;
- the maturation plan;
- the machine-local markers;
- the CLAUDE.md awareness migration;
- no test traffic on the operator's chat;
- every warning having a path to act.

All were resolved.

**Decision-completeness.** 14 frontloaded decisions, 0 cheap-to-change tags, 4 contested then cleared. No open questions.

## Convergence verdict

The spec converged at round 6, the Tier-2 cap. Round 6 raised four design findings:

- an app bug: the Face ID sheet dropping answers;
- two app network-contract gaps: HTTPS before the challenge, and redirects;
- a stale threshold in the text.

Each was fixed in place (code and spec) without changing the design; none needed a redesign or a seventh round, so they were not re-reviewed. The final constitution gate run shows 0 flags. No open questions remain, and 8 items are left behind with owners. The spec is ready for approval.
