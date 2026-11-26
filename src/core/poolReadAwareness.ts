/**
 * Agent Awareness for the pool-read selection fix
 * (peer-credential-guard-tailscale-coherence).
 *
 * Shipped to BOTH surfaces per the Migration Parity Standard: the generated
 * CLAUDE.md (new agents at `init`) and a content-sniffed `migrateClaudeMd()`
 * append (existing agents on update). The generated briefing is an
 * agent-installed file — an agent that still believes `url-rejected` means a
 * peer is unreachable will mis-explain this to its operator, and only new
 * agents would learn the difference from `init`.
 */
export function poolReadSelectionAwareness(): string {
  return `
### Why a pool read says \`peer-unreachable\` vs \`url-rejected\`

A \`?scope=pool\` read picks ONE rope per peer and makes ONE request. It now picks
the best rope the credential check **admits**, instead of the best rope outright —
so a peer whose preferred rope is inadmissible (a Tailscale address over plain
http, for example) is no longer blanked out when its other ropes are fine.

The failure reasons are three different facts and must not be reported
interchangeably:

- \`url-rejected\` — I refused **every** rope this peer advertises. Nothing was
  contacted. The per-rope reasons say why.
- \`peer-unreachable\` — I had an admissible rope, chose it, and **could not reach
  it**. This reason is new; before, it was indistinguishable from a refusal.
- \`no-known-url\` — the peer advertised no ropes at all.

\`cgnat-plaintext-unsupported\` is the accurate refusal for a Tailscale address
over plain http. It replaces a misleading \`scheme-not-allowed\`, which read as
"we don't do plaintext" when the real position is "we do plaintext inside ranges
we treat as the operator's own, and Tailscale's range is deliberately not one of
them." Admitting it would send the full agent API token to a destination nothing
authenticates as the peer, so it is **not built** — not disabled, absent — and is
sequenced behind destination authentication.

**Honest limits to report, rather than promising a fix:** a rope that is
admissible but dead is only dropped after **three consecutive recorded
failures**, and because that health record is shared with lease traffic, a lease
success or a recovery probe can reset the count — so recovery is **conditional,
not guaranteed**. What IS unconditional: an inadmissible rope is never selected.
Do not tell the operator a cross-machine read will start working immediately.
`;
}
