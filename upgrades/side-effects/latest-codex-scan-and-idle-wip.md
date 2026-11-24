# Side-effects review for the scheduled scan and idle model drafts

This is a Tier 2 work-in-progress checkpoint. The scheduled scan draft changes fleet job defaults and the idle draft adds process identity evidence. These drafts are for review. Keep release and live activation on hold.

## Over-block

The packaged catalog read fails closed for unsigned, missing or changed assets. An old package can therefore lack the new read surface until a signed package is available. The committed observation reader also rejects legacy successful runs without an attested digest. The macOS sampler withholds identity evidence when the process exits, changes generation or cannot be inspected.

## Under-block

The scheduler verifies the staged observation and attaches its digest. The shared HTTP history reader and safe pruning remain pending. The packaged reader fixtures use temporary signing keys. They cannot establish signer custody for a release. Process generation alone cannot prove that the terminal owns the expected Codex thread or that switching is safe.

## Ownership and authority

The scheduler owns successful run records. The packaged catalog reader owns signature and asset digest verification. The process helper reports kernel evidence to its caller. Under [Signal vs Authority](../../docs/signal-vs-authority.md), these observations confer no authority to change models or route work.

## Interactions

The scan draft changes the default cadence. New jobs stay disabled. Existing enabled jobs are preserved. Existing explicit configuration, the kill switch, and legacy notice behavior require parity checks before release. The observation reader requires the exact scheduler run and machine. The idle helper has no production caller.

## External surfaces

The packaged catalog can change what existing HTTP readers report if enabled and backed by trusted assets. The job template is a fleet-facing change. The idle fixture ran only against disposable local processes.

## Multiple machines

The catalog is a signed package asset. Scan observations and process identity are machine-local. A scan on one machine cannot attest another machine's scheduler run. A process generation cannot transfer with a topic.

## Rollback

Discarding the drafts leaves the current runtime intact. If the scan is later deployed and needs to be suspended, the existing doorway-scan kill switch stops the job. Restoring prior defaults and installed manifests would require a release with migration parity checks.

## Review status

Focused scan/store and scheduler history checks passed, as did three disposable macOS fixture cases. All 55 lint steps passed on the staged drafts. Independent side-effects review, complete verification, and release evidence are pending.

The independent review raised three concerns. The new-job default has been restored to disabled. Blocking issues remain for already-enabled jobs: the installed wrapper can invoke the prober without verifying its executable digest, and the existing scheduled script can update shared manual scan state. This checkpoint cannot be cleared for release while those paths remain.

## Opt-in execution checkpoint

The scheduler now admits the signed free-probe profile through the existing script runner and its claims, supervision and global and per-job operator controls. The explicit profile permits the zero-model doorway job through the default first-wave list. A blocked packaged run cannot fall back to a model session. The runner passes the verified executable bytes through stdin, records each attempted doorway before it starts, and reopens the staged result before recording success with its digest. The new path writes only machine-local run artifacts. Turning off the profile restores legacy routing on a subsequent trigger. Both profile selection and the kill switch use the scheduler's state directory.

Unsigned assets, missing machine identity, invalid configuration and incomplete output prevent an attestation. Packaged execution sends no notices and does not advance the manual baseline. Full release evidence, retention and freshness reconciliation, and legacy delivery parity remain open. The opt-in stays absent from defaults.

## Scheduled observation read checkpoint

The scheduler records which ledger rows selected the packaged profile, including runs that fail before starting a probe. The read model keeps the latest job result, latest admitted attempt for each doorway, and last committed observation separate. It uses the scheduler's cron parser to calculate expiration and leaves conflicting wall-clock evidence unknown. There is no pruning or change to either HTTP reader in this checkpoint. The read model requires bounded local history and the current enabled schedule from its eventual caller.

Independent checkpoint review concurred after a regression test confirmed that corrupt admission records withhold current reachability. Before connecting either HTTP reader, apply the same rule when an admission record conflicts with its corresponding ledger row.
