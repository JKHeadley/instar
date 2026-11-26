# A slow first Chrome start no longer fails the passkey browser test

The passkey browser test kept failing on CI with a timeout on the very first message sent to Chrome. It was always the first test in the file. Every later test in that file started Chrome in a few seconds, but the first start on a busy test machine sometimes took 20 to 40 seconds. That first message was held to the short timeout meant for ordinary commands. It was really waiting for Chrome to finish launching.

That first message now waits on the launch timeout, because until Chrome answers it the browser is still starting up. The test also starts Chrome once before the cases run, so the slow cold start is paid up front and no single test fails for happening to run first. Nothing else changes, and nobody needs to do anything when upgrading.
