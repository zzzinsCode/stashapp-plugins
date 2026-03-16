#!/usr/bin/env python3
"""
ConcatFiles - Stash Plugin
Merges multiple files into one video using FFmpeg, then wires the result
back into the original scene.

Two-phase execution to work around the Stash single-job-at-a-time constraint:

Phase 1 (merge / merge_folder task):
  encode → validate → destroy other scenes → delete files
  → write pending state → trigger scan → EXIT

Phase 2 (Scene.Create.Post hook, fires after scan creates the new scene):
  read pending state → sceneAssignFile → destroy temp scene
  → trigger phash generate → trigger clean → delete state file
"""

import sys
import json
import os
import re
import signal
import subprocess
import tempfile
import shutil
import time
import requests

PLUGIN_DIR   = os.path.dirname(os.path.abspath(__file__))
PENDING_FILE = os.path.join(PLUGIN_DIR, ".pending_merge.json")

# ---------------------------------------------------------------------------
# Cancellation handling
# ---------------------------------------------------------------------------

_ffmpeg_proc    = None
_partial_output = None

def _cleanup_and_exit(signum=None, frame=None):
    global _ffmpeg_proc, _partial_output
    _log("Cancellation signal -- stopping ffmpeg.", "WARN")
    if _ffmpeg_proc and _ffmpeg_proc.poll() is None:
        try:
            _ffmpeg_proc.terminate()
            _ffmpeg_proc.wait(timeout=5)
        except Exception:
            try: _ffmpeg_proc.kill()
            except Exception: pass
    if _partial_output and os.path.isfile(_partial_output):
        try:
            os.remove(_partial_output)
            _log(f"Deleted partial output: {_partial_output}", "WARN")
        except Exception as e:
            _log(f"Could not delete partial file: {e}", "ERROR")
    sys.exit(0)

signal.signal(signal.SIGTERM, _cleanup_and_exit)
signal.signal(signal.SIGINT,  _cleanup_and_exit)

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

def _log(msg, level="INFO"):
    print(f"[ConcatFiles][{level}] {msg}", file=sys.stderr, flush=True)

def log(msg): _log(msg, "INFO")
def err(msg): _log(msg, "ERROR")

# ---------------------------------------------------------------------------
# Plugin input
# ---------------------------------------------------------------------------

raw = sys.stdin.read()
try:
    plugin_input = json.loads(raw)
except json.JSONDecodeError as e:
    err(f"Failed to parse plugin input: {e}")
    sys.exit(1)

server = plugin_input.get("server_connection", {})
args   = plugin_input.get("args", {})

# Determine execution mode:
#   - hook trigger: args will contain "hookContext" with scene info
#   - manual task:  args will contain "mode"
hook_context = args.get("hookContext")
mode         = args.get("mode", "")

# ---------------------------------------------------------------------------
# Stash connection
# ---------------------------------------------------------------------------

scheme  = server.get("Scheme", "http")
host    = server.get("Host", "localhost") or "localhost"
if host == "0.0.0.0":
    host = "127.0.0.1"
port    = server.get("Port", 9999)
api_key = server.get("ApiKey", "")
gql_url = f"{scheme}://{host}:{port}/graphql"

headers = {"Content-Type": "application/json"}
if api_key:
    headers["ApiKey"] = api_key

def gql(query, variables=None):
    resp = requests.post(gql_url, json={"query": query, "variables": variables or {}}, headers=headers)
    resp.raise_for_status()
    data = resp.json()
    if "errors" in data:
        raise RuntimeError(f"GraphQL error: {data['errors']}")
    return data.get("data", {})

# ---------------------------------------------------------------------------
# Plugin settings
# ---------------------------------------------------------------------------

def get_settings():
    data = gql("query { configuration { plugins } }")
    return data.get("configuration", {}).get("plugins", {}).get("ConcatFiles", {})

# ---------------------------------------------------------------------------
# GraphQL queries / mutations
# ---------------------------------------------------------------------------

