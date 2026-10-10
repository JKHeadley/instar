# Convergence Report — A2A local-route signed envelope

**Spec:** [docs/specs/a2a-local-route-signed-envelope.md](../a2a-local-route-signed-envelope.md)
**Slug:** `a2a-local-route-signed-envelope`
**Converged at:** 2026-10-10
**Iterations:** 6

## Cross-model review: codex-cli:gpt-6-astra

A real outside (non-Claude) review ran through the codex CLI in all six rounds, each on a changed spec body. A clean-door second read on `claude-fable-5` ran in rounds 1 and 2 (`clean-door-anthropic-review: claude-code:claude-fable-5`); it is a second read, not a cross-model opinion. Gemini was not signed in on this machine (`gemini-not-authed`), so there was one outside family, not two.

## How this review stopped (read this first)

The skill's rule is two consecutive rounds with no finding that changes what gets built. **This review did not reach that.** Every round, including the sixth, produced at least one finding the reviewers labelled as changing the build. What changed is their size:

| Round | Build-changing findings | Largest one |
|---|---|---|
| 1 | 18 | the first-contact key fetch wrote the shared registry file, in watch-only mode too |
| 2 | 9 | parked messages were checked before any peer was listening |
| 3 | 3 | the 24-hour evidence did not survive a restart |
| 4 | 4 | a parked message held after a long outage was never reported |
| 5 | 2 | the round-4 fix let a forged message lock the real sender out |
| 6 | 2 | the agent-facing text named the wrong evidence for the switch-on decision |

The review was stopped after round 6 under the operator brief for this work ("keep it short and stop when findings stop changing the build"). By round 6 the findings were about a paragraph of shipped guidance text and one counter; nothing touched the wire format, the check, the modes or the refusal rules. Round 5 showed the loop had started to feed on itself: a round-4 patch created the round-5 finding. That was answered with a cut (the patch was reverted and the evidence moved to its own file), not another patch. The round-6 edits were applied and were not reviewed again.

## ELI10 Overview

Two agents on one computer can pass messages through a shortcut that skips the internet relay. The relay checks a digital signature on every message. The shortcut never did: it believed whatever name the sender wrote, and only checked a password-like token any program on the computer could read.

This design makes every agent sign what it sends over the shortcut, and gives the receiver a check with a three-position switch: off, watch-only, and enforcing. Watch-only checks every message and writes down what would have been refused, but delivers everything. Enforcing refuses a message that fails, before it is recorded anywhere. Ordinary agents start at off, a development agent starts at watch-only, and nobody starts at enforcing.

The main trade-off: until an agent is moved to enforcing, the check protects nothing on that agent. It only measures. The design says so, shows the position on each agent's health page, and lets a sender that must have the proof ask for it per message and be refused if it cannot be given.

## Original vs Converged

- **Originally** the check was on for everyone with no switch. **Now** it is off on ordinary agents, watch-only on development agents, and enforcing only where someone sets it. The brief for this work asked for that rollout.
- **Originally** a receiver that had never met a sender fetched the sender's key and wrote it into the shared list of known agents. **Now** it keeps that key in memory only. Writing the shared list changed where the agent sent its own messages and how it judged trust, even in watch-only mode, and could be silently undone by another part of the server that rewrites the same file.
- **Originally** a message parked for an offline agent was not signed at all, so an enforcing receiver would have deleted every one. **Now** the sender signs before it decides whether to post or park, and an enforcing receiver never deletes a parked message on first look: it holds it, tries again five minutes after start (when other agents are up and their keys can be fetched), and only then expires anything older than seven days.
- **Originally** a refused message on one of the two sending paths was parked and later delivered with no check. **Now** an explicit refusal is final on that path.
- **Originally** the plan to move Echo to enforcing rested on counters that reset at every restart, read from a log that keeps only a few hours. **Now** every check writes one row to its own small log file, and a 24-hour window the file does not cover counts as "unknown", which blocks the move.
- **Added:** a sender that must never deliver an unproven message (Dawn's backup route) can say so on each request, and a receiver that is not enforcing refuses it. A fixed test vector lets a second implementation prove it produces the same signed bytes.

## Iteration Summary

Internal reviewers ran on the authoring session's model (Opus 5.5). Round 1 ran the six perspectives as six reviewers. Rounds 2–6 ran the same six perspectives as three reviewers holding two each (security + adversarial, scalability + integration, decision-completeness + lessons-aware), to bound cost on a machine shared with four other builders.

| Iteration | Reviewers who flagged | Build-changing / wording | Spec changes |
|---|---|---|---|
| 1 | all six, codex, clean-door | 18 / 9 | registry write removed (in-memory key cache); sign before post-or-park; held parked messages; per-sender replay bound; mode in the answer; maturation plan |
| 2 | all six, codex, clean-door | 9 / 8 | two-pass pickup; wider signed transport set; key uniqueness across both sources; one signer factory; test vector |
| 3 | all six, codex | 3 / 9 | evidence carrier; colliding probe is a failed probe; held-report dedupe |
| 4 | all six, codex | 4 / 5 | shutdown flush; candidate-key rule; verifier error at pickup holds |
| 5 | security/adversarial, scalability/integration, codex | 2 / 5 | CUT: candidate-key rule reverted; dedicated audit file replaces counter lines; requirement header |
| 6 | all three pairs, codex | 2 / 6 | agent-facing text names the audit file; failed-append counter; wording |

Standards-Conformance Gate: ran in every round (3, 2, 2, 2, 1, 1 flags). The flag that stayed to the end is Migration-Consumer Completeness: the proven sender reaches the trust check and the message-id list but not thread attribution, the reply gate or the ack recorder. That is stated in the spec and tracked as ACT-072.

Externals were never delta-skipped: the body changed before every round (hashes `ea849fef`, `c33e568b`, `190e5519`, `8008d1fe`, `a99d99ac`, `69bda1cc`).

## Findings that were not fixed, and why

- **The parked-message folder has no trust check** (codex, lessons-aware, round 1). True today, with or without this change. Tracked as ACT-064.
- **The sender is never told a parked message was held or expired** (round 2). This is a cost this design adds. Tracked as ACT-064.
- **A routine discovery run replaces every recorded key** (security, lessons-aware, clean-door). The spec states how long a key pin lasts. Tracked as ACT-072.
- **A receiver swapped for an older release between a health read and a send ignores the requirement header** (codex, round 6). Stated as a limit; closing it needs a separate endpoint.
- **Same-user processes can sign as anyone.** Out of the threat model, stated.

The tracked-action records for ACT-064 and ACT-074 were written in round 1 and cannot be edited through the API. Where they differ from the spec (ACT-074 says to read the health counters; the spec says to read the audit file), the spec governs.

## Convergence verdict

Stopped at iteration 6 under the brief's stop rule, not the skill's two-quiet-rounds rule. The final round's two build-changing findings were small and were applied without a further round. Decision-completeness counts from the final round: 12 frontloaded decisions, 0 cheap-to-change tags, 0 contested-then-cleared, no open questions.
