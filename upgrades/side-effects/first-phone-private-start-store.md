# First-phone Start locator storage

The dark store persists a random locator digest, owner account, holder machine and epoch, expiry, and exact proposal digest. A direct private Telegram receipt can claim that digest once. A claim reserves disclosure delivery only. If delivery later fails, a new offer requires a newly issued locator.

Focused SQLite checks cover wrong owner or holder, expiry, digest-only storage, and one-use behavior across connections and reopen. This checkpoint has no production caller.
