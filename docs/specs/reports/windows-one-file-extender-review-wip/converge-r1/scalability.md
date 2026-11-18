# Scalability (round 1) — DESIGN 4
1 [DESIGN high] 1 GB default can't travel mesh RPC / whole-body signatures; split small inline results (1-4 MB cap, truncation reported in-band) from streamed file transfers via a ticketed stream relay (like DesktopMeshStreamRelay), not MeshRpc.
2 [DESIGN med] forever-reconnect: server refusal carries retry-after; permanent refusals park for hours + tray notice; breaker after sustained failure; full jitter vs stampede.
3 [DESIGN med] socket liveness + holder registry unspecified: ~30 s ping/pong, drop after 2 missed; holder record with epoch + TTL refreshed by heartbeat; stale -> pc-offline.
4 [DESIGN med] one socket, no multiplexing/backpressure: per-call ids, interleaved chunks, max in-flight per PC (pc-busy), respect bufferedAmount/window.
5 [PRECISION] audit log retention + paged pool read. 6 [PRECISION] ws endpoint settings (maxPayload, no deflate, WebSocketManager). 7 [PRECISION] exec time-limit ceiling + kill process tree.
