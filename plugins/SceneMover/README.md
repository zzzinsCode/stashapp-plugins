# SceneMover

A [Stash](https://github.com/stashapp/stash) plugin that automatically moves and renames scene files into an organised folder structure based on metadata — studio, date, title, performers, codec, resolution, and more.

---

## Features

- **Rule-based routing** — define multiple library roots, each with path/tag conditions and a filename template
- **Overlay badges** on scene cards showing at a glance which scenes are misplaced:
  - 💾 File is on the wrong drive
  - ⛔ File is in the wrong folder (same drive)
  - ⚠ File is in the right location but the filename doesn't match the template
- **Tooltip preview** — hover a badge to see the exact source → destination path before moving
- **Click-to-move** — click a badge to move that scene immediately, no modal needed
- **Bulk move** — select multiple scenes and move them all in one shot via the toolbar button
- **Filter button** — toggle to show only misplaced scenes on the current page
- **Move modal** with inline preview — see exactly where every file will land before committing
- **Long path handling** — automatically trims `{title}` and `{performers}` tokens to keep paths within the Windows 259-character limit
- **Empty folder cleanup** — removes empty source folders after a move
- **Same-folder rename** — handles filename-only changes via a temporary folder to avoid Stash's `_2` suffix bug
- **Unorganised scenes are ignored** — only organised scenes are evaluated

---

## Installation

1. Copy the `SceneMover` folder into your Stash plugins directory:
   ```
   C:\Users\<you>\.stash\plugins\SceneMover\
   ```
2. In Stash, go to **Settings → Plugins** and click **Reload Plugins**
3. The plugin UI appears under **Settings → Plugins → SceneMover**

---

## Configuration

Open the SceneMover modal (⚙ button in the Stash nav) and go to the **Settings** tab.

### Library Roots

Each root defines where a group of scenes should live. Configure one or more roots with:

| Field | Description |
|---|---|
| **Path** | The root folder for this library (e.g. `H:\Videos\Studios`) |
| **Template** | Filename/path template using tokens (see below) |
| **Match tag** | Only apply this root to scenes with this tag |
| **Match path** | Only apply this root to scenes whose current path contains this string |
| **Default** | Fallback root used when no other root matches |

### Filename Tokens

| Token | Value |
|---|---|
| `{studio}` | Studio name |
| `{studioFirstLetter}` | First letter of studio name |
| `{studioInitial}` | First letter of studio name (uppercase) |
| `{date}` | Full date (YYYY-MM-DD) |
| `{yyyy-MM-dd}` | Full date |
| `{yyyy-MM}` | Year and month |
| `{yyyy}` | Year only |
| `{MM-dd}` | Month and day |
| `{title}` | Scene title (auto-truncated to fit Windows MAX_PATH) |
| `{performers}` | All performers, comma separated |
| `{favoritedPerformer}` | First favourited performer (or first performer) |
| `{favoritedPerformerInitial}` | First letter of favourited performer |
| `{codec}` | Video codec (e.g. `hevc`, `h264`) |
| `{height}` | Vertical resolution (e.g. `1080`) |
| `{ext}` | File extension without dot |
| `{scene_id}` | Stash scene ID |

**Example template:**
```
{studioFirstLetter}\{studio}\{studio}.{yyyy-MM-dd}.{performers}.{title}.{scene_id}.{height}.{codec}.{ext}
```

---

## Requirements

- Stash (any recent version)
- Python 3.x at the path configured in your environment (Windows: update `SceneMover.yml` `exec` if needed)
- Plugin must be running as a user account that has write access to your media folders

---

## Known Limitations

- If Stash has a stale/orphaned database record at the destination path, the move will be skipped. Run **Settings → Tasks → Clean** to clear orphaned records.
- The plugin evaluates organised scenes only. Unorganised scenes are never touched.
