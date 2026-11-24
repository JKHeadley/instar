# Upgrade Guide — vNEXT

<!-- internal-only -->
<!-- bump: patch -->

## What Changed

The five subscription routing unit tests now use a private directory for process admission accounting.

## Evidence

The fixture checks the path selected by the real admission wrapper before constructing the provider. The existing routing cases check the selected command, its exact arguments and the simulated pool response.

All five cases passed in the focused run.
