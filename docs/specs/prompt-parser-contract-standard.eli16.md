# Prompt↔Parser Contract Standard — Plain-English Overview

## The problem this closes

When one of my AI checks (a "gate" or a classifier) asks a model a question, two
things have to agree that are written in two different places. The **prompt**
tells the model what words it's allowed to answer with — say, `PASS` or
`B15_CONTEXT_DEATH_STOP`. The **parser** is the little piece of code that reads
the model's answer back and decides what it means. Nothing forced those two
halves to stay in sync.

On 2026-07-02 a review of my own gates found exactly this break in the tone gate.
The prompt taught models the *short* name `B15`. The parser only accepted the
*full* name `B15_CONTEXT_DEATH_STOP` and threw everything else away. So every
model, on every route, did exactly what the prompt said — answered `B15` — and
every one of them "failed." It wasn't the models' fault at all; it was ours. One
tiny test comparing "what the prompt promises" against "what the parser accepts"
would have caught it before it ever shipped.

## The idea in one sentence

A prompt and its parser are **one contract with two halves**. If the two halves
can drift apart silently, they eventually will — so make the drift a build
failure instead of a hope.

## What this ships (all dark / report-only)

- **A shared contract library** (`src/core/promptContract.ts`). It defines the
  shape of a co-located "promise" a callsite can carry next to its prompt, and a
  pure helper, `deriveRejectedForms`, that *mechanically generates* the wrong
  answers a contract test must prove the parser rejects — the case-mangled,
  chopped-at-the-underscore, separator-stripped forms (including the exact `B15`
  shape). Generating them by machine matters: a hand-written list of "bad
  answers" invites lazy, trivially-wrong examples that prove nothing.

- **A classification of every LLM callsite** (`LLM_PARSER_CONTRACT` in
  `src/data/llmBenchCoverage.ts`), the `contract` sibling of the two axes the
  earlier defect-class standards added. For each of my ~53 AI components it
  records, with no default allowed, whether that component's answer is parsed
  into a *closed set of taught words* (so it needs a prompt↔parser contract
  test) or genuinely isn't (a free-text summary, a fixed self-check probe, or a
  component with no live prompt at all — each with a written reason). Forgetting
  to classify a new callsite fails the build, so the flag can never quietly slip
  toward "unchecked."

- **A shrink-only ratchet** (`tests/unit/parser-contract-classification-ratchet.test.ts`).
  The four highest-stakes parsed callsites named in the spec — the tone gate, the
  external-operation gate, the stop judge, and the input classifier — are pinned
  as a seed set that can only *graduate* to a real contract test, never quietly
  drop out of scope. Every other parsed callsite is pinned in a "pending" list
  that can shrink as tests are written but can't grow silently. A cross-check
  flags any gate or classifier marked "no contract needed" unless it's been
  explicitly reviewed onto an allowlist.

## What this deliberately does NOT do

It changes **no** prompt and **no** parser. Not one live check behaves any
differently after this merges — it is pure inventory and machinery. The actual
per-callsite contract tests each need the real production prompt refactored into
a clean, testable render function, and that touches live parsing code — so it's
deferred to its own carefully-gated increments, one at a time. The constitutional
registry text that names this a standard also waits for the operator's explicit
sign-off. This increment is just the honest map of where the work is, plus the
tool the future tests will use — so a taught-but-unparsed vocabulary becomes a
red build instead of a silent, 100%-our-fault defect.
