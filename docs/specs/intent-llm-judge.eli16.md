# Phase-2 LLM judge for ORG-INTENT governance (CMT-1128) — ELI16

## What this is

Your organization writes down rules ("constraints") in ORG-INTENT.md, and
instar can test a proposed action against them: "would this action break a
rule?" Until now that test worked by comparing WORDS — if the action and a
rule shared enough keywords, the rule matched. That's fast and never wrong
when it fires, but it has a blind spot the live boundary-map run exposed: a
rule that says "never present unverified WORK as completed" plainly covers
"presenting ESTIMATES as CONFIRMED numbers" — but the words don't overlap,
so the keyword test said "no rule covers this." A false negative.

PR #899 made that blind spot HONEST (verdicts say "this is only a keyword
check, treat misses as unconfirmed candidates"). This change makes it
FIXABLE: when the keyword check misses, one small, bounded LLM call asks the
question the way a person would — "does any rule forbid this action IN
MEANING, not in wording?"

## How it works, concretely

Think of it as two doormen. The first doorman has a guest list and only
matches exact names — instant and reliable when the name is on the list. If
he doesn't find a match, the second doorman (the LLM judge) actually looks
at the guest and uses judgment. The first doorman's YES is final (no judge
call, no cost); only his NO gets a second opinion.

Every verdict says which doorman produced it (`method: 'llm-judge'` or
`'keyword-heuristic'`) — that label is only ever claimed for a real, parsed
LLM verdict. If the judge can't answer (model unavailable, rate-limited,
garbled reply), the keyword verdict stands and the response says so with
`judgeUnavailable: true` — you asked for semantics and got keywords, and the
system tells you that instead of pretending.

## Why it's safe

- **Ships dark.** Nothing changes unless `monitoring.orgIntentLlmJudge.enabled`
  is set to true in config — and an intelligence provider must exist too.
  With the flag off, the route's response is byte-for-byte what it was.
- **Signal-only.** The test-action route answers a question; it never blocks
  anything. A judge problem can never break the route — proven by tests that
  make the provider throw and still get a 200.
- **Bounded.** One LLM call per keyword miss, fast model, temperature 0,
  8-second timeout, and the call is attributed (`IntentLlmJudge`, category
  `gate`) so its cost shows up in /metrics/features like every other gate.
- **Honest.** A judged "no rule covers this" is stronger evidence than a
  keyword miss, but it is still a judgment — the verdict text says exactly
  that, so nobody (human or agent) mistakes it for ground truth.