FIND_SCENE_QUERY = """
query FindScene($id: ID!) {
  findScene(id: $id) {
    id title date
    studio { name }
    performers { name }
    files { id path basename width height video_codec }
  }
}
"""

FIND_SCENES_IN_FOLDER_QUERY = """
query FindScenesInFolder($path: String!) {
  findScenes(
    scene_filter: { path: { value: $path, modifier: INCLUDES } }
    filter: { per_page: -1 }
  ) {
    scenes { id files { id path } }
  }
}
"""

DESTROY_SCENE_MUTATION = """
mutation DestroyScene($id: ID!, $delete_file: Boolean) {
  destroyScene(id: $id, delete_file: $delete_file)
}
"""

SCENE_ASSIGN_FILE_MUTATION = """
mutation SceneAssignFile($input: AssignSceneFileInput!) {
  sceneAssignFile(input: $input)
}
"""

SCENE_MERGE_MUTATION = """
mutation SceneMerge($input: SceneMergeInput!) {
  sceneMerge(input: $input) { id }
}
"""

SCAN_MUTATION = """
mutation MetadataScan($input: ScanMetadataInput!) {
  metadataScan(input: $input)
}
"""

CLEAN_MUTATION = """
mutation MetadataClean($input: CleanMetadataInput!) {
  metadataClean(input: $input)
}
"""

GENERATE_MUTATION = """
mutation MetadataGenerate($input: GenerateMetadataInput!) {
  metadataGenerate(input: $input)
}
"""

JOB_QUERY = """
query FindJob($id: ID!) {
  findJob(id: $id) { id status }
}
"""

# ---------------------------------------------------------------------------
# Stash helpers
# ---------------------------------------------------------------------------

def find_scene(scene_id):
    return gql(FIND_SCENE_QUERY, {"id": str(scene_id)}).get("findScene")

def destroy_scene(scene_id, delete_file=False):
    gql(DESTROY_SCENE_MUTATION, {"id": str(scene_id), "delete_file": delete_file})

def assign_scene_file(scene_id, file_id):
    gql(SCENE_ASSIGN_FILE_MUTATION, {"input": {"scene_id": str(scene_id), "file_id": str(file_id)}})

def scene_merge(source_ids, destination_id):
    data = gql(SCENE_MERGE_MUTATION, {
        "input": {
            "source":      [str(i) for i in source_ids],
            "destination": str(destination_id),
        }
    })
    return data.get("sceneMerge")

def _norm_path(p):
    return p.replace("\\", "/").lower()

def find_scenes_in_folder(folder_path):
    basename = os.path.basename(folder_path.rstrip("/\\"))
    try:
        data = gql(FIND_SCENES_IN_FOLDER_QUERY, {"path": basename})
        all_scenes = data.get("findScenes", {}).get("scenes", [])
    except Exception as e:
        _log(f"find_scenes_in_folder failed: {e}", "WARN")
        return []
    norm_folder = _norm_path(folder_path)
    result = []
    for scene in all_scenes:
        for f in scene.get("files", []):
            if _norm_path(os.path.dirname(f["path"])) == norm_folder:
                result.append(scene)
                break
    return result

def trigger_scan(path):
    data = gql(SCAN_MUTATION, {"input": {"paths": [path]}})
    return data.get("metadataScan")

def trigger_clean(paths=None):
    inp = {"dryRun": False}
    if paths:
        inp["paths"] = paths
    data = gql(CLEAN_MUTATION, {"input": inp})
    return data.get("metadataClean")

def trigger_generate_phash(scene_ids):
    data = gql(GENERATE_MUTATION, {
        "input": {
            "sceneIDs":                  [str(s) for s in scene_ids],
            "phashes":                   True,
            "previews":                  False,
            "imagePreviews":             False,
            "sprites":                   False,
            "markers":                   False,
            "markerImagePreviews":       False,
            "markerScreenshots":         False,
            "transcodes":                False,
            "interactiveHeatmapsSpeeds": False,
        }
    })
    return data.get("metadataGenerate")

# ---------------------------------------------------------------------------
# Pending state file
# ---------------------------------------------------------------------------

