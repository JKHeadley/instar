# CI1 — Keep destructive test cleanup inside test-owned space

The S3 ratchet deliberately creates a file it cannot read, proves the attribution lint reports that blind spot instead of calling the scan clean, and then removes the fixture. The defect was not in SourceTreeGuard: the test put its temporary directory under the project’s real `src/` tree, so cleanup correctly looked like a destructive operation against source. CI rejected that operation and later preflight checks encountered the leaked fixture.

This repair moves the synthetic tree beneath the operating system’s temporary directory. The fixture still has a `src/fixture.ts` shape so the production lint walks the same relative path rules, but `runLint` now accepts an explicit source root for isolated test fixtures while keeping the repository root as its production default. Cleanup therefore targets only the directory the test created and owns. SourceTreeGuard remains enabled and unchanged; its refusal was valid evidence that the caller was wrong.

A second runtime-compatibility correction pins the nested Node test invocation to the TAP reporter. The ratchet verifies exact test and failure totals, but newer Node versions changed the default human-readable decoration from TAP comments to informational glyphs. Choosing TAP explicitly preserves the semantic count assertion across supported runtimes without weakening any mutation control.

Acceptance means the unreadable-file control still reports one blind input, the readable control still bites, the hollow-checker mutation still runs four inner tests with three failures, cleanup leaves no source-tree residue, and the exact development preflight test passes. No production cleanup authority, allow-list, or guard policy changes.
