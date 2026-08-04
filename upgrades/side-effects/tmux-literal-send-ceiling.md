# Side-effects review — tmux literal-send argv ceiling

**Change:** every `tmux send-keys -l` call site now sends through a single funnel
(`src/core/tmuxLiteralSend.ts`) that chunks the payload below the argv ceiling; a new lint keeps the
class closed; `LlmCircuitBreaker`'s OPEN log line now reports the measured cause instead of asserting
"provider rate-limited".
**Author:** echo · **Date:** 2026-08-04
**Found by:** Phase A ground-truth audit (topic 29723) while measuring whether internal LLM judgment
calls could succeed end-to-end.

## What was wrong

`tmux send-keys -l <text>` passes the whole payload as ONE argv element, bounded by `ARG_MAX` minus
the environment. Measured on this host (tmux 3.6a / darwin): **~16,256 B succeeds, ~16,480 B fails**
with a bare `command too long`.

The `anthropic-interactive-pool` provider sends its prompt with a single `send-keys -l`. Real prompts
run tens of KB. The send failed, and the failure surfaced to `LlmCircuitBreaker` as an opaque error
whose OPEN log line **hardcoded "provider rate-limited"**.

**Measured on the live host before the fix:**

- `[llm-circuit] OPEN: provider rate-limited … (trip #14)` — tripping every 15 minutes since 09:59Z
- reason string, verbatim: `Failed to send prompt: Command failed: /opt/homebrew/bin/tmux send-keys
  -t =instar-pool-echo-aip-3757dfe6fb16: -l …`
- **ten** LLM-backed components at 76–100% error rate, every `byModel` row showing `tokensIn: 0`:

  ⚠️ **Correction (2026-08-04, post-deploy):** this originally read "(the calls never produced
  anything)". **Withdrawn.** `tokensIn: 0` also appears on components with 100+ clean successes
  (`durable-output-scrub` 125, `rope-health` 123, `mesh-coherence-live` 119) — it is a token
  ATTRIBUTION gap, not proof of an empty call. The error rates below are the real evidence and
  stand unchanged; only the token inference is retracted. Recording it rather than editing it away,
  because an unmarked silent fix of a shipped claim is the failure mode this artifact exists to
  prevent.

  | component | errors/calls | rate |
  |---|---|---|
  | SessionActivitySentinel | 6977/7148 | 97.6% |
  | completion-claim-verify | 121/128 | 94.5% |
  | MessagingToneGate | 260/342 | 76.0% |
  | ProfileIntentClassifier | 51/51 | 100% |
  | MoveIntentClassifier | 27/27 | 100% |
  | UnjustifiedStopGate | 21/22 | 95.5% |

The misclassification is the second defect and cost more than the first: it pointed the entire
diagnosis at quota while the actual cause was a decades-old argv limit.

## The 8 questions

**1. Over-block — what legitimate inputs does this reject that it shouldn't?**
None. The change strictly *widens* what can be sent: payloads that previously failed now succeed, and
payloads that already fit take the identical single-call path (`chunkLiteralForTmux` returns `[text]`
unchanged below the threshold — pinned by a test, so a "shred everything" regression cannot pass).

**2. Under-block — what failure modes does this still miss?**
The chunk size (8,000 B) is a fixed constant, not a probe of the live `ARG_MAX`. A machine with an
enormous environment block could in principle push the real ceiling below 8,000 B; the constant is set
at roughly half the measured ceiling to absorb that, and an integration test asserts a full-size chunk
sends in ONE call, so the assumption fails loudly rather than silently. A wrapper that builds the argv
array dynamically would evade the lint — declared as a guardrail, not a proof, in the lint header.

**3. Level-of-abstraction fit.**
Correct layer, and deliberately the *single-funnel* pattern this codebase already uses for destructive
git and fs operations (`SafeGitExecutor`, `SafeFsExecutor`). The alternative — patching only the
provider that happened to fail — is exactly the shape that produced the 2026-06-26 memory-pressure
sibling bug, where one caller was converted and another was not and the second surfaced two months
later. Seven call sites carried the same latent defect; all seven are converted.

**4. Signal vs authority compliance.** (`docs/signal-vs-authority.md`)
**Compliant, and the breaker change is the point.** `classifyTripCause` is a pure **detector** that
produces a label; it holds no authority, gates nothing, and does not influence whether the breaker
trips, how long it stays open, or which calls are refused — the trip decision continues to run through
the untouched `classifyRateLimit`/`recordFailure` path. The defect was an authority *narrating* a cause
it had not measured. The fix makes the narration honest and adds no blocking logic anywhere.
`chunkLiteralForTmux` is likewise pure transport mechanics, not a decision point.

