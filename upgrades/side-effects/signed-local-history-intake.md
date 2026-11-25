# Side effects of the signed local history intake

The router uses the existing native owner signature on exact bounded request bytes. It checks framing before buffering and requires a fresh active owner phone proof before dispatching to a service. Unrelated routes remain outside the router.

The caller supplies one state-scoped exchange lease and the sealed-channel dispatcher. The router keeps the lease until both the request and response lifecycle and the dispatched operation settle. Disconnect or deadline aborts the dispatcher. The dispatcher must cooperate with abort. Unproven cleanup retains the exchange and does not admit another request. The existing native signature allowlist grants no authority to seal or write history.

There is no default service and this base does not mount intake. The HTTP integration fixture proves signed exact bytes, dark default, refusal of unsigned, altered and unsupported requests, and retention and buffer clearing after disconnect. Revert the unmounted router and its allowlist entries together.

Independent rereview verified that asynchronous disposal keeps the shared lease held until cleanup fulfills. The HTTP fixture checks refusal during delayed work and delayed cleanup before checking buffer clearing and reuse.
