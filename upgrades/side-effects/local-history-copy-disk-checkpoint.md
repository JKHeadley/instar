# Side-Effects Review for Local History Copy Disk Checks

The approved local history contract requires checking available space before copy. This checkpoint adds internal volume validation and allocation estimates. The ledger can pin its original directory identities together with trusted destinations. No copy entry point invokes the pin, and no new write authority exists.

## Over-block

A replaced directory, final symlink, or distinct device causes a refusal. A valid installation on separate devices would need separately accounted reservations. Existing upload admission keeps its original capacity rules.

## Under-block

A descriptor device match is a local filesystem observation. It does not guard later pathname opens or account for transient metadata and copy-on-write peaks. The estimator depends on caller-supplied policy. Isolated APFS observations support the accounting categories, with no production reservation margin inferred.

## Abstraction fit and interactions

The ledger owns its original directory identities and the volume helper owns opened descriptors. The intended caller owns descriptor lifetime through worker exit, physical accounting and write permissions. Filesystem sampling checks directory identity on both sides of the sample. Existing allocation rows, disposal and recovery are unchanged.

## Signal versus authority

Under docs/signal-vs-authority.md, exact device and directory identities are protocol facts. The estimate feeds resource policy and does not authorize writes or consent. No routing judgment, owner change, or semantic heuristic is introduced.

## External surfaces and machine scope

The API is internal. There is no route, app control, setting, schema update, or notification. Descriptors and free-space samples are local to the selected machine and are never replicated.

## Rollback

Reverting the helper and its ledger entry point needs no data migration. No caller is enabled by this checkpoint.

## Evidence

TypeScript and 31 focused allocation, volume and ledger checks passed on the held source. Tests include directory replacement before admission and during measurement, a simulated distinct device, and rejection of directory symlinks. The fixture cleanup follows the repository's SafeFsExecutor path.
