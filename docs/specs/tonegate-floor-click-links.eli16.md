# ELI16 — Tone-gate floor stops blocking clickable links

## What this is, in plain English

Every message an Instar agent sends to its user passes through a safety gate
(the "tone gate") that checks for leaks — things the user should never see, like
raw shell commands, file paths, or internal endpoints meant for the agent to
call itself, not for the user to run. Normally a smart LLM does that check, and
it's clever enough to tell the difference between "here's a link to **open** in
your browser" and "here's an endpoint to **call** with curl."

But when that LLM is slow or down (e.g. the account is rate-limited), the gate
falls back to a dumb, fast, pattern-only check called the **deterministic floor**
so a user is never silently cut off during an outage. The problem: that dumb
floor couldn't tell a clickable link from a callable endpoint. So during an
outage it would **block every link the agent tried to share** — a private-view
report, a dashboard link, a Secret-Drop one-time URL, a Telegraph page, a file
download. This broke link-sharing for **all agents** whenever the LLM was
degraded. It's exactly what just happened when an agent tried to send a Secret
Drop link.

## What already exists

- The tone gate (`MessagingToneGate`) with its LLM judge (rules B1–B20).
- The LLM path **already** carves out clickable links by intent (open-vs-call).
- The deterministic floor (`detectDeterministicLeak`) used when the LLM can't
  answer — this is the only piece that was missing the carve-out.

## What's new

A small helper, `scrubClickLinksForFloor(text)`, that runs **before** the floor's
pattern scan. It removes `http(s)://…` URLs that are shared as click destinations
so their host/port/path/token don't trip the floor's "looks like an endpoint"
detectors — **unless** the text actually contains a call instruction (a `curl`/
`wget` command, an uppercase `POST/GET …` against a URL, or an imperative like
"hit the endpoint"). In that case nothing is scrubbed and the floor blocks as
before. The floor then scans the scrubbed copy.

## Safeguards in plain terms

- It only ever **loosens a false positive on clickable links** — it can never let
  a new kind of leak through.
- It strips **only** scheme'd URLs. File paths, CLI commands, config keys,
  internal ids, and every other leak class are left fully intact for the floor.
- The moment a real "run this" instruction appears, the scrub backs off entirely
  and the floor behaves exactly as it does today.
- The LLM path is untouched — it keeps its existing intent-based judgment.

## What you need to decide

Nothing risky. This is a safe-direction bug fix: it stops the floor from
blocking legitimate links during an LLM outage, while still holding real command/
path/secret leaks. It's always-on (no flag) because the old behavior was simply
wrong — there's no value in keeping the false positive available.
