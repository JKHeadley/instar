# Side effects of optional relay rendezvous codes

The dormant store issues a random 192-bit code for a current authorized relay assignment. Redemption returns the relay hostname once. It keeps a digest in memory for up to ten minutes and removes the entry on use.

- Unknown, used, expired or reassigned codes disclose nothing. Assignment authority is checked at both ends. The code never conveys ownership proof or a signed identity record.
- Redemption limits include malformed attempts. The current fixture policy allows ten attempts per transport IP per minute and bounds the address and code inventories. Shared addresses can hit the same limit. IPv4 and mapped IPv6 aliases share a bucket.
- The future listener must use the transport-observed address and authenticate issuance. This process-local component installs no endpoint. A restart drops outstanding codes. Multiple replicas would need one authoritative redemption store or routing ownership.
- The store logs no codes or addresses. Removing it needs no data migration. Direct agent connectivity remains independent.

Independent review concurred. The registrar must generate a fresh assignment identity whenever it reassigns a name.
