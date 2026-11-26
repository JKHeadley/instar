---
title: "Feature switches apply their setting, and say honestly whether it is running"
slug: "feature-transition-applies-action"
author: "echo"
parent-principle: "Verify the State, Not Its Symbol"
eli16-overview: "feature-transition-applies-action.eli16.md"
status: "converged"
review-convergence: "2026-10-26T03:25:00.000Z"
review-iterations: 3
review-completed-at: "2026-10-26T03:25:00.000Z"
approved: true
approved-by: "operator pre-approval — the Echo Bugs brief for topic 10000000857 (.instar/lanes/console-review/feature-enable-brief.md, 2026-10-25) authorizes the 12h autonomous run, the instar-dev gate and a self-merge unless a constitution file changes; exercised by Echo. Convergence report: docs/specs/reports/feature-transition-applies-action-convergence.md"
issue: "docs/issues/feature-switch-never-applies-enable-action.md (Echo Bugs topic 10000000857)"
---

# Feature switches apply their setting, and say honestly whether it is running

## 1. Problem (verified against the code on main 8f6fdb312)

Every built-in feature (`src/core/FeatureDefinitions.ts`) carries an `enableAction` /
`disableAction`: a request (almost always `PATCH /config`) that would change the config
key the feature reads. Nothing ever sends it.

- `POST /features/:id/transition` (`src/server/routes.ts` ~:40069) only calls
  `FeatureRegistry.transition()`, which writes the discovery state to `discovery.db`
  (`src/core/FeatureRegistry.ts` `transition()`), and returns.
- `grep -rn enableAction src/ dashboard/` finds the type, the definitions, a validity
  test and comments. No caller.
- So switching a feature "On" records `enabled` while `.instar/config.json` is unchanged
  and the agent keeps not running it. At the next boot `FeatureRegistry.bootstrap()`
  re-reads config, sees the key off, and silently moves the row back to `disabled`.

Further defects found while tracing, each of which would make "apply the action" still
not work, or make the shown state lie:

- **The switch cannot even record "On" for most features.** The legacy Features tab
  (`dashboard/index.html` `toggleFeature`) posts `{to:'enabled'}`. The state machine
  allows `enabled` only from `interested` or `disabled`; an `undiscovered` feature gets
  422 `INVALID_TRANSITION`. Nine of the thirteen features are `network` tier and also
  require a `consentRecord` the dashboard never sends (422 `CONSENT_REQUIRED`); the one
  `self-governing` feature additionally demands an activation challenge. The discovery
  state machine was built for an *agent* surfacing a feature to a user; it has no path
  for the *operator* flipping a switch.
- **Two actions write keys nothing reads** (review r1). Threadline's action writes
  `threadline.enabled`; the relay reads `threadline.relayEnabled`
  (`src/commands/server.ts` `bootstrapThreadline({ relayEnabled: config.threadline?.relayEnabled })`).
  Autonomous Evolution's action writes `evolution.autoImplement`, which has no consumer;
  `AutonomousEvolution` is on iff the resolved `evolutionApprovalMode === 'autonomous'`
  (`src/commands/server.ts` ~:17638, `AutonomyProfileManager.getResolvedState()`:
  `evolution.approvalMode` else the profile default).
- **Default-on features read as "off" when their key is absent** (review r1). Publishing,
  the tunnel, git backup, the file viewer, input guard and external operations all run
  unless `enabled: false` (`!== false` checks in `src/commands/server.ts`;
  `DEFAULT_FILE_VIEWER_CONFIG.enabled: true`); `resolveConfigValue()` returns false for a
  missing key. Evolution is constructed unconditionally ("always enabled") — its
  `enabled` key is ignored entirely.
- **The tunnel's enable body would overwrite a named tunnel.** `cloudflare-tunnel`'s
  body is `{ tunnel: { enabled: true, type: 'quick' } }`; `PATCH /config` merges one
  level deep, so it would replace an operator's `type: 'named'`. The server already
  defaults `type` to `quick`.
- **The file viewer cannot be switched on if it started off.** `createFileRoutes`
  returned an empty router when `enabled` was false at boot, so the enable target
  `PATCH /api/files/config` answered 404.

## 2. What changes

