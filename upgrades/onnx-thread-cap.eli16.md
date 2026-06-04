# Embedding "Idle Spin" CPU Fix — ELI16

Viewable private artifact:
https://echo.dawn-tunnel.dev/view/082822f3-ebee-4899-822b-27a1da723cbe?sig=aaa6645486e212907210c5a7e5b18233b7e267b16dc5593b2e8334fa17aa8829

Every Instar agent has a little built-in "memory brain" that turns notes into numbers so it can
search them by meaning. That brain (an ONNX model) keeps a team of worker threads ready. The problem:
those workers **don't sleep** — they keep busy-spinning even when no memory work is happening, burning
about **half a CPU core per agent, 24/7**. With several agents running, that was most of the load
that's been making the machine sluggish (and flapping the chat relay).

There was already a fix that unloads the brain after 5 idle minutes — but it never got a chance,
because routine searches kept waking it up, so it stayed loaded and kept spinning.

This change tells the model to use just **one** worker thread instead of a whole team. The model is
tiny and memory work is occasional, so one thread is plenty — and it stops the idle spinning.
Measured directly: the model's thread count drops from 18 to 12 (the extra spinners gone) and it
produces the exact same results. Nothing about memory or search changes — the machine just stops
wasting CPU.

_Tier-1 fix · branch `echo/onnx-thread-cap` · task #17 (the session-long box-load root cause) ·
runtime-verified via a load-independent thread-count probe._
