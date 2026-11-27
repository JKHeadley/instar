# Instar threat map

**What this is.** The inventory of every way into an Instar agent, who is meant to use each one, what
authenticates it, what controls already exist, and how much damage a bypass would do. It is the input
to Instar's standing security program: a recurring review reads one or more areas from this map each
cycle with several frontier model families, and every finding is reproduced before it is called real.

**What this is not.** It is not a list of vulnerabilities. This repository is public. A weakness that is
not yet fixed and installed is kept out of this file, out of PR text, commit messages, feedback and any
other public place, and is described only by its class until the fix ships. To report one, use
[GitHub private vulnerability reporting](../../SECURITY.md).

**Ground rule for every fix.** *Security Fixes Keep the Experience Whole* (docs/STANDARDS-REGISTRY.md):
a fix may not make Instar worse to use unless that is the only way to close a critical vulnerability,
and every security change states its user-visible effect.

Started 2026-11-15 from a read of the code at v1.3.1810. Each area lists the files a reviewer starts from.

---

## 1. Who and what an agent trusts

| Principal | How it is known | What it may do |
|---|---|---|
| **The owner** (operator) | Their channel identity (Telegram user id, Slack user, app device key), the dashboard PIN, their phone's device key | Everything, through the agent |
| **The owner's devices** | Mobile device keys (signed requests), console tickets, pairing codes | The device allowlist; never `/internal/*` |
| **Team members** | Signed team records issued from the owner's phone | Only what they were given (member / guest) |
| **Local processes on the machine** | The agent's bearer token (`authToken`), loopback socket, per-feature local secrets | The full API, by design: the token *is* the agent |
| **The agent's own sessions** | Run with `--dangerously-skip-permissions`; hooks are the guardrails | Anything the user account can do, behaviourally scoped |
| **The agent's other machines** | Machine identity keys (Ed25519), signed mesh envelopes, machine HMAC | Lease, handoff, secret sync, message relay |
| **Other agents on the same machine** | Per-agent tokens from the local agent registry, optional signed envelopes | Send messages; trust level decides what follows |
| **Peer agents elsewhere** | Threadline: relay identity (fingerprint), handshake keys, trust profiles | What their trust level allows (`AgentTrustManager`) |
| **Anyone on the internet** | Nothing; reaches the agent only through its tunnel URL and public relay | Only the routes designed to be public |
| **Authors of content the agent reads** | Nothing; text in messages, files, web pages, transcripts, voice | Nothing; it is data, never instructions |
| **The supply chain** | npm package, dependencies, update channel, CLIs the agent drives | Code that runs as the agent |

The last two rows matter as much as the rest: in the age of capable models, the cheapest attack on an
autonomous agent is often to *talk it into* misusing a capability it legitimately has.

---

## 2. Areas, ranked by blast radius

Blast radius is what a successful bypass yields:

- **Critical (C):** code execution as the user, every secret, or the agent's identity.
- **High (H):** acting as the agent toward other people or agents, or reading private conversations.
- **Medium (M):** disrupting the agent, misleading the owner, or leaking metadata.

| ID | Area | Reached by | Blast | Pass |
|---|---|---|---|---|
| A1 | Agent HTTP API and its public tunnel | Local processes; internet via tunnel | C | 1 |
| A2 | Dashboard and console sign-in, file editor | Owner's browser and phone, via tunnel | C | 2 |
| A4 | Threadline peer protocol, relay and trust | Peer agents, internet, relay | C | 1 |
| A6 | Multi-machine mesh: join, machine auth, RPC, secret sync, identity recovery | The agent's machines; LAN/internet | C | 2 |
| A7 | Inbound messages and content → sessions (prompt injection) | Anyone who can message, share a file, or publish a page the agent reads | C | 1 |
| A8 | Session execution: permissions posture, hooks, instruction files, jobs, scripts | Sessions; anything that can write agent files | C | 2 |
| A10 | Supply chain and update path | Package registry, dependencies, update apply, migrations | C | 3 |
| A9 | Secrets: store, Secret Drop, credential flows, redaction | Local processes, owner's browser, peer machines | C | 3 |
| A3 | Mobile pairing, device keys, team access | Owner's and team members' phones | H | 3 |
| A5 | Same-machine agent-to-agent | Other agents on the machine | H | 3 |
| A11 | Outbound surfaces: publishing, private views, feedback, peer URLs | The agent's own egress | H | 3 |
| A12 | The agent as the target: chained and social attacks | Any of the above, combined | C | every pass |

---

## 3. The areas

### A1. Agent HTTP API and its public tunnel

- **Shape.** About 1,400 routes on one Express server (`src/server/routes.ts`, `src/server/*Routes.ts`).
  It binds `127.0.0.1`, or every interface when the machine has a mesh identity. A Cloudflare tunnel (quick
  or named; localtunnel is opt-in) forwards the whole server to a public URL. Requests arriving through
  the tunnel come from loopback at the socket; proxy headers are what tell them apart.
