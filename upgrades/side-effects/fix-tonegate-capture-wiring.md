# Side-Effects Review — tone-gate operator-config wiring fix

Change: the MessagingToneGate construction site read `config.messaging?.toneGate` — structurally dead,
because `messaging` is an ARRAY of adapter configs — and whitelisted only 3 of the 4 operator knobs
(dropping `recordCandidateBody`). Result: PR #1599's candidate-body capture never fired (zero bodies ever
captured — evidence: the echo agent's drive12-retrospective-judge audit), and the three documented
fail-closed knobs were ALSO unreachable from any real config. Fix: a single exported resolver
(`resolveToneGateOperatorConfig`) reads the TOP-LEVEL `toneGate` block and passes all four knobs through;
the construction site uses it; `InstarConfig` gains the typed block; guidance strings (template, migrator
section, detector comment) move to the working path; an idempotent migration rewrites the dead path in
already-installed CLAUDE.mds.

1. **Over-block** — No issue identified. The resolver adds no blocking logic; absent flags resolve
   undefined, preserving the gate's internal defaults byte-for-byte (unit-tested).

2. **Under-block** — One behavior surface, named deliberately: configs that ALREADY carry top-level
   `toneGate` values (previously inert) become live on deploy. Sweep of the operated fleet: only the echo
   dev agent has the block (`recordCandidateBody: true`, set expressly awaiting this fix; its `_note` says
   so); codey has none. A config with `failClosedOnExhaustion: false` sitting inert would now genuinely
   flip that path to fail-open — that is the documented meaning of the operator kill-switch finally
   working, not a new failure mode. No such config exists on the operated fleet.

3. **Level-of-abstraction fit** — Correct layer: the bug was AT the wiring layer (construction site), and
   the fix is a single-point resolver owned by the gate module itself, so the knob list and the wiring
   can no longer drift apart (the root cause was an inlined, second copy of the knob list).

4. **Signal vs authority** — Compliant. No new authority: the resolver only transports operator config to
   the existing gate. `recordCandidateBody` is observe-only capture for decision-quality benchmarking.
   The legacy `messaging.toneGate` location is deliberately NOT read (unit-tested dead) — resurrecting it
   would create two conflicting sources of truth for a gate's kill-switch.

5. **Interactions** — The gate's live getter is called per review; the resolver is pure and allocation-
   light (no caching needed). No other component reads `config.toneGate` today (grep-verified). The
   migrator addition is content-sniffed on the old literal and idempotent (old literal absent after one
   run). No shadowing or double-fire risk.

6. **External surfaces** — Captured candidate bodies land only in the machine-local judgment-provenance
   store (existing #1599 machinery, `contextFull` — omitted from redacted reads and pool merges by that
   PR's design). No new network surface, no new route.

7. **Multi-machine posture** — Machine-local BY DESIGN: each machine's gate reads its own config.json;
   capture writes to that machine's local provenance store, which is already redacted-only at every
   cross-machine read (per #1599). No replication, no one-voice concern (no user-facing notice added).

8. **Rollback cost** — Config edit: remove/false the top-level `toneGate` keys (per-knob, live — no
   restart). Code back-out: single-commit revert; the resolver has no persistence, so no data migration.
   The CLAUDE.md path migration is text-only guidance; reverting code without reverting the doc string
   would leave docs pointing at the top-level block, which the revert would deaden again — so a full
   revert should revert the whole commit (it is one commit by design).

## Second-pass review

Concern raised: `src/server/routes.ts:2428-2434` still contains a SECOND inlined read of the
structurally-dead `messaging?.toneGate` location — it drives the slow-review budget-timeout
fail-direction (`_toneMode`, `operatorTierDeliver`, `budgetFailClosed`, `budgetDegrade`) and is
untouched by this diff. After this change, a top-level `toneGate.failClosedOnExhaustion:false` /
`failClosedMode:'tiered'` / `toneTierDryRun` is honored by the gate's own getter (resolver path)
but NOT by that routes.ts wrapper, which still resolves undefined and defaults to
'always'/degrade — so the operator kill-switch and tiered mode remain partially dead on the
budget-timeout path. This contradicts item 5's "no other component reads config.toneGate
(grep-verified)": literally true for the TOP-LEVEL key, but the artifact's own item-3 root cause
("an inlined, second copy of the knob list") survives at this callsite. Fix: route that read
through `resolveToneGateOperatorConfig(ctx.config)` too. (`recordCandidateBody` is not read
there, so the capture fix itself is unaffected.)

Everything else verified: the resolver/wiring/types/migrator/template/detector diffs match the
artifact; the migrator addition is content-sniffed on the exact backticked old literal, global-
replace removes it, idempotent; fleet sweep confirmed (echo `toneGate.recordCandidateBody:true`
with the awaiting-fix `_note`; codey `null`; no `messaging[].toneGate` entries on either); no new
blocking authority (resolver is pure transport, detector changes are comment-only); the capture
path clamps-then-scrubs and stores the body only under the machine-local contentFull key as
claimed; the new unit test covers all four knobs, absence, null-tolerance, and dead-location
non-resurrection. Minor: the working tree also carries an unrelated pnpm-lock.yaml regeneration
(ssh2/undici lockfile catch-up + pnpm-10 format churn) and an untracked pnpm-workspace.yaml the
artifact does not mention — exclude from this commit or note them.

### Concern resolution (author, same session)

Both points addressed before commit: (1) the routes.ts:2428 budget-timeout read now routes through
`resolveToneGateOperatorConfig(ctx.config)` — a follow-up converging sweep finds ZERO remaining live
reads of the dead location (remaining grep hits are the migration sniff literal, explanatory comments,
and detector-test fixture strings that use the old path as an arbitrary dotted-key example input).
The operator kill-switch / tiered mode now work on the budget-timeout path too, which is the complete
fix rather than the capture-only fix. (2) pnpm-lock.yaml and pnpm-workspace.yaml install churn is
excluded from the commit (local install artifacts, not part of the change).
