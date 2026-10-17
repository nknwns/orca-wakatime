# WakaTime for Orca

[Русская версия](README.ru.md)

Automatic time tracking for the [Orca](https://github.com/stablyai/orca) ADE with [WakaTime](https://wakatime.com), on par with the WakaTime plugins for JetBrains IDEs, VS Code, and Cursor.

## What gets tracked

| What you do in Orca | What is sent to WakaTime |
| --- | --- |
| A file is open in the editor | file heartbeat; language, project, and branch are detected by `wakatime-cli`; category `coding` |
| You save a file | heartbeat with `--write` and `--human-line-changes` (lines you changed by hand) |
| A diff is open | category `code reviewing` |
| You work in a terminal | `Orca Terminal` in the worktree's project; `ai coding` while an agent is working in that worktree |
| Built-in browser | the domain only (no path or query); `localhost` / `*.local` → `manual testing`, otherwise `browsing` |
| Native agent session | `Orca Agent`, category `ai coding` |
| AI agents (Claude, Codex, …) | `wakatime-cli` parses their transcripts itself; when an agent finishes a turn, the plugin runs `--sync-ai-activity` |

Project and branch are detected from the worktree folder, so Orca worktrees (`~/orca/workspaces/<repo>/<branch>`) land in the same project as the main checkout. For worktrees on SSH hosts, the repository name and branch are sent explicitly.

### When time counts

Same as an IDE: only while **the Orca window is in the foreground and you are giving input** (keyboard or mouse within the last 5 seconds). The WakaTime plugin rules are followed: a heartbeat is sent when the file or tab changes, every 2 minutes for the same entity, and always on save. If Orca is minimized or you step away, no time is counted; WakaTime itself joins short gaps (15 minutes by default).

Focus and idle time come from the OS:
- **Windows**: a background `powershell.exe` using `GetForegroundWindow` / `GetLastInputInfo`;
- **macOS**: `ioreg` and `lsappinfo`;
- **Linux (X11)**: `xprintidle` and `xdotool`, if installed.

If focus can't be detected, the plugin falls back to counting tab actions only (switches, edits, saves).

## Installation

1. You need `~/.wakatime.cfg` with your API key (`api_key = waka_…` under `[settings]`; get it at <https://wakatime.com/api-key>). If you've used WakaTime in another editor, the file is already there.
2. Orca → **Settings → Plugins**: turn on the plugin system.
3. Click **Install plugin**, choose **Git URL**, and enter:
   ```
   https://github.com/nknwns/orca-wakatime#v0.1.0
   ```
4. Review the requested permissions and enable **WakaTime**.

`wakatime-cli` is taken from `~/.wakatime/`. If it's missing or outdated, the plugin downloads the latest release from GitHub (checked once a day), as the [WakaTime plugin guide](https://wakatime.com/help/creating-plugin) requires. The binary is shared with your other WakaTime editor plugins.

The plugin worker starts with the first Orca event (an agent changes status, a worktree is created) or when you run one of its commands, and keeps running after that.

## Commands

Available in Orca quick actions (`Ctrl/Cmd+J`); shortcuts can be assigned in **Settings → Shortcuts**.

- **WakaTime: Status**: CLI version, API key, focus detection, last heartbeat.
- **WakaTime: Today's Time**: the same total an IDE shows in its status bar.
- **WakaTime: Open Dashboard**.
- **WakaTime: Pause Tracking / Resume Tracking**: persists across restarts.

Notifications are shown in your OS UI language (English and Russian for now).

## Settings

All standard WakaTime settings in `~/.wakatime.cfg` (`exclude`, `include`, `hide_file_names`, `hide_branch_names`, `proxy`, `api_url`, …) are applied by `wakatime-cli`. `debug = true` also turns on verbose plugin logging (Settings → Plugins → plugin log).

## How it works, and what to know before installing

Orca's public plugin API (v1.4) has no events for open or saved files. To see which file is in focus, **the plugin reads Orca's local runtime RPC**, the same named pipe / unix socket the `orca` CLI uses, authenticated with the token from Orca's `orca-runtime.json`. It only calls two read-only methods: `worktree.ps` (which worktree is focused) and `session.tabs.listAll` (tabs, their files, and dirty state).

Keep in mind:
- This goes beyond the capabilities you approve in the consent dialog. Plugin workers run as regular processes on your machine, so this is possible, but you should know about it.
- The RPC is internal to Orca and not a stable API. A major Orca update may require a plugin update.
- The plugin also runs `wakatime-cli` and, on Windows, a hidden PowerShell process for focus and idle detection. It reads file contents only to count changed lines on save (files up to 2 MB). Nothing is sent anywhere except what `wakatime-cli` sends to your WakaTime account (or your custom `api_url`).

## Limitations

- Line number and cursor position aren't available, so `--lineno` / `--cursorpos` are not sent.
- Codex started from Orca may store transcripts in Orca's own directory instead of `~/.codex`, so `wakatime-cli` won't see those sessions.
- Tested on Windows. macOS and Linux focus detection is implemented but not yet verified on real machines; reports are welcome.

## Development

```sh
npm test   # node --test, no dependencies
```

To try local changes, add the repository folder in Orca under **Settings → Plugins → Development**.

Code layout:
- `src/activity.mjs`: pure logic (what's in focus, when to send);
- `src/tracker.mjs`: polling and orchestration;
- `src/focus-probe.mjs`: window focus and idle time;
- `src/runtime-client.mjs`: Orca runtime RPC;
- `src/wakatime-cli.mjs`, `src/zip.mjs`: installing and running the CLI;
- `src/i18n.mjs`: notification texts.

## License

[BSD 3-Clause](LICENSE)
