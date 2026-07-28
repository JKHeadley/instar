# Standalone Playwright seat lease — ELI16

Playwright MCP already takes a numbered key before using the shared browser, but a
one-off Playwright script entered through a side door and skipped the key desk. This
adds an explicit check-out/check-in path for those scripts. Check-in only works for
the holder that checked out the key, so an old script cannot accidentally erase a
new script's reservation.
