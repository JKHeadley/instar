# Side-effects review — config-overridable decay profiles (cwa-decay-profile-config)

**Scope**: Ship the tracked `cwa-decay-profile-config` deferral from the rung-1
task-context spec (`docs/specs/topic-intent-task-context-capture.md` §3, approved):
let operators tune the per-kind decay horizons (method/audience/goal/fact/decision)
via config instead of code constants, so the short/medium/long numbers become
tunable from real data without a code change.

**Files touched**:
- `src/core/TopicIntent.ts` — split `DECAY_PROFILES` into `DEFAULT_DECAY_PROFILES`
  (the baseline) + a mutable `activeDecayProfiles`; add `configureDecayProfiles(overrides)`
  (existence-checked, validated, idempotent — always re-derives from defaults),
  `resetDecayProfiles()` (test isolation), and `DecayProfileOverrides` type.
  `decayProfileFor` now reads the active profiles. `projectConfidence` is
  unchanged (still pure w.r.t. its args; it calls `decayProfileFor`).
- `src/core/types.ts` — `topicIntent.capture.decayProfiles?` config field.
- `src/commands/server.ts` — call `configureDecayProfiles(config.topicIntent?.capture?.decayProfiles)`
  once at startup, right after the TopicIntentStore is constructed.
- `tests/unit/TopicIntent-decay-profile-config.test.ts` — 6 tests (defaults,
  partial override, invalid-ignored, idempotent, reset, projection-reflects-override).

**Under-block**: An override only changes the numbers it specifies; everything
else keeps the default. Invalid values (non-finite / ≤ 0) are silently ignored,
so a malformed config can never break decay (the loop falls back to defaults).

**Over-block**: None. This is a tuning knob, not a gate.

**Level-of-abstraction fit**: Decay horizons are process-wide *policy*, so a
module-level configurable map (set once at startup) is the right level — not
per-call state. `projectConfidence` keeps its signature and purity-w.r.t-args;
the only behavioral input it gains is the global policy via `decayProfileFor`,
which already read a module constant. `configureDecayProfiles` always re-derives
from `DEFAULT_DECAY_PROFILES` so it's idempotent and order-independent.

**Signal vs authority**: N/A (a tuning value, no decision authority).

**Interactions**:
- `configureDecayProfiles` is called once at server startup. If never called
  (e.g. tests, or a path that doesn't boot the server), the defaults are in
  effect — identical to pre-change behavior. **Rung-0/rung-1 decay math is
  unchanged when no override is set** (fact/decision stay 30/180; task kinds keep
  their defaults), so existing projection tests are unaffected.
- `resetDecayProfiles()` exists for test isolation (module-global state); tests
  call it in `afterEach`.
- Idempotent + validated → re-running migration / re-reading config is safe.

**External surfaces**: New config field `topicIntent.capture.decayProfiles`
(optional, existence-checked). New exported `configureDecayProfiles`,
`resetDecayProfiles`, `DecayProfileOverrides`. No new endpoint.

**Rollback cost**: Low. Revert `decayProfileFor` to read a const + drop the
config field + the startup call; behavior returns to fixed code-constant
profiles (today's state). No persisted state involved.

**Migration parity**: Pure config-read at startup (server-side; every agent
gets the capability on update). The field is opt-in with an existence check, so
no `ConfigDefaults` entry is required — absence → built-in defaults. No
hook/template/skill change.
