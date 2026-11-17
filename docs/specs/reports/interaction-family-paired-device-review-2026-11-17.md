# Interaction family: review of the paired-device paragraph in *Trust Is Earned* (2026-11-17)

PR 3296 adds a paragraph to *Trust Is Earned by Work and Granted Only by the Person*: a person's yes may also come from a paired device they accepted, in a recorded statement they can withdraw, with the disclosure that the device list is kept on the agent's own computer. It also adds an "Earned from" source line. The operator approved this exact wording on 2026-11-16 at 22:13 PST (telegram 143810/144056). This review checks its place in the Interaction family, not its merits.

**Independent read of the amended family** (a fresh Claude reviewer, read-only, given the whole Interaction area after the change and the coverage script's area boundaries):
1. **Contradiction or duplicated obligation: none.**
   - *Agent Proposes, Operator Approves* requires that the approved statement be written by the server and that what is shown matches what runs. "Covers that exact request once" makes a device yes narrower than that, not different from it.
   - *Mobile-Complete* lists the approval surfaces allowed on a phone; a paired device is a new route alongside them.
   - *The Person Decides* says neither the app nor the dashboard is required, and the paragraph keeps that by naming the device as one route among three.
   - Under *Security Fixes Keep the Experience Whole*, the unlock step belongs to a new optional route, not to a security fix that makes an existing route worse.
2. **Change of meaning elsewhere: none.** The whole registry was searched for "approval account", "direct chat" and any wording that limits where a yes may come from. The only hits are in *Trust Is Earned* itself. Its tree-placement line ("nothing but the person's yes") still holds, because the device yes is the person's yes, unlocked by them.
3. **Article intact: yes.** The heading, Rule, Tree placement, In practice, Earned from, Traces to the goal and Applied through lines are each one well-formed bold-labelled line.

Verdict: accepted.

**One gap noted, not a blocker:** the paragraph says the agent must never add or change a paired device, but the article's Applied-through line lists no check for that. The implementing work (instar PR 3301) records every pairing and shows it on every approving device. The Applied-through line is not changed here, because the wording is the operator's approved text; adding a check line to it is a follow-up for his review.
