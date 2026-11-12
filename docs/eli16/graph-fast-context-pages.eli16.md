# A faster default check that conversation-graph repair still works across a two-page proof

## The problem

When a machine joins an agent's shared conversation graph after another machine is removed, it receives a shared "proof context". This is one signed bundle that lists every past record, its hashes, and the new membership. It lets the new machine check that each old record is genuine without asking the original writer. The bundle can get big, so machines send it in pages of 128 KiB each. Repair after a crash has to pull every page from a signed peer and put them back together correctly.

A test proved this worked for a context bigger than one page. It built 300 real history rows, and each row went through the full signing, witnessing and certificate steps. That took about 347 seconds on the Studio. The integration tests run one file at a time inside a 30-minute limit, so this one test pushed every main check past the limit. A small earlier change made it opt-in. That stopped the timeouts, but the default test run then only had an eight-row case. Eight rows fit in one page, so nobody was checking by default that repair works across a page boundary.

## The fix

How big the context is depends almost entirely on two text fields in each row: the operation id and the idempotency key. Every other field is a fixed-length hash. The old test used short ids, so it needed about 300 rows to fill roughly three pages, far more than needed to cross one boundary.

The new default case uses the longest ids the production checks already accept: 80 characters for the operation id and 200 for the idempotency key. By an estimate worked out from the row shape (not measured from a real run), each row adds about 1.35 KB instead of about 1.15 KB, so 112 rows should come to about 151 KB. That would be over the 128 KiB page size with roughly 15% to spare, making a two-page context. Nothing about the protocol was loosened. The page size is still the real 128 KiB, and no signature, permission, erasure or size limit changed. The test still goes through the same full real process: two machines sign and certify every row, the owner signs a membership change, both members stage the transfer, the witness activates it, the added machine imports it, loses its whole source folder, restarts, and repairs everything from the signed peer.

The test proves the boundary was really crossed instead of trusting the estimate. The saved context file must be larger than 128 KiB. Every page the peer serves must say the context has at least two pages. Every page index from first to last must arrive. If the estimate is wrong, these checks fail loudly; they cannot pass by accident. All the old checks also stay: the refusal when the staging budget is one byte too small, verification of every record, the original certificate kept byte for byte, the live message body recovered, the erased body refused, and the full record count.

## Status at the initial draft checkpoint (2026-11-11)

This section records what was true when the draft was prepared. At that point the new case had not run: one manual run waited about 18 minutes for a test slot and was stopped on purpose before it started, so it gave no pass, failure or timing. The plan was to let the official Local Verify run on the draft pull request measure it. Running under 60 seconds on the Studio, not counting time waiting for a slot, is the goal, not a measured result. Whether it passed and how long it took is recorded by that official run (tracked as CMT-1637), not here. The slower 300-row and 4000-row cases are still available when `GRAPH_HISTORICAL_CONTEXT_SCALE_PROOF=1` is set.
