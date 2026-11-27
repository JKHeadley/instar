/**
 * Where imported Claude/ChatGPT history lives, spelled once for every place
 * that must keep it on this machine: the store that writes it, git sync's
 * never-sync list, and both .gitignore templates (plus their migration).
 *
 * A person's imported chats are private to this machine. They never ride git
 * sync, and a plain `git add` in the agent home or the internal state repo
 * must not pick them up either.
 */

/** Folder name under the state dir (`.instar/`). */
export const IMPORTED_HISTORY_DIRNAME = 'imported-history';

/** Project-relative spelling: FileClassifier never-sync + project `.gitignore`. */
export const IMPORTED_HISTORY_PROJECT_PATH = `.instar/${IMPORTED_HISTORY_DIRNAME}/`;

/** State-dir-relative spelling: the `.instar/.gitignore` of the internal state repo. */
export const IMPORTED_HISTORY_STATE_PATH = `${IMPORTED_HISTORY_DIRNAME}/`;
