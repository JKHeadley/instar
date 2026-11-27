# Development review observation side effects

The disabled setting `jobs.observeEmptyDevelopmentReview` records an observation at successful session launch for the shipped development review on its scheduled path. It shares the category-tag predicate with the existing report, including jobs that are disabled. It records unknown when the loaded roster has errors or withheld legacy entries. It uses the existing run history and reads exact-session token usage at request time so late ledger ingestion becomes visible.

Under [Signal vs Authority](../../docs/signal-vs-authority.md), the observation is a signal. It has no authority over admission, launch, prompts, retries or scheduling. The new field is absent from older runs and runs outside the observation. Existing history authorization covers the response, which exposes counts and withholds the internal session binding. Missing usage remains null. The read may show only the usage ingested so far. Existing ledger retention still applies.

No block or allow path is introduced. The measurement is local to the agent roster. The join uses the scheduler's native session identity and explicit transcript aliases, so adjacent runs of the same job cannot inflate each other's counts. No additional model, process, external request or transcript read is introduced. Turn the setting off to stop recording new rows.

Focused tests cover native-session isolation, the started scheduler, real authenticated history endpoints, delayed usage, and the empty, nonempty, unknown and disabled states. Full shared verification remains required.

The integration test covers older rows and a neighboring run of the same job. It also checks that the history summary keeps the ledger key internal.

The production server now attaches its token ledger to the scheduler and connects the existing native transcript binding callback. The job ledger preserves the scheduler's normal and triage labels. An early transcript callback can register the session idempotently before the spawn callback. The real server lifecycle test proves attributed usage through authenticated history with the unified usage ledger disabled and no test injection into the scheduler or alias table.
