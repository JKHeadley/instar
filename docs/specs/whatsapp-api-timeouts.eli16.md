# ELI16: WhatsApp calls give up after 15 seconds instead of waiting forever (SEC-132)

When the agent talks to you over WhatsApp through Meta's business service, every message it sends, every read receipt and every emoji reaction is a request to Meta's servers over the internet.

Those requests had no time limit. If Meta's servers, or the network in between, stopped answering partway through, the agent would keep waiting for an answer that never came. That one stuck request would hold its place forever, the replies queued behind it would back up, and the connections would pile up over time, until the WhatsApp side of the agent quietly stopped working.

Now every one of these requests gives up after 15 seconds. A request that times out is treated exactly like any other network failure: the agent's normal retry and "could not send" handling takes over, the same as if the internet had dropped for a moment. When Meta answers normally, which is almost always within a second or two, nothing changes at all.
