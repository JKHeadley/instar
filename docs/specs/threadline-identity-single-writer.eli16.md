# One writer for my agent-to-agent identity key (ELI16)

To talk to other agents through the shared relay, I have an identity: a key pair, like a signature only I can make. The key lives in a small file. The relay knows me by that key, so the key is also my address.

**What went wrong.** Two different parts of my code could create that file, and they wrote the key in two different ways. One wrote it as hex text (only the characters 0-9 and a-f). The other wrote it in base64, a more compact text form. The part that *reads* the file always assumed base64 and never checked what it got.

Hex text happens to also be readable as base64. It just comes out as nonsense of the wrong size: 48 bytes instead of the 32 a key must have. So this is what happened to an agent that started with the relay switched off, which is the default:

1. Another agent on the same computer asked "are you there?". Answering that question created the key file, in hex.
2. Later the relay was switched on. The startup code read the hex file as base64, got 48 bytes of nonsense, and copied that into a second, "official" identity file.
3. From then on the agent offered the relay a 48-byte "key" at every start. The relay refused it every time. Nothing ever fixed it.

On top of that, the startup log printed "relay connected" no matter what, even on the line right after the relay's refusal.

**What this change does.**

- **Only one piece of code may write the key file now.** The part that used to write hex asks the proper identity code for the key instead. Being asked "are you there?" no longer creates a key at all. If I have no key yet, I leave that part of the answer blank, and the agents that ask treat a blank as "can't verify this one yet" and "no direct route, use the relay".
- **Every read is checked.** A key must be exactly 32 bytes, and the public half must belong to the private half.
- **Agents that are already broken get repaired by themselves.** If the file holds a key in hex, it is the right key in the wrong spelling. I decode it properly and rewrite the file in the right form. It is the same key, so my address does not change. This happens for both files, the first time I start with this change.
- **If a file is damaged in any other way, I stop and say so.** I do not quietly make a new key over it, because a new key means a new address and every agent that knew me would lose me. The damaged file is left exactly as it is.
- **The key file is private.** It is written so that only my own user account can read it, and it is swapped in whole, never left half-written.
- **The startup log tells the truth.** It says "connected" only when the connection really is up.

**What you need to decide.** Nothing. This is a repair with no setting to choose. It ships to every agent at once, because a repair that is switched off would leave the broken agents broken. If it had to be undone, the repaired files still work with the old code.

**Honest limits.** If someone's two identity files hold two different valid keys, this change does not pick between them; the official one wins, as before. And a key file locked with a passphrase is not repaired automatically. No agent is set up that way today.
