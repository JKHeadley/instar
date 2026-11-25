# Side-Effects Review — Camera verifier request route

## Summary of the change

Registers a fixed Camera request endpoint in AgentServer. The endpoint remains unavailable unless boot supplies a resolver for the configured pilot. An issued request is acknowledged only after the existing journal service returns success.

## Decision-point inventory

- Refuse a missing or malformed verifier credential.
- Resolve verifier identity and journal through the configured runtime.
- Report unavailable, forbidden or active Pass without returning a request ID.

## 1. Over-block

An unavailable Camera runtime or storage authority holds the request. An active Pass must be retired before the reviewer can start a retest.

## 2. Under-block

The production resolver must use the strict session credential and the real assigned verifier. The default server has no resolver. The end-to-end test injects a controlled resolver and uses the real HTTP stack.

## 3. Level-of-abstraction fit

The route handles HTTP statuses and delegates authority and durable issuance to the resolver and Camera journal service.

## 4. Signal vs authority compliance

Credential shape only filters. A trusted resolver and the exact journal assignment supply authorization. See [Signal vs. Authority](../../docs/signal-vs-authority.md).

## 4b. Judgment-point check

No competing-signals heuristic is added.

## 5. Interactions

The route is registered after the server's general middleware. There is no automatic retry on durable failure. The response never includes credentials or journal contents.

## 6. External surfaces

Adds a dormant reviewer endpoint. It provides no operator interaction and requires normal server access and the independent verifier credential when activated.

## 7. Multi-machine posture

The route does not add storage. The production resolver must attach the lease-fenced Chief of Staff journal on the serving holder. No user notice or URL is generated.

## 8. Rollback cost

Remove the dormant route and boot option. No production records need migration.

## Conclusion

The HTTP route and production server registration have paired end-to-end tests. Production still needs its authenticated runtime resolver and the remaining submission and withdrawal endpoints.

## Second-pass review

The independent acceptance security reviewer concurred. The end-to-end test also confirms that a verifier credential alone cannot bypass the normal server authentication middleware.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable.
