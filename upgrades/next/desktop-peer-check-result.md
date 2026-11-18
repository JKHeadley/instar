# Remote Desktop explains when a Mac did not answer its check

<!-- bump: patch -->

## What Changed

The dashboard machine picker now reports when it could not check a desktop. An unanswered peer and a helper check that throws both produce this explanation. When a Mac answers with a specific problem, such as a missing permission, the picker displays that reason.

## What to Tell Your User

If the picker says it could not check your Mac, select **Check again**. You can keep using another ready machine while you wait. Once the Mac answers that its desktop is ready, you can select it.

## Summary of New Capabilities

The **Check again** button is available when some machines are ready and others need another check. The dashboard continues to require a ready desktop and verified machine identity before you can open it.

## Evidence

The picker regression in `tests/unit/desktop-video-viewer.test.ts` clicks **Check again** and checks the option, full explanation and button before and after a successful response. The HTTP regression in `tests/integration/desktop-routes.test.ts` models a peer timeout followed by a successful reply.

The boot lifecycle regression in `tests/e2e/desktop-mesh-boot-lifecycle.test.ts` covers a registered peer before its endpoint is discovered. The session-end test verifies that the picker renders the same checked response.

Check again also keeps your selected Mac when it is still ready. If that Mac disappears or can no longer be selected, you can choose from the machines that are ready.
