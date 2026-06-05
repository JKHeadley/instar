# Notification Emission Gate ELI16

Sometimes Instar has a real internal signal, but the signal is not strong enough
to say something to the user yet. The topic-505 problem was like that. The
system saw context exhaustion, restart activity, summary failures, and pending
message state. Those were real things to record and monitor, but they produced
too many user-facing notices that sounded more certain than the system really
was.

The proposed fix is a small authority layer in front of those notices. Detectors
still detect. Recovery still recovers. The difference is that a detector no
longer gets to directly say "the agent is actively working" or "your message was
dropped" unless the evidence is strong enough.

For example, if a Codex pane is hard to summarize but another deterministic
check shows active work, the gate should record the event and keep watching
instead of sending a generic "working" claim. If the deterministic check says
the session is stalled or dead, that stronger signal can still surface to the
user through the gate. The fix is quieter, not blind.

Restart and respawn notices get the same treatment. The user should see one
clear lifecycle notice for an incident, not one notice per callsite. If the same
incident turns into a crash loop, the gate breaks silence and escalates because
that is now a new actionable state.

Dropped-message notices also need stronger proof. A softer message helps tone,
but the durable fix is to reconcile against delivery state: if the same message
envelope is later consumed or handled, the system should suppress or retract the
drop notice instead of relying on guesswork from the agent response text.

The safety rule is simple: this changes what is allowed to interrupt the user,
not whether the underlying recovery machinery runs. Internal evidence is still
logged, and real stalls still surface. Low-confidence status guesses stop
pretending to be facts.
