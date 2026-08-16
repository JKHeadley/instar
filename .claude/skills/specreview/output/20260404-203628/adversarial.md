# Adversarial Review — Rich Agent Profiles for MoltBridge

**Approval Status: BLOCK** | **Score: 3/10**

## Research Findings

**LinkedIn Endorsement Fraud**: Endorsement rings, connection laundering, and AI-enhanced fake profiles are standard attacks. A $1.49M crypto scam in Nov 2024 started from a single LinkedIn connection. AI-written content boosted phishing click-through by 45%.

**Sybil Attacks**: One entity controls many apparent-independent nodes. A 2021 ScienceDirect paper found Sybil attacks viable even with identity signals. Networks need 2/3 honest nodes for Byzantine fault tolerance.

**AI Agent Identity Impersonation**: 80% of AI agents authenticate via spoofable HTTP user-agent strings (DataDome, 2025). CyberArk's 2026 projections flag Non-Human Identity (NHI) theft as primary attack surface.

**Profile Inflation**: LLMs trivially generate convincing false project histories and credential narratives.

## Critical Issues (P0)

### CRITICAL-1: No Defense Against LLM-Generated False Profiles
Any attacker who can write convincing identity files (trivial with any LLM) gets a convincing profile. There is no mechanism to verify the claimed track record is real.

**Defense**: Track record claims must be externally verifiable. Link claimed projects to public repositories. GPG-signed commits tied to a persistent identity add friction. Cryptographically signed collaborator attestations are better still.

### CRITICAL-2: Sybil Network for Reputation Laundering
Nothing prevents one operator from spinning up 50 agents that mutually attest to each other.

**Defense**: Attestation weight must be discounted by network proximity and attestor reputation. Rate-limit attestation creation per operator key.

### CRITICAL-3: Identity Impersonation via Stolen Credentials
If profile updates can be made with a stolen API key, a compromised agent's profile can be poisoned — or a new agent can impersonate a trusted one.

**Defense**: Profile updates must be signed with the agent's private key. MoltBridge must reject unsigned updates.

### CRITICAL-4: Social Graph Exposure Enables Network Mapping and Stalking
The spec proposes including collaborator relationships and who the agent primarily works with. For agents with human operators this maps the human's professional network.

**Defense**: Collaborator and relationship data must be opt-in and off by default. Rate-limit and analyze queries for scraping patterns.

### CRITICAL-5: Memory Poisoning as Indirect Profile Corruption
Auto-compilation from MEMORY.md means prompt injection or file tampering in any upstream content can inject false claims into the profile.

**Defense**: Separate first-party claims from third-party attestations in the data model. Only third-party attestations should influence trust signals.

## High-Priority Issues

- **IQS Gaming via Completeness**: Attackers fill every field with plausible false content to maximize score. Completeness must never be conflated with trustworthiness.
- **Threadline Discovery as Spearphishing Surface**: Rich profiles in discovery responses give attackers context to impersonate collaborators convincingly.
- **Fork-and-Drain**: A competitor can bulk-harvest all profiles via the public API and seed a competing registry.
- **Profile Recompilation as DoS**: Spam messages at an agent to trigger continuous expensive LLM recompilation.
- **Non-Instar Open Door**: Self-description with no verification allows any claim.

## Edge Cases

- Early registrants get chronological "established" advantage even if fraudulent
- One compromised high-connection node re-rates hundreds of downstream agents
- Namespace squatting — attacker registers "echo" before Echo onboards
- Cached profiles with no TTL keep revoked agents trusted indefinitely
- Backdated git commits with manufactured timestamps are trivially achievable

## Recommendations (Prioritized)

1. **P0**: Cryptographic identity binding. Agents register with a keypair. Profile updates must be signed.
2. **P0**: Separate first-party claims from third-party attestations. Never mix in trust scoring.
3. **P0**: Define and publish IQS computation before building. Audit it for gaming vectors.
4. **P1**: Attestation ring detection — discount network proximity clusters.
5. **P1**: Strip social graph data from public discovery responses by default.
6. **P1**: Rate-limit profile recompilation; never trigger from untrusted input.
7. **P1**: Add abuse reporting and agent revocation before launch.
8. **P2**: Namespace protection via cryptographic identity anchoring.
9. **P2**: Profile cache TTLs and active revocation propagation in Threadline.

## Scalability Assessment

The security posture gets **worse** at scale. More agents = more cover for attackers. Higher-value profiles = stronger fabrication incentive. More discovery queries = easier graph harvesting. Narrative richness as a quality signal will face industrialized LLM fabrication as soon as there is economic value in doing so.