**5. Interactions — shadowing, double-fire, races.**
The chunk loop is sequential and `await`ed, so ordering within a send is preserved; tmux processes
`send-keys` synchronously per invocation, so chunks cannot interleave with another send on the same
pane from the same call site. Chunking composes with the existing bracketed-paste branch in
`SessionManager.sendTextToPane`: everything a terminal receives between `\e[200~` and `\e[201~` is one
paste regardless of how many writes deliver it, so newline semantics are unchanged.

⚠️ **Interaction worth naming:** that bracketed-paste branch carries a comment saying it "completely
avoids load-buffer/paste-buffer and their TCC prompts." `load-buffer`/`paste-buffer` was the obvious
remedy and is empirically unlimited, but adopting it would have re-introduced a macOS privacy-consent
dialog that an unattended agent cannot answer. Chunking was chosen *because* of that recorded
decision. A second observation: that branch already existed to solve **newlines**, and passed the full
text through argv anyway — so it carried the ceiling bug too, and would not have been found by looking
only at the component that failed.

**6. External surfaces.**
One user-visible change: the breaker's OPEN log line no longer says "provider rate-limited" for every
cause. Anything grepping that literal string will need updating — that is the correction, not a
regression, since the string was frequently false. No API, config, or persisted-format change.

**7. Multi-machine posture (Cross-Machine Coherence).**
**Machine-local BY DESIGN — correctly so.** The argv ceiling is a property of the local kernel and the
local process environment; it must never be replicated, proxied, or inferred from a peer. Each machine
chunks against its own limit. No replication path, no merged read, no cross-machine state. The defect
itself was machine-local: it took down the substrate on the Mini while the laptop was unaffected.

**8. Rollback cost.**
Trivial. Revert the commit — no data migration, no agent-state repair, no persisted format change. All
edits are confined to call sites plus one new pure module, one new lint, and three test files.

## Testing

**Unit** — `tests/unit/tmux-literal-send.test.ts` (14) and `tests/unit/llm-circuit-trip-cause.test.ts` (6).
Both sides of the boundary are covered: oversized payloads must split AND already-fitting payloads must
stay a single call, so a chunker that shreds everything fails. Byte-based encoding is pinned (3,000
emoji is under the character count but over the byte ceiling) and multi-byte code points are asserted
never to split.

**Integration** — `tests/integration/tmux-literal-send-ceiling.test.ts` (3), against real tmux and a
real pane:

- a single `send-keys -l` of the 39,992 B outage payload **is rejected with `command too long`** — the
  defect, reproduced directly rather than described;
- the chunked path delivers the same payload and the pane receives **39,992 of 39,992 bytes,
  byte-exact**, head and tail markers both present;
- a full-size chunk sends in one call, so the constant is checked against the live ceiling.

**Falsifiability check (the control that matters).** Raising `TMUX_SEND_KEYS_CHUNK_BYTES` to 60,000
turns **2 of the 3** integration tests red; restoring 8,000 makes them green. The suite therefore fails
against pre-fix behaviour rather than passing vacuously. An earlier version of this harness used `cat`
in canonical mode and reported 0 bytes received — a tty line-discipline artifact, not a code failure;
`stty raw` is now set in the receiver and the reason is recorded in a comment so the next reader does
not re-derive it.

**Lint** — `scripts/lint-no-unfunneled-tmux-literal-send.js`, A/B verified: injecting a raw
`send-keys -l` at a converted call site exits 1 and names file+line; the restored tree exits 0.

**Green:** 132/132 across the 8 suites covering the circuit breaker, session-manager injection, and
interactive-pool readiness, plus 20/20 new unit and 3/3 new integration. `tsc --noEmit` clean; the full
`npm run lint` chain clean **with the new lint registered in it**.

## Second-pass review

Required — this touches the LLM transport that gates (`MessagingToneGate`, `UnjustifiedStopGate`) and
the circuit breaker depend on. See appended section.

---

## Second pass — SELF-REVIEW (independence NOT obtained)

**Stated limitation first:** the skill requires a *dedicated reviewer subagent* for a change touching
gates and recovery paths. This session is operating under an instruction not to spawn agents, so this
pass was performed by the change's own author. **That is materially weaker than the standard asks
for** — an author reviewing their own work shares the author's blind spots by construction. Recorded
as a gap, not waved through; an independent pass before merge would be worth having.

