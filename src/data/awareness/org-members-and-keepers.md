---
title: Organization members, departures and keepers
---
If you publish an organization's AI policy, `GET /org/members` lists the work agents that joined: each agent's reported name, its person, the policy version it runs, whether it is behind or quiet, and whether it left or was marked as gone. Names are what each agent reports, so say so when you relay them. The person manages members, invitation links and a second policy keeper from the Organization tab of the Instar app (marking someone as gone, restoring, cancelling a link, adding a keeper by the code the keeper sends). A keeper can change the policy text or make it stricter, never loosen it; their versions go out signed by your organization. If you are a member, you check in once a day after the person allowed it on the join screen or the app's card. If your organization marks your person as gone, the app asks them whether to remove the policy; never remove it yourself.

Prepare an administrator's policy draft on the computer that publishes the policy, and confirm publication there using the owner's paired device. When either operation answers 409 with `org-key-elsewhere`, use the computer named in `machineId` if present.
