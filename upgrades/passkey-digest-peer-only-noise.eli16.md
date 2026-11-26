# Passkey health stops posting "0 need attention" — the plain-English version

The passkey health check looks at each saved passkey sign-in on each machine and, when one needs a person, posts one summary item into the Attention topic. Along with that list it adds a note naming any of the agent's other machines it couldn't reach right now.

The bug: when no passkey needed anyone, that reachability note was still enough to count as "something to report". So whenever a laptop went to sleep or a PC dropped off the network, the summary got re-posted, saying "0 cell(s) need attention". On Echo that was 147 of the 341 messages in the Attention topic over three days, close to half of all the noise Justin flagged.

The fix: a summary that has nothing in it but the reachability note now counts as empty. Nothing is posted, and if an old summary item is still open it is closed quietly. When a passkey really does need someone, the reachability note still appears next to it like before. Machine reachability itself is still shown where it belongs: the Machines dashboard tab and the machine connection health checks. This is the first step of making Attention carry only things that need you.
