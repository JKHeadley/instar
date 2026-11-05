# Plain overview: a narrow exception to "no information may depend on another computer"

Instar has a written constitution, a set of rules every agent follows. One rule says an agent that runs on several computers must be able to work from any single one of them as if the others were gone: it may lose speed, but it must never lose information. A design where some information can only be reached by asking another computer breaks that rule.

That makes a problem for the planned Conversations view, which organises an agent's topics under the work they belong to. Its design only calls a change saved once every one of the agent's computers holds it, so the rule is met. But if one computer is asleep, a new message or change could never be called saved, because the sleeping computer cannot take it yet.

On November 5, 2026, Justin approved a narrow way out ("choice A"). A new message or change may be shown as "Saved · Pending" while one computer is asleep, but only after a separate, always-on witness service, outside all of the agent's own computers, has safely stored it. The sleeping computer must catch up before it shows anything current, and nothing pending is ever described as fully saved everywhere. Everything that was already fully saved keeps the old, stricter rule.

This change writes that exception into the constitution. It is limited to the Conversations design: any other feature that wants the same exception needs its own decision from Justin. It does not change any code. Because it changes the constitution, it cannot be merged until Justin approves it on GitHub.
