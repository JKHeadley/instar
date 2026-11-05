<!-- bump: minor -->

## What Changed

Linux agents can now drive a normal Chrome. The agent runs Chrome on a private virtual screen of its own, reads pages through the accessibility system, clicks what it finds by name after checking what is under the point, and types ordinary text. Passwords go from Secret Drop straight into the password box: the person sees the site on the form, the agent cannot change it, and the box must really belong to that site. A new agent on Ubuntu 24.04 with passwordless sudo installs all of this by itself after it starts. Existing agents are never changed without asking.

Every agent now knows it has a browser. `GET /browser/state` always answers ready, installing, not-built or broken with a next step, Linux sessions start with a line saying so, and the standing instructions say to check before saying a browser task can't be done.

## What to Tell Your User

Your agent can now use a real browser on a Linux server. If it was set up before this update, it will ask you one yes-or-no question the first time you want a browser task, because that needs software installed. It can sign in with a password you give it through Secret Drop, and it can't do one-time codes yet.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Drive Chrome on a Linux server | The /normal-chrome-browser skill, through .instar/scripts/browser/xdrive.sh |
| Type a password from Secret Drop | Request it with browserHost, then the helper's --browser mode |
| See the browser's state | GET /browser/state, or browser in GET /capabilities |
| Install on an existing Linux agent | After the operator says yes, POST /browser/linux/install |

## Evidence

Rule, wrapper, helper, provisioner, migration, route and boot tests in the repository. Live on a real Ubuntu 24.04 server: a new agent installed itself in 38 seconds, and a Secret Drop password reached a page with a matching hash. The full table, including rows not run, is in docs/specs/normal-chrome-linux.md.
