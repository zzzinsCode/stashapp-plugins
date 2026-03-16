# FindFileScenes

A [Stash](https://github.com/stashapp/stash) plugin that finds all Stash scenes associated with a given file path or folder. Useful for diagnosing which scenes reference a specific file, or finding all scenes under a particular folder — including subfolders.

---

## Features

- **File mode** — given an exact video file path, returns every Stash scene that contains that file
- **Folder mode** — given a folder path, returns every scene that has a file anywhere under that folder (recursive)
- **Auto-detects mode** — determines file vs folder automatically from the file extension
- **Case-insensitive, cross-platform path matching** — normalises backslashes and forward slashes
- **JSON output** — results returned as structured JSON for use in scripts or other tooling

---

## Installation

1. Copy the `FindFileScenes` folder into your Stash plugins directory:
   ```
   C:\Users\<you>\.stash\plugins\FindFileScenes\
   ```
2. In Stash, go to **Settings → Plugins** and click **Reload Plugins**

> **Windows note:** If your Python installation path contains spaces (e.g. `C:\Users\Adam Plant\...`), update the `exec` section of `FindFileScenes.yml` to use the full quoted path to your Python executable:
> ```yaml
> exec:
>   - "C:\\Users\\Adam Plant\\AppData\\Local\\Python\\pythoncore-3.14-64\\python.exe"
>   - "{pluginDir}/FindFileScenes.py"
> ```

---

## Usage

Run the **Find Scenes For File** task from **Settings → Plugins → FindFileScenes Tasks**, passing a `file_path` argument.

### File mode
Pass an exact video file path to find the scene(s) referencing that file:
```
H:\Videos\Studio\scene.mp4
```

### Folder mode
Pass a folder path (no video extension) to find all scenes with files anywhere under that folder:
```
H:\Videos\Studio\
```

Results are written to the plugin log and returned as JSON:

```json
{
  "count": 2,
  "file_path": "H:\\Videos\\Studio\\",
  "mode": "folder",
  "scenes": [
    {
      "id": "123",
      "title": "Scene Title",
      "date": "2024-01-15",
      "studio": "Studio Name",
      "performers": ["Performer One"],
      "files": ["H:\\Videos\\Studio\\scene.mp4"]
    }
  ]
}
```

---

## Recognised video extensions

`.mp4` `.m4v` `.mkv` `.avi` `.mov` `.wmv` `.flv` `.webm` `.ts` `.mts` `.m2ts` `.mpg` `.mpeg` `.ogv` `.3gp` `.3g2`

Any path without one of these extensions is treated as a folder.

---

## Requirements

- Python 3.x
- `requests` library (`pip install requests`)
