# Side-effects review: kept helper asks for both permissions

## Change

- `MacDesktopHost.probe()` records the kept copy's own reading before the installed copy's reading replaces it. When the installed copy serves (`servingPackaged`) and a `helperChange` applies, the change carries `keptMissing`: every permission the kept copy lacks.
- `DesktopProbeReadiness` uses `keptMissing` (when present) instead of the overall-missing list in the helper-change reason.
- New `MacDesktopHost.setupHelperPath()` returns the kept path whenever retention resolves to the kept copy; `AgentServer` passes it to `DesktopSetupTarget` instead of `servedHelperPath()`.
- `DesktopHelperPermissionChange` gains optional `keptMissing`.

## Over-block / under-block

No gate. Nothing blocks or admits anything differently; only text and a displayed path change. Serving selection (`servingPackaged`) is untouched.

## Level of abstraction

The kept-copy reading exists only inside `probe()`, so the field is computed there; the reason text stays in the readiness module.

## Signal vs authority

Signal only: operator-facing instructions. No authority added.

## Interactions

- `DesktopHelperPermissionNotice` keys its attention item on the source hash, not on the reason text; `keptMissing` does not change the condition key, so no duplicate notices.
- `servedHelperPath()` is unchanged and still names the copy a permission request would run; only guided setup moved to `setupHelperPath()`. `requestPermission()` still runs the serving copy (existing behaviour, out of scope).
- `/desktop/diagnostics` exposes `helperChange`, which now may include `keptMissing` (additive field).

## External surfaces

Diagnostics JSON gains one optional field. No config, migration, or hook changes; no CLAUDE.md template change needed (behaviour already documented as "diagnostics carry helperChange and the steps").

## Rollback

Revert the commit. No state is written.

## Tests

`tests/unit/MacDesktopHostIdentity.test.ts` (both-permissions ask while installed copy serves; kept-only ask when kept serves; setup path names kept copy), `tests/unit/desktop-probe-readiness.test.ts` (reason uses `keptMissing`), plus `desktop-setup-target` and `DesktopHelperPermissionNotice` run unchanged: 67 passed.
