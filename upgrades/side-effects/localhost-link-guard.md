# Side-effects review — localhost-link guard at the outbound message chokepoint

Operator-mandated STRONG RULE (Justin, 2026-06-05, after receiving
`http://localhost:4040/dashboard` on his phone — unopenable AND the wrong
agent's port): never send a machine-local link to a user.

## 1. The change

- **`src/core/localhost-link.ts`** (new) — `detectLocalhostLink(text)`:
  deterministic regex over SCHEME-BEARING links only
  (`http(s)://localhost | 127.x.x.x | 0.0.0.0 | [::1]`, any port/path), with a
  host-boundary lookahead so loopback-looking PREFIXES of public hostnames
  (`localhost.example.com`) do NOT match. Prose mentions ("port 4042",
  "localhost config") never match — only clickable links are policed.
- **`src/server/routes.ts`** — `checkOutboundMessage()` (the SINGLE authority
  for agent→user delivery across telegram/slack/whatsapp/imessage call sites)
  gains a deterministic block BEFORE the tone-gate availability early-return:
  detected link → 422 `{ blockedBy: 'localhost-link-guard', match, error }`
  with remediation in the error text (fetch `GET /tunnel`, substitute, or omit
  + follow up). New option `allowLocalhostLink` (deny-by-default escape hatch)
  plumbed from `metadata.allowLocalhostLink` at the `/telegram/reply` call
  site only.

## 2. Why a hard deterministic block (not a tone-gate signal)

Per docs/signal-vs-authority.md, detectors whose verdict needs conversational
judgment emit signals for the LLM authority. A loopback link in a user-bound
message has NO legitimate reading — like the 4096-length check, it's a fact,
not a judgment. Blocking also makes the failure self-correcting: the 422 text
tells the sending agent exactly how to fix and re-send.

## 3. Blast radius

- All user-facing channel sends that flow through `checkOutboundMessage`
  enforce the rule the moment a server updates — fleet-wide, no migration
  needed (server-side change only; no template/hook/config surface).
- Paths that SKIP `checkOutboundMessage` keep their existing behavior:
  proxy messages (`metadata.isProxy`), matched system templates, and
  standby→holder relays (the holder gates on receipt, so the rule still
  applies there).
- False-positive risk: bounded by the scheme requirement + host boundary;
  the unit matrix covers tunnel links, prose mentions, path-embedded
  "localhost", `ssh://` schemes, and `localhost.example.com` as passes.
- Agent ergonomics: a blocked agent sees the remediation in the error; the
  escape hatch requires an explicit per-message opt-in, so it cannot become
  ambient.

## 4. Test coverage

- `tests/unit/localhost-link.test.ts` — 20 cases: 9 detection shapes
  (ports, paths, case, IPv6, bare host, the real incident string, markdown
  punctuation boundaries) + 11 pass shapes (tunnel/public links, prose,
  boundary hostnames, empty).
- `tests/unit/localhost-link-guard-route.test.ts` — 5 route-level cases over
  real HTTP against `createRoutes` with NO tone gate configured: 422 +
  `blockedBy` + no send for localhost/127.0.0.1; 200 + send for tunnel link
  and prose; escape hatch honored.
- `npx tsc --noEmit` clean.
