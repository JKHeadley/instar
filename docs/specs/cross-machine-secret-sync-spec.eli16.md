# Cross-Machine Secret Sync — Plain-English Overview

> The one-line version: a credential you hand the agent on one of your machines should just work on its other machines too — without you typing it twice, and without it ever sitting in plaintext.

## The problem in one breath

Your agent can run on more than one computer (say a laptop and a Mac mini) and act like one being. But secrets — a bot token, an API key, a GitHub password — currently live only on the machine where you entered them. If the agent needs that key while running on the *other* machine, it's stuck, and today the only fix is to re-enter the secret by hand on every machine. That's friction, and it's exactly the kind of thing "one agent, many machines" is supposed to erase.

## What already exists

- **A private vault on each machine.** Each computer keeps its secrets in an encrypted file, not in the plain settings file that lives in version control. So nothing sensitive is sitting in the open on any one machine. (This part is built and working.)
- **A secure phone line between machines.** When two of your machines are paired, they talk over an encrypted, signed channel — each message is provably from the machine it claims to be from, and can't be replayed or forged. (Also built.)
- **A reserved "share a secret" slot.** The machines' messaging protocol already has a labelled slot for "here is a secret for you" — but it's an empty slot. Nothing actually sends a secret, and nothing on the other side knows how to receive one. (This is the missing piece.)

## What this adds

The agent learns to **hand a secret from one machine to another, safely and automatically.** When you give the agent a new credential on machine A, A wraps that secret so that *only* machine B can unwrap it (using B's own public key), and sends it over the secure channel. B unwraps it and tucks it into its own private vault. From then on, the agent has that credential on both machines — and you only ever entered it once. If a machine was asleep when the secret was shared, it asks for the secret the next time it actually needs it, so nobody falls behind.

## The safeguards

- **Encrypted to the recipient only.** A shared secret is scrambled specifically for the machine receiving it. Even something sitting in the middle of the connection can't read it, and it's never written to a log.
- **Only your own machines.** A secret is only ever shared with a machine that's already been paired and proven as yours — never a stranger.
- **Off by default, proven on the dev agent first.** The feature stays dark for the fleet until it's switched on; the dogfooding agent runs it live first so it's proven before anyone else gets it.
- **Tested end to end.** Two real agent servers, a real secret dropped on one, and a check that the other can read it — plus unit checks that a tampered or wrong-key payload is rejected.

## Why a spec first

This is brand-new machinery that moves *secrets* between machines — a bigger blast radius than most changes. So it gets written down, threat-modeled, and signed off before a line of it ships. A few choices (share eagerly to all machines vs. only when needed; sync everything vs. an allowlist; whether to include revoke now) are left as explicit questions for the human to decide.
