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
- **ten** LLM-backed components at 76–100% error rate, every `byModel` row showing `tokensIn: 0`
  (the calls never produced anything):

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

### 1. ⚠️ The fix is NOT proven to restore the substrate — only to remove the send failure

`interactive-pool` shows **zero recorded successes** in the metrics window examined. I have direct
evidence that the *send* failed (`command too long`, reproduced) and direct evidence that chunking
delivers byte-exact. I do **not** have evidence that a chunked prompt then produces a completed LLM
call, because no successful call exists on record to compare against.

So the honest claim is narrow: **this removes a defect that made success impossible.** It does not
establish that success is now possible — there may be a second, independent fault behind it. Anyone
reading this as "the LLM substrate is fixed" is reading more than the evidence supports. The
end-to-end observation is the outstanding item.

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
