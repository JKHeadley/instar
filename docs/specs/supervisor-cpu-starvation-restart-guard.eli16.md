# Plain-English overview: stop restarting a server that's just busy

## What was broken

When your laptop is running a lot of agents at once, it can get so overloaded
that programs can't get a turn on the CPU for a while — even though they're
perfectly alive. Each agent has a little "supervisor" that pings its server
every 10 seconds to check it's healthy. When the machine is slammed, the live
server can't answer the ping in time, so after about a minute the supervisor
decides "this server is stuck" and restarts it.

The problem: restarting doesn't fix an overloaded machine. The brand-new server
is just as starved as the old one — so it can't answer either, and a minute
later the supervisor restarts it again. Meanwhile, every message you send during
one of those restarts gets dropped or misrouted, and you see "Session
restarting" with your message never landing (which is exactly what you were
hitting). On Echo's logs the server restarted six times in about 35 minutes
during a load spike.

## Why this kept happening

The supervisor had no idea the machine was overloaded. It only knew "the server
isn't answering," and its only tool was "restart it." So under heavy load it
spun in a pointless restart loop that hurt more than it helped.

## What already existed

We'd already taught a *different* watcher (the sleep/wake detector) this same
lesson: when the machine's load is more than ~1.5× the number of CPU cores,
treat a hiccup as "the machine is just overloaded," not as a real event. This
change reuses that exact idea.

## What's new

The supervisor now checks the machine's load before restarting an
unresponsive-but-alive server:

- If the machine is **overloaded** (load more than 1.5× the cores), it **waits**
  instead of restarting — because restarting wouldn't help, it would just drop
  your message. It keeps waiting until the load eases and the server answers
  again on its own.
- There's a safety cap: if the server stays unresponsive for about 5 minutes
  even after accounting for load, it restarts anyway — in case the server is
  genuinely hung rather than just starved.
- Everything else is unchanged: a truly-dead server still restarts instantly, and
  a normal (not-overloaded) hiccup still restarts after the usual ~60 seconds.

## What you need to decide

Nothing — it's automatic and on by default. It only ever changes one situation
(alive-but-unresponsive *and* the machine is genuinely overloaded), and there it
can only choose to wait instead of pointlessly bouncing the server. It can't make
recovery of a real failure any slower than the 5-minute safety cap.

## The real cure

This stops the laptop from making a bad situation worse, but the underlying issue
is capacity — the machine is running more concurrent agent work than it has cores
for. The durable fix is moving hosting to a dedicated machine (the mac-mini
migration). This guard buys reliability in the meantime, and helps on any
busy box, fleet-wide.
