# ELI16 — Apprenticeship program: the core ideas, written down once

## What this change actually is

Two new documentation files, nothing else. No code changes, no behavior changes, no
new features turning on anywhere.

For the last few days the apprenticeship program (one agent, Echo, mentoring another
agent, Codey, while Codey does real development work) has been steered by ideas the
operator stated in chat: what the program is for, what "phasing out" means, and how to
analyze failures properly. Chat history is a terrible place for load-bearing ideas —
every new session has to re-derive them, and a paraphrase drifts a little each time.
This change writes them down once, canonically, in the repo the program lives in.

## What the two files say

**PROGRAM-CONCEPTS.md** captures five operator-ratified ideas:

1. When the mentee improves Instar, he upgrades BOTH agents — the mentee isn't just
   fixing his own tooling, he's rebuilding the shared platform both agents run on.
2. The mentor's current advantage is temporary (Instar was built Claude-first). The
   end goal is parity for every framework. What stays different on purpose is the
   ROLES: one observer, one worker — that separation is where the leverage comes from.
3. Each layer teaches its role downward: the operator teaches the mentor how to think
   like an operator, the same way the mentor teaches the mentee. "Phasing out" means
   moving up a layer, not disappearing.
4. A logged failure isn't done until three questions are answered: what infrastructure
   gap allowed it? Is a watchdog failing, or missing entirely? What standard would have
   prevented the whole class ahead of time?
5. Two research ideas (hidden test batteries, high rejection rates) are adopted only in
   bounded, operator-reviewed form.

**DEFECT-MATRIX-TEMPLATE.md** turns idea 4 into a form: every defect entry in a drive's
tracking matrix must answer those three questions as required fields, or it doesn't
count as logged. It also requires evidence (a screen capture, an acknowledgment) for
any claimed cross-agent action — never just "I sent it."

## What you need to decide

Whether these written framings match what the operator actually meant. They were
drafted directly from the operator's own messages (topic 29723, July 16-17) and are
labeled with that origin. If a framing is off, editing the doc is the whole fix —
there is no code depending on the wording.

## Safeguards, in plain terms

Docs only. Nothing reads these files at runtime. Wrong wording costs an edit, not an
outage. The riskiest thing about this change is that a future reader treats a
mis-stated concept as the operator's intent — which is why each section cites its
origin (operator, topic, date) so it can be checked against the source.
