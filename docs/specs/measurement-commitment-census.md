# Include commitment records in the independent census

Tier 1: additive, reversible advisory reads. No new registry, metric producer,
baseline capture, authoring seam, control or promotion authority.

The deployed census reads initiatives but omits CommitmentTracker. A live read on
November 6 found 1,398 commitment records, including material corrective work
CMT-1146, outside the census. `sourcesComplete` only describes the selected reads;
it must not hide this additional existing owner.

Read the existing tracker's `getAll()` without filtering completed, withdrawn or
routine entries by guessed intent. Add its records to the existing effort-kind
inventory using `commitment:<JSON [origin, id]>` identities and explicit
`commitment-tracker` provenance. Preserve the commitment owner's composite key;
legacy rows with no origin use the current source machine. Current initiative
authoring identifiers are kebab case, keeping the namespace separate. Preserve
status as posture.
Share only the source identifier and status, not conversation excerpts from
userRequest or agentResponse. Existing authorised commitment views own that text.
These are tracking records, not distinct improvement efforts: two records may
describe the same work. The UI must say so rather than imply semantic deduplication.

Commitment entries have no measurement-subject links. Collect them after the
existing target-binding computation so they cannot register a generic target,
inherit an initiative's proof or change current authoring/admission semantics.
Existing explicit parent relationships remain unchanged; infer none from titles,
identifiers or topics. Absent/failed commitment reads make that source unavailable
while preserving other known rows. Existing row and byte bounds still apply;
counts and omissions retain the full known denominator.

An older peer can return a shape-valid census that lacks this source. Preserve
its known origin rows/counts and disclose the unsupported inventory in the
existing pool failure list, making poolComplete false. Do not rewrite its source
claims or pretend missing commitment records are a zero. Envelope shapes remain
unchanged; this is an explicit incomplete-source signal, not an operational gate.

Acceptance: real owner records appear despite overlapping raw identifiers;
missing or failing owner reads remain explicit; generic target binding is
unchanged; large commitment inventories remain bounded without losing totals;
the actual board route includes a test-owned commitment. No production samples
are created. Reverting the read/UI/docs change removes it without a data migration.

Build base: fresh own worktree from origin/main c034523ac, package 1.3.1686,
remote JKHeadley/instar. This is the original independent-coverage task, separate
from the failed-cap baseline/promotion proposal. That proposal remains paused.
