# Integration (r1) — DESIGN 9 ; Decision-completeness (r1) — DESIGN 11 (merged)
- CRITICAL: default tunnel is quick; stableOrigin() null w/o named tunnel; mint answers 409 stable-address-required. Feature needs a named/stable origin; say how a new person's agent gets one or refuse in plain words; how PC re-learns address after restart (authenticated update).
- Pairing must reuse pair-mac drop point (r,k,d,n; 120 s drop TTL; strict phone parser) + v2/platform; iOS app release needed (Windows wording, switch list, device page audit, removal) -> name builder (this run edits apps/instar-ios via desktop lane) + min app version + completion entry.
- Device record has no platform field; switches need a new replicated write path; mixed-version peers rule (ignore vs refuse).
- computers.enabled off must use its own handshake code (no removal); breaker on sustained failure.
- Update path: protocol version in handshake, update-required refusal, signed self-update checking publisher signature.
- Publishing: host for ~70 MB binaries (e.g. GitHub Releases + instar.sh redirect), arch selection, signing identity (individual Justin vs org; publisher name users see; validation needs documents) = frontload; Mama PC outside release pipeline.
- Audit log justification key wrong (not a credential): make audit unified/replicated or merge-on-read with unknown for missing machines; 'proxied' not in taxonomy -> describe as unified routing over a machine-local connection w/ correct justification.
- Maturation ladder (test agent -> dev agent -> fleet), devGatedFeatures entry, live-PC proof as dev gate.
- Web console page backed by GET /computers (dashboard surface), not iOS-only.
- Idle rule mis-classified invariant/external: floor = no input while a person is using the PC; 30 s default; arbiter = person's switch (+ unattended declaration).
- Reconnect judgment row needs arbiter + breaker.
- Callers: owner-only or signed team grants. No elevation in v1.
- PRECISION: computers.enabled default in ConfigDefaults (migrateConfig); awareness gated; backup/rollback of audit; command time-limit default+ceiling; working folder; Chrome vs Edge; uninstall entry HKCU; delayed self-delete; run end = live proof on Mama PC, third-machine wipe test tracked follow-up; chunk size + resume.
Decision-completeness counts: frontloaded 6, cheap 0, contested-cleared 0.
