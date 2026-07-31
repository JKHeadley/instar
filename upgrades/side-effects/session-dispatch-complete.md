# Side-effect review — complete context dispatch delivery

## Changed boundary

`ContextHierarchy` writes an unbounded generated `DISPATCH.md`. The two
deployed consumers in `PostUpdateMigrator` now preserve that producer contract
by emitting the complete file on fresh-session and compaction-recovery paths.

## Expected effects

- Session-start hook output grows by the currently omitted tail of the dispatch
  file (22 lines on the reporting installation).
- Tier 0 and Tier 1 guidance is visible at the point where agents need it.
- Future generator additions remain visible without coordinating a line cap.

## Explicit non-effects

- No context files are loaded eagerly because of this change; the dispatch file
  is routing guidance, not the referenced file contents.
- The intentional `AGENT.md` excerpt bounds are unchanged.
- No persisted data or config migration is required.
