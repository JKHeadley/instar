# A session stuck on a menu is now noticed, even when the menu is not at the very bottom of the screen (plain-English overview)

Governing standard: the Permission-Prompt Floor ("you are never blocked by a framework approval prompt"; `docs/STANDARDS-REGISTRY.md`). This change makes its announce half do what it already promised; it adds no new rule and presses no new key.

## What happened

On 2026-10-19 an autonomous session on the Mac Studio stopped twice on a menu it could not answer itself: once on Claude Code's "switch model?" menu, once on a confirmation for a risky `rm` command. The watcher that is supposed to notice this was on and healthy. It pressed nothing (correct: it only ever answers one specific prompt it was built for, and neither of these is it). But it also told nobody and wrote nothing down. The coordinator found both by looking at the screen by hand.

A throwaway session reproduced the first case exactly. Claude Code drew the menu, then 17 empty rows, then one status line at the bottom of the screen ("Waiting for API response, will retry in 2m 40s"). The watcher reads the last few rows of the screen. Counting empty rows, the last five were four blanks and that status line, and the last sixteen were fifteen blanks and that line. The menu was simply out of view. Even with the menu in view, two more rules would have stopped it: the last line was a status line rather than part of the menu, and the highlighted option sat eight lines up, outside the six-line window it checks.

## What changes

- The watcher now counts only non-empty rows when it reads the bottom of the screen, so blank padding can no longer hide a menu.
- When deciding whether to announce a menu (never when deciding to press a key), it ignores a trailing "waiting for API, will retry" line and Claude Code's permission-mode status bar, and it looks twelve lines up instead of six, because a menu may carry a description under each option.
- It writes one audit row when it first sees a menu it will not answer, and one when it raises the alert. Before, an abstention left no trace at all.
- A reviewer found one shape the wider rule would have mistaken for a menu: a numbered list the model printed inside a tool result, sitting above that same status line. The watcher now counts a bare numbered list as a menu only when no status line had to be ignored; a real menu always has its own footer line ("Esc to cancel"), so real menus are unaffected.

The announce rule itself is unchanged: a menu that stays on screen for four checks raises one attention item.

## What does not change

The auto-answer half is untouched: it still answers only the one Claude Code prompt it was built for, and only when at least two of that prompt's exact phrases are present. A "do you want to proceed?" from a safety guard, or a model-switch menu, can never be auto-approved. Tests pin this against the captured screen.

## What you need to decide

Nothing.
