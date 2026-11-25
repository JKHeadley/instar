# Testing Two Compatible Changes Together

A long queue of finished changes is waiting for complete testing. The proposed experiment checks two compatible changes together, then merges the exact combined version that passed. That can save a full test run when the pair works together. It can also cost extra work when the pair fails, so the measurement includes failed runs and the work needed to separate them.

The first possible pair is the clearer Accounts list and the large-repository worktree deadline repair. They change different files and are adjacent in the saved normal waiting order. They can be selected only after earlier priorities finish and a fresh check confirms their heads, dependencies, holds and outside overlaps. Nothing in this document moves them ahead of another change.

The existing test system still checks every required test. A successful combined result belongs to that exact combined version; it never invents a passing result for either original version. The publishing owner creates a separate combined candidate. After the checked version actually merges, the original requests can be closed with links explaining where their changes landed. If the combined run fails, the original changes return to separately checked candidates.

This is a design for one measured experiment. No combined candidate has been published or tested, and the running main repair continues first. The document changes no installed software or service settings. The next decision is whether the publishing owner accepts the concrete membership and current compatibility evidence at the moment the pair becomes eligible.
