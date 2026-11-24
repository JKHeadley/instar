# Freeing space from finished work on the Studio

A worktree is a separate Git checkout used to work on a change. Old checkouts can build up on the Studio even after their changes have merged.

The proposed cleanup waits until a pull request has merged and its checkout has been idle for at least 24 hours. It checks that the checkout still points to the expected commit and has no local edits, active session, owner hold, or shared dependency. If any of those checks are uncertain, it keeps the checkout.

Before removing an eligible checkout, it saves local evidence such as logs, screenshots, and receipts in a compressed archive and verifies the archive. Dependencies and other files that can be rebuilt can go with the checkout. The branch and any backups stay available.

The first rollout will only report what it would remove. The report will explain each decision and later show how much disk space removal actually recovered.
