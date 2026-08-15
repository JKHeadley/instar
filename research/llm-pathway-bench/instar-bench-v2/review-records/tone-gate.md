# Review Record — MessagingToneGate prompt edit (tone-gate)

**Status: CLEAN-WIN — SHIPS (v2 variant)**

## What changes
File: src/core/MessagingToneGate.ts:880 (canonical main).

Rule-id contract: the JSON schema line and the closing constraint now demand the FULL rule identifier (e.g. B15_CONTEXT_DEATH_STOP), byte-identical to the rule list. The incumbent prompt ENUMERATED SHORT IDS ('rule MUST be exactly one of B1–B9, B11, …') while parseResponse fails closed on anything but the full identifier — the prompt instructed the exact failure the parser rejects.

Variant under test: research/llm-pathway-bench/instar-bench-v2/variants/tone-gate.*.json (exact winning text ships verbatim).

## Why (forensic evidence)
Cross-model share up to 1.00 (ctx-completion-laundering: every model, both doors). 13 metered frontier groups (gpt-5.5, opus-4.8 via OpenRouter API) + all CLI routes show the identical abbreviation. Forensic verdicts: crit-cli + crit-metered forensic-verdicts.jsonl, promptFault=prompt-improvable, rationale cites the schema self-contradiction.

## Risk & rollback
Low. The edit only tightens the output-format instruction; rule semantics untouched. Rollback = revert the two edited strings.

## A/B result — v1 variant (ab-tone-gate, 196 cells, samples=1 + ×3 arbitration on disputed cells)
- **41 cells FIXED** across claude/codex/pi/groq doors — the rule-id abbreviation failure class is eliminated (18→0 on matched cells mid-run; full-run fixed list in ab-tone-gate-verdict.json).
- 2 raw "regressions", both arbitrated at ×3 samples: groq-llama4-scout cell = a Groq 429 (infra, now excluded by the comparator); claude-sonnet::bound-b19-parked-restart = REAL but noisy (arm A 2/3 → arm B 0/3), failure mode = UNESCAPED double quotes when the model quotes the candidate message inside the issue string — invalid JSON that breaks production identically. **The hazard pre-exists in the incumbent** (arm A sample 2 failed the same way; haiku is 1/3 in BOTH arms on this cell).
- Ruling: v1 must not ship per strict ratchet. **v2 variant** (rule-id contract + explicit escaping rule) authored — re-A/B queued after the driver sequence completes; arm A reused (incumbent unchanged), fresh arm B.

## A/B result — v2 variant (ab-tone-gate2, FINAL)
**CLEAN-WIN: 40 cells fixed, 0 regressed, 118 cells** (claude-sonnet/opus/haiku, codex gpt-5.5/gpt-5.5-plain/gpt-5.4-mini, pi gpt-5.5; samples=1 with ×3 arbitration on the single disputed cell — sonnet::canon-b17 was 2/3 pass, a sample-0 flake). v2 = v1 rule-id contract + JSON-escaping rule (the v1 A/B exposed a pre-existing quote-escaping hazard; v2 composes both fixes and the v1 disputed cell bound-b19 is now FIXED by the escaping rule). Infra-class cells excluded from accounting (comparator patch, evidence in ab-tone-gate2-verdict.json). Ship target: the two response-format strings in src/core/MessagingToneGate.ts.
