# Correction-Derived Hardening — plain-English overview

## What this actually is

On July 18 the operator corrected the agent twice in one evening, and both
corrections exposed the same deeper wish: when he tells the agent it did
something wrong, that lesson should get built into the machinery every agent
runs on — not just written into one agent's notebook. This change does exactly
that for both corrections.

**Correction 1:** the agent got stuck on a Slack setup task and sent the
operator a helpful-looking checklist: "open this website, click here, add these
four permissions, reinstall, then type /invite in two channels — takes about 60
seconds." The operator's answer was blunt: any solution that requires
step-by-step clicking on the user's side is unacceptable. The agent owns
browser work. The only things it should ever need from a person are a
credential or a yes/no.

**Correction 2:** minutes later the agent asked the operator which account
manages a Slack workspace — and the operator pointed out the agent had BUILT
that workspace itself. The agent's own records (five test accounts it had
provisioned, including the workspace owner) held the answer the whole time. Its
"I've checked everywhere, this needs you" conclusion had never checked the
identities it had personally created.

## What already exists

Instar already has two relevant pieces of machinery. First, every outgoing
message passes an LLM gate that catches known bad patterns — like the agent
quitting on itself or parking its work on the user. Second, there's a
"self-unblock checklist" that, before the agent is allowed to claim it's
blocked on a human, mechanically probes everything the agent can reach: its
vault, the org password manager, cloud accounts, browser sessions, and so on.

## What's new

1. **A new rule in the message gate (B21) — and it NUDGES, it doesn't block:**
   if an outgoing message hands the user a multi-step procedure for something
   the agent could do itself with at most a credential or an approval, the
   gate hands the message BACK to the agent with the pitfall named. The agent
   makes the final call: rewrite it, or consciously send it anyway with an
   acknowledgment — and that override is recorded where it can be reviewed.
   This is the operator's chosen architecture for these sentinels (blocking
   proved too much power; reviewing after sending is too late). Sending
   a one-tap link (like a secure credential-drop link), asking for an approval,
   or walking through something that genuinely only a human can do (a PIN-gated
   dashboard action, a payment, a CAPTCHA) all still pass. What gets caught is
   exactly the July 18 shape: a click list for agent-doable work — even when
   it's offered "as an option."

2. **A new probe in the self-unblock checklist:** a small registry file where
   the agent records every identity it provisions — test users, service
   accounts, workspace owners — with pointers to where their credentials live
   (never the secrets themselves). The checklist now consults that registry
   before ever concluding "this needs the operator." The agent's instructions
   also gain the habit-forming line: the moment you create an identity,
   register it.

## Safeguards in plain terms

- The gate rule can only cause a message to be held and rewritten — worst case
  is a false hold that's visible in the review history, never a lost message.
- The registry never stores passwords — only names and "where to find it"
  pointers. Tests specifically verify that even if someone stuffs a password
  into the file, it can't leak into any output.
- The probe fails safe: no file, broken file, or empty file just means "nothing
  found," exactly like today.

## What you actually need to decide

Whether these two behaviors — "never hand the user click-steps" and "always
check identities you yourself created before escalating" — should be enforced
by the shared machinery. Given both came from direct operator corrections and
the operator explicitly asked for corrections to become infrastructure, the
decision is essentially "yes, as specced." The blanket pre-approval recorded
for this drive covers it; the PR is the review surface.
