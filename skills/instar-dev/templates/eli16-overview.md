# <Spec Title> — Plain-English Overview

> The one-line version: <the entire decision compressed into one sentence>.

## The problem in one breath

<Two or three sentences explaining what's actually broken / missing / needed. Plain English. No internal module names unless they're already in the user's vocabulary.>

## What already exists

<List the relevant pieces of the system that ARE already in production, named in plain terms. The reader needs to know what's already working before they can evaluate what's being added.>

- **<Component A in plain terms>** — <what it does, what it doesn't do>
- **<Component B in plain terms>** — <same>
- ...

## What this adds

<Lead with the single biggest change. One paragraph max. Then bullet the secondary changes. Avoid type signatures, file paths, and internal field names unless naming them genuinely adds clarity.>

## The new pieces

<For each module/system being introduced, one paragraph in plain terms:>

- **<Name>** — <what it does, what it's NOT allowed to do, why the line between them matters>

## The safeguards

<The amendments / guardrails / threat-model coverage, in plain terms. Group them — don't enumerate every finding. Something like:>

**Prevents X from happening.** <one paragraph>

**Prevents Y from happening.** <one paragraph>

**Prevents Z from happening.** <one paragraph>

## What ships when

<The phases or PR order, in plain English. Roughly: foundation pieces ship first, then the wrappers/UI, then the optional layers.>

## What you actually need to decide

<End with the explicit decision being asked of the reader. Should be one sentence ending with a clear yes/no or shape-question. The reader should know exactly what they're saying yes to.>
