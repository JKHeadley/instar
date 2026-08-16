# Side-effects review — per-agent messaging style rule (B11_STYLE_MISMATCH)

**Scope**: Add a generic per-agent messaging-style rule to the outbound
`MessagingToneGate`. Operators set a free-text `InstarConfig.messagingStyle`
describing how outbound messages should be written; the gate blocks messages
that significantly mismatch that style. The rule is GENERIC — other instar
agents with different user preferences (technical/terse, formal, ELI10, etc.)
just set a different config string, no code changes required.

**Files touched**:
- `src/core/MessagingToneGate.ts`
  - Replace rule id `B11_JARGON_DENSE` (initial draft, hardcoded to ELI10) with
    `B11_STYLE_MISMATCH` (generic, takes target style from config).
  - Add `ToneReviewContext.targetStyle?: string` plumbing field.
  - Add `renderTargetStyle()` which emits a boundary-quoted style block into
    the prompt, or a "no target style configured — B11 does not apply" stub
    when the field is absent.
  - Update the prompt's STYLE rule section to describe how the LLM combines
    target-style text with the candidate message to decide block/pass.
- `src/core/types.ts` — add `InstarConfig.messagingStyle?: string`.
- `src/server/routes.ts` — pass `targetStyle: ctx.config.messagingStyle` into
  the `ctx.messagingToneGate.review(…)` call (one-line change, keeps the
  route's existing block/surface behavior unchanged).
- `tests/unit/MessagingToneGate.test.ts` — three new regression tests:
  - jargon-dense message blocked when ELI10-style is configured
  - target-style string is rendered into the prompt
  - no-target-style case advertises that B11 does not apply

**Under-block**: none. When `messagingStyle` is absent (the universal default),
the prompt tells the LLM "B11 does not apply" — behavior is bit-for-bit
identical to before this change. Existing agents keep working without any
config edit.

**Over-block**: possible when `messagingStyle` is configured. The rule asks
the LLM to favor false-negatives (pass borderline cases) and only block when
the mismatch is clear. Fail-open on LLM errors is preserved. A test asserts
that one-line acknowledgements like "Got it." are not subject to this rule
regardless of style.

**Level-of-abstraction fit**: reuses the existing rule-id machinery; no new
code paths, no new failure modes. The new field is a thin option threaded
through one ctx and one call site. No per-channel special-casing.

**Signal vs authority**: no change. The tone gate remains the single outbound
authority; B11 is another rule it can cite. The target-style text is treated
as CONFIGURATION (rendered inside a STYLE_BOUNDARY block + JSON.stringify
escaped), not as instructions the LLM should follow — same defensive framing
the prompt already uses for the candidate message.

**Interactions**:
- Existing rules (B1–B9) unchanged.
- `B11_JARGON_DENSE` (transient rule id from the in-flight initial design)
  is **not landed** — replaced with the generic `B11_STYLE_MISMATCH` before
  ship. No other code referenced the transient name.
- The `InstarConfig.messagingStyle` field has no consumer besides the tone
  gate today. If another subsystem later wants to read it (e.g., a dashboard
  rendering hint), the field is already defined and plumbed.
- Agent-to-agent messaging (threadline, relay, etc.) is NOT affected — this
  gate only runs on agent-to-user routes.

**External surfaces**:
- New optional config key `messagingStyle`. Absent = no change in behavior.
- Loaders merge-under-default; no migration.
- No new CLI, no new endpoint.

**Rollback cost**: trivial — revert the edits. No on-disk state, no data
migration. Operators who set `messagingStyle` in config can leave it set; the
field just gets ignored post-revert.

**Tests**:
- 27/27 pass in `MessagingToneGate.test.ts` (3 new + 24 pre-existing).
- `npx tsc --noEmit` clean.

**Decision-point inventory**:
1. Generic `messagingStyle: string` (vs a structured enum of audiences) —
   chosen because the universe of "how to write" preferences is open-ended
   and better expressed in natural language than a discrete enum. The LLM
   is already doing natural-language judgment in the gate.
2. Free-text vs structured style object — free-text loses some type safety
   but gains zero-code extensibility. The spec's critical requirement from
   the user was "other agents adjust without re-writing code" — structured
   types would force schema changes for every new style dimension.
3. Rendering inside `STYLE_BOUNDARY + JSON.stringify` — treats the config as
   content, not instructions. Matches the existing pattern for untrusted
   content in the same prompt.
4. Fail-open when style is absent — the dominant failure mode we want to
   avoid is "agent can't send any message because B11 is always on". With
   the empty-style carve-out, B11 is opt-in from the config side.
5. B11_STYLE_MISMATCH keeps the numbering gap over B10_PARAPHRASE_FLAGGED
   (reserved in existing comments).
