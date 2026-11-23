# Local History Parent Reconciliation

Tier 1 composition repair, two files with type narrowing, one review pass, first merge attempt. This merges the existing history acquisition work at dad3ba150 into the committed local-history primitives at 3b78dad91. Both parent histories remain intact. No native endpoint or app action is enabled.

## Problem and resolution

The local parser adds Codex and Claude Code to the general ImportSource union. ZIP export parsing and provider export delivery still support only Claude and ChatGPT. Preserve dad3ba150's complete provider-marker validation, account matching, immutable archive checks and writer integration, narrowing only the types in importExport.ts and exportDelivery.ts to ExportSource. Runtime statements in both files are identical to that parent.

## Review

review_import_verification_repairs independently compared both files with dad3ba150 and confirmed the only differences are ImportSource to ExportSource narrowing. It found no concrete issue and confirmed the broader union and local parsers still support both local session kinds.

## Side effects

Over-block: no new runtime refusal. Under-block: source composition alone does not establish a completed native journey or ordinary full-suite pass. Layer fit: provider-only types live in provider modules, while shared stored conversations retain the full source union. Signal versus authority: reference docs/signal-vs-authority.md; no new detector, permission or blocking decision. Interactions: preserve provider account checks and writer ownership rather than replacing either side. External surface: no route, setting, UI or capability added. Team posture and selected-machine privacy remain those of the existing parent. Multi-machine posture is unchanged; no new state or replication is introduced. Rollback is a source revert with no data migration. No imported data is deleted.

## Evidence

Official no-emit TypeScript check passed. Nine focused files passed all 219 checks, including both local formats, encrypted records, manifest validation, real parser children, snapshots, provider delivery and existing ZIP/store regression checks. Full ordinary verification and installed native acceptance remain required. No publication, live provider action or production installation is claimed.