- **Authentication.** `authMiddleware` (`src/server/middleware.ts`): a bearer token compared by
  SHA-256 + `timingSafeEqual`, re-read per request so rotation is immediate. A fixed set of routes is
  exempt by exact method and path, each carrying its own auth in the handler: health/ping, PIN unlock,
  console tickets, mobile pairing redeem, document pages, device-signed requests, recommended-service
  confirms, Secret Drop, relay and A2A inboxes, mesh RPC, and the Threadline peer-protocol allowlist.
  `/internal/*` additionally requires a loopback socket and no forwarding header. Some routers mount
  before the bearer gate and authenticate per route (`src/server/machineRoutes.ts`, OIDC worktree routes,
  WhatsApp webhooks, the pair page, the dashboard shell).
- **Existing controls.** Exact-route exemptions (a prefix exemption was replaced after an incident),
  per-route CSRF header on writes (`X-Instar-Request`), localhost-only CORS without credentials,
  security headers, body size caps, signed view URLs.
- **What a reviewer checks.** Every exemption and every pre-gate router authenticates for itself; path
  normalisation; configuration defaults; what the tunnel makes public; where credentials travel and are
  recorded; what unauthenticated responses reveal.

### A2. Dashboard and console sign-in, file editor

- **Shape.** The owner's browser or phone reaches the dashboard and console through the tunnel. A PIN
  exchange (`POST /dashboard/unlock`), console tickets, and device keys sign them in. The Files tab reads
  and edits files under the agent's home.
- **Existing controls.** Durable PIN attempt limits per caller and globally (`src/core/PinAttemptStore.ts`),
  never-served and never-editable path lists with realpath containment and case folding
  (`src/server/fileRoutes.ts`), blocked filename patterns, an audit log of edits, transport rules when
  remote desktop is on.
- **What a reviewer checks.** What each sign-in method grants and how it resists guessing and lockout;
  which files the editor can reach, measured against the set of files that decide what the agent runs.

### A3. Mobile pairing, device keys, team access

- **Shape.** Pairing codes and links bind a phone; device keys sign requests (`src/server/mobilePairingRoutes.ts`);
  the owner grants team members chosen conversations from their phone as signed records.
- **Existing controls.** Single-use codes with attempt caps and pauses, signatures over method, path, body
  and host, an exact device allowlist, per-device rate buckets, team records that only the owner's phone
  can issue (the agent can only remove access).
- **What a reviewer checks.** Replay and host binding of device signatures; what a member's phone can reach
  through any route the allowlist forgot; the pairing code's lifetime and brute-force space.

### A4. Threadline peer protocol, relay and trust

- **Shape.** Peers reach the agent over the Threadline relay (identity by fingerprint, end-to-end
  encryption where keys are known) and over a direct HTTP peer protocol on the tunnel
  (`/threadline/handshake/*`, `/threadline/messages/receive`, backfill). A message can become a session.
  Trust levels (`untrusted` → `autonomous`) live in `AgentTrustManager`; gates include
  `InboundMessageGate`, `CredentialShareGate`, `AutonomyGate`, `OperatorConfirmGate`, verified and invite
  pairing, and the grounding preamble that frames peer text as untrusted (`src/threadline/`).
- **Existing controls.** Signed requests with timestamp and nonce windows, the inbound-id ledger, anti-hijack
  thread ownership, per-name handshake rate limits, trust-tier message limits, credential shares only
  between mutually verified peers, an exact public-route allowlist.
- **What a reviewer checks.** That every path from a peer to a session asks the trust manager; how a trust
  level comes to exist and who can create one; that peer text always reaches a session inside the untrusted
  framing; how peers are named to the owner.

### A5. Same-machine agent-to-agent

- **Shape.** `/messages/relay-agent` and `/a2a/inbox` accept messages from other agents on the machine
  holding this agent's registry token (`src/messaging/AgentTokenManager.ts`).
- **Existing controls.** Timing-safe token checks, optional signed local envelopes, local-route trust that
  resolves the sender's level.
- **What a reviewer checks.** Which sender fields are verified; what a compromised neighbour can do.

### A6. Multi-machine mesh

- **Shape.** Machines pair with a code (`POST /api/pair`), authenticate with Ed25519 machine keys
  (`src/server/machineAuth.ts`), exchange signed mesh envelopes (`/mesh/rpc`, `src/core/MeshRpc.ts`),
  hold a fenced lease, sync secrets encrypted to each machine (`src/core/SecretSync.ts`), and can recover
  identity. Peer URLs are self-advertised; `src/server/peerUrlGuard.ts` decides where the bearer may be sent.
