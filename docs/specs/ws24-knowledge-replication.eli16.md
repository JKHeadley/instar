# WS2.4 Knowledge-Base Replication — ELI16

## What is this?

Your agent keeps a knowledge base — a catalog of sources it has ingested (articles,
transcripts, docs), each with a title, a link, some tags, and a short summary, plus the full
text saved in a file. Today that catalog lives on ONE machine. If you run the agent on a
laptop AND a Mac mini, a source you ingested on the laptop is invisible to the mini. WS2.4
fixes that: when you turn it on, a source ingested on one machine becomes known on the others
— ONE knowledge catalog, not one-per-machine.

## How does it know two machines ingested "the same" source?

This is the tricky part. Each machine gives every source its own local id like
`kb_20260601_abc123` — but those ids are LOCAL. The laptop's id and the mini's id for the
same article are different. So we can NEVER use that id to decide "is this the same source
across machines."

Instead we compute a CONTENT FINGERPRINT — a hash of the source's link (or its title, if it
has no link) plus its type. If two machines ingest the same article, they produce the SAME
fingerprint, and the two copies collapse into ONE record instead of showing up twice. Trivial
differences (extra spaces, capitalization in the URL) are ignored. Genuinely different sources
get different fingerprints, so two unrelated sources never get mistaken for one.

## Does the whole file travel between machines?

No — and this is the important scope decision. Only the catalog ENTRY travels: the title, the
link, the type, the tags, the summary, and the word count. The full ingested file (which can
be a huge transcript) stays put. The other machine LEARNS the source exists and can re-fetch
or re-ingest it locally if you want it there too. This keeps the sync small and fast. (Syncing
the full file bodies is a planned follow-up, not part of this change.)

## What if two machines have slightly different versions of the same source?

A knowledge source is REFERENCE, not a command, so we never silently throw one version away.
If the laptop and the mini both re-summarized the same link at the same time and they
disagree, the agent surfaces BOTH versions as advisory hints and flags the conflict for you to
clean up later if you want. It never blocks waiting for you to decide. A replicated copy from
another machine never overwrites a different local copy.

## What about sources that get removed?

If you remove a source and it just vanished locally, another machine that still had it would
keep re-sending it — and it would come back from the dead forever ("resurrection"). So when a
source is removed, the agent sends a "tombstone" — a positive "this one is gone" marker — so
the removal sticks everywhere, even on a machine that was offline when you removed it.

## Is it on by default? Is anything private leaking?

No. It ships DARK: `multiMachine.stateSync.knowledge.enabled` defaults to `false`. With it
off, nothing changes at all — a single-machine agent behaves byte-for-byte as before, and no
source ever crosses a machine boundary. When you DO turn it on, every field is strictly checked
on arrival (the ingest date must be a real date, the type must be one of article/transcript/doc,
the word count must be a real number, free text is length-bounded, and a link that looks like a
sneaky file path is dropped) so a peer can't smuggle anything malicious in, and a peer's source
is always treated as quoted, untrusted reference — never an instruction. The local id and the
local file path are never sent across the wire.

## Why does this matter?

It's the third of a family ("memory-family") of replicated stores. Preferences (WS2.1),
relationships (WS2.3), and learnings (WS2.2) already do this; the knowledge base is next, and
the evolution queue and playbook follow on the exact same machinery. The end state: ONE
coherent memory that follows you across every machine you run the agent on, instead of a
separate brain per machine.
