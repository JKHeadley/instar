# Side-effects review for two media integration fixtures

- Tier 1. The application service in two integration test files receives the existing disk-capacity callback. Each test instance gets healthy capacity without reading the host volume. The remaining files are this review and an internal release note. All 22 focused checks passed. The first publication attempt identified the missing review artifact.
- The two fixtures cover uploads, media sharing and access rules. They still hit the regular service and HTTP routes. A real low-capacity refusal is covered by the dedicated integration case added in #3972.
- The callback is set only while constructing the two test fixtures. It has no new authority, shared mutable state, timing dependency, or competing signals. Production continues to measure the filesystem.
- The change applies equally on every test machine. It adds no runtime configuration, external calls, durable state, or data migration.
- Reverting the fixture change restores live-capacity reads in those two tests. No production data changes are needed.

[Signal and authority standard](../../docs/signal-vs-authority.md)
