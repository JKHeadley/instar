<!-- bump: patch -->

## What Changed

The server now refuses to deliver any agent→user message that contains a
clickable machine-local link (`http://localhost:…`, `127.x.x.x`, `0.0.0.0`,
`[::1]`). Users are almost never on the machine the agent's server runs on —
such links are unopenable from their device. The send is rejected with a 422
whose error text tells the agent exactly how to fix it: fetch the public
tunnel URL (`GET /tunnel`) and substitute, or omit the link and say it will
follow. Prose mentions of localhost/ports still pass — only clickable links
are policed.

## What to Tell Your User

Nothing to configure. If you ever asked your agent for a dashboard or view
link and received a `localhost` address you couldn't open — that mistake is
now structurally impossible; you'll always get the public tunnel link.

## Summary of New Capabilities

- Localhost-link guard at the outbound message chokepoint (all user-facing
  channels: Telegram, Slack, WhatsApp, iMessage). Deterministic, independent
  of the LLM tone gate, active even where no gate is configured.
- Agent guidance lives in the rejection itself: the 422 names the offending
  link and the remediation, so the failure self-corrects in one round trip.
- Rare deliberate sends of a raw local URL (operator explicitly asked):
  resend with `metadata.allowLocalhostLink: true` on `/telegram/reply`.
- Maturity: stable (deterministic guard + tests; no config surface).

## Evidence

Born from a real 2026-06-05 incident: an agent sent its operator
`http://localhost:4040/dashboard` over Telegram — unopenable from the phone,
and the port belonged to a DIFFERENT agent on the same machine. 25 tests
green (20 detector cases incl. the incident string and boundary hostnames
like localhost.example.com; 5 route-level cases over real HTTP proving 422 +
no-send, tunnel-link pass, and the escape hatch); `tsc --noEmit` clean.
