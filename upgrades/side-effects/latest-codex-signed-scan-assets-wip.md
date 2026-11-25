# Side-effects review for signed doorway scan assets

Tier 2 work-in-progress checkpoint under the approved doorway scan spec. This slice signs packaged asset digests and verifies exact asset bytes. It adds no scheduler caller or execution authority.

- **Over-block.** The paired read declines unsigned and incomplete packages, including older locks without the optional digests. Catalog-only reads still work with a valid catalog digest.
- **Under-block.** A signed asset does not prove that the scheduler will execute those exact bytes or safely handle observations. Production execution and release signing still need an end-to-end check.
- **Ownership.** The release signer binds the fixed packaged files into the lock. The reader verifies the pinned authority, running version and digests before handing bytes to its caller.
- **Authority.** This read supplies verified evidence under [Signal vs Authority](../../docs/signal-vs-authority.md). It grants no permission to probe, deliver notices or update agent state.
- **Interactions.** The new verifier retains compatibility with signed locks without these optional fields. Previous verifier versions reject extended locks. Rollbacks must keep the runtime and its lock together.
- **External surfaces.** The lock payload changes when the assets are present. No route, agent defaults, scheduler profile or output path changes in this checkpoint.
- **Multiple machines.** The approved release package is the common source. Every machine checks its own installed package bytes. No scan observations transfer between machines.
- **Rollback.** Revert the signer and verifier together and use the corresponding lock. No agent data migration is required.

The independent reviewer concurred with the standalone signer and verifier slice after checking exact byte handling and canonical signature compatibility. The fixture uses an ephemeral key. Release and live activation remain on hold.

## Legacy prober checkpoint

This WIP preserves the staged legacy path. Scheduled runs keep local scan observations and omit direct delivery. The packaged prober resolves its adjacent manifest when the scheduler supplies it. The scheduled wrapper honors the disabled flag and retains its separate canary path. This checkpoint does not enable the scanner or cleanup. The focused regression covers local-only scheduled observations.
