# Work Card Plain Language

## Summary

This reversible draft adds a deterministic check to agent-written card creation and edits and to the request-to-card path. It recognizes common internal identifiers, commit fingerprints, code-shaped words, and a short list of recurring internal terms. The refusal names the field and requests a rewrite.

## Over-block

Some technical language is useful to an owner. Common product names remain usable. The check is restricted to agent-authored copy. A verified owner's original request remains verbatim, and people can write their own cards in their own words. Unchanged text on a legacy card remains editable one field at a time.

## Under-block

This check is a structural writing floor. It does not infer the meaning of arbitrary jargon or whether a completion item expresses the right outcome. Server-owned templates such as custom app version cards use stored approval material that requires a separate owner-facing projection. They keep their existing behavior in this draft.

## Level Of Abstraction

Work Board validates the text before it records a card. The commitment route uses the same projected fields before it records an eligible new request. Technical references remain available in structured source fields and link destinations.

## Signal Versus Authority

The check changes what an agent may save as copy. Existing owner identity, approval proofs, source binding, and card permissions still decide authority. It never approves a card or quietly rewrites its intent.

## Interactions

A new eligible commitment can be retried after the author rewrites the named field. A historical item that fails in the card backfill keeps its existing commitment record and a terminal card reason, so the board does not retry the same copy forever. Other cards can still accept metadata-only changes.

## External Surfaces and Multi-Machine Posture

The server checks new local writes and continues reading replicated records from older versions. An older writer cannot enforce a check it does not ship. The template and content-sniffed migration teach existing and new agents to handle the rewrite response.

## Rollback

Revert the guard, request preflight and guidance. Existing cards retain the human-written copy saved through the normal route.

## Evidence

The focused suite covers text patterns, nested fields, intact technical references and original request scope, HTTP create and update, and a production server lifecycle. Independent review identified internal producer approval material and a request retry risk. The implementation now isolates those producers and returns a rewrite instruction before recording an eligible commitment.
