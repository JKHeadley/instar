# Keeping the work lists manageable without losing memory

This is a revised design, not an implemented fix or a request for approval yet.

Instar keeps lists of proposals, lessons, gaps and actions. Its trimming code has a real bug: when active work uses up the entire target, asking for the last zero finished records actually keeps all of them. The same mistake appears in four places.

There is a separate limitation: the target cannot force active work to disappear. The proposed policy now preserves those open commitments and gives the setting an honest name: a soft retention target. With a target of 300 and 200 active records, there is room for 100 finished records. If active work alone exceeds 300, the system should report that pressure. It should not quietly cancel your work to make the number look good.

The old example of 350 open actions is historical. On September 12, the inspected queue contained 300 actions, including 21 active ones. The source bug is still present, but that current count does not prove the bug is firing. Instar also now has a separate optional expiry mechanism for old pending actions. This proposal would not turn it on or change its protections.

Review found a reason the arithmetic fix cannot ship by itself: a finished lesson is still memory. Making the trimmer work would remove some lessons that the broken version currently keeps. The system must preserve their full content in an accessible archive before taking them out of an operational list. Calling removal an archive does not make the information recoverable.

Two related details also need design work. The current allocator can reuse an old record number, potentially sending an old reference to new work. And saving a removal locally does not guarantee another machine received it. The design must account for those failures, including crashes and unavailable machines.

The eventual change must therefore preserve open work and memory, fix all four arithmetic sites, keep old configuration values compatible, and show accurate retained counts plus overflow. Its report must distinguish an unavailable measurement from a healthy empty list. A pressure indicator must not claim an alert was delivered unless delivery was actually verified.

The remaining work is mine: specify and review archive recovery, stable references, cross-machine removal, and the alarm's delivery rules. The design has not completed convergence, and no approval is being requested on these unfinished details. The soft-target choice also leaves file size and rewrite cost able to grow with active work; it is not a hard storage bound.
