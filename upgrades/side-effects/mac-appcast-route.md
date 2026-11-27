# Side-Effects Review — instar.sh /mac/appcast.xml points the Mac app's updater at its release feed

**Version / slug:** `mac-appcast-route`
**Date:** `2026-11-16`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

The change is one new site route, `site/src/pages/mac/appcast.xml.ts`, plus its unit test `tests/unit/site-mac-appcast.test.ts`. The Instar Mac app (apps/instar-ios, target InstarMac, Sparkle 2) has `https://instar.sh/mac/appcast.xml` built in as its update feed. This route answers that address with an uncached 302 to `https://github.com/JKHeadley/instar/releases/download/mac-app/appcast.xml`, a release asset. Publishing a new Mac build therefore means uploading files to that release, with no site deploy. Operator Justin chose this layout, an unlinked instar.sh address, in topic 143051 on 2026-11-16 at 20:41 PST ("A").

Tier 1, declared: 2 files, about 41 lines, reversible by revert. Effort: one commit attempt and no spec review rounds.

## Decision-point inventory

No decision-point surface. The route decides nothing. It always redirects to one fixed address.

---

## 1. Over-block

No block/allow surface, so over-block is not applicable.

---

## 2. Under-block

No block/allow surface, so under-block is not applicable. Update trust is enforced in the app, not here: Sparkle accepts an update only when its EdDSA signature matches the public key built into the app, and the update must be the same Developer ID app. A tampered feed or release asset is therefore refused by the app.

---

## 3. Level-of-abstraction fit

This is the right layer: a stable public address on the site that points at a store you can upload to. The feed and binaries live as release assets, so the site is not redeployed for each build. A static file in `site/public` would need a merge for every build.

---

## 4. Signal vs authority compliance

It holds no authority. The route is a pointer, and the authority to install an update stays with the signed-update check in the app.

## 4b. Judgment-point check

No competing-signals decision point, so not applicable.

---

## 5. Interactions

The route does not touch the pair-drop route, the assetlinks or AASA files, or any page. It sets `prerender = false`, matching the other dynamic routes, so it runs as a function and its no-store header applies.

---

## 6. External surfaces

Visible change: a new public address, https://instar.sh/mac/appcast.xml. It is not linked from any page. The public Mac download page still waits on the operator's go-ahead. Until the `mac-app` release exists, the redirect target returns 404, and Sparkle treats that as "no update" with no user-facing error during automatic background checks.

## 6b. Operator-surface quality

No operator surface is touched (no dashboard or approval files).

---

## 7. Multi-machine posture

Not agent runtime: this is the hosted site (Vercel), so it is machine-independent by design. Mac apps on any machine read the same feed.

---

## 8. Rollback cost

Revert the commit; the site redeploys on merge. Installed apps then get a 404 on update checks and simply stay on their current build. No state, migration or agent repair is involved.

## Conclusion

This is a safe, inert pointer, and the security of updates rests on the app's signature check. Ship it.

## Evidence pointers

- `npx vitest run tests/unit/site-mac-appcast.test.ts`: 1 passed. It checks the 302, the Location header, no-store, and that prerender is false.
- App side: apps/instar-ios echo/mac-app-m1 sets Info.plist `SUFeedURL=https://instar.sh/mac/appcast.xml` and `SUPublicEDKey`. The private key is in the vault as `sparkle_mac_ed_private_key`.
