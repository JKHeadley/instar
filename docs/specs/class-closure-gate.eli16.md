# The Class-Closure Gate — Plain-English Overview

## What this is

Last night I fixed ten prompt defects, each with full evidence. But you had to be the one to ask the bigger question: "what KIND of problems are these, and what stops the whole kind from ever coming back?" It turned out the ten fixes were really just four kinds. Nothing in my shipping process forces that question — it fired only because you asked. This spec builds the machinery so it fires every time, automatically.

## The two pieces

**Piece 1 — the gate (at fix time).** From now on, when I fix a defect in something I authored (a prompt, a hook, a config, a standard), the fix can't be closed until it answers two short questions on the record: *What class of defect is this?* (from a growing catalog — the four from last night seed it) and *What now prevents the whole class?* — either point at the concrete guard (a test, a rule, a check that now exists) or file a tracked "we owe a standard for this" item. One paragraph of work per fix. The effect: a fix can never again quietly treat a symptom while the disease stays unnamed.

**Piece 2 — the escalator (over time).** My failure-learning system already collects records of what went wrong; today it only *displays* patterns. New rule: when the same class shows up 3+ times across different components, the system must produce a DRAFTED standard proposal and put it in front of you — not just more one-off fixes. You approve or reject; nothing enters the constitution without you. Data goes in; a proposal is forced out.

## Why this converges

Every caught defect either cites the guard that ends its class or creates the tracked demand for one. Repeating classes force a drafted rule to your desk. Rules can only accumulate; classes can only shrink. It's the same ratchet idea we already use for routing and test coverage — applied one level up, to the standards themselves.

## What changes for you

Occasionally you'll receive a drafted standard proposal to approve or reject (one per pattern, never a flood — re-triggers update the same draft). That's the whole visible surface.

## Open questions (your call, stated simply)

1. **Where's the starting line?** We propose the gate applies only to defects in things I authored (prompts, hooks, configs, standards) — ordinary product bugs stay exempt at first, so every bugfix doesn't get taxed with paperwork. Widen later if it earns it. Agree?
2. **The trigger number.** A drafted proposal fires at 3+ instances across 2+ components, with no time limit (defect classes don't expire). The four known classes get marked "already handled" so history doesn't immediately re-fire. Sound right?
3. **Who names the class?** The fixer (me) declares it; the machinery checks form, not judgment. Is a periodic "were these filed under the right class?" audit worth building, or does your review of proposals catch drift naturally?

## What the multi-reviewer process changed

The meta-machinery took the hardest beating — reviewers attacked it as future lazy fix authors would. (1) Instance counting is now DERIVED by scanning the committed fix records rather than hand-edited per fix — no merge conflicts, no undercounting, no routine fix ever needing your manual merge (an earlier draft would have accidentally routed EVERY fix through you). (2) A made-up hyper-narrow defect class buys nothing: novel classes need real definitions (what's in, what's out, nearest existing class), enter unconfirmed until you ack them, and can't claim closure while unconfirmed. (3) A cited "guard" only counts if it's genuinely ALIVE and enforcing — a dark or draft guard auto-downgrades the claim to an open gap, and gaps can't park forever (they age, escalate, and count toward forcing a drafted standard to you). (4) The four already-fixed classes are seeded closed for history, but a NEW occurrence of any of them re-alarms immediately and deterministically. (5) Security/privacy classes escalate on ONE occurrence, not three. (6) The whole proposal-drafting arm must obey the sibling standards it ships alongside (its inputs are untrusted, its output is durable — it scrubs and neutralizes like everything else). (7) *Round 3:* the counter now reads from exactly ONE machine-readable ledger, deduped by PR — an earlier draft scanned two mirrored records of the same fix and would have counted every fix twice (2 real instances looking like 4, falsely tripping the "3+ means draft a standard" wire). (8) *Round 3:* a class that recurs heavily inside a SINGLE component now also escalates (at 5 instead of 3) — before, ten repeats in one component never tripped the wire because the trigger insisted on spread across components.
