# Bound duplicate flushes inside a synchronous custody read

Implementation checkpoint only; no release concurrence, operator approval or full recovery acceptance is supplied by this artifact. Root owns GraphCustodyProfileAuthority.ts and the focused bootstrap tests. Existing reviewed Conversations scope and Justin's owned-machine/no-required-paid-service direction remain unchanged.

## Decision and authority

The real ordinary-pin diagnostic recorded 28,097 fsync calls taking 73.86 seconds in a 96.78-second window. Bounded stack samples identify the Core retained-file checker as one repeated site; they do not attribute every call or all elapsed time to it.

The change coalesces repeated flushes only inside one synchronous currentMembership or verifiedNegativeRoleLineage call. The private map is destroyed in finally. It never survives an await or request and never stores a membership, signature verdict, negative-state verdict or permission. Every artifact still receives fresh bounded descriptor reads, canonical-hash comparison, exact file identity/size/mtime/ctime and owned-root ancestor identity/mtime/ctime checks. Ancestors above the owned root bind identity, type, ownership and mode, so unrelated sibling activity cannot masquerade as a change in the owned tree. New or changed files are flushed. An unchanged ancestor may share its already-completed barrier within that same read. The bounded map falls back to full checks when full; it does not introduce a new admission refusal or shrink history.

Persist, hold issuance, ACT publication, pin, receipt and final publication/erasure paths retain their explicit barriers. The read optimization cannot sign, activate, acknowledge a Source or clear a hold. See docs/signal-vs-authority.md.

## Side effects and limits

- Over-block: metadata or ancestor changes during a check may reject that read. The caller keeps the existing unavailable/pending behavior; no fallback grants authority.
- Under-block: signatures and live negative controls are reread, including a negative control introduced after an earlier successful read in the same scope. No timestamp-only positive cache exists.
- Scope: synchronous local Core verification only. No peer/device route, credential, owner policy, membership definition or backup setting changes.
- Failure: a failed barrier or read clears the memo and throws. A thrown callback clears the entire scope. Cold and subsequent calls execute fresh barriers.
- Capacity: at most 4,096 metadata memo entries per call; overflow uses full validation. File reads retain the existing 32 MiB bound and use descriptor-bounded reads.
- Performance: reduced duplicate flush count is tested; integrated latency improvement is not yet measured or claimed. It does not establish larger-history capacity.
- Rollback: remove synchronous coalescing and return to full repeated flushes. Durable artifacts and all signed formats are unchanged.

## Validation and independent review

Eighteen focused real-filesystem and existing bootstrap/hold/activation tests passed in root-core-read-durability-unit-final18.log. A prior 17-test attempt executed zero tests because shared compilation was mid-edit; that failure remains recorded. The actual prep and signed HTTP two-case regression passed at the same frozen Core hash. Compiler evidence is root-core-read-durability-final-tsc.log. Exact source hashes and final counts belong in the checkpoint evidence after the terminal run. Independent review remains pending; this artifact is not its concurrence.
