# Make the 6-minute graph test opt-in (plain-English overview)

Every change to instar has to pass the full test run on our own machines before it can merge. The integration part of that run checks one test file at a time, and it has a 30-minute limit.

On November 11 a large change merged that added one test taking almost 6 minutes by itself. That pushed the Studio's integration tests past the 30-minute limit, so every check of the main branch failed there and nothing could merge. Over eight hours, the Studio ran 12 test checks and 11 of them ran out of time.

This change makes that one slow test run only when someone asks for it on purpose, the same way an even bigger sibling test in the same file already works. An 8-row version of the same check still runs every time. It goes through the same signing, restart and repair steps, just with less data.

What is lost for now: the default run no longer checks a history big enough to be split across more than one page. A faster test that does cover that case (about 87 seconds instead of 347) is already written as a draft. It will return to the default run once the Studio's time budget is confirmed to have room for it.

Nothing about how instar behaves changes. Only which tests run by default changes.
