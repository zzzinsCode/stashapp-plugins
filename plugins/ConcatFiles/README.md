# ConcatFiles — Stash Plugin

Adds a **"Merge Files with FFmpeg"** button to any scene that has multiple files attached.
It concatenates them in order into a single video file using FFmpeg, with options to clean up
the originals afterwards.

---

## Installation

1. Copy the `ConcatFiles/` folder into your Stash plugins directory:
   - **Windows:** `C:\Users\<you>\.stash\plugins\ConcatFiles\`
   - **Linux/Mac:** `~/.stash/plugins/ConcatFiles/`
   - **Docker:** map a volume to `/root/.stash/plugins/` and place the folder there

2. Make sure Python 3 and the `requests` library are installed:
   ```bash
   pip install requests
   ```

3. In Stash, go to **Settings → Plugins** and click **Reload Plugins**.

4. The `ConcatFiles` plugin should now appear in the plugins list.

---

## Configuration

Go to **Settings → Plugins → ConcatFiles** to configure:

| Setting | Options | Default | Description |
|---|---|---|---|
| Output File Location | `first`, `last`, `parent`, `prompt` | `first` | Where to save the merged file |
| Delete Original Video Files | on/off | off | Delete source files from disk after merge |
| Delete Original Scene Entry | on/off | off | Remove the original scene from Stash DB and rescan |
| Re-encode if lossless fails | on/off | off | Fall back to libx264/aac if `-c copy` fails |

### Output Location options
- **`first`** — same folder as the first file in the scene
- **`last`** — same folder as the last file in the scene
- **`parent`** — parent folder of the first file's directory
- **`prompt`** — a dialog appears each time asking for the output folder

---

## Usage

1. Open any scene that has **2 or more files** attached.
2. Scroll down to the **File Info** section.
3. You'll see a **"Merge N Files with FFmpeg"** button with the files listed in order.
4. Click the button (and enter an output path if set to `prompt`).
5. The task runs in the background — check **Settings → Tasks → Logs** for progress.
6. Once done, Stash will automatically scan the output folder and the merged file will appear as a scene.

---

## File order

Files are merged in the order they appear in Stash's file list for the scene (top to bottom in the File Info panel). The primary file is always first.

---

## Requirements

- Stash v0.24.0+
- Python 3.7+
- `pip install requests`
- FFmpeg accessible via PATH or `~/.stash/ffmpeg`

---

## Troubleshooting

**Lossless concat fails (re-encode option is off)**
Source files must share the same codec, resolution, framerate, and audio settings for `-c copy` to work.
Enable **"Re-encode if lossless fails"** in settings to handle mismatched files automatically (slower).

**Button doesn't appear**
- Confirm the scene has 2+ files (check the File Info panel)
- Reload plugins (Settings → Plugins → Reload)
- Check the browser console for JS errors

**`requests` module not found**
Run `pip install requests` (or `pip3 install requests`) on the machine running Stash.
For Docker, use an image that supports Python plugin deps, or install into the container.
