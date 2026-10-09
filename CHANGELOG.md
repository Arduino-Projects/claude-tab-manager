# Changelog

## 0.9.4

- Fixed: a finished session stayed marked "needs you" after you opened its tab in Cursor. Cursor reports the window as unfocused while you type in a Claude chat, so the extension no longer checks window focus. The active tab counts as seen.
- Added a "Claude Code Tab Manager" output channel that logs how tabs are matched to sessions.

## 0.9.2

First public version.

- Claude Tabs sidebar: group Claude Code tabs, color-code groups, rename and reorder tabs by drag and drop.
- Session status: a spinner while Claude works, and a filled circle when Claude needs you or finished while you were away. On first start, a notification asks before adding the Claude Code hooks it needs.
- A `+` on each group opens a new Claude Code tab in that group.
- Links open a new Claude Code tab in a named group.
