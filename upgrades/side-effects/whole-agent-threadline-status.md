# Side effects review: whole-agent Threadline status

## Decision and tier

Tier 1 repair applying the existing multi-machine standard and the approved A2A cross-machine route spec. The status answer is advisory; it does not grant a send permit. Proxied reads are bounded. Roll back by reverting this patch and releasing again. The measured remaining status surfaces are tracked in #2697.

## 1. Over-block

No send is blocked. A peer with a missing or mismatched fingerprint cannot establish reachability, so the answer may be unknown while the relay happens to work. That is intentional uncertainty.

## 2. Under-block

The holder can disappear after the read. Status describes a moment, and the send path retains its own lease and delivery checks. The source roster may omit a machine; an empty standby roster is unknown. Probes stop after eight peers and count every omitted peer as unknown. Other status routes remain in #2697.

## 3. Level of abstraction

The server combines local relay health from peers into one agent verdict. MCP tools and `/channels` consume that verdict instead of inventing a second authority. The existing relay forwarder retains send authority.

## 4. Signal versus authority

The new helper produces a read-only signal. It neither authorizes nor rejects outbound messages. Fingerprint matching prevents an unrelated host from being called Echo's holder. The status does not supersede the lease fence or delivery receipt.

## 5. Interactions

`GET /threadline/health?scope=local` prevents recursive peer fanout. The authenticated health view leads with `agentRelay`; its old `relay` field remains machine-local for existing discovery checks. The unauthenticated view performs no peer probe and reports a standby as unknown. `/channels?scope=local` similarly bounds Slack aggregation and counts unprobed peers as unknown. The relay discover route forwards only to a peer URL supplied by the validated resolver, with a local scope flag to prevent loops.

## 6. External surfaces

Authenticated sessions and API callers see reachable, unreachable, or unknown plus the holder machine. A lost holder can move a reachable answer to unknown without claiming Threadline is disabled. Public health gives a coarse agent verdict without holder identity or a peer fanout trigger. No operator form changes.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Proxied-on-read. `GET /threadline/status`, authenticated `GET /threadline/health`, `GET /capabilities`, and `GET /channels` lead with the whole-agent verdict; each keeps its local connection detail secondary. Public health returns a coarse verdict and never probes peers. The server probes at most eight known peers' local health and local channel reports. A dark, omitted, or absent holder yields unknown. MCP status and discovery read or forward through the agent server. The session-start guidance names `agent.state` and `agentRelay.state` as agent truth. No notice is emitted, no durable state is added, and no new URL is persisted. The validated peer resolver supplies transient addresses.

## 8. Rollback cost

Code-only hot-fix release. No data migration. The legacy local fields remain readable during rollback. The follow-up in #2697 addresses status routes this patch does not change.

## Independent second pass

Concern raised on first pass: MCP discovery never refreshed its initial unknown state; status and Slack peer reads needed a cap that preserved uncertainty for omitted peers; public health exposed holder topology and triggered peer fanout; failed discover calls looked like an empty live network. All four were corrected and tested. **Concur with the review** on recheck.
