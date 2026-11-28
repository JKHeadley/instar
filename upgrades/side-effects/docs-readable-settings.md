# Side effects of the document settings display fix

- Scope. This Tier 1 change affects the document page render tree and its tests. It uses the existing approved document viewer design.
- Stored data. Version-one projected text, coordinates and hashes stay the same. Stored comments remain readable. An old comment on hidden settings can remain in the comment list without a highlighted passage.
- Recognition. Only a leading dash-delimited block with mapping-like settings is eligible to be hidden. The viewer checks that the removed blocks match that prefix in the existing projection. Dash-underlined prose and multiline heading tokens render as paragraphs or list items.
- Authority. Session admission, document access, comment signing and writes use the existing rules. The renderer makes a presentation decision only.
- Rollback. Reverting this change restores the prior display using the same stored data.
- Verification. The staged patch passed four unit files, one HTTP integration file and one lifecycle file. An anchored comment round trip checks absolute body offsets. Live browser screenshots are pending.

## 6b. Operator-surface quality

The page starts with the reader's content. The body keeps its formatting and selection positions, with no new controls or setup steps. People still read and write comments through the existing controls.
