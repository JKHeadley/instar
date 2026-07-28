# Operator-seat UX gate on apprenticeship cycles — ELI16

The apprenticeship program has agents mentoring agents: a mentor drives a
mentee through real work over Telegram, exactly the way a human user would,
and one of its PRIMARY jobs is to notice when the experience is bad — the
confusing notices, the duplicate messages, the "please resend that" asks.

Today the operator sat in the user's chair himself for ten minutes and hit
several of those UX failures immediately. The program had filed thirty-five
findings about the mentee's framework — and not one of them was about the
user experience. Why? The instruction to observe the UX existed only as a
sentence in the mentor's prompt. Nothing required proof that the looking
actually happened, so it silently didn't. (Our own foundational principle
says exactly this: a prompt is a wish, a gate is a guarantee. We just hadn't
applied it to observation.)

There's a second, sneakier reason: agents don't feel friction. When the
mentee asks the mentor to resend a message, the mentor just… resends it —
zero annoyance, zero cost — and the evidence evaporates. The frictions that
burn a human's attention are invisible to an agent's pain threshold unless
something forces them to be counted.

This change makes the observation unskippable. Recording an apprenticeship
cycle now REQUIRES an "operator-seat UX" block: how many duplicate notices
appeared, how many infrastructure-noise messages a human shouldn't see, how
many times the mentee asked the USER to do machine work, how many
content-free updates, which message types were actually exercised (text?
photo? — coverage equals what you used), and whether the drive happened
during restart churn. A cycle without the block is refused with an error
naming the exact shape, so the mentor can't forget and can't half-comply.
The mentor's standing orders now teach the counting and require every
worked-around friction to be filed as a finding — silent compensation is a
swallowed finding.

Old cycle records from before the gate still read fine (they show "no UX
verdict recorded" honestly), and nothing else about the program changes.
