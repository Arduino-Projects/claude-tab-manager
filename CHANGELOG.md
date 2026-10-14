# Changelog

## 0.10.0

- A tab you close in the editor now stays in its group, or under Ungrouped, as a closed row in the same place. Click it to reopen the session.
- The sidebar's X closes a tab and removes it from the list.
- Deleting a group moves its closed rows to Ungrouped.
- Fixed: sessions that never got an AI title (short chats like "hi!") could not be reopened or show a status. Titles now follow Claude Code's order: custom title, AI title, last prompt, summary.
- A session you reopen another way (Claude Code's sessions list, or moving a tab to another split) goes back to its group.

## 0.9.4

- Fixed: a finished session stayed marked "needs you" after you opened its tab in Cursor. Cursor reports the window as unfocused while you type in a Claude chat, so the extension no longer checks window focus. The active tab counts as seen.
- Added a "Claude Code Tab Manager" output channel that logs how tabs are matched to sessions.

## 0.9.2

First public version.

- Claude Tabs sidebar: group Claude Code tabs, color-code groups, rename and reorder tabs by drag and drop.
- Session status: a spinner while Claude works, and a filled circle when Claude needs you or finished while you were away. On first start, a notification asks before adding the Claude Code hooks it needs.
- A `+` on each group opens a new Claude Code tab in that group.
- Links open a new Claude Code tab in a named group.
