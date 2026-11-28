# Side effects of keeping document settings out of the reading page

## Summary

This Tier 2 correction covers the reader, client selection model and document page rendering. The existing approved Instar Document Viewer design describes the version-one projection and signed comment flow. The code preserves its absolute selection positions when a leading settings block is omitted. The prior Tier 1 commit exposed a browser quote regression, found in an independent review.

- Storage and access. The stored Markdown, version-one projection, hashes and permissions remain unchanged. The browser supplies spaces in omitted positions to keep its visible text aligned with saved comment positions.
- Formatting. Authored Setext headings stay headings. The reader recognizes leading dash delimiters around field-style lines and comments within those delimiters. A paragraph written in that shape may be treated as settings. A projection mismatch retains the original blocks.
- Comment list. A comment entirely inside hidden settings remains readable. Its Show passage action is absent. An anchor crossing the boundary highlights the visible words. A comment with no visible mark can move the wide-screen comment rail into its stacked list.
- Rollback. The renderer and client updates can be reverted together using the same stored document data.
- Verification. The final-word selection, cross-boundary anchor, CRLF, prefix mismatch and preserved headings have focused coverage. Real Chromium saved, reloaded and verified the exact final quote at 390 and 1280 pixels.

## 6b. Operator-surface quality

The article follows the read-and-comment instruction on both widths. The reader sees headings, prose and table contents without horizontal scrolling. The selection and comment controls keep their existing location and labels. Historical comments on hidden settings stay readable in the list with only available actions.

## 6c. Delight the user

The title and article lead the reading order. When the author gives both the same heading, both remain visible. The select-text instruction makes the next step clear, and the browser demonstrates that the quote and saved highlight match. Removing the settings block makes room for the prose and support section at phone width. The table and existing heading spacing remain readable. Raw settings disappear from the article. The same layout and action work at both tested browser widths, and the native document view embeds this reader.

Before: ../../.instar/dashboard-makeover/instar-docs/screens-4029-corrected.CnVeyn/before-390.png
After: ../../.instar/dashboard-makeover/instar-docs/screens-4029-corrected.CnVeyn/after-390.png
Before: ../../.instar/dashboard-makeover/instar-docs/screens-4029-corrected.CnVeyn/before-1280.png
After: ../../.instar/dashboard-makeover/instar-docs/screens-4029-corrected.CnVeyn/after-1280.png

## Second-pass review

**Reviewer:** Pipeline Strategy’s independent reader

Pipeline Strategy's independent reader concurred on staged tree f6e7620fcde9df3cd967e92b95e63210bb504af5 once the fresh Tier 2 trace covers all seven runtime and test files. The reviewer verified before-390.png, after-390.png, before-1280.png and after-1280.png, plus comment-390.png and comment-1280.png. At both widths the article fits, the settings are hidden, and the saved comment quotes the final words exactly. The updated prose matches the tested behavior, and the six focused files passed 97 checks.
