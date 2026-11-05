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