### 2.1 The transition applies the action, server-side, one switch at a time

`src/core/FeatureActionApplier.ts` exports
`applyFeatureAction(action, direction, target): Promise<FeatureApplyResult>`.

- It sends the action as a loopback HTTP request to the **same socket the transition
  request arrived on** (`req.socket.localAddress` / `localPort`; wildcard and
  IPv4-mapped addresses map to loopback), carrying the server's own
  `Authorization: Bearer <config.authToken>`, `Content-Type: application/json` and
  `X-Instar-Request: 1` (the file-viewer route requires it). 10-second timeout.
- Why loopback rather than a function call: the targets are three different routes
  (`PATCH /config`, `PATCH /api/files/config`, `POST /telemetry/enable|disable`) and
  each already owns its validation (the `PATCHABLE_CONFIG_KEYS` allowlist, the
  executable-selection fence, the CSRF header, telemetry provisioning). Going through
  the route means the applier can never apply something the route itself would refuse.
- **Containment (review r1 §7):** the client sends ONLY the four exact method/path pairs
  in `ALLOWED_FEATURE_ACTIONS`; anything else a definition names is `not-applied`,
  never sent. The action comes only from the static `FeatureDefinition` in code;
  nothing from the request reaches the method, path or body. Redirects are not
  followed (a 3xx is `failed`). A unit test asserts every built-in action is on the list.
- Result (`FeatureApplyResult`): `{ direction, outcome, httpStatus, detail, at }` with
  `outcome` ∈ `applied` (2xx) · `refused` (4xx; the route's error text as `detail`,
  clamped to 300 chars) · `failed` (3xx/5xx, timeout, connection error) · `not-applied`
  (deliberately not sent: not on the allowlist, no auth token, or a non-default user —
  §2.5). A timeout means the outcome is **unconfirmed**: the detail says "it may still
  land", and the shown state re-reads config rather than trusting the result.

`POST /features/:id/transition` runs the registry write AND the apply inside a
**per-feature serial queue** (review r1 §4): two switches on one feature are handled in
arrival order, each waiting for the previous one's route call to answer. **Scope of
that promise (review r2 §4):** a client timeout does not cancel the target handler, so
ordering holds only for handlers that finish their local mutations before answering or
within the client window. All four targets now do: `PATCH /config` and
`PATCH /api/files/config` write synchronously; `POST /telemetry/enable` writes before
answering; `POST /telemetry/disable` was reordered so the local deprovision and config
write happen BEFORE the awaited remote cleanup (5 s timeout, inside the 10 s client
window), so a slow remote cleanup can never land a local "disabled" after a later enable. After the write succeeds
with `enabled`/`disabled`, it awaits the apply, records the result (§2.2), and returns
it as `apply` beside the existing fields, plus `effective` (§2.3) and
`viaOperatorSwitch`. The HTTP status stays 200: the transition did land; `apply.outcome`
says whether the setting followed.

The recorded decision is **not** rolled back when the apply is refused or fails. The
operator's choice is real and must stay visible; the shown state says "switched on, but
the setting is still off: …". There is **no separate retry route** (review r1 §8): the
operator's switch (§2.4) may set the same state again from any state, which re-applies.

### 2.2 The result is recorded on the feature

`feature_state` gains one nullable column `last_apply_json TEXT` (the registry's
existing idempotent `ALTER TABLE … ADD COLUMN` pattern; `SCHEMA_VERSION` → `'5'`).
`FeatureState.lastApply: FeatureApplyResult | null`. The result is also appended to the
discovery-events JSONL as `context: 'apply:<outcome>[ — detail]'` so the audit trail
shows it next to the transition. The column survives a boot reset of the switch, so
the shown state can still name a past failed attempt (§2.3).

### 2.3 The shown state is honest

`GET /features`, `GET /features/:id` and `GET /features/summary` gain, per feature,
`effective`:

```ts
{
  recorded: boolean;         // state.enabled — what the switch says
  configured: boolean;       // the config key now (config.json on DISK over runtime config — see below)
  atBoot: boolean | null;    // the key when this process bootstrapped; null = no snapshot taken
  lastAttempt: FeatureApplyResult | null;
  status: 'on' | 'off' | 'on-after-restart' | 'off-after-restart' | 'recorded-only' | 'not-recorded';
  summary: string;           // one plain sentence for a person
}
```

