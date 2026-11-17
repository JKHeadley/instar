# ELI16 — Why the M5 kept losing the Studio, and how the agent will now say so

## What went wrong

Your Macs talk to each other three ways: over the home Wi-Fi/Ethernet (the "local network"), over Tailscale, and through a Cloudflare tunnel. The M5's agent server kept failing to reach the Studio, so conversation sync kept flipping between "ready" and "not ready" all day.

Newer macOS versions treat the local network like the camera or microphone: each program needs permission before it can talk to other devices at home. When you run something in a Terminal, macOS can ask you. When the agent's server starts on its own in the background, there is nobody to ask, so macOS just says no, and the program sees "host unreachable", which looks exactly like the other machine being off.

The permission is tied to the exact program file. On the M5, one copy of the node program (the engine the agent runs on) had been allowed at some point, but the agent's server uses a different copy at a different path, and that copy was never allowed. Same program, same signature, different file: no permission.

Tailscale was not the problem. The M5 reaches the Studio over Tailscale fine. The agent deliberately does not send its credentials over plain-http Tailscale addresses (that is a separate safety rule). The Cloudflare route works but was flaky earlier today, so the home-network route was the one that mattered.

## What this change does

The agent server now notices this exact situation by itself. When a call to a home-network address fails with "host unreachable" on a Mac, it double-checks with one of Apple's own built-in tools, which macOS does not restrict. If Apple's tool can reach the address and the agent cannot, that is proof macOS is blocking the agent. The agent then shows a plain warning that says what is blocked, which program file it is, and how to fix it: open System Settings, then Privacy & Security, then Local Network, and turn on "node". If "node" is not listed, ask the agent and it will move to a copy macOS already allows.

## What it does not do

It does not change how the machines connect, does not retry anything, and does not block anything. It only stops the problem from hiding. It does nothing on Linux or Windows. If the other machine really is off, Apple's tool cannot reach it either, and no warning appears.

## Safeguards

At most one double-check runs at a time, and the same address is checked at most once every ten minutes. The warning repeats while the problem lasts and goes away once a home-network call gets through. Undoing it is a plain revert, with no saved state or settings to clean up.

## What you need to decide

Nothing for the code. For the M5 itself, the fix is either a toggle in its System Settings or pointing its agent at the already-allowed node copy. The second needs a restart, which the throughput session handles.
