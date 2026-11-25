# Side-effects review for passive Codex idle observation

Tier 2 checkpoint under the approved idle-switch spec. This commit contains the passive observation and process evidence prototypes. It introduces no production caller.

- **Over-block.** Missing, stale or changed process evidence yields an unavailable observation. A valid process may temporarily be missed during a sample or after an exit.
- **Under-block.** A process generation alone cannot establish the owner thread, active turn state or safe switching. Those checks are prerequisites for a production switch.
- **Ownership.** The native fixture reads kernel process identity. The TypeScript sampler binds observations to a launch. The topic store projects committed policy for inspection.
- **Authority.** In accordance with [Signal vs Authority](../../docs/signal-vs-authority.md), these observations are evidence only and cannot change a model or session.
- **Interactions.** The fixture uses disposable processes. Existing session lifecycle and model policy write paths do not call the sampler. Verification must precede any production use of the policy projection.
- **External surfaces.** The draft adds no endpoint, launch integration or packaged executable.
- **Multiple machines.** Process generations and launch evidence are machine-local. They cannot establish identity after ownership transfer.
- **Rollback.** Revert the passive helpers and tests. They write no durable state and require no migration.

Prior focused checks covered the classifier, process cache and sampler, and three macOS fixture cases. Release and live activation remain on hold.

Independent reviewer concurs. The topic store keeps a distinct committed snapshot so staged writes and legacy seeds do not enter the projection. The existing write and rollback paths remain in place. The draft adds no owner transport or model mutation. Future production wiring needs to retire cached observations when a launch or owner is removed and establish the owner thread, input state and mutation authority independently.
