# Legacy apprenticeship cycles remain inspectable — ELI16

The integrity report exists to find old cycle records that no longer line up with the current apprenticeship registry. Those old rows can also contain vocabulary from before the current `kind` list was introduced. Previously, the store applied today's strict write rules while reading history, so one unfamiliar historical value crashed the entire report with a server error.

Reads now preserve the row and represent any out-of-date `kind` as `unknown`. This is deliberately different from writes: a new cycle still has to use one of the supported values and is rejected if it does not. Historical data remains visible without weakening the rules for new data.

The behavior is covered at the store, HTTP route, and real server initialization layers. The integrity endpoint can therefore do its actual job—enumerating legacy inconsistencies—without silently rewriting or deleting the evidence it is inspecting.

## ELI16 — practical result

One strange old label can no longer take down the apprenticeship integrity report. Old rows stay readable and honest; new bad rows are still refused.