def write_pending_state(master_scene_id, merged_file_path):
    state = {
        "master_scene_id":  str(master_scene_id),
        "merged_basename":  os.path.basename(merged_file_path),
        "folder_path":      os.path.dirname(merged_file_path),
    }
    with open(PENDING_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)
    log(f"Pending state written to {PENDING_FILE}")

def read_pending_state():
    if not os.path.isfile(PENDING_FILE):
        return None
    try:
        with open(PENDING_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        _log(f"Could not read pending state: {e}", "WARN")
        return None

def clear_pending_state():
    try:
        if os.path.isfile(PENDING_FILE):
            os.remove(PENDING_FILE)
    except Exception as e:
        _log(f"Could not delete pending state file: {e}", "WARN")

# ---------------------------------------------------------------------------
# Phase 1 post-merge: destroy/delete then hand off to Phase 2 via scan
# ---------------------------------------------------------------------------

def phase1_cleanup(merged_file_path, master_scene_id, original_file_paths):
    """
    Everything that runs synchronously while the plugin task is alive:
    - Destroy Stash scenes that own individual files (not master)
    - Delete individual files from disk
    - Write pending state so Phase 2 hook knows what to do
    - Trigger scan (fire-and-forget; runs after plugin exits)
    """
    output_dir = os.path.dirname(merged_file_path)

    # Find and destroy scenes that own original files (excluding master)
    log("Finding scenes that own the original files...")
    norm_originals  = {_norm_path(p) for p in original_file_paths}
    scenes_in_folder = find_scenes_in_folder(output_dir)

    for scene in scenes_in_folder:
        sid = str(scene["id"])
        if sid == str(master_scene_id):
            continue
        for f in scene.get("files", []):
            if _norm_path(f["path"]) in norm_originals:
                log(f"Destroying scene {sid} (owned individual file)...")
                try:
                    destroy_scene(sid, delete_file=False)
                except Exception as e:
                    err(f"  Failed to destroy scene {sid}: {e}")
                break

    # Delete individual files from disk
    log("Deleting original files from disk...")
    for p in original_file_paths:
        try:
            if os.path.isfile(p):
                os.remove(p)
                log(f"  Deleted: {p}")
        except Exception as e:
            err(f"  Could not delete {p}: {e}")

    # Write pending state for Phase 2 hook
    write_pending_state(master_scene_id, merged_file_path)

    # Trigger scan — this is a job, so it queues and runs after we exit
    log(f"Triggering scan on {output_dir} (will run after plugin exits)...")
    try:
        trigger_scan(output_dir)
        log("Scan queued. Phase 2 hook will fire when Stash creates the scene.")
    except Exception as e:
        err(f"Failed to trigger scan: {e}")

# ---------------------------------------------------------------------------
# Phase 2: Scene.Create.Post hook handler
# ---------------------------------------------------------------------------

def run_post_scan_hook():
    """
    Fired by Stash when a new scene is created (i.e. after the scan finds
    the merged file). Checks if it matches our pending state and if so:
    - assigns the file to the master scene
    - destroys the temp scene
    - triggers phash generate and clean
    """
    state = read_pending_state()
    if not state:
        # No pending merge — nothing to do
        return

    log("Post-scan hook fired.")

    master_scene_id = state["master_scene_id"]
    merged_basename = state["merged_basename"]
    folder_path     = state["folder_path"]

    # Get the newly created scene ID from the hook context
    new_scene_id = None
    if hook_context:
        # hookContext.id is the scene ID for Scene.Create.Post
        new_scene_id = str(hook_context.get("id", "")).strip()

    if not new_scene_id:
        log("No scene ID in hook context -- cannot proceed.")
        return

    log(f"New scene created: {new_scene_id}. Checking if it contains {merged_basename}...")

    # Fetch the new scene to check its files
    new_scene = find_scene(new_scene_id)
    if not new_scene:
        log(f"Could not fetch scene {new_scene_id}.")
        return

    # Check if this scene contains our merged file
    merged_file_id = None
    for f in new_scene.get("files", []):
        if os.path.basename(f["path"]).lower() == merged_basename.lower() and \
           _norm_path(os.path.dirname(f["path"])) == _norm_path(folder_path):
            merged_file_id = f["id"]
            break

    if not merged_file_id:
        log(f"Scene {new_scene_id} does not contain {merged_basename} -- not our merge, ignoring.")
        return

    log(f"Matched. Assigning file {merged_file_id} to master scene {master_scene_id}...")

    # Assign merged file to master scene
    assigned = False
    try:
        assign_scene_file(master_scene_id, merged_file_id)
        log("File assigned to master scene.")
        assigned = True
    except Exception as e:
        _log(f"sceneAssignFile failed ({e}), falling back to sceneMerge...", "WARN")
        try:
            scene_merge([new_scene_id], master_scene_id)
            log("sceneMerge complete.")
            assigned = True
            new_scene_id = None  # already consumed by merge, don't destroy separately
        except Exception as e2:
            err(f"sceneMerge also failed: {e2}")

    if not assigned:
        return

    # Destroy the temp scene Stash created for the merged file
    if new_scene_id:
        log(f"Destroying temporary scene {new_scene_id}...")
        try:
            destroy_scene(new_scene_id, delete_file=False)
        except Exception as e:
            err(f"Could not destroy temp scene {new_scene_id}: {e}")

    # Generate phash for master scene
    log(f"Generating phash for master scene {master_scene_id}...")
    try:
        trigger_generate_phash([master_scene_id])
        log("Phash generate job queued.")
    except Exception as e:
        err(f"Generate phash failed (non-fatal): {e}")

    # Clean dead file references from master scene
    log(f"Triggering clean on {folder_path}...")
    try:
        trigger_clean(paths=[folder_path])
        log("Clean job queued.")
    except Exception as e:
        err(f"Clean failed (non-fatal): {e}")

    # Done — clear pending state
    clear_pending_state()
    log(f"Phase 2 complete. Master scene {master_scene_id} now has merged file.")

# ---------------------------------------------------------------------------
# FFmpeg helpers
# ---------------------------------------------------------------------------

def find_ffmpeg():
    candidates = [
        shutil.which("ffmpeg"),
        os.path.expanduser("~/.stash/ffmpeg"),
        os.path.expanduser("~/.stash/ffmpeg.exe"),
        "/usr/local/bin/ffmpeg",
        "/usr/bin/ffmpeg",
    ]
    for c in candidates:
        if c and os.path.isfile(c):
            return c
    return None

def find_ffprobe(ffmpeg_path):
    candidates = [
        shutil.which("ffprobe"),
        re.sub(r'(?i)ffmpeg(\.exe)?$', lambda m: f'ffprobe{m.group(1) or ""}', ffmpeg_path),
    ]
    for c in candidates:
        if c and os.path.isfile(c):
            return c
    return None

def get_duration(ffprobe, path):
    cmd = [ffprobe, "-v", "quiet", "-print_format", "json", "-show_format", path]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        return None
    try:
        return float(json.loads(result.stdout)["format"]["duration"])
    except Exception:
        return None

def validate_output(ffprobe, output_path, input_paths, tolerance_secs=5):
    if not ffprobe:
        return False, "ffprobe not found -- cannot validate."
    out_dur = get_duration(ffprobe, output_path)
    if out_dur is None:
        return False, f"Output file failed ffprobe validation (may be corrupt): {output_path}"
    total_input, missing = 0.0, []
    for p in input_paths:
        d = get_duration(ffprobe, p)
        if d is None:
            missing.append(p)
        else:
            total_input += d
    if missing:
        return False, f"Could not read duration of: {missing}"
    diff = abs(out_dur - total_input)
    if diff > tolerance_secs:
        return False, (
            f"Duration mismatch: output {out_dur:.1f}s vs inputs {total_input:.1f}s "
            f"(diff {diff:.1f}s > tolerance {tolerance_secs}s). Originals NOT deleted."
        )
    return True, f"Output validated: {out_dur:.1f}s (inputs {total_input:.1f}s, diff {diff:.1f}s)."

def build_filelist(file_paths, tmp_dir):
    filelist_path = os.path.join(tmp_dir, "filelist.txt")
    with open(filelist_path, "w", encoding="utf-8") as f:
        for p in file_paths:
            safe = p.replace("\\", "/").replace("'", "\\'")
            f.write(f"file '{safe}'\n")
    return filelist_path

def run_ffmpeg_concat(ffmpeg, filelist_path, output_path, re_encode=False):
    global _ffmpeg_proc
    if re_encode:
        cmd = [ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", filelist_path,
               "-c:v", "libx264", "-preset", "fast", "-crf", "18",
               "-c:a", "aac", "-b:a", "192k", output_path]
    else:
        cmd = [ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", filelist_path,
               "-c", "copy", output_path]
    log(f"Running: {' '.join(cmd)}")
    _ffmpeg_proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    stdout, stderr = _ffmpeg_proc.communicate()
    returncode = _ffmpeg_proc.returncode
    _ffmpeg_proc = None
    return returncode == 0, stderr.decode("utf-8", errors="replace")

# ---------------------------------------------------------------------------
# Output filename logic
# ---------------------------------------------------------------------------

def tokenize(s):
    return re.findall(r'[A-Za-z0-9]+|[^A-Za-z0-9]+', s)

def replace_variant_token(vals):
    min_len = min(len(v) for v in vals)
    p = 0
    while p < min_len and len(set(v[p] for v in vals)) == 1:
        p += 1
    prefix = vals[0][:p]
    s = 0
    while s < min_len and len(set(v[-(s+1)] for v in vals)) == 1:
        s += 1
    suffix = vals[0][len(vals[0])-s:] if s else ''
    trimmed_prefix = prefix.rstrip('0123456789')
    kept_len = len(trimmed_prefix) + len(suffix)
    removed  = len(vals[0]) - kept_len
    x_count  = min(max(removed, 1), 3)
    return trimmed_prefix + ('X' * x_count) + suffix

def derive_variant_name(file_paths):
    bases = [os.path.splitext(os.path.basename(p))[0] for p in file_paths]
    if len(bases) == 1:
        return bases[0]
    tokenized = [tokenize(b) for b in bases]
    min_tok   = min(len(t) for t in tokenized)
    tokenized = [t[:min_tok] for t in tokenized]
    result_parts = []
    for i in range(min_tok):
        vals     = [t[i] for t in tokenized]
        is_sep   = bool(re.match(r'^[^A-Za-z0-9]+$', vals[0]))
        all_same = len(set(vals)) == 1
        if all_same or is_sep:
            result_parts.append(vals[0])
        else:
            result_parts.append(replace_variant_token(vals))
    result = ''.join(result_parts)
    result = re.sub(r'[ _\-\.]{2,}', lambda m: m.group()[0], result)
    return result.strip(' _-.')

def sanitise(s):
    if not s:
        return ""
    return re.sub(r'[\\/:*?"<>|]', '', s).strip()

def get_video_info_ffprobe(ffprobe, file_path):
    if not ffprobe:
        return None, None
    cmd = [ffprobe, "-v", "quiet", "-print_format", "json",
           "-show_streams", "-select_streams", "v:0", file_path]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        return None, None
    try:
        streams = json.loads(result.stdout).get("streams", [])
        if streams:
            st = streams[0]
            return st.get("codec_name"), st.get("height")
    except Exception:
        pass
    return None, None

def build_output_path(output_dir, file_paths, scene=None, ffprobe=None):
    ext = os.path.splitext(file_paths[0])[1] or ".mp4"
    if scene:
        parts = []
        studio = sanitise((scene.get("studio") or {}).get("name", ""))
        if studio: parts.append(studio)
        date = sanitise(scene.get("date", "") or "")
        if date: parts.append(date)
        title = sanitise(scene.get("title", "") or "")
        if title: parts.append(title)
        performers = [sanitise(p["name"]) for p in (scene.get("performers") or []) if p.get("name")]
        if performers: parts.append(", ".join(performers))
        codec, height = get_video_info_ffprobe(ffprobe, file_paths[0])
        if not codec or not height:
            scene_files = scene.get("files", [])
            if scene_files:
                codec  = codec  or scene_files[0].get("video_codec") or ""
                height = height or scene_files[0].get("height") or ""
        if codec:  parts.append(sanitise(str(codec)))
        if height: parts.append(str(height))
        if len(parts) >= 3:
            name = ".".join(p for p in parts if p)
            log(f"Using metadata filename: {name}{ext}")
            return os.path.join(output_dir, name + ext)
    variant = derive_variant_name(file_paths)
    if len(variant) >= 2:
        log(f"Using variant filename: {variant}{ext}")
        return os.path.join(output_dir, variant + ext)
    fallback = os.path.splitext(os.path.basename(file_paths[0]))[0] + "_merged"
    return os.path.join(output_dir, fallback + ext)

def resolve_output_dir(file_paths, location_setting, override_path):
    if override_path:
        return override_path.strip()
    setting = (location_setting or "first").strip().lower()
    if setting == "last":
        return os.path.dirname(file_paths[-1])
    elif setting == "parent":
        return os.path.dirname(os.path.dirname(file_paths[0]))
    else:
        return os.path.dirname(file_paths[0])

# ---------------------------------------------------------------------------
# Shared encode + validate logic
# ---------------------------------------------------------------------------

def encode_and_validate(file_paths, output_path, re_encode_fallback, ffmpeg, ffprobe):
    """Run ffmpeg concat, validate output. Returns True on success."""
    global _partial_output
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    _partial_output = output_path

    tmp_dir = tempfile.mkdtemp(prefix="stash_concat_")
    try:
        filelist = build_filelist(file_paths, tmp_dir)
        log("Attempting lossless concat (-c copy)...")
        success, stderr_txt = run_ffmpeg_concat(ffmpeg, filelist, output_path, re_encode=False)

        if not success:
            if re_encode_fallback:
                log("Lossless failed. Re-encoding with libx264/aac...")
                success, stderr_txt = run_ffmpeg_concat(ffmpeg, filelist, output_path, re_encode=True)
            else:
                err("Lossless concat failed. Enable Re-encode option in settings.")
                err(f"FFmpeg stderr:\n{stderr_txt}")
                if os.path.isfile(output_path): os.remove(output_path)
                return False

        if not success:
            err(f"Re-encode also failed.\n{stderr_txt}")
            if os.path.isfile(output_path): os.remove(output_path)
            return False
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    _partial_output = None
    log(f"Merged file created: {output_path}")

    log("Validating merged file...")
    valid, msg = validate_output(ffprobe, output_path, file_paths)
    log(msg)
    if not valid:
        err("Validation failed -- originals NOT deleted.")
        return False

    return True

# ---------------------------------------------------------------------------
# Main merge tasks
# ---------------------------------------------------------------------------

def run_merge():
    scene_id      = str(args.get("scene_id", "")).strip()
    override_path = str(args.get("output_path", "")).strip()

    if not scene_id:
        err("No scene_id provided.")
        sys.exit(1)

    settings           = get_settings()
    location_setting   = settings.get("outputLocation", "first")
    re_encode_fallback = bool(settings.get("reEncode", False))

    log(f"Processing scene {scene_id}")
    scene = find_scene(scene_id)
    if not scene:
        err(f"Scene {scene_id} not found.")
        sys.exit(1)

    files = scene.get("files", [])
    if len(files) < 2:
        err(f"Scene {scene_id} has {len(files)} file(s) -- nothing to merge.")
        sys.exit(1)

    file_paths = [f["path"] for f in files]
    log(f"Files to merge ({len(file_paths)}):")
    for i, p in enumerate(file_paths):
        log(f"  [{i+1}] {p}")

    ffmpeg  = find_ffmpeg()
    ffprobe = find_ffprobe(ffmpeg) if ffmpeg else None
    if not ffmpeg: err("ffmpeg not found."); sys.exit(1)
    log(f"Using ffmpeg: {ffmpeg}")
    if ffprobe: log(f"Using ffprobe: {ffprobe}")

    output_dir  = resolve_output_dir(file_paths, location_setting, override_path)
    output_path = build_output_path(output_dir, file_paths, scene=scene, ffprobe=ffprobe)
    log(f"Output path: {output_path}")

    if not encode_and_validate(file_paths, output_path, re_encode_fallback, ffmpeg, ffprobe):
        sys.exit(1)

    phase1_cleanup(output_path, scene_id, file_paths)

    log("Phase 1 complete. Scan queued -- hook will complete the merge when scan finishes.")
    print(json.dumps({"output": f"Encoded to: {output_path}. Scan queued for Phase 2."}))


VIDEO_EXTENSIONS = {
    ".mp4", ".m4v", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm",
    ".ts", ".mts", ".m2ts", ".mpg", ".mpeg", ".ogv", ".3gp", ".3g2"
}

def get_video_files_in_folder(folder_path):
    try:
        files = [
            os.path.join(folder_path, f)
            for f in os.listdir(folder_path)
            if os.path.isfile(os.path.join(folder_path, f))
            and os.path.splitext(f)[1].lower() in VIDEO_EXTENSIONS
        ]
        try:
            import natsort
            return natsort.natsorted(files)
        except ImportError:
            def nat_key(p):
                parts = re.split(r"(\d+)", os.path.basename(p).lower())
                return [int(x) if x.isdigit() else x for x in parts]
            return sorted(files, key=nat_key)
    except OSError as e:
        raise RuntimeError(f"Cannot list folder {folder_path}: {e}")


def run_merge_folder():
    folder_path   = str(args.get("folder_path", "")).strip()
    scene_id      = str(args.get("scene_id", "")).strip()
    override_path = str(args.get("output_path", "")).strip()

    if not folder_path or not os.path.isdir(folder_path):
        err(f"Invalid folder path: {folder_path}")
        sys.exit(1)

    settings           = get_settings()
    re_encode_fallback = bool(settings.get("reEncode", False))

    log(f"Folder merge: {folder_path}")
    file_paths = get_video_files_in_folder(folder_path)
    if len(file_paths) < 2:
        err(f"Only {len(file_paths)} video file(s) found -- nothing to merge.")
        sys.exit(1)

    log(f"Files to merge ({len(file_paths)}):")
    for i, p in enumerate(file_paths):
        log(f"  [{i+1}] {p}")

    ffmpeg  = find_ffmpeg()
    ffprobe = find_ffprobe(ffmpeg) if ffmpeg else None
    if not ffmpeg: err("ffmpeg not found."); sys.exit(1)
    log(f"Using ffmpeg: {ffmpeg}")
    if ffprobe: log(f"Using ffprobe: {ffprobe}")

    anchor_scene = find_scene(scene_id) if scene_id else None
    output_dir   = override_path.strip() if override_path else folder_path
    output_path  = build_output_path(output_dir, file_paths, scene=anchor_scene, ffprobe=ffprobe)
    log(f"Output path: {output_path}")

    if not encode_and_validate(file_paths, output_path, re_encode_fallback, ffmpeg, ffprobe):
        sys.exit(1)

    if scene_id:
        phase1_cleanup(output_path, scene_id, file_paths)
        log("Phase 1 complete. Scan queued -- hook will complete the merge when scan finishes.")
    else:
        log("No anchor scene -- triggering scan only (fire and forget).")
        try:
            trigger_scan(output_dir)
        except Exception as e:
            err(f"Scan trigger failed: {e}")

    log("Done.")
    print(json.dumps({"output": f"Encoded to: {output_path}. Scan queued for Phase 2."}))

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if hook_context:
    # Fired by Scene.Create.Post hook
    run_post_scan_hook()
elif mode == "merge":
    run_merge()
elif mode == "merge_folder":
    run_merge_folder()
else:
    err(f"Unknown mode: '{mode}'")
    sys.exit(1)
