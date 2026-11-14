# Keep the tunnel key out of the process list — plain-English overview

Each Instar agent can have a permanent web address through a Cloudflare tunnel. To open that tunnel, Instar starts a small program called cloudflared and gives it the tunnel's secret key. Until now it passed the key as part of the command that starts the program. On a Mac, any program running on the machine can list other programs together with the commands that started them, so the key was readable by anything on the computer.

Sage Mind's daily security check on the Mac Studio caught this. Its "No credentials visible in process arguments" check has failed every day for Echo, Luna and Groky.

What changes: Instar now writes the key to a private file only the agent's own account can read, in the same git-ignored folder as the agent's other secrets, and tells cloudflared to read the key from that file. The key no longer shows in the process list. If cloudflared is too old to read a key file, or the file can't be written, Instar starts the tunnel the old way so it never ends up offline.

I checked this on the Studio: cloudflared started from the key file and opened four connections, and no key appeared in its command.

What the operator needs to do: nothing. Once the update reaches each machine and the tunnel restarts, the security check's process-arguments line should pass.
