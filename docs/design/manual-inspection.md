# Manual Design Policy Inspection

The manual checker compares two committed Git trees. It identifies affected screens and inspects the standard's structure and permanent rule history. It also preserves both versions of changed wording for independent review. It does not approve a change, judge a screen, authorize an exception or enforce merging.

```
instar design:inspect --repo /path/to/repository --base BASE_COMMIT --head HEAD_COMMIT
```

Choose the trusted comparison commit explicitly. The command pins both refs once and reports their immutable commit IDs. It reads Git blobs, not working files, and runs no candidate scripts or imports. Renames are read as a deletion and addition, and both versions of changed source text are inspected so deleting HTML cannot hide a screen change. Both trees must contain `docs/DESIGN-STANDARD.md`, `docs/design/screens.json`, and `docs/design/rule-ids.lock.json` as ordinary files. A baseline before these files existed is unavailable, rather than a successful empty check.

The JSON includes `scope: manual-design-policy`, `mergeAuthority: false`, the exact evaluated checks and `notEvaluated`. The statuses are `structurally-valid`, `findings`, `review-required`, `invalid-policy`, and `unavailable`. Exit codes are 0 for structurally valid, 1 for findings or review, and 2 for unavailable. Even exit 0 leaves all visual and review obligations in place.

The command checks four things: standard structure, permanent rule history, screen registration, and earned-rule text and provenance. It does not run rendering, accessibility, coverage or modes, feedback-entry lint, semantic wording review, owner waivers or merge enforcement. Those are the remaining stages of the approved design-standards project, tracked in `docs/specs/design-standard-enforcement.md`. Any rule present at the base and missing at the head is reported as `rule-removed`, whether or not the rule was earned from feedback, and so is a rule whose heading no longer parses. An earned wording change is a review signal; this command neither decides that the change weakens a rule nor accepts an agent's claim that it does not.

Reads have an operational budget of 30 seconds total, 2 MiB per blob, 4 MiB for the path diff, and 2,000 changed paths. Exceeding a budget returns unavailable. These are bounds for a manual read, not new merge rules or a waiver of the approved standard. Shared production route files intentionally affect all registered consumers until narrower handlers exist in the production tree. The initial registry keeps all screens marked uncaptured.

Git reads disable replacement objects and lazy fetching, use the existing Git executor’s repository/config environment scrub, and strictly decode UTF-8. Noncanonical backslash paths are unavailable instead of being rewritten into another file. Total Git output is capped at 16 MiB, including source blobs; aggregate bounds apply before retention. Older Git versions that cannot disable lazy fetch report unavailable. The deadline is checked again after synchronous inspection before returning a successful report.

Reads use Instar’s existing audited Git executor; normal local executor audit entries can be written. The selected base and candidate code are never imported or run.
