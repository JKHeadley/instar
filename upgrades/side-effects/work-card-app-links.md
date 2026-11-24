# Work Card App Links

The authenticated dashboard card detail can request a permanent app link. The existing web card remains available. The server, public fallback parser, and shared vectors accept the strict `card` target with `wc_` plus sixteen lowercase hexadecimal characters. Existing targets and identity handling remain unchanged. Native support ships separately; older clients refuse this target.

The new control requests `/agent-links` only after the person presses Open in Instar. It validates the returned identity-based card URL, then offers Continue in Instar as a real link. It never navigates to an arbitrary returned origin. No pairing, role, card action, identity creation, public browser lookup, automatic redirect, or credential transfer is added.

Rollback: revert this commit. No persisted state or migration is introduced. The new static console module is imported by the existing console asset delivery path. Awareness is updated through the existing awareness registry.

Focused verification: 81 checks passed across shared parser vectors, HTTP builder integration, dashboard card-detail wiring, and browser fallback. Throughput ran the three production lifecycle cases in `tests/e2e/agent-links-alive.test.ts` at `701516f74e5a652f37da741006478ae935beb899` and all passed. The release note and this evidence update change documentation only. Installed browser-to-app verification remains pending.
