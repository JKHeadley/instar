# Side effects of keeping Accounts quota visible

- Scope. The web Accounts row and the app's existing owner-scoped account response change how quota is displayed and consolidated. Machine sign-in classification, permissions, and repair actions use their existing inputs.
- Evidence. Each valid, timestamped quota window competes independently with the same window on other answering machines. Readings beyond the existing app clock-skew allowance are excluded in both projections. Old windows still display their rollover state.
- Partial answers. A timestamp without a usable window records the last check. A real window retains its source timestamp. The oldest displayed window determines the overall stale indicator.
- Authority. The projection supplies usage information to the owner. Existing authentication and account repair flows retain control of mutations. The selected windows continue to feed existing capacity notices under their existing eligibility rules.
- Migration. The native response gains optional lastCheckedAt for empty rows. Older clients tolerate its absence. Native layout changes ship separately and continue to render older responses.
- Rollback. Revert this projection and web change independently of the native row change.
- Verification. Existing whole-file unit, integration, lifecycle and ratchet tests are assigned to the shared Studio wrapper. The release proof requires actual Accounts rows at phone and laptop widths after installation.

## 6b. Operator-surface quality

Accounts leads with the limit, percentage, and reset time. Account names and readable machine names remain the labels. The empty state shows “No reading yet” and a plain last-check age when available. It exposes no raw IDs or timestamps. The existing Sign-in repair view owns repair actions. This change adds no destructive control. At phone width the empty track and both status lines span the account row. That layout still needs the released 390-pixel check.
