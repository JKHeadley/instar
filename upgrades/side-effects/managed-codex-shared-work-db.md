# Side-effects review for the ordinary launch common work database

The normal server poller opens the existing managed project work database for each ordinary execution and closes it after execution. It does so independently of the continuation switch so rollback does not bypass a held worker. An unused installation gets no database. Provisioned but missing, orphaned, unrecognized or linked database paths refuse launch. The protected directory is within the canonical agent state root.

The managed production launcher still does not provision this store. The packaged lifecycle fixture uses the actual opener and separate handles to prove the ordinary executor cannot start after managed enrollment. Server refusal is logged. The existing poller may consume the scheduled attempt before it discovers a hold. The next scheduler change should surface that hold before bookkeeping.

## Class-Closure Declaration

Each existing scheduled launch opens and closes one database handle. No additional launch schedule, retry loop or unbounded-self-action is introduced.

## Second-pass review

**Reviewer:** ordinary_shared_store_review, independent Instar second-pass agent

Concur with the ordinary-only wiring. The updater switch cannot hide an existing claim, damaged provisioned state fails closed, and the handle closes in the executor's finally path.
