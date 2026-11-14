# A new safety hold takes effect without a restart

When a scheduled script finishes, Instar records what happened and may ask a
model whether the result needs a person or a follow-up session. A known safe
result can eventually use a signed certificate instead. If that certificate
is revoked, the script route must stop until the old full-session route can
take over.

Before this change, a running scheduler loaded its list of stopped scripts
at startup. A hold recorded later could wait until the scheduler restarted.
It now checks the durable hold before every script admission. A synthetic
test agent also checks the scheduler and server path with a timeout, a late
model answer, secret-bearing output, and a revoked certificate.
It checks again if it had to wait for a job gate, because a hold can arrive
while that gate is running.

The test uses fake model replies. Instar still needs a shared certificate
registry and more rollout evidence before live model decisions can start.
