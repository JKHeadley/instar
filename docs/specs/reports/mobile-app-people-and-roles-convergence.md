# Convergence Report — Each paired phone belongs to one named person, with a role (owner or MSP)

## Cross-model review: codex-cli:gpt-6-astra

The external pass ran in all four rounds through the Codex CLI (gpt-6-astra, read-only, via `skills/spec-converge/scripts/cross-model-review.mjs --family codex-cli`). Each round returned "SERIOUS ISSUES". The findings narrowed every round, from four design gaps in round 1 to one narrow mixed-version edge in round 4, which is queued as fb-e8327f7f-4d4. The Gemini family was unavailable (`gemini-not-authed`).

## ELI10 Overview

An agent's iPhone app used to assume every paired phone was the owner's. Now each phone belongs to one person from the agent's own list of people, as the owner or as an MSP (the company that runs the agent for the owner).
- Messages from an MSP phone carry the MSP's name and never the owner's Telegram or Slack identity.
- By default an MSP can't open the owner's private app chats or use Slack. Only the owner's phone can switch either one on for an MSP.
- Every phone paired before this change counts as the owner's.
- A phone whose person was removed from the list stops working, rather than turning into an owner phone.

## Original vs Converged

- **Every route that names a conversation is covered.** Originally only list, read, send, rename and delete were limited. Five more device routes (sync events, preview, media download, upload, purge) could reach the owner's chats. Now one shared check guards all of them, a test fails if a new conversation route is not flagged, and reply pushes go only to phones the check allows.
- **No borrowed authority.** Originally an MSP phone would have passed its own Telegram id, which the device path treats as a proven Telegram sender. Now an MSP phone passes no Telegram id at all. When granted Slack, it speaks with its own Slack id, never the owner's, and a profile carrying the owner's Slack id counts as the owner.
- **The API token can only lower access.** Originally it could reassign any phone, including raising one to owner, or moving an MSP's phone to another MSP who holds the owner's grants. Now it may only turn an owner phone into an MSP phone.
- **Person references are machine-namespaced**, using the same machine id the conversation store stamps. Registry ids are local to each machine.
- **Rollback fails closed.** Unknown roles are refused, and the spec says how a revert must keep that rule.
- **The owner's switch was added** after the operator's 10:29 answer: owner-phone-only, off by default, with a read route the agent can use to answer questions.
- **Honest wording.** The owner default is a compatibility assumption, not proven identity, and the mixed-version edge is a recorded limit.

## Iteration Summary

| Iteration | Reviewers who flagged design | Design findings | Spec changes |
|-----------|------------------------------|-----------------|--------------|
| 1 | internal (security, adversarial, integration, decision-completeness, lessons), codex, conformance gate (3 flags) | 9 | shared check over every conversation route; MSP sends no Telegram id; reassign never raises to owner; machine-namespaced person refs; structured sender through dispatch; rollback guard; owner default justified; history from stored sender |
| 2 | codex | 3 (+1 precision) | reassign never moves sideways; Slack rows follow the grant; mixed-version behaviour stated; compatibility wording |
| 3 | codex | 2 (+1 precision) | reply pushes filtered by the check; mixed-version claim corrected |
| 4 | codex | 1 new (mixed-version persistence), 2 already built | notify-token branch stated; aggregate count stated; mixed-version persistence queued as fb-e8327f7f-4d4 |

Standards-Conformance Gate: round 1 ran (3 flags: Know Your Principal on the owner default, Truthful Provenance on history fallback, multi-machine on local ids). All three were addressed in round 1.

Code review (independent subagent, after the build): no BUG. Two RISKs were fixed: the machine-id source, and the owner's Slack id on an MSP profile. Two ordering NITs were fixed.

Internal reviewer model: claude-opus-5-5 subagents.

## Proportion

Tier 2: identity and authority on an auth surface. The spec is about 160 lines and the code about 700 LOC plus tests. It used four rounds of a six-round cap. Each round's findings were narrower than the last, and round 4's only new point is a mixed-version edge needing four simultaneous conditions.

## Left behind

- Mixed-version stripping of `ownerPerson` by an older peer (spec §8.2): queued as feedback fb-e8327f7f-4d4.

## Full Findings Catalog

- Round 1 internal:
  - five uncovered device routes (fixed);
  - MSP Telegram id trusted as a proven sender (fixed);
  - MSP device list visibility (fixed);
  - shared Telegram topics made explicit;
  - replay timing stated;
  - "not the owner" rule stated;
  - rollback field handling tested;
  - pool row field named.
- Round 1 codex:
  - bearer reassign to owner (fixed);
  - local user ids across machines (fixed with the namespace);
  - structured principal through dispatch (fixed);
  - rollback escalation (guard + procedure).
- Round 2 codex:
  - sideways reassign (fixed);
  - mixed-version stripping (stated);
  - Slack list vs grant (fixed);
  - owner-default precision (fixed).
- Round 3 codex:
  - mixed-version claim (corrected);
  - push privacy (fixed in code: `mayNotify`);
  - legacy attribution wording (fixed).
- Round 4 codex:
  - mixed-version persistence (queued);
  - notify-token branch (already built, now stated);
  - aggregate count (stated: a bare number).

## Convergence verdict

Converged under the 80/20 bar. No open design question remains. The only remaining finding is a narrow mixed-version edge with a tracked queue item, and every other finding is built and tested.
