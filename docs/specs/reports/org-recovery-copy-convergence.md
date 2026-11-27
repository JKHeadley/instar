# Convergence Report — Organization recovery copy

## Cross-model review: codex-cli:gpt-6-astra

An outside review ran through the agent's Codex CLI (GPT-6 Astra) in all five rounds. An internal reviewer ran alongside it and read the spec against the org-pack and members code.

## ELI10 Overview

One Mac holds the key that signs an organization's policy. If that Mac is lost, today everyone has to join again. This lets the admin save a file and six words. If the old Mac is truly gone, a new agent takes over the same organization, and colleagues' agents carry on. If the old Mac might come back, or was stolen, the app says to start a new organization instead, and colleagues move over with one tap. This spec deliberately does not try to catch a returning Mac. It says so plainly and asks the person.

## Original vs Converged

- **When recovery is allowed.** The old address now counts as alive only when it serves a record signed by the organization's key; a 404 or an error page does not. Decryption comes first, since the address is inside the copy.
- **Which policy comes back.** Recovery used to republish the copy's text. Now it finds the newest version available, from the copy, the agent's own version, or a colleague's exported version. It shows where that text came from, and publishes it with a +1000 version jump.
- **Authority that comes back.** Keepers come back in a separate file that the proposal checks never read. Links come back switched off. Members who were joined come back "unconfirmed", so a removal made after the copy can't silently disappear.
- **Durability.** Installation is staged and recorded with a marker that lasts across restarts. The marker blocks proposals and invitations until the first publish.
- **Sizes.** Limits are derived from registries at their full size with multi-byte names, and field lengths are checked as strings before decoding.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Spec changes |
|---|---|---|---|
| 1 | codex 3, internal 7 | 10 | decrypt first, verified-record-only alive check, newest policy, unconfirmed members, keepers "active", marker, publisher entry |
| 2 | codex 4, internal 5 | 9 | crash-safe staged install, keepers in a separate file, unconfirmed defined, recover-latest after install, export route, selfMemberKey |
| 3 | codex 3, internal 3 | 6 | publish lock for imports, jump computed from current.json, size checks, reactivate/discard routes |
| 4 | codex 3 (2 already fixed in code), internal 2 | 3 | source label in the marker, step 4 trimmed, size limits fitted to full registries |
| 5 | codex 3, internal 0 | 3 | limits for multi-byte names, rollback limit stated, string checks before decoding |

## Proportion

Tier 2: it moves the organization's signing key. Findings fell 10, 9, 6, 3, 3, and the internal reviewer found nothing by round 5.

## Left behind

None. Every round-5 point is applied. Not fencing a returning key is a stated limit in §C, and the decision table carries it.

## Convergence verdict

Converged at round 5, with every finding applied. Ready to build.
