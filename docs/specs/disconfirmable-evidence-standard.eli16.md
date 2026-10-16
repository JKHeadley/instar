# Evidence that could have disagreed - plain-English overview

## What this is

This is a rule for my self-improvement system.

When I say "this proves the problem is real" or "this confirms the fix worked", the check only
counts if it could have come back the other way.

If a check gives the same answer for every case, it is not evidence. It is just a constant that
happened to agree with me.

## The concrete bug that exposed it

One learning said an action was missing because this request returned 404:

```text
GET /evolution/actions/ACT-299
```

That sounded like proof. But the route did not exist at all. Every action id returned 404, present
or absent. The check could never have disagreed with the claim, so it was not evidence.

The same shape appeared in several places:

- `0 fired / 0 checked` was read as "this never fires", when it really meant "nothing checked it".
- A file with almost no finished action records could mean "the trimmer deleted too much" or "the
  trimmer stopped working". The file shape alone could not choose between them.
- Context files being non-empty was read like proof they were used at boot, but the boot script is
  the consumer. The file being well formed only proves the producer wrote it.
- A memory-size measurement sampled pinned entries, which were selected for being exactly the large,
  hand-written entries under discussion.

The common failure is simple: a symbol agreed with the story, and I treated that as corroboration
without asking whether the symbol could have refuted the story.

## What changes

Every important evidence line in evolution learnings and proposals needs to answer:

1. What claim is this supporting?
2. What instrument produced the observation?
3. What did it observe?
4. What result would have disproved the claim?
5. What denominator was measured?

If the evidence cannot answer those questions, it can still be saved, but it is labeled
`hypothesis`, not `evidence`.

## The HTTP rule

For HTTP-based evidence, I have to test the tool before trusting it.

That means checking a known-present case and a known-absent case. If both return the same result,
the route is not a valid instrument for that claim.

This would have caught the missing `/evolution/actions/:id` route immediately.

## The denominator rule

A ratio must print both numbers.

`0 / 42` means "measured, did not fire".

`0 / 0` means "unmeasured".

Those are different states, and the interface needs to show them as different states.

## The consumer rule

If the claim is about behavior, the check has to inspect the thing that performs the behavior.

A file existing proves the file exists. It does not prove the boot process read it.

A config flag existing proves the config was written. It does not prove the spawned process was
restricted by it.

A store having rows proves rows exist. It does not prove the user-visible slice contains them.

The consumer is the other end of the system. That is where behavioral evidence has to come from.

## What you need to decide

The main policy question is when the new requirement starts blocking old records.

The strict version blocks implementation and applied-status transitions unless the record has
structured, disconfirmable evidence. The gentler version allows old records to be updated once with
the missing evidence during implementation.

Either way, new consequence-bearing records should not advance on hypothesis-only evidence.
