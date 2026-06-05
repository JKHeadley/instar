# Telegram inbound project directory — plain-English overview

When a Telegram user sends a short message to an agent, instar can inject that
message directly into the agent's terminal session. Long messages are different:
very large text can be awkward or unreliable to pass through terminal input, so
instar writes the full message to a file and injects a short reference that says
"the long message is saved here; read it before responding."

Before this change, those Telegram files were written to `/tmp/instar-telegram`.
That worked for Claude Code in many cases because Claude could usually read that
machine-wide temp path. It failed for Gemini CLI because Gemini runs with a
workspace sandbox. From Gemini's point of view, `/tmp` is outside the readable
project area. The agent could see the reference path but could not open the file
that contained the user's actual message. For a long inbound Telegram message,
that is effectively a delivery failure: the message arrived at the platform
layer, but the working agent could not read its contents.

The fix is intentionally small. Telegram inbound files now live under the
agent's project directory at `.instar/telegram-inbound/`. That directory is
inside the same project tree the agent already works in, so both Claude Code and
Gemini CLI can read it through their normal workspace access. The directory is
still treated as runtime data, not source code. It is added to `.gitignore`, and
the existing stale-file cleanup path now cleans the project-local directory
instead of the old temp location.

The important engineering detail is that the path is defined once. A new shared
helper, `getTelegramInboundDir(projectDir)`, returns the project-local inbound
directory. The long-message injection path, session bootstrap history path,
Secret Drop-triggered session context path, Telegram forward auto-spawn context
path, and cleanup path all call that helper. That matters because this bug came
from a storage location assumption being copied across several callsites. If one
caller kept writing to `/tmp` while another caller cleaned or documented the new
directory, the same sandbox failure would come back in a harder-to-debug form.

This does not change who receives Telegram messages, how Telegram topics map to
sessions, or whether a message is allowed through. It only changes where the
temporary payload file is stored after the existing delivery path has already
decided to create one. The user-visible behavior should be the same for short
messages and better for long messages: the agent still gets a file reference,
but now the file is in a place sandboxed agents can actually read.

The regression test covers the relay-sensitive part directly. It sends a long
Telegram message through `SessionManager.injectTelegramMessage`, verifies that
the file lands under the configured project directory, verifies the injected
reference points at `.instar/telegram-inbound`, and reads the file to confirm it
contains the tagged full Telegram message.
