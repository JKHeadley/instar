# Login Flow Restart Recovery — Side Effects

## Runtime

- Startup re-drives each durable, non-terminal pending login before serving
  dashboard traffic.
- A dead-pane submit may create a fresh provider login process and public
  verification artifact.
- Missing flows auto-mint only when the matching pool account is explicitly
  `needs-reauth` or in an owner-login-required drift episode.

## External

Provider login commands may run once per unfinished flow after server restart.
Background restoration never opens a browser. No stale submitted code is typed,
stored, returned, or logged.

## 6b. Operator-surface quality

The affected dashboard cell continues to lead with its primary sign-in action.
The new states use plain language (“expired” and “a fresh sign-in is ready”),
with no status codes, process names, paths, or internal identifiers as primary
content. No destructive action is added or promoted. The copy is short enough
to read at phone width and directs the operator to the fresh flow already shown
in the same account cell.

## Rollback

Reverting the wizard, boot wiring, route, and dashboard changes restores the
prior behavior. The pending-login file schema is unchanged.

## Class-Closure Declaration

- Defect class: `unbounded-self-action`
- Closure: `n/a`
- Reason: boot recovery is a one-shot pass over the finite durable pending-login
  set, with at most one re-drive per incomplete record and no self-rescheduling
  path. Dead-flow refresh is user-triggered and bounded to one flow.
