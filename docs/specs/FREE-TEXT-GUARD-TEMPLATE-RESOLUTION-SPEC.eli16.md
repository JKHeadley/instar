# ELI16 Overview — Free-text Guard Template Resolution

Instar updates existing agents by running a post-update migrator. One of that
migrator's jobs is to reinstall built-in hooks so older agents receive the
latest safety behavior after they update.

The free-text guard hook is one of those built-in hooks. It lives as a real
template script because its contents include shell, Python, and regular
expressions. Keeping that script in a template file is less fragile than trying
to embed the whole thing inside a TypeScript string.

The bug is simple: the migrator was looking for that template in only one
place. That place matches a compiled-template folder, but the package we publish
does not ship templates there. The package does ship the template under the
source-template folder. So the hook was not actually missing; the migrator was
looking in the wrong place for the package layout we really publish.

The fix is to add one shared template loader. It checks the compiled-template
location first, then checks the packaged source-template location. The
free-text guard uses that loader, and the existing similar template readers use
it too. That makes template lookup consistent instead of leaving each caller to
remember its own path fallback.

The behavior of the free-text guard does not change. This only changes how the
post-update migrator finds the file it already intends to install. Existing
agents should again receive the guard during update, and future template readers
are less likely to repeat the same single-location mistake.

The main thing reviewers need to decide is whether the fix should change the
reader or the build. This spec chooses the reader because the published package
already includes the source templates. Adding a second copied template tree to
the build would create two package locations for the same asset. Using the
existing shipped template location is the smaller and cleaner repair.
