# Side effects: approving from the Instar app (constitution, trust-journey item 9)

## Summary of the change

The 1.x article *Trust Is Earned by Work and Granted Only by the Person* gains one paragraph in "In practice" and one line in "Earned from". A person's yes may now come from a paired device they accepted, not only from their direct chat or an accepted approval account. The 2.0 counterpart adds a paired-device exception to the master's rule that the agent never administers its own safeguards (instar-2, stacked on instar-2#204).

Approved by Justin on the exact text: topic 143810, 2026-11-16 22:13 PST, "approved" (telegram 143810/144056). Origin: topic 143810, 2026-11-16 20:35 PST (telegram 143810/143996).

## Decision-point inventory

Docs only. No code reads this text at runtime. The approval path in code (the trust journey's account path) is unchanged here; building paired-device approval is separate work that cites this article.

## Over-block / under-block

Nothing is blocked or allowed by this change alone. The conditions it states (hardware-held key, unlock per approval, one use of an exact unexpired request, pairing rules, withdrawal, disclosure) bind the build that follows.

## Interactions

It sits beside the accepted-account exception and changes none of its requirements. An organization policy may forbid paired-device acceptance.

## External surfaces

None until the build lands.

## Multi-machine posture

The text says the device list and acceptance travel with the installation, and a machine uses a device approval only with the current withdrawal state.

## Rollback cost

Revert the paragraph; nothing depends on it yet.

## Class-Closure Declaration

Not a defect fix; no class to close.

## Conclusion

A wording change, approved by the operator on the exact text, that lets an app-only person approve trust raises once the build lands.
