# Locked-Mac proof scripts: build and re-stage fixes (plain-English overview)

**What this is.** Two small fixes to the test scripts used to prove that remote desktop works on a locked Mac. These scripts are only used by the developer on the throwaway test account on the Mac Mini. They never ship as part of any agent's runtime, and no user ever runs them.

**What was broken.** On 2026-11-20, after the Studio rebuild, building a fresh test package from current main failed at the very last step. The build copies the project into a scratch folder and links in the installed packages. Before packaging, it removes that link. Then npm's packaging step ran the project's "prepare" step anyway, even though it was told to skip scripts. That step installs git hooks with a tool called husky, which was no longer reachable, so the packaging failed. Second, installing the new package for the test account failed. The setup script tries to create both test agents every time, and creating an agent that already exists stops with an error. So re-installing a newer build over the existing test agents never reached the settings step.

**What changes.** The build now removes the "prepare" step from its scratch copy of the package file before packaging. An installed test package never needs git-hook setup, so nothing is lost. The setup script now creates a test agent only when that agent has no settings file yet. The settings step still runs for both agents every time, as before.

**Safeguards.** The real project files are never edited by the build, as before. The setup script still refuses anything that isn't a test build, and still only acts on the throwaway test user. Unit tests check both fixes.

**What you need to decide.** Nothing. This is a test-tooling fix with no effect on shipped behavior, and a revert fully undoes it.
