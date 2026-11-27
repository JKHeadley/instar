# Windows Remote Desktop setup: say why it failed

When an agent runs on Windows (inside WSL), it installs a small Windows helper at every start so you can open that machine's screen from the dashboard. If the install fails, the agent writes down one short reason code, never the raw error text, because that text can hold private paths and addresses.

The problem: most real failures got the same catch-all code, "installer-process-failed", reported as if it had happened in the first check. That told nobody anything. On 27 Nov the Mama PC failed this way at every start, and the only clue was that useless code. Part of the cause was a simple mismatch: the installer's errors say "spawnSync cmd.exe ENOENT", but the patterns looked for "spawn cmd.exe ENOENT", so they never matched.

The fix teaches the reason-finder the failures that happen fast: a Windows program (cmd.exe, wslpath or PowerShell) that is missing or too slow, WSL's link to Windows being broken, the installer failing to load its own code, the installer being stopped for taking too long (it is usually stopped by its own 130-second limit) or printing too much, and a second install already running. Nothing about what the installer does changes. Only the reason it records becomes specific, so the next failed start says what to fix.
