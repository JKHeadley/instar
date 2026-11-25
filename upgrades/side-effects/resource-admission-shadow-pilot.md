# Resource-aware admission shadow pilot

This adds a disabled-by-default, development-only report to the authenticated session reaper status read. The pilot reports count outcomes and cached Mac memory pressure. It does not change count policy or acquire capacity. It deliberately returns unknown for a normal-pressure fit while real startup calibration is absent.

- Over-block: the comparison has no admission authority. A missing sample or calibration can only suppress an advisory fit.
- Under-block: the observer may miss a decision or outcome. Its bounded in-memory history is lost on restart, and runner creation does not prove readiness or capacity.
- Level: existing SessionManager checks provide actual count evidence, and the existing host sampler provides cached native evidence. No competing admission path is introduced.
- Signal and authority: see docs/signal-vs-authority.md. The report cannot control launch, transfer or pause. Observer exceptions do not escape into the launch decision.
- Interactions: shared pressure sampling is unchanged. The pilot reads its cache. Two count paths report independently and the existing overload gate can still refuse after a count pass.
- External surfaces: the local authenticated status read has an opt-in report. Public health and default response behavior are preserved. The report contains counts and timestamps, without prompts or account data.
- Multi-machine: readings are host-qualified and reflect physical local measurements. This iteration exposes the local report. No cross-machine action is taken.
- Rollback: remove the pilot environment opt-in and restart through normal operations, or revert the source. No stored data needs migration.

Focused checks covered both count paths, the authenticated route, the disposable server startup, cache reads and the calibration reducer. A representative isolated launch and a measured overhead run remain required before enabling development observation.
