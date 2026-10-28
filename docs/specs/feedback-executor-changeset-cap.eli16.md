# A feedback fix can include a large source file and its test

Instar has a feedback worker that prepares code fixes in an isolated copy of the source. Before it can publish a pull request, a trusted checker compares the worker's files with an untouched copy. That checker caps the total size of changed files. The limit was 2 MB.

One central source file, `src/commands/server.ts`, is already about 1.9 MB. The checker counts the whole changed file, even if the actual edit is only a few lines. A worker that edits this file and adds a small test can therefore be rejected as too large before anyone reviews the code. In the live feedback run on 28 October, an attempt that touched this file and a test ended with `changeset-too-large`; its temporary workspace was then removed, so the exact byte total cannot be recovered.

This fix raises the whole-file limit to 4 MB. It keeps the separate 200-file limit, the isolation that keeps the worker away from credentials and the network, the secret scan, the list of protected paths, and the independent review limit of 192 KB for the actual code diff. A test proves that a large modified source file with a small companion test passes, while a file even one byte over the new limit fails.

The decision is whether this extra room is reasonable for the source tree Instar has today. A revert immediately restores the old limit. No existing feedback item or stored result is changed by installing it; an executor retry is still needed to prove the live path.
