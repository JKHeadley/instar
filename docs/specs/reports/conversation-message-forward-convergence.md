# App Forward server review

The initial and confirming reviews examined source visibility, destination access, request custody, history segregation, journal validation and next-session context. The first independent review caught transfer-state acceptance, private metadata exposure and automatic context ingestion. The runtime now requires active serving ownership on the original machine, strips the internal binding from sync and browse, and routes session-facing reads through history that excludes forwards before pagination.

Cross-model rounds identified inconsistent receipt recovery, insufficient crash coverage, lost context caused by filtering after a limit, a replication envelope decoding error and authorization order that exposed an early source outcome. The corrected contract binds a freshly signed attempt to its original machine and exact intent. A durable destination record can settle a receipt after restart. An entered reservation with missing or unreadable evidence remains unknown. Destination send is checked before inspecting a fresh source and current grants are rechecked before reservation. The replica decoder removes the envelope origin after checking it against the sender, and validates copies separately.

## Experience fit

The text-only first increment provides the selected occurrence and explicit destination needed by the message menu. An interrupted request can yield a stable receipt, an unavailable result or an honest unknown. The operator's existing draft is independent of Forward. Activation requires native testing, compatible peers and the usual full candidate verification. Attachments and bridged operation remain distinct message-action milestones.

## Related work

- App message actions for selection and destination placement.
- App Reply and exact message history for signed target admission.
- Inbound delivery custody for restart behavior.
- App replication and the context-budget row writer for history delivery and exclusion.

## Disposition

The independent confirming reviewer concurred on the default-off candidate. The last cross-model review, from Codex Astra, found no material issue in the dark server scope. It noted the difference between a direct assertion on the reconciliation output and the separate real-store exclusion proof, and suggested making the final read-revocation test independent of middleware call counts. The supported older decoder and live native menu are pre-activation checks. This review does not claim a live multi-machine run.
