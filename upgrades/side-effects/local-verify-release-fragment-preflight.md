# Release-fragment admission check

Two full runs could not lead to a merge because the release-fragment check had already failed. Local Verify now refuses source changes missing a Markdown fragment under upgrades/next before admitting them. It uses the GitHub PR file list and confirms the head and target after fetching additional pages. The release workflow retains its own checks and decisions.

Already running attempts are allowed to finish. An operator can offer a new head once the fragment is present. To roll back the admission change, revert this commit and deploy through the guarded restart. Do not hand-publish statuses for an unverified successor.
