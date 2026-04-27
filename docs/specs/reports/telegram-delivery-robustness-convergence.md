# Convergence Report — Telegram Delivery Robustness

## ELI10 Overview

You sent a message to one of your agents, and it actually wrote you a clean, helpful answer back. But you never saw the answer. The agent thought it was sending it. The phone showed nothing. That happened because the little script the agent uses to talk to its own server got the wrong door — knocked on a *different* agent's door by mistake, and that door correctly said "you're not the right person, go away." The answer was real, the agent thought it succeeded, and the message dropped into a hole nothing was watching.

This spec fixes that in three layers. First, the door problem itself: scripts now read where their own server lives from a single source of truth, not a stale default. And servers now check that the visitor is actually one of their own — even if you somehow walked up to the wrong door with the right name, the wrong server now refuses to even read what you came to say. Second, when delivery fails for any reason that's not "the user isn't allowed to hear this," the message is parked in a small per-agent database. Third, a little watcher checks that database, fixes the configuration if it can, retries with backoff, and ultimately gets your message to you on the same conversation it was meant for — never on a generic alert channel unless that conversation itself is broken.

Two real-world things change for you. One: when an agent has a working answer for you, you'll get it — even through a brief outage, even if the configuration was momentarily wrong. Two: if delivery genuinely can't be saved, you'll be told *on the same topic*, with a fixed-template message that doesn't quote the original (which keeps the existing tone-of-voice safety in place). The lifeline channel only fires if even the topic is dead.

## Original vs Converged

The first version of this spec was about right in shape — three layers, fix the bug, queue failed deliveries, sentinel retries them — but the review process changed it substantially in three architectural ways and tightened it in twenty smaller ways.

**The biggest architectural change:** the original spec said "if the script hits the wrong server, just resolve to the right port and try again." Two reviewers (security and adversarial) pointed out that this *recreates* the originating incident on every retry tick — the recovery code itself sends an auth token to a server that isn't this agent's server. The fix is server-side: tokens now have to be presented alongside an agent-id header, and the server checks the agent-id matches *before* it even looks at the token. So a token sent to the wrong server is structurally inert, regardless of whether the script bug recurs. That's a much stronger guarantee than "just be careful about ports."

**The second architectural change:** the queue moved from a flat append-only file to a per-agent SQLite database. Three reviewers (Gemini, Grok, GPT — all external) flagged that an append-then-rewrite text file is racy in ways Claude reviewers don't naturally catch — it falls apart on Docker volumes, NFS, and concurrent script invocations. SQLite gives proper atomic transactions, indexed dedup lookups, and an OS-managed lockfile via `flock(2)` instead of a hand-rolled heartbeat. Multi-machine git-sync replay (which would have been catastrophic — machine A's stuck queue replaying on machine B as duplicate user messages) was also closed by ensuring the new database files are git-ignored.

**The third architectural change:** the original spec planned to append a "(recovered)" tag to the recovered message. Gemini caught that this would push messages near Telegram's 4096-character limit over the edge, and an internal reviewer caught that the tag would break code blocks ending the message. The tag is now a separate fire-and-forget follow-up reply, sent only after the original is confirmed delivered, and never queued itself. So the meta-information is operator-visible without corrupting the actual message.

The smaller tightenings include: SQLite must use WAL journaling (otherwise a stampede after an outage would deadlock the database), bootId must come from real cryptographic randomness (not start-time + hostname, which is guessable), the templates allow-list for sentinel-emitted system messages must be compiled into the binary (not a writable file, which would be a tone-gate bypass surface), the daily templates-drift verifier got a kill switch for operators with intentional customizations, and the "templates drift" hardening that was originally deferred to a follow-up PR got pulled into this PR — leaving an orphan TODO would have repeated a known anti-pattern.

The single most important property the converged spec has that the round-1 spec didn't: **no code path can send an auth-bearing request to a server that isn't this agent's server, even on the recovery path.** That's the structural fix; everything else is service quality.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | Security, Scalability, Adversarial, Integration, GPT, Gemini, Grok | 40+ | Comprehensive rewrite — 9 new sub-sections, ~80% of round-1 §4 reshaped, JSONL→SQLite, /whoami added, agent-id binding added, recovered marker re-shaped, multi-machine + privacy + telemetry sections added |
| 2 | Security, Scalability, Adversarial, Integration | 20 | Tightenings — WAL pragma, bootId crypto.randomBytes, templates allow-list compiled-in, marker fire-and-forget, agentId-infix paths, sqlite3 CLI fallback, cross-version upgrade paths, /whoami cache, 32KB text cap, max-concurrency 4 |
| 3 | Convergence-check (single reviewer covering 4 perspectives) | 0 | (converged) |

## Full Findings Catalog

The full per-reviewer finding lists for round 1 are catalogued in the spec itself at §10. Round-2 findings are summarized as the diff between rev-1 and rev-2 of the spec. Round-3 produced a 20-line resolution checklist (all closed) and an explicit "no new material findings."

Reviewer transcripts retained at:
- `/Users/justin/.instar/agents/echo/.claude/skills/crossreview/output/20260427-112255/{gpt,gemini,grok}.md` (external, round 1).
- Internal reviewer outputs in agent task transcripts (round 1 + round 2).
- Round-3 convergence-check output in agent task transcript.

## Convergence Verdict

**Converged at iteration 3.** No material findings in the final round. Two non-material observations were noted for documentation (the suspended-state queue growth interaction with the dead-letter cap, and the same-port event POST being correctly gated by agent-id auth) but neither requires a spec change.

The spec is ready for principal review and approval. Both required tags will be present once the user adds `approved: true` to the spec frontmatter:

- `review-convergence: 2026-04-27T18:35:00Z` (this skill writes this)
- `approved: true` (the user adds this after reading)

Without both tags, `/instar-dev`'s pre-commit hook will reject any code commit derived from this spec.
