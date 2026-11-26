# Delete dispatch fence

The unmounted supervisor boundary recomputes the fleet read decision before
dispatch. It matches the selected custodian to the isolated worker's machine,
instance, generation and listener. A continuation can require the same worker
and compartment. The callback receives a frozen copy.

- Over-block. Missing current evidence denies dispatch. This can deny a
  legitimate conversation during controller loss or worker replacement.
- Under-block. The caller must establish actual process and data isolation,
  read current evidence, and perform the check before each protected emission.
  This checkpoint does not mount a supervisor, listener, or stream.
- Abstraction. The lifeline owns dispatch. Fleet policy still decides custody.
- Signal versus authority. The decision consumes verified control-plane facts.
  Request labels, version strings and worker self-reports grant no authority.
- Interactions. Rechecking the worker tuple prevents a retained continuation
  from selecting a replacement worker. Dispatch must start synchronously.
- External surfaces. There is no change to application routes or deployment.
- Multi-machine posture. Authorization checks the custodian and selected
  worker machine. Isolation evidence comes from the supervisor for that worker.
- Rollback. Reverting the unmounted checkpoint needs no data migration.

## 6b. Operator-surface quality

This checkpoint adds no user-facing behavior.

## Independent review

Concur for the unmounted dispatch boundary. Mounting must pin the
conversation and worker at stream open, start the actual dispatch within the
checked turn, and establish process isolation and rollback-protected
controller evidence independently of the application.
