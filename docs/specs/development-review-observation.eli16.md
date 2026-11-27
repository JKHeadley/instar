# Measuring model launches for empty development reviews

The development review asks the scheduler to list the jobs tagged as development. On November 22 the list was empty, but the review had already started a model session. That session recorded 331,137 tokens including cached input. This change measures how often that happens so a later decision can use real run data.

The observation starts disabled. If enabled, the standard scheduled review reads the same loaded list that feeds the category report. An empty list records that the review would qualify for a skip. Any matching job records that it would run. An incomplete list records an unknown result. The review still launches as usual in every case. Manual runs and custom versions of the job are outside the trial.

The authenticated job history shows the observation beside the actual usage attributed to that session. Usage is unknown until the token ledger has a measurement. Cached input, fresh input and output are separate numbers. Disabling the flag stops collecting new observations and leaves past measurements readable.

The history list and its latest-run summary both use the same public observation fields.

The server attaches the token ledger on startup and links each reported job transcript to its scheduler session. This works even when the separate unified usage ledger is disabled.