| recorded | configured | atBoot | status | summary (shape) |
|---|---|---|---|---|
| true | false | – | `recorded-only` | "Switched on, but the setting is still off." |
| false | true | – | `not-recorded` | "The setting is on, but the switch says off." |
| true | true | true | `on` | "On (the setting was on when the agent started; running is not separately verified)." |
| true | true | false | `on-after-restart` | "Saved as on; it may not start until the next restart." |
| true | true | null | `on` | "On in the settings; whether it started is not known to this process." |
| false | false | false | `off` | "Off (the setting was off when the agent started; not running is not separately verified)." |
| false | false | true | `off-after-restart` | "Saved as off; it may keep running until the next restart." |
| false | false | null | `off` | "Off in the settings; whether it stopped is not known to this process." |

Every summary appends, when present: the last failed attempt ("The last attempt to
turn it on was refused: …") — kept in EVERY status, including `off` after a boot reset
(review r1 §6) — and the definition's `honestyNote` (§2.7). A boot flag is not a
successful start (response review can be configured on yet unavailable without an
intelligence provider), so `on` never says "running"; `atBoot` is `null`, never
invented, when no snapshot exists (review r1 §2).

`configured` reads **config.json on disk merged OVER runtime config**. That is
deliberately the reverse of `bootstrap()` (`{ ...rawConfig, ...config }`, runtime wins),
because the routes write the file (telemetry writes disk without touching runtime
config) and the shown state must reflect what was just written (review r1 §5). The
boot snapshot is captured once in `bootstrap()` from its own merged view and never
changes afterwards.

**No prerequisite rule.** A prerequisite-off rule was tried after round 1 and dropped
in round 2: `EvolutionManager` is constructed regardless of `evolution.enabled` and
`AutonomousEvolution` is enabled from the resolved approval mode alone, so
`{ evolution: { enabled: false, approvalMode: 'autonomous' } }` IS autonomous evolution
running — a prerequisite rule would have called it off (review r2 §1). `effective`
reads the consumer's real rule, nothing else.

**Read-only switches.** A definition with `switchable: false` (evolution-system, whose
`enabled` key the runtime ignores) is shown as its key reads (`on`/`off`, `recorded`
following `configured`, never a mismatch) with the honesty note as the sentence, and
`POST /features/:id/transition` to `enabled`/`disabled` is refused with 409
`FEATURE_NOT_SWITCHABLE` — for the operator too. A working-looking switch over an
ignored key would be the original bug in new clothes (review r2 §1).

This is the field the new console page (`dashboard/console/allowed.js`, branch
`feat/console-native-1`) reads. That branch owns `dashboard/console/`; this change does
not touch it and tells topic 127504 the field name when it lands.

### 2.4 The operator's switch is its own consent

`POST /features/:id/transition` accepts an operator path: when the request carries a
valid `X-Instar-Operator-Session` (`ctx.verifyDashboardOperatorSession` — the
15-minute proof `POST /dashboard/unlock` issues on a correct PIN, kept only in the
dashboard's memory) and `to` is `enabled` or `disabled`:

- `FeatureRegistry.operatorSet(featureId, userId, to)` skips the discovery graph (the
  operator is setting a switch, not being surfaced to), writes the state, stores a
  consent record with `mechanism: 'explicit-written'` and the definition's own
  `dataImplications` when enabling a `network`/`self-governing` feature, and logs the
  event with `trigger: 'operator-switch'`;
- the activation challenge for `self-governing` is not required on this path: the
  operator session is the human proof (a PIN-backed issuance, `POST /dashboard/unlock`).
  The legacy challenge is a protocol step for the agent path — the transition hands
  it to the same caller that presents it back, beside a caller-supplied consent record,
  so it cannot by itself establish human presence (review r2 §6). That existing
  limitation is unchanged here.

**Omitted proof vs invalid proof (review r2 §3).** With NO `X-Instar-Operator-Session`
header, every existing rule is unchanged: an agent (Bearer only) walks the discovery
graph and needs a consent record and, for self-governing, the challenge. With a header
that is PRESENT but does not verify (expired after 15 minutes, or forged), the route
answers 401 `OPERATOR_PROOF_INVALID` ("unlock with your PIN again") instead of silently
falling back to the agent path — an expired proof must re-unlock, not strand the switch
behind consent errors. A Bearer caller gains no new reach: it could already send the
same `PATCH /config` directly.

**The dashboard flow (review r1 §3).** The legacy Features tab (`dashboard/index.html`,
not `dashboard/console/`):
1. On enabling a `network`/`self-governing` feature, shows the feature's description,
   data implications and reversibility note in a confirm dialog FIRST — so the consent
   being recorded is consent to something the person saw.
2. Sends the in-memory operator proof. It tracks `operatorSessionExpiresAt` from the
   unlock response; when the proof is missing (page restored from the saved token
   after a reload) or expired, or the server answers 401 `OPERATOR_PROOF_INVALID`, it
   asks for the PIN once, calls `POST /dashboard/unlock` for a fresh proof, and retries
   the already-confirmed switch. This is the one place a PIN is asked for on this tab,
   and only when a valid proof is genuinely absent — the operator's standing rule that
   a PIN must not be stacked on what the Bearer already does is honoured by never
   asking while a valid proof exists.
3. Shows `apply.outcome` honestly: a toast for `refused`/`failed` with the reason; an
   info toast for the after-restart states; the card's sub-line ALWAYS shows
   `effective.summary` (review r2 §2 — a plain `off` after a boot reset still carries
   the refusal reason, and a plain `on` still carries an honesty note), in red when
   the state is a mismatch or the last attempt failed; the detail panel shows the same
   sentence under "Right now". A read-only switch renders disabled with the note as
   its tooltip.

### 2.5 Per-user state, agent-wide config

Feature state is per `userId`, but config is agent-wide. The action is applied only for
the `default` user; any other `userId` gets `not-applied` with
`detail: 'per-user state; the setting is agent-wide'`. **Honest limit (review r1 §7):**
`userId` is a caller-chosen body field, not an identity — this rule stops a multi-user
deployment's secondary users from flipping agent-wide settings by accident; it is not
an authorization boundary (the Bearer holder could send `PATCH /config` directly
anyway).

### 2.6 Bootstrap

`bootstrap()` keeps config as the source of truth. With the action applied, an applied
"On" survives restart because the key is on. A refused/failed one still resets at boot,
and its `lastApply` row stays, so the operator sees "Off. The last attempt to turn it on
was refused: …".

### 2.7 Definitions aligned with their consumers (review r1 §1)

`FeatureDefinition` gains four optional fields: `defaultOn` (an absent key counts as
on), `configEnabledValue` (the key counts as on only at this value), `honestyNote` (a
sentence appended to the shown state where the runtime differs from the key) and
`switchable` (false = read-only). `resolveConfigValue()` reads the first two — and a
per-feature `configuredResolver` installed by `server.ts` for a consumer whose default
lives outside config — so bootstrap and the shown state agree. A section object with
other keys but no boolean `enabled` follows `defaultOn` (review r2: the old "any object
counts as on" read `feedback: { webhookUrl }` as on while the manager treated it as off).

| feature | change |
|---|---|
| threadline-relay | `configPath: 'threadline.relayEnabled'`; actions write `threadline.relayEnabled` |
| autonomous-evolution | `configPath: 'evolution.approvalMode'`, `configEnabledValue: 'autonomous'`; enable writes `approvalMode: 'autonomous'`, disable writes `'ai-assisted'`; note: the `autonomous` profile turns it on with no explicit key |
| publishing-telegraph, cloudflare-tunnel, git-backup, dashboard-file-viewer, input-guard, external-operation-gate | `defaultOn: true` |
| evolution-system | `defaultOn: true`, `switchable: false` (read-only: the runtime ignores the key — see §2.3), honesty note; reversibility note no longer promises that disabling stops anything |
| threadline-relay (notes) | `honestyNote` names the `THREADLINE_RELAY_ENABLED=true` environment override (it keeps the relay on regardless of the switch, so the card says so); the reversibility note says the relay disconnects at the next restart |
| every restart-dependent feature | reversibility notes now say "saves <key>: false; … at the next server restart" — `PATCH /config` saves a setting, it stops nothing (review r3); the file viewer (live) and telemetry (its own routes) keep their notes |
| autonomous-evolution (resolution) | `server.ts` installs `setConfiguredResolver`: an explicit `evolution.approvalMode` else `PROFILE_DEFAULTS[autonomyManager.getProfile()].evolutionApprovalMode` — exactly the consumer's rule; the registry uses it for bootstrap AND `effective`, so a missing key resolves through the profile instead of reading as off |
| cloudflare-tunnel | enable body `{ tunnel: { enabled: true } }` (no `type`) |

`createFileRoutes` no longer returns an empty router when the viewer is off at boot:
its existing guard (every file route except `/api/files/config` answers 404 while
`config.enabled` is false, already used for a live disable) covers the off-at-boot case,
so enabling works without a restart and no file route is reachable while off. This
newly exposes `GET`/`PATCH /api/files/config` to Bearer callers while the viewer is
off — the same handlers, CSRF header and validation that were already reachable while
it was on.

## 3. Signal vs authority

No new detector and no new blocking decision. The applier is a client of routes that
already hold the authority; it decides nothing itself. The operator path *removes* a
block for a verified operator using the existing operator proof; it adds no new one.

## 4. Multi-machine posture

Machine-local by design. Config, `discovery.db` and the boot snapshot are per machine,
like every `PATCH /config`. `PATCH /config` has no write-admission check today, so a
standby applies the change to its own file like any other machine; the shown state
names only this machine's view. Fanning a switch out across machines is a separate
question this change does not answer.

## 5. Rollback

Revert the PR. The new column is nullable and ignored by older code; no data
migration. A refused apply leaves config untouched by construction. The definition
fixes (relayEnabled, approvalMode) are corrections to keys nothing read; reverting
them only restores the dead keys.

## 6. Tests (three tiers)

- **Unit** (`tests/unit/feature-action-applier.test.ts`,
  `tests/unit/feature-registry-apply-and-operator.test.ts`): outcome mapping for
  2xx/3xx/4xx/5xx/timeout/connection-refused against a real local HTTP server; the
  allowlist (every built-in action on it; anything else never sent); the effective
  table on both sides of each boundary incl. `atBoot: null` and the retained failed
  attempt; `operatorSet` consent rules per tier; `lastApply` persists across reopen;
  default-on / `configEnabledValue` / prerequisite resolution; the definition fixes.
- **Integration** (`tests/integration/feature-transition-applies-action.test.ts`): a
  real listening express app with `createRoutes`; Bearer-only still refused; operator
  switch applies to `config.json` and writes consent; `effective` on every read route; a
  refused action (non-patchable key) → `recorded-only` with the reason; telemetry with
  no heartbeat → `failed`; non-default user → `not-applied`; disable applies; overlapping
  switches serialized; no `/apply` route.
- **E2E** (`tests/e2e/feature-switch-applies-config.test.ts`): the production
  `AgentServer` with the registry built as `server.ts` builds it; a real PIN unlock; the
  operator switches `publishing-telegraph` on from `undiscovered`; `config.json` shows
  `publishing.enabled: true`; `effective.status: 'on-after-restart'`; the event trail
  carries `apply:applied`; a fresh registry bootstrapped from that config (the restart)
  reports `on` and does **not** reset the row.

## 7. Agent awareness

The CLAUDE.md template's feature-discovery lines gain one bullet: a transition now
applies the setting and returns `apply`; read `effective.status` before telling the
user a feature is on. Added to `generateClaudeMd()` and to `migrateClaudeMd()` with a
content-sniffing guard.

## Review changes

Round 1 (GPT-6 Astra: not ready; Gemini 4 Argon: ready with changes):
- Astra 1 / consumer misalignment → §2.7: threadline `relayEnabled`, evolution
  `approvalMode`, `defaultOn` for the six default-on features, honesty note for the
  always-on evolution system. Done.
- Astra 2 / "on and running" unsupported, default-on read as off, invented boot
  evidence → §2.3: `on` wording no longer claims running; `atBoot: null` when no
  snapshot; `defaultOn` in resolution. Done.
- Astra 3 / consent flow → §2.4: disclosure shown before enabling a high-tier feature;
  PIN asked once only when the proof is absent; forged proof = no proof. Done.
- Astra 4 / concurrency → §2.1: per-feature serial queue around write+apply; timeout
  described as unconfirmed; test with overlapping requests. Done.
- Astra 5 & Argon 2.1 / merge precedence → §2.3: stated correctly (disk over runtime
  for the shown state; bootstrap unchanged). Done.
- Astra 6 / failed attempts vanish after boot reset → §2.3: `lastAttempt` carried in
  every status, incl. `off`; the dashboard flattening carries `effective`. Done.
- Astra 7 / narrow security claims → §2.1 allowlist of the four pairs + no redirects;
  §2.5 userId is not identity; §4 standby refusal claim removed; §2.7 names the newly
  reachable file-settings handlers. Done.
- Astra 8 & Argon 1 / cut `/apply` and the duplicate timestamp → removed; one JSON
  column. Done.
- Argon 2 / drop the column entirely → declined: a refused attempt must survive the
  boot reset to be explained (Astra 6); one nullable column is the smallest way.
- Argon 3 / remove the early return in fileRoutes → done (§2.7), replacing the
  half-mounted router idea.
- Argon 5 / prerequisites → §2.3. Done.
- Argon 6 / collapse status to four values → declined: the console page needs the
  direction of a mismatch and of a pending restart; `summary` carries the words, the
  six statuses carry the shape.

Round 2 (Astra: ready with changes; Argon: ready with changes):
- Astra 1 / the prerequisite rule lies for evolution; absent approvalMode reads off →
  §2.3: rule dropped; `configuredResolver` wired from `server.ts` with the autonomy
  profile fallback; evolution-system made `switchable: false` (409) instead of a
  cosmetic switch. Done.
- Astra 2 & Argon 1 / the dashboard hid the retained refusal and the honesty note →
  §2.4: the card always shows `effective.summary`; the detail panel shows it under
  "Right now"; `effective.detail` carries what the sentence adds. Done.
- Astra 3 / an expired proof strands the switch → §2.4: present-but-invalid proof →
  401 `OPERATOR_PROOF_INVALID`; the dashboard tracks the expiry, re-unlocks once and
  retries. Done.
- Astra 4 / ordering after a timeout → §2.1: scope stated; telemetry disable
  reordered (local mutations before the awaited remote cleanup); timeout text says "may
  still land". Done.
- Astra 5 / reversibility notes promise what PATCH /config cannot do → §2.7: Threadline
  and evolution-system notes corrected. Done.
- Astra 6 / the challenge is a protocol step, not human proof → §2.4 wording. Done.
- Argon 2 / shallow merge in `readMergedConfig` → one-level-deep, disk wins per key.
  Done (unit-pinned).
- Argon 3 / object without boolean `enabled` → `defaultOn`. Done (unit-pinned).
- Astra security note / ELI16 "nothing new is allowed" → the file-settings exception is
  now stated there too.

Round 3 (Argon: ready — two doc leftovers; Astra: ready with changes — four display items):
- Argon 1 & 2 / stale prerequisite clause in the ELI16, stale JSDoc on
  `readMergedConfig` → fixed.
- Astra 1 / Threadline "Off" while the env override enables it → `honestyNote` on the
  definition names `THREADLINE_RELAY_ENABLED=true`; the plain off sentence is now about
  the setting ("not running is not separately verified"), like the plain on. Done.
- Astra 2 / undo notes promising immediate shutdown → every restart-dependent note
  rewritten as "saves <key>: false; … at the next server restart". Done.
- Astra 3 / the detail panel's "Right now" went stale after a toggle → the open detail
  re-renders from fresh data after every completed or cancelled toggle
  (`featReloadKeepingDetail`). Done.
- Astra 4 / read-only switch clickable in the detail view → the detail checkbox shares
  `featIsOn` / `featToggleTitle` / the disabled condition with the catalog. Done.

Convergence: round 3 found no architectural, security or honesty-of-state change —
only wording and two dashboard rendering fixes, all applied. Findings stopped changing
the build, which is the 80/20 convergence bar; no round 4.
