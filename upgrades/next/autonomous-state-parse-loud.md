# Upgrade Guide — vNEXT

## What Changed

The autonomous stop hook used a fenced-frontmatter parser while the server
status reader accepted plain multiline fields. If a selected run-state file
existed without `---` fences, the server could report `active: true` while the
hook read an empty `active` value and silently exited 0 on every turn.

The hook now separates three outcomes:

- no state file: clean exit 0, unchanged;
- valid fenced state with `active: false`: clean exit 0, unchanged;
- selected state whose fences or required `active: true|false` field cannot be
  parsed: a visible error and nonzero exit.

The update migrator’s capability marker is bumped. Anchor-compatible recent
hooks are patched at exact unique anchors, so unrelated customizations survive.
Older canonical stock revisions are replaced only on an exact historical
SHA-256 match. Unknown layouts are left untouched.

## What to Tell Your User

If an autonomous run’s state file becomes malformed, the agent now reports the
corruption instead of quietly appearing to have no active run. No action is
needed for valid existing runs.

## Summary of New Capabilities

- Autonomous status and continuation can no longer disagree silently when a
  selected state file has lost its frontmatter fences.
- Missing autonomous state remains normal and silent.
- Existing stock installations receive the corrected hook during update.

## Evidence

- Refusal-first proof on the same fence-less active file: before, exit 0 with
  empty stdout/stderr; after, exit 1 with an explicit unparseable-state error.
- The test also proves the server-side reader reports that exact fence-less file
  as `active: true`, reproducing the live split rather than testing a surrogate.
- Absent-file and valid-inactive controls remain clean exit 0.
- The complete autonomous stop-hook and migration unit surface passes: 154 tests across 13
  files. The focused post-change test adds five passing behavioral cases,
  including Codex stdout-protocol cleanliness on the corrupt-state failure.
- Migration tests prove that a stock-derived customization survives the patch
  and that a stock-looking customized hook with an unknown layout is refused
  without modification.
- Exact historical-stock tests prove both the original session-keyed hook and
  the topic-keyed v1.2.55-era hook still receive the current valid shell hook.
- Shell syntax validation and TypeScript typechecking pass.

## Known Limits

This change does not rewrite malformed state and does not make both readers
share one parser. It makes the disagreement observable at the continuation
chokepoint. An unknown customized hook layout is intentionally not modified by
migration and therefore requires deliberate reconciliation.
