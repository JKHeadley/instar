# Convergence Report — Secret Drop self-mint hardening

> **Disclosure note.** This fixes an issue that is not yet installed, in a public
> repository. The report records the class of each finding and how the design changed.
> Per-finding detail (routes, limits, field names, sinks, vectors, reproduction) is in the
> maintainers' private security ledger (SEC-049, SEC-050) and will be published after the
> fix is installed.

## Status

**Converged at round 10.** Rounds 6–8 kept finding design issues, all in extra machinery
for unproven requests; round 9 cut the design to the smallest fix that closes the hole,
and design findings then fell to one per round, each small and fixed. Round 9: GPT
converged; Claude confirmed the hole is closed and raised one real design point (fixed).
Round 10: Claude converged; GPT raised one small design point (fixed). The fix is ready
for approval and build.

## Overview

The issue: a Secret Drop route trusted "the request came over loopback" as if it meant
"the agent asked", so untrusted caller text could reach an agent session, and could start
a full-permission session, without proof of the agent's key. The fix decides each drop's
authority once, when it is created (proved key, scoped dashboard credential, or keyless),
stores it, and lets only proved-key drops reach a session. Keyless drops keep working as
plain paste pages, bounded per machine and clearly marked unverified, and their wording
never reaches the agent.

## How the design moved, by round (class level)

| round | reviewers | design-class findings (class) | resulting change |
|---|---|---|---|
| 1 | six internal Claude lenses; GPT reviewer failed to run | key check could fail open with no key configured; the "helper can't send the key" premise was false; key possession is a user/network boundary, not owner intent; an unproven drop still yielded a page on the owner's domain; structural fencing doesn't stop plain-language instructions | Full rewrite: honest threat boundary, authority decided at creation, fail-closed key check, untrusted-text handling at every sink |
| 2 | internal lenses; GPT failed | encoding not context-aware; a home-grown de-duplication was itself racy; untrusted-text handling covered one sink only | Context-correct encoding; reuse existing durable machinery; handling at every sink |
| 3 | internal lenses; GPT failed | none (precision only) | Precision folded in |
| 4 | Claude + GPT (first successful cross-model rounds; two passes) + conformance gate | the admission check described did not enforce the stated policy; a submitted drop with no notice had no place the owner could find it; part of the design depended on telling forwarded from local traffic; migration statements contradicted each other; the peer-signature encoding was ambiguous | Received-drop listing; no reliance on traffic origin; a peer signature authorizes only the transfer; encoding issue split out as SEC-056 |
| 5 | Claude + GPT | some browser requests still passed admission; stored keyless drops were never released; owner-only reading not established in the no-key state; keyless accounting had no defined lifecycle | Browser-proof admission; authority classes; bounded keyless drops; step-up for scoped reads; no-key state named as a residual |
| 6 | conformance gate, then Claude + GPT on the revised text | standards possible-violations (data cut, machine-local storage, breadth of refusals) | No automatic deletion; unified storage with per-machine counting; minimal validator. Claude + GPT findings on that text are listed below |

| 7 | Claude + GPT | a freed slot was not released across machines; some caller-chosen identifiers still reached the agent | Cross-machine release; server-chosen identifiers |
| 8 | Claude + GPT | the round-7 additions had their own design gaps (release bookkeeping, identifier collisions, an unclassified creation path) | Count not falling: cut decided |
| 9 | Claude + GPT (cut design) | GPT: none. Claude: the hole is closed; one identifier-safety point where text could reach a command line | Identifier safety for every non-master request |
| 10 | Claude + GPT (confirmation) | Claude: none. GPT: the same safety point for identifiers stored before the update | Unsafe stored identifiers are referred to by position |

The keyless-request bound, cross-machine listing and server-chosen identifiers from rounds
5–8 are deliberately deferred as follow-up work.

## Cross-model review

Rounds 1–3: the GPT reviewer was installed but failed on every attempt (internal CLI
error), so those rounds rested on Claude reviewers only. From round 4, GPT reviews ran
successfully and contributed design findings in every round. Gemini cross-checked the
original finding. Grok was unreachable.

## Proportion

Tier 2 (security-sensitive: authentication gate, untrusted-text handling, session-start
gating). The 6-round cap was passed because rounds 6–8 kept finding design issues; the
"two rounds without a drop, cut to the smallest fix" rule triggered the round-9 cut, after
which it converged in two rounds.

## Convergence verdict

Converged at round 10. Detail per finding is in the private ledger until the fix is
installed.
