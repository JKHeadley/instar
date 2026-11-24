# Proposed Structural Follow-Through For Host-State Fixtures

This is design evidence, not an implemented gate or convergence claim. The current audit still retains all 6031 tracked test files and unresolved candidates.

The recurring cause is dependency evolution below a fixture's visible API: a real factory adds shared admission, or a module captures a default path before the fixture's later spy. An owned project/state directory or a fake physical process does not prove ownership of those new dependencies.

A small reusable fixture helper could own a temporary home, install a scoped homedir spy before initialization, reset the known process singleton, assert the exact resolved state path, and expose an ordered teardown that closes owned resources before resetting/restoring. It must not modify the runner's HOME environment or private-ledger actual native provider work. Introducing a shared helper should follow the demonstrated repeated call paths and preserve the explicit real-system category; it is not necessary to delay the current three-file narrow fix.

A future ratchet should index factory construction and home-derived module captures structurally, then require each reviewed fixture to declare whether it uses owned simulated state or intentionally touches a real native system. By-name searches alone miss aliases, static imports, helper-created providers and callback wrappers. Content matches should surface review candidates, not automatically rewrite tests or authorize native work. Real-system declarations must explain the contract and admission boundary. Inert construction and mocked direct-provider cases need distinct accepted reasons.

Import-time capture needs a different check from lazy default resolution. A beforeAll environment/helper change cannot isolate an already evaluated module constant. A reliable fixture must bind that input before module evaluation or exercise a supported explicit seam. The Discovery and AgentConnector findings demonstrate why scanning merely for homedir mocks produces a false safe classification.

No standard amendment is needed to state the existing throwaway-home rule. The missing piece is implementation coverage and a ratchet whose accepted classifications can be inspected. Until a complete resweep discovers zero new defects and all unresolved paths are closed, the audit remains incomplete.
