# Standby machines stop disturbing Telegram while they start

Echo runs on several machines, but Telegram allows just one of them to collect messages with the shared bot. The machine holding the lead is supposed to do that. A standby still runs its server and can help with work, but it must leave that shared inbox alone.

A slow Laptop start broke that rule. After waiting three minutes for its server, its small supervisor started collecting Telegram messages anyway, even though the Laptop was set to observe the lead without taking it. That produced competing Telegram connections. The Studio's supervisor then treated the conflict as a reason to restart itself, and stopped the healthy Studio server along with it. That interrupted work and changed the lead's lease even though the server was not the broken part.

The repair has two parts. A standby setting now applies from the first moment of startup, and a muted standby never collects messages after that wait. Ordinary lease following waits for the server to confirm ownership. An unmuted machine keeps its old emergency fallback after three minutes without an answer, so you can still send /restart when the server itself will not start. This fallback does not prove that it is the only machine collecting messages; several broken unmuted machines can still compete. Ordinary single-machine agents keep their existing startup behavior.

If Telegram connections still conflict, the supervisor can perform its existing limited recovery without stopping the healthy server. A different failure, where the server refuses messages sent to it, keeps its existing server restart recovery. Every supervisor exit records whether it actually left the server running, stopped it, or could not establish the outcome. A timeout is recorded honestly as unknown.

This changes no passwords, bot keys, user messages or machine settings. It adds no new alerts or endless recovery loop. The existing recovery limits stay in place. The code is tested on isolated fake process boundaries, then goes through the normal shared test line. It is only called live after the release contains it and the relevant machines have installed that release.
