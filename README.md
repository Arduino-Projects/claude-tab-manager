# Claude Code Tab Manager

Keep many Claude Code tabs under control in VS Code and Cursor. Put tabs in color-coded groups, rename and reorder them, and see at a glance which sessions are working and which need you.

> This is an independent extension. It is not made, endorsed, or supported by Anthropic. It works with the official [Claude Code extension](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code), which must be installed.

## Requirements

- VS Code 1.80 or later, or Cursor.
- The Claude Code extension, with sessions opened as editor tabs.
- macOS or Linux for session status (the hooks run a small `sh` script).

## Known limits

- The extension uses some of Claude Code's internal commands (rename and new tab) and reads the titles in its session files. A Claude Code update can change these without notice.
- Tabs are matched to sessions by title. Two tabs with the same title can swap their status.

## Use

- Open the **Claude Tabs** view in the activity bar. It lists the Claude tabs that are open in this window, by group.
- **New group:** the `+` button in the view title.
- **New Claude tab in a group:** hover a group (or **Ungrouped**) and click its `+`. A new Claude Code tab opens in that group.
- **Add or move a tab:** drag it onto a group or onto a tab in that group, or right-click it and pick **Move to Group…**. In a Claude tab, press ⌘⌥G or click the icon in the editor title bar.
- **Rename a tab:** hover it and click the pencil, or right-click it and pick **Rename Tab…**. This uses Claude Code's own rename, so the new name shows on the real tab and in Claude Code's sessions list, and it stays after a reload. The tab keeps its group.
- **Reorder tabs:** drag a tab onto another tab to put it just above that tab, or onto a group's title to put it at the end of the group. The order is saved and comes back after a reload. It is the sidebar order only; the editor's tabs keep their places.
- **Closing tabs:** a tab you close in the editor stays in its group (or under **Ungrouped**) as a *closed* row, in the same place. Click it to reopen the session. The sidebar's **X** closes the tab and removes it from the list. On a closed row, the X just removes the row. New tabs that never got a title are not kept. Deleting a group moves its closed rows to **Ungrouped**.
- **Remove a tab from its group:** right-click it and pick **Remove from Group**, or drag it to **Ungrouped**.
- **Group actions** (hover or right-click a group): change color, rename, reorder, close all tabs, delete.
- Click a tab to switch to it. The sidebar selects the active Claude tab, like the Explorer does for the active file, without taking focus from the editor. The status bar shows the group of the active Claude tab.
- **Hide the editor tab bar** (optional): set `"workbench.editor.showTabs": "none"` in your settings, or `"single"` to show only the active tab's title. The sidebar then works as your tab list.

## Session status

Each tab shows a circle in its group's color, and group titles use the group's color too:

| Icon | Meaning |
|------|---------|
| Spinner | Claude is working. |
| Filled circle | Claude needs your approval or an answer, or it finished and you have not looked at the tab yet. |
| Empty circle | Nothing to do. |

A finished tab goes back to an empty circle as soon as it is the active tab. A tab waiting for approval stays filled until you answer.

VS Code does not let an extension see another extension's tab icons, so the status comes from Claude Code hooks. On first start, a notification asks whether to add these hooks: **Allow** adds them, **Don't Allow** means you are not asked again. If you close the notification without choosing, it asks again next start. To add the hooks later, click **Set up session status** at the top of the sidebar, or run **Claude Tabs: Set Up Session Status**. It adds hooks for `UserPromptSubmit`, `PostToolUse`, `Notification`, and `Stop` to `~/.claude/settings.json`, after a backup to `settings.json.claude-tabs.bak`. Each hook runs `~/.claude/claude-tabs/record-event.sh`, which appends only the session id, transcript path, event name, notification type, and time to `~/.claude/claude-tabs/events.jsonl`. Claude sessions that are already running pick up the hooks after a window reload. **Claude Tabs: Remove Session Status Hooks** takes them out again.

The extension matches events to tabs by session title. It reads each session's title from its transcript in `~/.claude/projects`.

## Group color in the editor

VS Code does not let an extension draw on the tab bar or color another extension's tabs. Instead, a dot in the group's color shows in the editor title bar (top right) for the active Claude tab. Click it to change the group. Ungrouped tabs show a tag icon instead.

## Open a new Claude tab in a group from a link

```
cursor://araadshams.claude-tab-manager/open?group=PR%20Reviews&prompt=/pr-review%20123
vscode://araadshams.claude-tab-manager/open?group=Bugs&color=red&prompt=...
```

| Parameter | Meaning |
|-----------|---------|
| `group`   | Group name. Case does not matter. The group is created if it does not exist. |
| `color`   | Optional. Used only when the group is created: `red`, `orange`, `yellow`, `green`, `blue`, `purple`. |
| `prompt`  | Optional. Passed to Claude Code, the same as `cursor://anthropic.claude-code/open?prompt=...`. |
| `session` | Optional. Claude Code session ID to open, the same as Claude Code's own link. |

## How groups are stored

Group names, colors, and order are stored in the editor's global state, so all windows share them. Each open tab keeps its group while the window is open. To restore groups after a reload, the extension also saves the tab title of each grouped tab. When Claude Code retitles a tab, the saved title is updated.

If two tabs have the same title when the window reloads, they get the same group.

## Develop

```sh
npm test          # unit tests, and extension tests against a fake VS Code API
npm run package   # builds claude-tab-manager.vsix
npm run release -- patch   # bumps the version, tests, builds, and publishes to both stores
"/Applications/Cursor.app/Contents/Resources/app/bin/cursor" --install-extension claude-tab-manager.vsix --force
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --install-extension claude-tab-manager.vsix --force
```

Then run **Developer: Reload Window**.
