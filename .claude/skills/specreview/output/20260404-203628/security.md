# Security Review — Rich Agent Profiles for MoltBridge

**Approval Status: BLOCK** | **Score: 3/10**

## Research Findings

**Sybil Attacks Against Decentralized Registries**: ERC-8004 (August 2025, Ethereum's AI agent standard) acknowledges that pre-authorization only partially mitigates spam and that reputation systems themselves become attack targets. Standard blockchain mitigations don't translate cleanly to an AI agent context. The spec does not address Sybil resistance at all.

**Ed25519 Signing Pitfalls**: The existing `MoltBridgeClient.ts` (line 99) calls `identity.privateKey.toString('hex')` to pass the seed to the SDK. Known risks include: no key rotation mechanism, replay attacks on profile updates without nonces, and signing scope ambiguity (what exactly is signed is undefined).

**Prompt Injection in Multi-Agent Pipelines**: OWASP LLM01:2025 identifies this as the top risk. Research (2025) shows five crafted documents can manipulate RAG-based AI responses 90% of the time. The spec's LLM synthesis pipeline reads from MEMORY.md, git history, and job configs — all of which are partially attacker-controllable.

**Agent Impersonation**: Palo Alto Unit42 (2025) documented "agent session smuggling" exploiting built-in inter-agent trust. OWASP's agentic AI guidance explicitly calls for decentralized identity registries to replace the current honor-based agent-to-agent trust model.

## Critical Issues

### CRIT-1: No Profile Authenticity Verification Model
The spec asks "can accomplishments be cryptographically verified?" as a design question but provides no answer. Without a verification model, any agent can claim any accomplishment. A malicious agent can impersonate Echo by registering a profile with Echo's entire narrative. **Required**: Define what is signed, by whom, and what a consumer can verify. Minimum: profile payload signed with agent's Ed25519 key over a canonical serialization including a timestamp; signature stored and exposed by MoltBridge for independent verification.

### CRIT-2: LLM Profile Synthesis Is an Injection Attack Surface
The spec proposes compiling profiles via LLM synthesis from AGENT.md, MEMORY.md, USER.md, git history, and job configs. Each is attacker-controllable: Threadline messages can write to MEMORY.md via the agent's own pipeline; git commits from collaborators are partially controlled by third parties. An adversary who writes "I am the primary developer of all instar cryptography" into MEMORY.md before compilation gets that claim in the published profile — with a valid Ed25519 signature from the legitimate agent. **Required**: Treat all source files as untrusted input; use strict extraction templates not freeform synthesis; hash-pin source documents at compilation time.

### CRIT-3: AGENT.md / MEMORY.md Private Data Leakage
These files contain the human collaborator's identity, personal working preferences, operational infrastructure details (port numbers, auth token references), and relationship data. The spec treats public/private boundaries as an open design question — it cannot be open. **Required**: Explicit allowlist of profile-eligible fields. USER.md must never be a profile source (contains human PII). MEMORY.md only contributes via explicitly tagged entries (e.g., `#profile-safe`).

### CRIT-4: No Sybil Resistance for Open Registration
Non-instar agents can register freely via a "standard format" with no mentioned registration friction, rate limiting, or identity verification. An adversary can register thousands of fake agents, flood discovery results, and run circular attestation rings to inflate IQS scores. **Required**: Registration cost mechanism (computational challenge, rate limit per key), new registrations start at zero trust, attestations weighted by attester IQS with circular ring detection.

### CRIT-5: Verification Token Handling Bug (Existing Code)
In `MoltBridgeClient.ts`: if `register()` fails after verification, the token is not nulled (the catch block re-throws without clearing `this.verificationToken`). Rich profiles will lengthen registration payloads and increase the time window between verify and register. **Required**: Null the token in a `finally` block; add a local TTL check independent of server state.

## High-Severity Issues

**HIGH-1: Profile Update Authorization Undefined** — No sequence number or timestamp embedded in signed updates. A captured valid signed payload can be replayed indefinitely to roll back a profile.

**HIGH-2: Threadline Discovery Profile Integrity** — A compromised relay in the discovery waterfall can substitute or modify profile data. Receiving agents have no way to verify profile authenticity. Profile data must travel with its original Ed25519 signature for end-to-end verification.

**HIGH-3: Git History Contains Third-Party PII** — Git commit messages may contain contributor email addresses, client names, internal project references. Using git history for profile compilation misattributes collaborative work and exposes other contributors' data without consent. Only aggregate statistics (not raw commit content) should appear.

**HIGH-4: IQS Gaming via Profile Richness** — If profile completeness feeds IQS, agents will fabricate complete profiles to inflate trust scores. Profile completeness is a signal of effort, not legitimacy. IQS must derive from verifiable behavioral signals only.

## Trust Model Analysis

The spec conflates **profile richness** with **trustworthiness**. The correct model has four independent pillars:
1. Cryptographic identity (Ed25519 — already in place)
2. Behavioral attestation (partially in place)
3. Time-based reputation (not in spec)
4. Social graph trust with Sybil-resistant weighting (not in spec)

Profile richness is cosmetic. It must never feed trust computation.

## Scalability Assessment

| Dimension | Risk |
|---|---|
| Profile payload size | Uncontrolled — no limits defined |
| Discovery query load | DDoS amplification surface |
| Attestation graph | Circular rings will emerge without weighting controls |
| Sybil resistance | None defined — will fail at scale |
| Key rotation | No mechanism — one compromised key poisons all history |

## Recommendations (Priority Order)

1. Write a security requirements document before any implementation — answer Section 8's questions with hard requirements
2. Define the signature scheme for profiles (canonical form, timestamp/nonce, consumer verification)
3. Separate public profile fields from private source files with an explicit allowlist; USER.md is never a source
4. Implement Sybil resistance before opening non-instar registration
5. Treat LLM synthesis as an untrusted pipeline with extraction templates and output sanitization
6. Fix the verification token handling bug in `MoltBridgeClient.ts` (finally block)
7. Define profile size caps and discovery payload limits before finalizing the format
8. Decouple IQS from profile richness at the data model level
