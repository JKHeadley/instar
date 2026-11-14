# Side-effects review: native Passwords & keys read

**Change:** `GET /mobile/secrets` for owner phones and the bearer, one `DEVICE_ALLOWLIST` entry, CLAUDE.md template and migration line, capability entry.
**Spec:** `docs/specs/mobile-native-secrets.md`
**Second-pass reviewer:** `claude-code clean-door pass (see below)`

## Decision point

The change widens device-key access by one read-only path. It's an exact-path allowlist entry plus the existing `ownerOrBearer` role check: deterministic authentication, no new judgment. The route blocks nothing else and gates no agent behaviour.

## 1. Over-block

No issue identified for owners. An MSP phone is refused, the same as the other owner reads. A key name shaped like a token is withheld from the list and counted, which can hide a legitimate long name; the screen says so.

## 2. Under-block

The token filter is pattern-based. A short token used as a key path would pass as a name. Key paths are written by the agent's own tools, and the owner already reads them in the console. A request label that holds a token-shaped run has it replaced; a short secret typed into a label would not be caught.

## 3. Level-of-abstraction fit

Right layer: a purpose-built trimmed read, like the other mobile routes. Opening `/secrets/pending` to phones would have handed out the one-time tokens, so this route is the point of the design.

## 4. Signal vs authority

Compliant. This is display data. The allowlist and role check are existing deterministic authentication, not a brittle judgment holding authority over agent behaviour.

## 5. Interactions

Shares the peer read helper with the other mobile routes. A `?scope=local` read never fans out again. It has its own 20-per-minute bucket, so it can't starve the other reads. It reads `SecretDrop.listPending()` without changing it, and the boot inventory read records its usual feature evidence only on the raw route, not here.

## 6. External surfaces

One new route, visible to owner phones. Peers are asked with the agent's own bearer over the existing mesh path. Depends on `mobilePairing` for phones; the bearer path works regardless.

## 7. Multi-machine posture

Waiting requests: proxied-on-read, each machine named, and the all-clear is scoped when a machine doesn't answer. Key names: machine-local, `physical-credential-locality`; a peer gives only a count and vault state. No durable state, notices or generated URLs.

## 8. Rollback cost

Revert the commit. The app then shows "update the agent". The read writes nothing, so there's no data repair.

## Second-pass review (if required)

**Reviewer:** Claude clean-door pass (`cross-model-review.mjs --family claude-code`, fresh context, read the spec, the route, the wiring diff and the integration tests), alongside codex-cli gpt-6-astra across six rounds. Forks can't spawn subagents, so this stands in for the subagent second pass.
**Independent read of the artifact: concur after fixes**

Its last read was MINOR ISSUES and found no leak in the auth checks or field allowlist. Its design points (peer vault unknown, unexpected vault state unrecorded, gate-off branch) were fixed and tested before this commit. No reviewer has read the code after those last fixes.

**Merge note (2026-11-04):** merged main after PR 2763 landed. The two features share the allowlist, routes.ts and the migrator; each conflict kept both sides. No behaviour of this feature changed. Type check clean.

## Independent security review of the peer read (2026-11-04)

An independent reviewer read the final peer code and found no leak of a value, length, token, link or path, and no auth bypass. It found one high fault, now fixed: `phoneText` scrubbed the whole string before cutting, and a scrub pattern is quadratic, so one long string from a peer blocked the server for minutes (measured 51.8 s at 160 KB). Both copies of `phoneText` now cut to the shown length plus a 2,048-character margin first. A new test covers it; before the fix it took 378 s. A secret longer than the margin that starts inside the shown text is only partly scrubbed, and the Passwords text path still hides long opaque runs. Also fixed: a key name is checked for token shape after cleaning as well as before. Left as is, matching the spec: short opaque names under the token thresholds are shown; nothing writes such a name today.

**Order note (2026-11-04):** both this feature and Proposals asked to sit right after the permissions line in the Mobile app routes block. The block now lists permissions, Proposals, then Passwords & keys.
