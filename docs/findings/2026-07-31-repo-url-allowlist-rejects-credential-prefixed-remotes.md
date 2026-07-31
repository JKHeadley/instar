---
title: "A credential-prefixed remote URL can never match the repo allowlist, so every instrument that resolves the instar repo reports 'you have no repo' instead of 'your URL has a userinfo prefix'"
date: 2026-07-31
author: echo
machine: Mac Mini
severity: high
status: open
kind: finding
relates:
  - "src/core/InstarWorktreeManager.ts"
  - "docs/specs/AGENT-WORKTREE-CONVENTION-SPEC.md"
  - "docs/findings/2026-07-31-accumulating-memory-never-synthesises.md"
---

## The claim

`resolveInstarRepo` validates a candidate by comparing its `remote.origin.url` against an allowlist
with an **exact string match**:

```ts
remote.ok && remote.stdout && allowlist.has(remote.stdout) ? remote.stdout : null;
```

A clone configured by a token-authenticated tool carries the credential username in the URL:

```
https://x-access-token@github.com/JKHeadley/instar.git
```

The allowlist holds the canonical form (`https://github.com/JKHeadley/instar.git`). The two differ
only by the `x-access-token@` userinfo segment, so the match **can never succeed**, and the repo is
rejected as not-ours no matter how correct it is.

`x-access-token` is a literal placeholder username, not a secret — the credential itself lives in a
helper. So this is not a case of a secret leaking into config; it is a case of a **cosmetic URL
variant defeating an identity check**.

## Blast radius — measured, not assumed

On this machine the agent's clone carried that prefix. Four independent instruments were blind at
once, and **each reported a different local symptom**:

| instrument | what it reported | what was true |
|---|---|---|
| `instar worktree create` | `no candidate passed integrity validation` | the repo was there and valid |
| green-PR auto-merge | `no analyzable instar repo + safe-merge, or disabled` | (also disabled — see limits) |
| `AgentWorktreeDetector` | no repo to scan | — |
| conformance / standards audit | **`analysable: true`** against a stale tree | the worst one: a confident yes |

Not one of them said *"the remote URL has a userinfo prefix and therefore failed the allowlist."*
The operator-visible surface is four unrelated-looking failures with four unrelated-looking causes.

A fifth symptom rode along, unrecognised for hours: `git push` on that clone prompted for a
password every time (`could not read Password for 'https://x-access-token@github.com'`), because
the URL pins a username the helper is not supplying a password for. I worked around it all evening
with an inline credential helper before connecting it to the same root.

## Why this shape matters more than the bug

This is the same defect class as `2026-07-31-accumulating-memory-never-synthesises.md`, one layer
down: **an instrument that cannot reach its subject reports a local excuse rather than naming what
it looked for and what it found.** The audit case is the dangerous one — it did not fail, it
succeeded against the wrong tree and returned a confident yes.

## Proposed fix

1. **Normalize before comparing.** Strip the userinfo segment from both the candidate remote and
   the allowlist entries before matching (`https://user@host/path` → `https://host/path`). Keep the
   comparison exact after normalization — this widens the match by exactly one cosmetic dimension,
   not by loosening host or path.
2. **Name the near-miss in the failure text.** When a candidate is rejected *and* its normalized
   form would have matched, say so: `remote URL matches the allowlist except for a userinfo prefix
   ('x-access-token@') — strip it with 'git remote set-url'`. A rejection that names the one-token
   difference is self-serving; `no candidate passed integrity validation` is not.
3. **Do not add `.dev/instar` to the fallback chain.** It is this agent's private layout, present on
   1 of 9 agent homes here and referenced nowhere in the source. `INSTAR_REPO` is the documented
   override and is the correct answer for a non-standard location.

## Honest limits

- **The green-PR auto-merge case is not attributable to this bug.** After fixing the URL its route
  still reported not-configured, and its config shows `enabled: false` with an empty
  `expectedGhLogin` — it is switched off. Its error string conflates the two causes ("no analyzable
  instar repo + safe-merge, **or disabled**"), and I initially read only the first clause and was a
  step away from editing this machine's launchd plist for a cause that was not there. The row is
  kept in the table because the *message* is genuinely ambiguous, which is its own finding.
- The conformance-audit row is a **separate, already-filed defect**
  (`2026-07-31`/`2026-07-30-conformance-audit-probes-a-stale-tree.md`): it resolves source from the
  agent home and finds its landmarks in a 28-May copy. Fixing the allowlist does not fix that; both
  are instances of the same class, not the same bug.
- Fix verified only in the negative direction: after `git remote set-url origin` to the canonical
  form, `resolveInstarRepo` accepts the clone (it now fails later, on an unrelated husky PATH
  issue, which is a legitimate refusal). The proposed normalization itself is **not** yet
  implemented or tested.