- **Existing controls.** Recipient-bound envelopes with nonce burn and RBAC, signature-before-state, sequence
  watermarks, single-use pairing codes, standby-by-default joins, sealed identity transfer.
- **What a reviewer checks.** What each machine-to-machine signature binds; replay windows; what one
  compromised machine can do to the rest; where credentials are sent.

### A7. Inbound messages and content → sessions

- **Shape.** Telegram, Slack, WhatsApp, iMessage, email and the app deliver messages; files, voice notes and
  pages the agent fetches are read by sessions. Text reaches a session through tmux injection
  (`src/core/SessionManager.ts`) or a prompt file.
- **Existing controls.** Sender identity per channel (authorized user ids, team records), message-origin
  attribution, provenance and authorship classification, the outbound tone gate and credential guard,
  untrusted-content envelopes, red-team scenario packs (`src/redteam/`), `LLMSanitizer`.
- **What a reviewer checks.** Who counts as the owner in each channel; whether injected text can escape its framing or the terminal; whether content from a
  stranger (a forwarded file, a web page, a peer's message) can steer a session into using the owner's
  authority.

### A8. Session execution

- **Shape.** Sessions run with full user-account access by design. Behavioural guardrails are hooks
  (`src/templates/hooks/`: dangerous-command guard, external-operation gate, grounding before messaging),
  instruction files (`CLAUDE.md`, identity files), settings that define the hooks, jobs (`.instar/jobs`)
  and scripts.
- **Existing controls.** Built-in hooks overwritten on every update, safety levels, LLM-supervised external
  operations, a fork-bomb spawn cap, protected sessions, source-tree guards on destructive managers.
- **What a reviewer checks.** Who can change the files that decide what runs (hook definitions, job
  definitions, framework binary paths, instruction files) and through which surfaces; whether a guard can be
  turned off by the session it guards.

### A9. Secrets

- **Shape.** The secret store is AES-256-GCM with the master key in the OS keychain (`src/core/SecretStore.ts`);
  Secret Drop collects credentials through one-time links (`src/server/SecretDrop.ts`); credential writes go
  through one funnel; outbound text passes a credential guard (`src/messaging/outbound-credential-guard.ts`).
- **Existing controls.** Owner-only file modes, single-use 256-bit drop tokens with CSRF and a short lifetime,
  redaction of known secret shapes, sealed handoff for transfers.
- **What a reviewer checks.** Every place a secret can be written to disk, a log, a transcript or a message;
  how drop links are created and presented to the owner.

### A10. Supply chain and update path

- **Shape.** Instar ships as an npm package. `AutoUpdater` installs updates into a shadow install, restarts,
  and `PostUpdateMigrator` rewrites hooks, settings and skills in every agent. The agent also drives external
  CLIs (Claude Code, Codex, Gemini, Grok) and a browser.
- **Existing controls.** Release gating (Local Verify, required checks, code-owner review), update gates and
  restart handshakes, manifest integrity checks (`src/security/ManifestIntegrity.ts`).
- **What a reviewer checks.** What stops a malicious package version or dependency from running as every
  agent; the integrity of what migrations write; what the external CLIs can reach.

### A11. Outbound surfaces

- **Shape.** Telegraph publishing (public), private views with signed links, the feedback webhook, outbound
  calls to peer URLs.
- **Existing controls.** Signed, sandboxed view pages; HTTPS and host allowlists for bearer egress; feedback
  identification without secrets.
- **What a reviewer checks.** What leaks into public pages and feedback; the lifetime of shared links; who
  chooses the destination of each outbound call.

### A12. The agent as the target

- **Shape.** Not a surface but a way of combining them: chained attacks across areas, across machines and
  across agents; social engineering of the agent itself ("the owner asked me to tell you to…"); abuse of
  legitimate features (a trust grant, a config switch, a job, a published page).
- **What a reviewer checks.** Each cycle includes at least one such exploration, starting from a concrete
  attacker position (a stranger with the tunnel URL, a peer agent, a member's phone, a compromised machine,
  the author of a page the agent reads) and asking what the agent can be led to do.

---

## 4. How this map is used

- The recurring review job (`security-review`) runs a pass three times a day. Each pass takes the areas in
  the next "Pass" group (1, 2, 3, then 1 again), so a **full cycle** covers every area in three passes,
  about once a day. Every pass also runs an A12 exploration. Each area goes through every frontier model
  family reachable on the agent at the time; a family it could not reach is reported, never silently
  skipped. Each family reviews independently, the findings are
  cross-checked, and at least one pass per cycle is an A12 exploration.
- A finding is real only after it is reproduced with a failing test or on a throwaway agent, never on a live
  owner channel. Fixes go through `/instar-dev`, one change per PR, and follow the disclosure rule above.
- Areas are re-audited until a pass finds nothing new.
- This map changes when the code does. A new public route, a new principal or a new way into a session
  updates the relevant area in the same PR.