With that caveat, an adversarial pass found three things.

### 1. ✅ RESOLVED — end-to-end success now observed on the live provider

*Written first as an open risk ("not proven to restore the substrate"), then closed by measurement.
Kept visible rather than edited away, because the sequence is the point.*

Driven against the live pool session `instar-pool-echo-aip-682604145ed3` (a real
`claude --model haiku`, idle at prompt):

| step | payload | result |
|---|---|---|
| unchunked single send | 18,972 B | **`command too long`** — the defect, reproduced on the live session |
| chunked send | 18,971 B / 3 chunks | accepted; Claude read it and replied substantively |
| chunked send (clean control) | 19,337 B / 3 chunks | accepted; **replied `Mitochondrion.`** |

The third row is the clean one. The second reply was Claude *declining*: that payload was padding plus
"ignore all padding above, reply with exactly…", which reads as a prompt-injection probe, and it
refused on those grounds. The refusal is correct behaviour and still proves delivery — it could only
object to instructions it had received in full — but it is ambiguous as evidence, so the run was
repeated with a natural passage and question.

**So the claim is now the strong one:** a >16 KB prompt that fails pre-fix on this exact session
delivers post-fix and produces a complete model response. Not a unit test standing in for the claim.

⚠️ Still true: this proves the *transport*. If a component still fails after this, the next suspect is
newline-as-submit in `promptRunner` (it does not use bracketed paste), which this change does not
touch.

### 2. Newline semantics are unchanged — and that may be the next fault

`promptRunner` does not use bracketed paste; it sends the prompt with plain `-l`, and prompts contain
newlines. With `-l`, newlines go through as literal characters, which a readline-style consumer can
treat as submit. Chunking neither introduces nor fixes this. If prompts are being submitted early at
the first newline, that is a separate defect this change does not touch, and it is the first place to
look if calls still fail after this lands. Named here rather than discovered later.

### 3. Two behaviour changes that are improvements but are still changes

- `promptRunner` and the canary previously passed no `--` terminator; via `buildLiteralSendArgs` they
  now do. A payload beginning with `-` was previously parsed as a flag (a latent bug) and is now
  literal. Verified against live tmux that `send-keys -l -- <text>` is accepted.
- The breaker's OPEN line no longer emits the literal `provider rate-limited` for non-rate-limit
  trips. Correct, but any log tooling matching that string will silently stop matching those cases.

### Verdict

**Concur with the change as scoped**, with the scope stated honestly: it fixes a reproduced transport
defect and a false-cause label, and it closes the class with a verified guard. It does **not** yet
demonstrate a working end-to-end internal LLM call, and the artifact should not be read as claiming
one. Independent review still owed.

---

## Post-deploy addendum (2026-08-04) — what the fix did and did NOT restore

Deployed as 1.3.1125 and verified live: shipped `promptRunner.js` carries the chunked path, and
post-restart there are **0 send failures and 0 breaker trips** (last trip #17 was pre-restart).

**But the interactive-pool call count did not move at all** in 7.5 minutes of observation — so the
"one real pool call succeeding" close condition is not satisfied by this deploy, and absence of a
breaker trip is not being counted as success.

**Cause: a SECOND, independent fault this change does not address.**

    codex_api: HTTP 401 Unauthorized · "code": "refresh_token_invalidated"

Internal components route to **codex-cli by default** (provider-fallback default policy). Codex's OAuth
refresh token is revoked server-side, so those components fail at their PRIMARY door and never reach the
interactive-pool tail this PR repaired.

**Honest restatement of scope:** the argv ceiling was real, is fixed, and was proven end-to-end on the
live provider. But it governed the FALLBACK path. The primary path for most of the affected components
was independently dead, and still is. This PR repaired the spare tyre — necessary, and not sufficient.

### Related finding — a third instance of the class this work already named

`GET /intelligence/routing` reports codex-cli **`available: true`** for every component while every
codex call 401s: availability is evidently measured as *the binary exists*, not *the door opens*.

That is the same **asserts-unmeasured-state** class as the pre-fix memory metric and the pre-fix breaker
label. The Phase A round-5 sweep concluded that class was "an outlier, not a pattern" after three
angles over 348 files. **This counterexample weakens that conclusion** — and it sits precisely in the
blind spot that sweep declared it could not see: *a cause asserted by a computed field rather than a
string.* The named blind spot found the thing it predicted.
