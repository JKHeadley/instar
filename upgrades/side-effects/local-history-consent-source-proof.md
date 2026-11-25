# Side effects of source ownership proof verification

A destination can check a stored, source-machine-signed capture against the exact import operation and pinned target. The verifier asks for current source enrollment and an independently established owner link on every call. A retained public key, equal owner-ID strings or an uploaded manifest cannot establish ownership.

- Missing, expired, future-dated, tampered and wrong-scope evidence fail closed. Legitimate captures require a current owner link and accepted key, so a revoked owner link or rotated key requires fresh evidence.
- The existing machine signature primitive authenticates the scoped capture. The existing consent join still checks the raw captures against the exact prepared preview.
- The verifier confers no standalone copy authority. A future confirmation and permit caller must independently run it at their existing authority boundaries.
- The verifier adds no storage, remote request, external disclosure or enabled route. The producer that captures source data and the current authority lookup remain server-side dependencies.
- Evidence is scoped to the source machine and target operation, agent, owner, machine key, boot and origin. Cross-machine ownership is an explicit independent lookup input.
- Reverting removes the verifier and its dormant fixture wiring without a data migration.

Independent review concurred. Primitive identifier checks and exact target comparison bound persisted fields before encoding.
