# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Accounts now opens grouped by provider, with the soonest weekly reset first in each group. Use **Group by** to switch to machine groups or a single list, and **Sort by** to order by weekly reset, most used, or name. The dashboard remembers your choices in that browser.

## What to Tell Your User

Choose how you want to see Accounts. The layout changes immediately, and your dashboard remembers it when you return.

## Evidence

On main base `3e318c923`, 63 renderer and model tests, 17 HTTP integration tests, two production lifecycle tests, and six disposable browser cases passed. The browser cases covered light and dark themes at 320, 390 and 1280 pixels, saved preferences, and 44-pixel controls.
