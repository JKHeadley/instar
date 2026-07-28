# Side-Effects Review — Tone-gate deterministic floor: click-link carve-out

**Tier:** 1 (small, surgical, safe-direction false-positive fix). **Risk floor will signal Tier 2** (messaging block/allow gate) — Phase-5 second-pass review performed regardless; `belowFloor` audit accepted (I hold authority; the override is recorded).
**Anchor:** `docs/specs/tone-gate-graceful-degradation.md` (the F4 deterministic floor this fix extends) + `docs/specs/tonegate-floor-click-links.eli16.md`. The precise-subject spec is the shipped F4 postmortem fix; this is a follow-up false-positive correction to that floor. (Not Tier-2-anchored: that spec carries no `approved:true`, and I must never self-approve.)
**Files:** `src/core/MessagingToneGate.ts`, `tests/unit/MessagingToneGate.test.ts`

## What changed

1. **`scrubClickLinksForFloor(text)` (new, exported):** removes scheme'd `http(s)://…`
   URLs (the click-destination token) from a copy of the text BEFORE the floor's
   signal scan — UNLESS the text carries a CALL instruction: a fetch tool
   (`curl`/`wget`/`xh`/`httpie`), an uppercase HTTP method against a URL/path
   (`POST https://…` / `GET /…`), or an imperative call phrase ("hit/call/invoke/
   issue/send … endpoint/url/api/request"). On any of those it returns the text
   UNCHANGED, so the floor sees the call verbatim and blocks as today.
2. **`detectDeterministicLeak(text)`:** now scans `scrubClickLinksForFloor(text)`
   instead of raw `text` — for BOTH `detectGateSignals` and `detectInternalIdLeak`.
   Nothing else about the floor changed; the LLM path is untouched.

## 1. Over-block

- **Before:** the floor over-blocked EVERY clickable link an agent shared during an
  LLM outage (private view, tunnel, dashboard, Secret-Drop, Telegraph, download) —
  the host/port/path/token tripped the `api-endpoint` / `cron-or-slug` signals.
  This is the bug being fixed (it just blocked a real Secret-Drop link).
- **After:** a bare clickable URL no longer trips the floor. No new over-block is
  introduced — the scrub only REMOVES match surface, never adds a rule.

## 2. Under-block

- The scrub removes scheme'd URLs only. A leak embedded in a URL's path/query
  (e.g. a file path inside `…/download?path=.claude/CLAUDE.md`) is removed along
  with the URL — acceptable, because the agent deliberately shared that as a
  click destination (the same intent the LLM path already passes). A file path or
  command written OUTSIDE a URL is left fully intact and still HELD (proven by the
  file-path + bare-CLI tests).
- A call instruction that uses none of the three recognized forms (no curl/wget,
  no uppercase method, no "hit/call/…" phrase) — e.g. a lowercase prose "open this
  api 〈url〉" — would have its URL scrubbed. This is acceptable: such phrasing reads
  as an open instruction, the host/path is gone, and no command/path/secret
  escapes. The floor is the DEGRADED path (LLM down); the LLM path catches intent
  precisely when up. Erring toward delivering a link beats silencing the user.

## 3. Level-of-abstraction fit

- Correct layer. The fix lives exactly where the false positive lives — the
  deterministic floor (`detectDeterministicLeak`), the degraded-path counterpart
  to the LLM judge's existing intent-based B5 carve-out. It does NOT touch
  `GateSignalDetectors` (those feed the LLM prompt too and must stay literal); it
  pre-processes only the floor's input. The smarter gate (the LLM) already owns
  the precise judgment when available; this only narrows the dumb fallback's known
  false-positive class.

## 4. Signal vs authority compliance

- The floor HOLDS authority (it blocks under degradation) but with deliberately
  brittle logic — that is its established design (F4: never silently cut the user
  off; hold only hard artifact leaks). This change only REDUCES that authority's
  false-positive surface in the safe direction (fewer wrong holds), never expands
  what it lets through. No new blocking authority is added. Per
  `docs/signal-vs-authority.md`, loosening a brittle authority's over-block while
  preserving its leak-safety is the correct direction.

## 5. Interactions

- `buildDegradedToneResult` (both degrade sites: provider-throw in `review()` and
  the slow-stall seam in `reviewWithinBudget`) calls `detectDeterministicLeak`, so
  both degrade sites inherit the carve-out identically — no divergence.
- The `failClosedOnExhaustion: true` operator override is unaffected: it bypasses
  the floor entirely (pure hold), so its behavior is unchanged.
- No race, no double-fire, no shadowing — pure synchronous string pre-processing.

## 6. External surfaces

- No new route, no config key, no schema, no migration. Behavior visible to users
  only as: during an LLM outage, a shared click-link now reaches them instead of
  being silently held. No timing/runtime-state dependence (pure function).

## 7. Multi-machine posture

- **Machine-local BY DESIGN, identical on every machine.** The tone gate runs
  per-message on whichever machine is serving; this is a pure-function change to
  that per-message logic. No state, no replication, no cross-machine surface.
  Every machine applies the identical floor. No one-voice / transfer / URL-survival
  concern (it has no durable state and emits no notice).

## 8. Rollback cost

- Trivial. Revert the two edits in `MessagingToneGate.ts` (delete the helper +
  restore `detectGateSignals(text)` / `detectInternalIdLeak(text)`). No data, no
  config, no agent-state repair. Always-on with no flag because the prior behavior
  was simply incorrect.

## Tests

- `tests/unit/MessagingToneGate.test.ts` — new `deterministic floor — click-link
  carve-out` describe (12 cases): each click-link class (Secret-Drop / private
  view / dashboard / Telegraph / download) PASSES the floor; a `curl` call, an
  uppercase-method call, and a "hit the endpoint" phrase still HOLD; a file-path
  leak still HOLDS (`B2_FILE_PATH`); a bare CLI command alongside a link still
  HOLDS; `scrubClickLinksForFloor` unit behavior (strips a URL, leaves a curl line
  unchanged); and an end-to-end `review()` degrade-and-SEND of a Secret-Drop link
  on provider throw. Full file: 53/53 green. Budget + no-silent-fallbacks +
  dark-gate lint ratchets: green. tsc clean.

## Agent awareness

- No CLAUDE.md change required: this is an internal correctness fix to an existing
  safety gate with no new user-facing capability, route, or config knob. The
  user-visible effect (links reach you during an outage) needs no agent
  instruction.

## Phase-5 second-pass review (independent reviewer)

**VERDICT: Concur with the review** — the change preserves leak-safety while
fixing the false positive. The reviewer empirically ran the scrub against eight
bypass attempts and verified:

- No new leak class escapes. Leaks written OUTSIDE a URL are fully preserved
  (env-var `GITHUB_TOKEN=…`, config-key, file-path `/Users/…/id_rsa` all still
  trip after the scrub). The scrub regex consumes only scheme'd URL tokens up to
  whitespace/`)`/`]`, so an adjacent space-separated leak survives — the
  safe-direction claim is real.
- "Secret inside a URL escapes" is out-of-scope by correct layering, not a gap:
  the floor has no secret detector (raw-credential redaction is a separate
  `redactSecrets`/`guardProxyOutput` pass), so the scrub removes nothing the floor
  was protecting. A token inside a URL the agent chose to share as a click
  destination is the intended open-vs-call trade (matches the LLM B5 carve-out).
- Call-instruction suppression is sound (curl / uppercase-method-vs-URL /
  "hit … endpoint" all still HOLD). The one documented loosening (a file path
  inside a `…/download?path=…` URL) is acknowledged in §2 and acceptable on the
  degraded path.
- Internal-id detector on scrubbed text does not weaken meaningfully: a bare
  `CMT-1234` in prose (the actual anti-pattern) is untouched; only an id embedded
  in a shared click-URL is skipped — benign by the rule's own intent.
- Both degrade sites inherit the carve-out via the single
  `buildDegradedToneResult → detectDeterministicLeak` chokepoint; the
  `failClosedOnExhaustion:true` override (pure hold) is unaffected. No race/state.

**Non-blocking concern raised → RESOLVED in this PR (no deferral):** the reviewer
flagged latent O(n²) backtracking in `CALL_PHRASE` (`\s+(?:…)?\s*` adjacency),
harmless at Telegram's ~4096-char cap (~9ms) but a hardening risk for any future
unbounded-input caller. Fixed immediately: the article group now carries its own
trailing `\s+` (`(?:(?:this|the|a)\s+)?`), eliminating the ambiguous whitespace
split — linear time. Guarded by a new test (`scrubClickLinksForFloor runs in
linear time on a long whitespace run`, 200k-char adversarial input < 200ms) and a
no-article call-phrase HOLD test.
