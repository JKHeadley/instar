# Checking whether a Mac can still start a program — in plain English

Instar has a watcher that looks for signs that a machine is frozen ("wedged"). It looks at a few different kinds of evidence, and it only gets suspicious when two different kinds agree for twenty minutes. Today it only takes notes. It never restarts, closes or stops anything.

On a Mac, one kind of evidence was always blank. That kind asks a simple question: can this Mac still start a program? On Linux the watcher already had a way to ask. On a Mac it did not, so the answer always read "unknown".

This change gives the Mac an answer. Instar now ships a tiny app, about 110 KB, inside its own package. The app has no window and no Dock icon. When it starts, it quits straight away. Every time the watcher takes a sample (every 10 minutes, or every 2 when something already looks wrong), it asks macOS to open that app in the background. If macOS opens it and the command finishes normally, the Mac can still start programs, and that counts as healthy. If the command fails with an error or takes longer than 10 seconds, that counts as a warning sign.

There are three fair-play rules, taken from the design document. A failure only counts if the app has opened successfully at least once since the Mac last started, so a Mac where it never works is not called frozen. A failure does not count while the screen is properly locked. It also does not count when nobody is logged in at the screen, or when someone else is.

The second addition reads one number from the Mac's kernel: how much memory one particular kernel pool is using. On October 6 that pool grew to 20 GB and crashed the Studio. If it goes over 4 GB, that is a warning sign. No administrator password is needed to read it; if it cannot be read, the watcher says so instead of pretending it is zero.

On the Studio the app opened 24 times out of 25 in well under a tenth of a second. The one failure happened only because it was asked to open again within a few milliseconds of the previous launch; the watcher never asks that often.

The app is signed the same way as Instar's desktop helper. It is not notarized by Apple, because the release process has no notarization step or the certificate it needs. This does not stop it from working, because macOS only checks notarization on files downloaded through a browser, and npm installs do not carry that download mark.
