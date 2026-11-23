# Reviewing Computers That Have Been Silent

A computer that has not been heard from for seven days may still hold a reserved share of the agent's PIN guess limit. The owner needs one clear reminder for the whole agent, rather than a separate warning for every computer. This change adds that reminder to Needs you and opens a review at the beginning of the Machines page.

The review lists the computers named by the server. A computer already confirmed gone stays visible and carries the label “Confirmed gone for good”. Confirmation does not retire it. Every review explains that these computers keep the PIN guess limit lower. If a change to the split is waiting, it says so separately. When some computer's records cannot be read, the page says that some computers could not be checked. Missing evidence never becomes a claim that a computer has been silent.

The dashboard can dismiss this reminder for the list currently shown. It cannot retire a computer or confirm that it is gone. Those choices require the owner's phone and its existing Face ID action. Dismissal uses the server's fingerprint, so a changed list is loaded again before the owner can dismiss it. A failed save leaves the review available. Replies arriving after navigation cannot overwrite another page.

The adapter and review must ship together. The read and dismiss routes come from the separate server change in pull request3672, which must land first. Focused tests cover the model, rendered controls, stale responses, HTTP Needs composition and existing production Needs initialization. Full verification and release are separate gates; these development checks do not claim the new phone routes are live.
