# A constitution check for every bug fix

A small fix can violate an important principle just as easily as a large feature. Until now,
small changes could use a shorter development path that skipped the constitution checker entirely.
Bug reports could also suggest an implementation before anyone reviewed the design, giving the
builder a bad starting assumption.

This change keeps the shorter path but adds a warning-only constitution review to every change.
The developer sees what the checker found, and the existing independent reviewer decides whether
the actual fix respects the governing rules. A checker warning does not automatically block work.
If the checker could not run, the record says so, rather than pretending the change passed.

The automated feedback pipeline's existing reviewers also receive the constitution when they
review a fix. They judge the fix itself, with the report's claims treated as evidence to examine,
not directions to obey. Bug reports describe what happened, what should have happened, and the
evidence. Any suggested cause or remedy is clearly a hypothesis requiring independent review.

The checker must read the right constitution. The old Instar registry points to the purpose and
rule book in the newer project as the governing documents. Those complete documents will ship
with their source version and hashes, so a reviewer can identify exactly what it read and works
without a network fetch. Missing documents or incomplete input are reported as an unavailable
check. They never become a clean bill of health.

No new person needs to approve ordinary fixes. Existing independent review, testing and merge
protections remain responsible for what ships. The change also reaches existing agents on update,
and Echo's running bug-overseer job receives the same instructions on the machine that owns it.
