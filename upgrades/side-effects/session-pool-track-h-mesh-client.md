# Side effects — Track H part 4: outbound MeshRpcClient (§L0 send side, dark)

## What this adds
`src/core/MeshRpcClient.ts` — the SEND side of MeshRpc, the outbound counterpart to MeshRpcDispatcher (receive). Builds a §L0 envelope (recipient-bound, Ed25519-signed, nonce + timestamp), POSTs to a peer's /mesh/rpc, returns the typed result (maps the dispatcher's reason/status on a non-200; throws only on transport error/timeout so the caller's retry loop catches it). Per-attempt timeout via AbortController; fully injected (fetch/sign/nonce/clock).

This is the activation transport (D11): it's what makes the SessionRouter's deliverMessage/spawnOnMachine deps and the TransferOrchestrator's sendTransferRpc dep live ACROSS machines.

## Risk / blast radius
None — pure transport class, not wired into the router yet (the activation step wires it as the router's outbound deps). No behavior change.

## Tests
- `tests/integration/mesh-rpc-client-roundtrip.test.ts` — 4 over a real MeshRpcDispatcher + real Ed25519 keys + loopback /mesh/rpc: full router→owner deliverMessage round-trip (200 + result + handler ran); RBAC rejection mapped (non-router → 403 not-router); replayed-nonce → 409 on the second send; transport error throws.

## Status — m2m transport COMPLETE
Send (MeshRpcClient) + receive (MeshRpcDispatcher) are both built + round-trip-proven. The remaining Track-H work is the ACTIVATION (wire MeshRpcClient as the SessionRouter's outbound deps + flip live-ingress to route through the router) + the staged real-hardware (laptop+mini) + test-as-self nickname-swap proof.
