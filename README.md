# pi-diff-panel

A [pi](https://pi.dev) extension that keeps a persistent side panel of your **uncommitted git changes** and **current branch**, with a syntax-highlighted diff viewer — similar to `/diff` in Claude Code.

```
╭─ Changes ──────────────────────╮
│ ⎇ feature/demo ↑2             │
│ 2 files  +2 -1                │
│                               │
│▶ M math.ts              +2 -1 │
│  ? new.py                     │
╰─ ↑↓ ⏎ diff · r · esc ──────────╯
```

## Install

```bash
pi install git:github.com/hazrid93/pi-diff-panel
```

To try it once without installing: `pi -e git:github.com/hazrid93/pi-diff-panel`

## Usage

| Command / key | Action |
|---|---|
| `/diff-panel` | Show or hide the side panel |
| `/diff-panel left` \| `right` | Move the panel to that side (default: right) |
| `ctrl+alt+d` | Focus the panel. Opens it if it is hidden. Press again to unfocus. |
| `/diff` | Open the diff viewer directly |

**When the panel has focus:** `↑/↓` or `j/k` select a file, `Enter` opens its diff, `r` refreshes, `Esc` gives focus back to the editor.

**In the diff viewer:** `↑/↓` scroll, `PgUp/PgDn` (or `b`/`space`) page, `g/G` jump to top/bottom, `←/→` (or `h/l`) previous/next file, `Esc`/`q` close.

The panel shows staged, unstaged, and untracked changes against `HEAD`. It refreshes every 2 seconds and after each agent turn. It hides when the terminal is smaller than 80×12. Syntax highlighting uses pi's built-in highlighter and theme.

## Notes

- The panel is a non-capturing overlay drawn above the transcript, because pi has no split layout. On narrow terminals it covers part of the chat. Toggle it with `/diff-panel` when you need the space.
- Very large diffs are cut at 5000 lines.

## Development

```bash
bun test                    # parser tests
pi -e ./index.ts            # run locally
```

## License

MIT
