# Standard (final draft, pending operator last-look) — Intelligence Infers, Keywords Only Guard

**Destination:** `docs/STANDARDS-REGISTRY.md`, under "The Substrate — model-level truths the framework
must structurally honor" (sibling to "No Silent Degradation to Brittle Fallback"). Origin: operator
directive 2026-07-03 (topic 29836), after the move-intent recognizer's keyword verb-list hijacked a
discussion message. Incorporates the operator's four refinements.

---

### Intelligence Infers, Keywords Only Guard

**Rule.** A decision about what a human MEANT — their intent, their request, whether a message is a
command or just conversation — is made by an LLM reasoning over the message AND its surrounding
conversation context. A keyword/phrase/regex list is NEVER the decision-maker for natural-language
meaning.

**Notice and fight the reflex (the load-bearing awareness).** You are an LLM trained on a world where
keyword lists WERE how software made decisions. That reflex is in your training, and it is wrong here.
The moment you reach for `const VERBS = [...]` to classify what someone meant, stop — that is the bias
firing. An LLM excels precisely when given MORE context, not a restricted list of trigger words. This
awareness is the standard, not a footnote to it.

**The near-total ban.** A keyword list deciding natural-language meaning is a bug, effectively without
exception. The only two survivors:
1. **Validating already-structured input against a fixed, closed enum** (e.g. "is this string one of
   off/low/medium/high/max?") — this validates a value, it does not infer intent.
2. **A deliberate, LLM-backed safety FLOOR** — e.g. the emergency-stop fast-path that matches `^stop`
   before the LLM, WITH an LLM stage behind it. Deterministic first strike for safety, never the sole
   decision. These are rare and must be justified as safety floors.

**Constrain the model's output with structure, never by matching its prose.** When a decision needs a
value from a limited/standard set OUT of an LLM, do NOT let the model write free text and then
keyword-match that text. Make the model emit **structured/constrained output** (schema / enum /
tool-call) whose allowed values ARE the known set. The known set becomes the enum the model must choose
from — it is structurally incapable of producing an out-of-set answer, and no code ever string-matches
model prose. (Example: the move recognizer's target machine is an enum of the real nicknames + `null`,
emitted by the model, not resolved by matching its words.)

**Benchmarks earn a real job.** Constrained/structured output is only as good as the model's adherence
to it. Measure which models reliably honor schema/enum output and route these decisions to those. This
is a concrete, measurable bar — exactly what the benchmark harness should exist to answer.

**In practice.** Route the decision through the shared `IntelligenceProvider` (as `CoherenceGate` does).
Where latency/cost matters, a cheap structural pre-filter may run first but only to DROP obvious noise
toward pass-through (as `TopicIntentCapture` does) — it may never itself DECIDE a positive intent.
Fail-OPEN: on any uncertainty (model down, breaker open, low confidence), do the SAFE thing for that
surface — for a message-gate that can swallow user input, that means pass the message through to the
agent, never hijack it.

**Enforcement.** A lint/ratchet flags keyword/phrase/regex lists tested against message or conversation
text inside sentinel/gate/classifier code (sibling to the existing "an LLM gate must not string-match"
guard, which was clearly not applied everywhere — three live-wired violators found 2026-07-03). New
such code must justify itself as one of the two survivors or route through an LLM.

**Earned from.** 2026-07-03 (topic 29836): `NicknameCommand.recognizeNicknameCommand` used a verb list
(`move/transfer/…/run/continue/resume/keep`) to decide if a message was a "move this to <machine>"
command; it silently hijacked "keep the work on the laptop" (discussion) as a command and swallowed the
operator's message before the agent saw it. The audit found six instances of the class, three live-wired
into the inbound message path. The operator's framing: we live inside intelligence that understands
context — dumbing its decisions down to string-matching is the antithesis of leveraging it, and it is a
reflex our own training pushes us toward that we must structurally refuse.

**Traces to the goal.** A sovereign, coherent agent must actually USE the intelligence it is. A keyword
list is brittle in both directions — it fires on discussion and misses genuine intent — so an agent
that gates its own perception through keyword lists cannot perceive its principal accurately. Coherence
of understanding requires inference-with-context, not lookup.
