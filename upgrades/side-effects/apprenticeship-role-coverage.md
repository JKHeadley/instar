### apprenticeship-role-coverage side effects

Primary risk reviewed: a visibility surface could accidentally become authority and start blocking
apprenticeship lifecycle transitions or messages.

Mitigation:

- The new route is read-only and only calls `ApprenticeshipCycleStore.roleCoverage(instanceId)`.
- `driftWarning` is a boolean signal, not a gate. No transition route, message route, or completion
  gate reads it.
- Store migration only changes legacy `kind = 'differential-cycle'` rows to `unknown`; it does not
  assign them to a real role axis.
- New writes use a closed vocabulary. Invalid labels fail fast instead of silently creating fake
  coverage.
- Unknown historical rows are preserved in a separate `unknown` bucket so operators can see that
  evidence exists without treating it as mentor-mentee or overseer review coverage.

Secondary risk: a default kind could hide a missing caller update. The only current HTTP cycle-write
site now explicitly supplies the default `mentor-mentee-differential` value when a request omits
`kind`, and tests pin the returned kind.
