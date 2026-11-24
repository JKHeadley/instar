# Work Card App Links

The authenticated dashboard card detail can request a permanent app link. The existing web card remains available. The server, public fallback parser, and shared vectors accept the strict `card` target with `wc_` plus sixteen lowercase hexadecimal characters. Existing targets and identity handling remain unchanged. Native support ships separately; older clients refuse this target.

The new control requests `/agent-links` only after the person presses Open in Instar. It validates the returned identity-based card URL, then offers Continue in Instar as a real link. It never navigates to an arbitrary returned origin. No pairing, role, card action, identity creation, public browser lookup, automatic redirect, or credential transfer is added.

Rollback: revert this commit. No persisted state or migration is introduced. The new static console module is imported by the existing console asset delivery path. Awareness is updated through the existing awareness registry.

Focused verification: shared server/site parser vectors, HTTP builder integration, actual dashboard card-detail wiring, and browser control fallback tests. Production-path test coverage is added but currently cannot collect because this checkout's dependencies lack smol-toml. Full suites, deployment, and native verification remain outside this prepared slice.
