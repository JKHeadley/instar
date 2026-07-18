# ELI16 — StandingDrive Slice 1

A long-running drive needs durable structure, but adding a brand-new lifecycle database would duplicate rules that Instar already has and eventually let those rule sets disagree. This slice instead adds one optional, versioned section to the server-owned autonomous-run record. Ordinary autonomous runs do not have that section and behave exactly as before.

The section freezes the operator-authorized phases and allowed actions. Code compares a proposed action against enumerated fields; it never asks a model whether the action feels related. Enrollment keys include the source surface, so identical raw ids from different sources cannot collide. Rebinding requires the stored principal and current locally verified operator to match exactly. Corrupt breaker state holds instead of reopening a wake loop. Every extension mutation checks and advances one shared revision, preventing concurrent last-write-wins changes.

This does not wake sessions, replay messages, dispatch external effects, or grant new authority. Those behaviors remain in later reviewed slices and must compose with their existing owners.
