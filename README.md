# pi-diff-panel

[![npm version](https://img.shields.io/npm/v/pi-diff-panel?style=flat-square)](https://www.npmjs.com/package/pi-diff-panel) [![npm downloads](https://img.shields.io/npm/dt/pi-diff-panel?style=flat-square&label=npm%20downloads)](https://www.npmjs.com/package/pi-diff-panel) [![license](https://img.shields.io/npm/l/pi-diff-panel?style=flat-square)](LICENSE)

A [pi](https://pi.dev) extension that shows your **uncommitted git changes** and **current branch** in a panel, with a syntax-highlighted diff viewer similar to `/diff` in Claude Code.

```
╭─ Changes ─────────────────────────────────────────────────────────╮
│ ⎇ feature/demo ↑2   12 files  +10 -7                              │
├───────────────────────────────────────────────────────────────────┤
│  M src/math.ts                                              +4 -3 │
│  ? extra_1.txt                                                    ┃
│▶ ? extra_4.txt                                                    ┃
│  ? extra_5.txt                                                    │
│  ? extra_6.txt                                                    │
╰─ ↑↓ select · ⏎ diff · r refresh · esc back · 4–8 of 12 ───────────╯
───────────────────────────────────────────────────────────────────────────────
 > your prompt…
```

<img width="1031" height="206" alt="Screenshot 2026-10-14 at 4 22 10 PM" src="https://github.com/user-attachments/assets/ab102c57-4a92-48e6-95de-7759605f2cf9" />


By default the panel sits just above the editor and opens on every new session. You can move it to the left or right side instead.

## Install

```bash
pi install npm:pi-diff-panel
```

Or from GitHub: `pi install git:github.com/hazrid93/pi-diff-panel`

To try it once without installing: `pi -e npm:pi-diff-panel`

## Usage

| Command / key | Action |
|---|---|
| `/diff-panel` | Show or hide the panel |
| `/diff-panel on` \| `off` | Show or hide the panel |
| `/diff-panel bottom` \| `left` \| `right` | Move the panel (for this session) |
| `/diff-panel help` | Show keys and settings |
| `ctrl+\` | Focus the panel: `↑↓` select, `PgUp/PgDn` page, `Enter` open the diff, `Esc` back to the editor |
| `/diff-panel focus` | Same as `ctrl+\` |
| `/diff` | Open the diff viewer |
| Mouse wheel / click | Scroll the list / open a file's diff (fullscreen mode only) |

When the panel is hidden, the footer shows a short hint: `⎇ /diff-panel · ctrl+\ diff`.

**Side panel with focus:** `↑/↓` or `j/k` select, `Enter` opens the diff, `r` refreshes, `Esc` gives focus back to the editor.

**Diff viewer:** `↑/↓` scroll, `PgUp/PgDn` (or `b`/`space`) page, `g/G` top/bottom, `←/→` (or `h/l`) previous/next file, `Esc`/`q` close.

The panel shows staged, unstaged, and untracked changes against `HEAD`. It refreshes every 2 seconds and after each agent turn. The bottom panel hides itself outside git repositories.

## Settings

Add a `diffPanel` block to `~/.pi/agent/settings.json`, then run `/reload`:

```json
{
  "diffPanel": {
    "position": "bottom",
    "height": 5,
    "key": "ctrl+\\",
    "autoShow": true
  }
}
```

| Setting | Values | Default |
|---|---|---|
| `height` | number of file rows in the bottom panel (1–40); longer lists scroll | `5` |
| `position` | `"bottom"`, `"left"`, `"right"` | `"bottom"` |
| `key` | a key, or a list of keys, in [pi key syntax](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/keybindings.md#key-syntax) | `"ctrl+\\"` |
| `autoShow` | `true` shows the panel on every new session; `false` shows only the footer hint | `true` |

### Choosing a key on macOS

The default is `ctrl+\` because pi does not use it and macOS terminals send it unchanged. Some keys do not work well:

- `ctrl+alt+…` — Option often types a special character instead.
- `ctrl+shift+p` — pi already uses it to change the model.
- `cmd+shift+p` (`super+shift+p`) — most terminals keep Cmd shortcuts for themselves. It only works in terminals with the Kitty keyboard protocol, such as Kitty, Ghostty, or WezTerm.
- `shift+p` — you could not type a capital P any more.

Function keys such as `"f2"` are a safe alternative.

## Notes

- The side panels are drawn over the transcript, because pi has no split layout. On narrow terminals they cover part of the chat.
- Very large diffs are cut at 5000 lines.

## Development

```bash
bun test                    # parser tests
pi -e ./index.ts            # run locally
```

## License

MIT
