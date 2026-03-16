#!/usr/bin/env python3
"""
SceneMover - Stash Plugin
Moves/renames scene files based on ordered rules and per-root path templates.
Updates Stash file paths after moving so scenes stay intact.
"""

import sys
import json
import os
import re
import shutil
import subprocess
import requests

PLUGIN_DIR   = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE  = os.path.join(PLUGIN_DIR, "SceneMover.json")

DEFAULT_CONFIG = {"roots": [], "rules": []}

def ensure_config_exists():
    if not os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(DEFAULT_CONFIG, f, indent=2)

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

def log(msg):
    print(f"[SceneMover] {msg}", file=sys.stderr, flush=True)

def warn(msg):
    print(f"[SceneMover][WARN] {msg}", file=sys.stderr, flush=True)

def err(msg):
    print(f"[SceneMover][ERROR] {msg}", file=sys.stderr, flush=True)

# ---------------------------------------------------------------------------
# Plugin input
# ---------------------------------------------------------------------------

raw = sys.stdin.read()
try:
    plugin_input = json.loads(raw)
except json.JSONDecodeError as e:
    err(f"Failed to parse plugin input: {e}")
    sys.exit(1)

ensure_config_exists()
server = plugin_input.get("server_connection", {})
args   = plugin_input.get("args", {})
mode   = args.get("mode", "")

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
# Config
# ---------------------------------------------------------------------------

def load_config():
    ensure_config_exists()
    with open(CONFIG_FILE, "r", encoding="utf-8") as f:
        return json.load(f)

def save_config(config):
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)

# ---------------------------------------------------------------------------
# GraphQL queries
# ---------------------------------------------------------------------------

FIND_SCENES_IN_FOLDER_QUERY = """
query FindScenesInFolder($path: String!) {
  findScenes(
    scene_filter: { path: { value: $path, modifier: INCLUDES } }
    filter: { per_page: -1 }
  ) {
    count
    scenes {
      id title date code
      studio { name }
      performers { name favorite }
      tags { name }
      files { id path basename video_codec height }
    }
  }
}
"""

FIND_SCENE_QUERY = """
query FindScene($id: ID!) {
  findScene(id: $id) {
    id title date code
    studio { name }
    performers { name favorite }
    tags { name }
    files { id path basename video_codec height }
  }
}
"""

MOVE_FILE_MUTATION = """
mutation MoveFiles($input: MoveFilesInput!) {
  moveFiles(input: $input)
}
"""

# Input field is destination_folder (not destination)

def find_scenes_in_folder(folder_path):
    basename = os.path.basename(folder_path.rstrip("/\\"))
    data = gql(FIND_SCENES_IN_FOLDER_QUERY, {"path": basename})
    all_scenes = data.get("findScenes", {}).get("scenes", [])

    norm_folder = folder_path.replace("\\", "/").lower()
    result = []
    for scene in all_scenes:
        for f in scene.get("files", []):
            file_dir = os.path.dirname(f["path"]).replace("\\", "/").lower()
            # include files in this folder or any subfolder
            if file_dir.startswith(norm_folder):
                result.append(scene)
                break
    return result

def find_scene(scene_id):
    return gql(FIND_SCENE_QUERY, {"id": str(scene_id)}).get("findScene")

def move_file_in_stash(file_id, dest_folder, dest_basename):
    """Use Stash's moveFiles mutation to update the path and move on disk."""
    log(f"  moveFiles: file_id={file_id} dest_folder={dest_folder} basename={dest_basename}")
    gql(MOVE_FILE_MUTATION, {
        "input": {
            "ids":                  [str(file_id)],
            "destination_folder":   dest_folder,
            "destination_basename": dest_basename,
        }
    })

# ---------------------------------------------------------------------------
# Rule evaluation
# ---------------------------------------------------------------------------

def get_favourite_performers(scene):
    return sorted(
        [p["name"] for p in scene.get("performers", []) if p.get("favorite")],
        key=str.lower
    )

def scene_matches_rule(scene, rule):
    condition = rule.get("condition", "")
    value     = rule.get("value", "").strip().lower()

    if condition == "performer_is_favourite":
        return len(get_favourite_performers(scene)) > 0

    elif condition == "studio_equals":
        studio = (scene.get("studio") or {}).get("name", "").strip().lower()
        return studio == value

    elif condition == "studio_contains":
        studio = (scene.get("studio") or {}).get("name", "").strip().lower()
        return value in studio

    elif condition == "tag_equals":
        tags = [t["name"].strip().lower() for t in scene.get("tags", [])]
        return value in tags

    elif condition == "performer_equals":
        names = [p["name"].strip().lower() for p in scene.get("performers", [])]
        return value in names

    return False

def resolve_root(scene, config):
    """
    Evaluate rules in order (index 0 = highest priority).
    Returns the matching root dict, or the default root if no rule matches.
    """
    rules = [r for r in config.get("rules", []) if r.get("enabled", True)]
    roots = {r["id"]: r for r in config.get("roots", [])}

    for rule in rules:
        if scene_matches_rule(scene, rule):
            root_id = rule.get("rootId")
            if root_id in roots:
                log(f"  Scene '{scene.get('title')}' matched rule '{rule.get('label')}' → {roots[root_id]['path']}")
                return roots[root_id]

    # Fall back to default root
    for root in config.get("roots", []):
        if root.get("isDefault"):
            log(f"  Scene '{scene.get('title')}' matched no rule → default {root['path']}")
            return root

    return None

# ---------------------------------------------------------------------------
# Template rendering
# ---------------------------------------------------------------------------

def sanitise(s):
    if not s:
        return ""
    return re.sub(r'[\\/:*?"<>|]', '', str(s)).strip()

def get_video_info(file_rec):
    """Extract codec and height from the scene file record."""
    return (
        sanitise(file_rec.get("video_codec") or ""),
        str(file_rec.get("height") or ""),
    )

def render_template(template, scene, file_rec, config):
    """
    Expand template tokens. Handles both path separators (/ and \\).
    Tokens: {studio} {date} {yyyy-MM} {yyyy-MM-dd} {title} {performers}
            {favoritedPerformer} {codec} {height} {ext} {scene_id}
    scene_id = studio code (scene.code); empty string if not set.
    """
    studio     = sanitise((scene.get("studio") or {}).get("name", ""))
    date       = scene.get("date") or ""
    title      = sanitise(scene.get("title") or "")
    performers = [sanitise(p["name"]) for p in scene.get("performers", []) if p.get("name")]
    fav_perfs  = get_favourite_performers(scene)
    codec, height = get_video_info(file_rec)
    ext        = os.path.splitext(file_rec.get("basename", "") or file_rec.get("path", ""))[1].lstrip(".")
    code       = sanitise(scene.get("code") or "")
    scene_id   = code if len(code) < 10 else ""

    # Date parts
    yyyy_mm_dd = sanitise(date)
    yyyy_mm    = date[:7] if len(date) >= 7 else ""
    yyyy       = date[:4] if len(date) >= 4 else ""

    fav_name     = sanitise(fav_perfs[0]) if fav_perfs else (sanitise(performers[0]) if performers else "")
    mm_dd        = date[5:] if len(date) >= 10 else ""

    tokens = {
        "studio":                        studio,
        "studioFirstLetter":             studio[0].upper() if studio else "",
        "studioInitial":                 studio[0].upper() if studio else "",
        "date":                          yyyy_mm_dd,
        "yyyy-MM-dd":                    yyyy_mm_dd,
        "yyyy-MM":                       yyyy_mm,
        "yyyy":                          yyyy,
        "MM-dd":                         mm_dd,
        "title":                         title,
        "performers":                    ", ".join(performers),
        "favoritedPerformer":            fav_name,
        "favoritedPerformerFirstLetter": fav_name[:1].upper() if fav_name else "",
        "favoritedPerformerInitial":     fav_name[:1].upper() if fav_name else "",
        "codec":                         codec,
        "height":                        height,
        "ext":                           ext,
        "scene_id":                      scene_id,
    }

    result = template
    for key, val in tokens.items():
        result = result.replace("{" + key + "}", val)

    # Clean up double separators from empty tokens
    result = re.sub(r'[\\/]{2,}', lambda m: m.group()[0], result)
    result = re.sub(r'[\\/]$', '', result)  # trailing separator
    result = re.sub(r'\.{2,}', '.', result)  # collapse multiple dots
    result = result.strip('. ')

    return result

def build_destination(root, scene, file_rec, config):
    """
    Returns (dest_folder, dest_basename) for a given scene file.
    Handles conflict resolution with _2, _3 suffixes.
    """
    template = root.get("template", "{studio}.{date}.{title}.{ext}")
    rendered = render_template(template, scene, file_rec, config)

    # Split into folder and filename
    # The template may contain path separators — the last component is the filename
    parts = rendered.replace("\\", "/").split("/")
    filename = parts[-1]
    subpath  = "/".join(parts[:-1]) if len(parts) > 1 else ""

    root_path   = root["path"].rstrip("\\/")
    dest_folder = os.path.join(root_path, subpath.replace("/", os.sep)) if subpath else root_path

    # Ensure filename has extension
    if "." not in filename.split("\\")[-1].split("/")[-1]:
        ext = os.path.splitext(file_rec.get("path", ""))[1]
        filename += ext

    # Conflict resolution: append _2, _3, etc.
    # But skip if the file already at dest_path IS the source file — it's already correct.
    base, ext2 = os.path.splitext(filename)
    dest_path  = os.path.join(dest_folder, filename)
    src_path   = file_rec.get("path", "")
    if not (os.path.exists(dest_path) and
            os.path.normcase(os.path.normpath(dest_path)) == os.path.normcase(os.path.normpath(src_path))):
        counter = 2
        while os.path.exists(dest_path):
            filename  = f"{base}_{counter}{ext2}"
            dest_path = os.path.join(dest_folder, filename)
            counter  += 1

    return dest_folder, filename

# ---------------------------------------------------------------------------
# Core: plan moves for a list of scenes
# ---------------------------------------------------------------------------

def validate_scene(scene, root):
    """Check required template tokens have values. Returns skip reason or None."""
    template = root.get("template", "")
    token_values = {
        "{studio}":             (scene.get("studio") or {}).get("name", "").strip(),
        "{studioFirstLetter}":  (scene.get("studio") or {}).get("name", "").strip(),
        "{studioInitial}":      (scene.get("studio") or {}).get("name", "").strip(),
        "{favoritedPerformerInitial}": ", ".join(p["name"] for p in scene.get("performers", []) if p.get("favorite")),
        "{title}":              (scene.get("title") or "").strip(),
        "{performers}":         ", ".join(p["name"] for p in scene.get("performers", []) if p.get("name")),
        "{favoritedPerformer}": ", ".join(p["name"] for p in scene.get("performers", []) if p.get("favorite")),
        "{date}":               (scene.get("date") or "").strip(),
        "{yyyy}":               (scene.get("date") or "").strip(),
        "{yyyy-MM}":            (scene.get("date") or "").strip(),
        "{yyyy-MM-dd}":         (scene.get("date") or "").strip(),
        "{MM-dd}":              (scene.get("date") or "").strip(),
    }
    missing = [t for t, v in token_values.items() if t in template and not v]
    return f"Missing: {', '.join(missing)}" if missing else None


def clean_rendered(s):
    """Tidy up artifacts left by empty optional tokens."""
    # Collapse multiple dots
    s = re.sub(r'\.{2,}', '.', s)
    # Collapse multiple spaces
    s = re.sub(r' {2,}', ' ', s)
    # Strip leading/trailing dots and spaces from each path component
    sep = s[2] if len(s) > 2 and s[1] == ':' else s[0] if s and s[0] in '/\\' else None
    parts = s.replace('\\', '/').split('/')
    parts = [p.strip('. ') if i > 0 else p for i, p in enumerate(parts)]
    parts = [p for p in parts if p]
    return '\\'.join(parts) if '\\' in s else '/'.join(parts)


WIN_MAX_PATH = 259  # Windows MAX_PATH minus null terminator

def fit_to_max_path(dest_folder, dest_basename, scene, file_rec, root, config):
    """
    If the full destination path exceeds WIN_MAX_PATH, shorten the rendered
    filename by trimming {title} first, then {performers} if needed.
    Returns (dest_folder, dest_basename) that fits within the limit.
    """
    full_path = os.path.join(dest_folder, dest_basename)
    if len(full_path) <= WIN_MAX_PATH:
        return dest_folder, dest_basename

    template   = root.get("template", "")
    studio     = sanitise((scene.get("studio") or {}).get("name", ""))
    date       = scene.get("date") or ""
    performers = [sanitise(p["name"]) for p in scene.get("performers", []) if p.get("name")]
    fav_perfs  = get_favourite_performers(scene)
    codec, height = get_video_info(file_rec)
    ext        = os.path.splitext(file_rec.get("basename", "") or file_rec.get("path", ""))[1].lstrip(".")
    fav_name   = sanitise(fav_perfs[0]) if fav_perfs else (sanitise(performers[0]) if performers else "")
    title_full = sanitise(scene.get("title") or "")
    perfs_full = ", ".join(performers)

    def try_build(title_val, perfs_val):
        tokens = {
            "studio": studio, "studioFirstLetter": studio[0].upper() if studio else "",
            "studioInitial": studio[0].upper() if studio else "",
            "date": sanitise(date), "yyyy-MM-dd": sanitise(date),
            "yyyy-MM": date[:7] if len(date) >= 7 else "",
            "yyyy": date[:4] if len(date) >= 4 else "",
            "MM-dd": date[5:] if len(date) >= 10 else "",
            "title": title_val, "performers": perfs_val,
            "favoritedPerformer": fav_name,
            "favoritedPerformerFirstLetter": fav_name[:1].upper() if fav_name else "",
            "favoritedPerformerInitial": fav_name[:1].upper() if fav_name else "",
            "codec": codec, "height": height, "ext": ext,
            "scene_id": (lambda c: c if len(c) < 10 else "")(sanitise(scene.get("code") or "")),
        }
        result = template
        for key, val in tokens.items():
            result = result.replace("{" + key + "}", val)
        result = re.sub(r'[\\/]{2,}', lambda m: m.group()[0], result)
        result = re.sub(r'[\\/]$', '', result)
        result = re.sub(r'\.{2,}', '.', result).strip('. ')
        parts  = result.replace("\\", "/").split("/")
        fname  = clean_rendered(parts[-1])
        sub    = "/".join(parts[:-1]) if len(parts) > 1 else ""
        folder = os.path.join(root["path"].rstrip("\\/"), sub.replace("/", os.sep)) if sub else root["path"].rstrip("\\/")
        return folder, fname

    # Step 1: trim title
    overflow = len(full_path) - WIN_MAX_PATH
    title_trimmed = title_full[:max(0, len(title_full) - overflow)].rstrip()
    folder, basename = try_build(title_trimmed, perfs_full)
    full_path = os.path.join(folder, basename)

    if len(full_path) <= WIN_MAX_PATH:
        if title_trimmed != title_full:
            log(f"  Path too long: trimmed title to {len(title_trimmed)} chars")
        return folder, basename

    # Step 2: title is empty, now trim performers
    overflow = len(full_path) - WIN_MAX_PATH
    perfs_trimmed = perfs_full[:max(0, len(perfs_full) - overflow)].rstrip()
    folder, basename = try_build("", perfs_trimmed)
    log(f"  Path still too long: trimmed title fully and performers to {len(perfs_trimmed)} chars")
    return folder, basename


def plan_moves(scenes, config):
    """
    Returns a list of move plan dicts:
      { scene_id, scene_title, file_id, src_path, dest_folder, dest_basename, skip_reason }
    skip_reason is None if the move should proceed.
    """
    plans = []
    for scene in scenes:
        root = resolve_root(scene, config)
        if not root:
            for f in scene.get("files", []):
                plans.append({
                    "scene_id":      scene["id"],
                    "scene_title":   scene.get("title") or "",
                    "file_id":       f["id"],
                    "src_path":      f["path"],
                    "dest_folder":   None,
                    "dest_basename": None,
                    "skip_reason":   "No matching root and no default defined",
                })
            continue

        for f in scene.get("files", []):
            validation_err = validate_scene(scene, root)
            if validation_err:
                plans.append({
                    "scene_id":      scene["id"],
                    "scene_title":   scene.get("title") or "",
                    "file_id":       f["id"],
                    "src_path":      f["path"],
                    "dest_folder":   None,
                    "dest_basename": None,
                    "skip_reason":   validation_err,
                })
                continue

            dest_folder, dest_basename = build_destination(root, scene, f, config)
            dest_folder   = clean_rendered(dest_folder)
            dest_basename = clean_rendered(dest_basename)
            dest_folder, dest_basename = fit_to_max_path(dest_folder, dest_basename, scene, f, root, config)
            dest_path = os.path.join(dest_folder, dest_basename)
            src_norm  = f["path"].replace("\\", "/").lower()
            dst_norm  = dest_path.replace("\\", "/").lower()

            skip_reason = None
            if src_norm == dst_norm:
                skip_reason = "Already in correct location"
            elif path_exists(dest_path):
                # Destination exists on disk — but it might BE the source file
                # (e.g. manually moved outside Stash, or Stash path out of sync).
                # If the source no longer exists on disk, the file is already there.
                if not path_exists(f["path"]):
                    skip_reason = "Already in correct location (source gone, file already at destination)"
                else:
                    skip_reason = f"Destination already exists on disk: {dest_path}"
            else:
                # Check if another file on this same scene is already at the destination
                for other in scene.get("files", []):
                    if other["id"] == f["id"]:
                        continue
                    other_norm = other["path"].replace("\\", "/").lower()
                    if other_norm == dst_norm:
                        skip_reason = f"Scene already has a file at destination: {dest_path}"
                        break
                # Check if a different scene in Stash already tracks a file at the destination
                if not skip_reason and stash_has_file_at(dest_path):
                    skip_reason = f"Another scene already has a file at destination: {dest_path}"

            plans.append({
                "scene_id":      scene["id"],
                "scene_title":   scene.get("title") or "",
                "file_id":       f["id"],
                "src_path":      f["path"],
                "dest_folder":   dest_folder,
                "dest_basename": dest_basename,
                "skip_reason":   skip_reason,
            })

    return plans

# ---------------------------------------------------------------------------
# Execute moves
# ---------------------------------------------------------------------------

def path_exists(path):
    """os.path.exists silently returns False for paths > 260 chars on Windows.
    Use the \\\\?\\\\ prefix to bypass MAX_PATH."""
    if os.name == "nt" and len(path) > 240:
        long_path = "\\\\?\\" + os.path.abspath(path)
        return os.path.exists(long_path)
    return os.path.exists(path)

def stash_has_file_at(path):
    """Check if Stash's DB already tracks any file at this path (any scene)."""
    try:
        norm = path.replace("\\", "/")
        result = gql(
            'query($p:String!){findScenes(scene_filter:{path:{value:$p,modifier:EQUALS}},filter:{per_page:1}){count}}',
            {"p": norm}
        )
        return (result.get("findScenes") or {}).get("count", 0) > 0
    except Exception:
        return False


def cleanup_empty_dirs(path, config):
    """
    Walk up from path removing empty directories.
    Stops at a configured root folder or if a directory is non-empty.
    """
    # Collect root paths to use as stop boundaries
    root_paths = set()
    for r in config.get("roots", []):
        p = r.get("path", "").strip()
        if p:
            root_paths.add(os.path.normcase(os.path.normpath(p)))

    folder = os.path.normpath(path)
    while True:
        norm = os.path.normcase(folder)
        # Stop at a library root
        if norm in root_paths:
            break
        # Stop if folder doesn't exist or isn't empty
        if not os.path.isdir(folder):
            break
        if os.listdir(folder):
            break
        try:
            os.rmdir(folder)
            log(f"  Removed empty folder: {folder}")
        except Exception as e:
            warn(f"  Could not remove folder {folder}: {e}")
            break
        parent = os.path.dirname(folder)
        if parent == folder:  # reached drive root
            break
        folder = parent


def _find_actual_path(file_id):
    """Query Stash for the current path of a file by its file ID.
    Used to detect if moveFiles silently appended _2 to the basename."""
    try:
        data = gql(
            "query($id:ID!){findFile(id:$id){... on VideoFile{id path}}}",
            {"id": str(file_id)}
        )
        f = data.get("findFile")
        if f:
            return f.get("path")
    except Exception as e:
        warn(f"  Could not fetch actual path for file {file_id}: {e}")
    return None


def apply_moves(plans, config):
    results = []
    for plan in plans:
        if plan["skip_reason"]:
            log(f"Skip: {plan['src_path']}  ({plan['skip_reason']})")
            results.append({**plan, "status": "skipped"})
            continue

        dest_folder   = plan["dest_folder"]
        dest_basename = plan["dest_basename"]
        src_path      = plan["src_path"]
        src_folder    = os.path.dirname(src_path)
        dest_path     = os.path.join(dest_folder, dest_basename)

        log(f"  MOVE [{plan['scene_id']}] {src_path}")
        log(f"  To:   {dest_path}")

        try:
            same_folder = os.path.normcase(os.path.normpath(src_folder)) == \
                          os.path.normcase(os.path.normpath(dest_folder))

            # Check destination doesn't already exist (different file at that path)
            if os.path.exists(dest_path) and \
               os.path.normcase(os.path.normpath(src_path)) != os.path.normcase(os.path.normpath(dest_path)):
                err(f"  Skipped: destination already exists: {dest_path}")
                results.append({**plan, "status": "skipped", "skip_reason": f"Destination exists: {dest_path}"})
                continue

            if same_folder:
                # Same-folder rename: moveFiles sees the existing file as a conflict
                # and appends _2. Work around by moving to a temp subfolder first,
                # then moving to the final destination — Stash DB stays in sync throughout.
                tmp_folder = os.path.join(dest_folder, "_sm_tmp")
                os.makedirs(tmp_folder, exist_ok=True)
                log(f"  Rename via temp folder: {tmp_folder}")
                move_file_in_stash(plan["file_id"], tmp_folder, dest_basename)
                move_file_in_stash(plan["file_id"], dest_folder, dest_basename)
                try:
                    os.rmdir(tmp_folder)
                except Exception:
                    pass
                log(f"  Done: renamed via Stash")
            else:
                os.makedirs(dest_folder, exist_ok=True)
                move_file_in_stash(plan["file_id"], dest_folder, dest_basename)
                log(f"  Done: moved via Stash")

            # Stash sometimes appends _2 (or _3 etc.) to the basename when its internal
            # index sees a transient conflict during bulk moves — even when no real conflict
            # exists on disk. Detect this and correct it with a second moveFiles call.
            actual_path = _find_actual_path(plan["file_id"])
            if actual_path:
                actual_basename = os.path.basename(actual_path)
                if os.path.normcase(actual_basename) != os.path.normcase(dest_basename):
                    log(f"  Stash renamed to '{actual_basename}' — correcting back to '{dest_basename}'")
                    # Move via temp folder to avoid same-name conflict again
                    tmp_folder = os.path.join(dest_folder, "_sm_tmp")
                    os.makedirs(tmp_folder, exist_ok=True)
                    move_file_in_stash(plan["file_id"], tmp_folder, dest_basename)
                    move_file_in_stash(plan["file_id"], dest_folder, dest_basename)
                    try:
                        os.rmdir(tmp_folder)
                    except Exception:
                        pass
                    log(f"  Corrected.")

            results.append({**plan, "status": "moved"})
            cleanup_empty_dirs(src_folder, config)
        except Exception as e:
            err_str = str(e)
            if "already exists" in err_str.lower():
                log(f"  Skipped: destination already exists (path too long for os.path.exists or cross-scene conflict)")
                results.append({**plan, "status": "skipped", "skip_reason": "Destination already exists"})
            else:
                err(f"  Move failed: {e}")
                results.append({**plan, "status": "error", "error": err_str})

    return results

# ---------------------------------------------------------------------------
# Entry points
# ---------------------------------------------------------------------------

def run_preview():
    source_path = str(args.get("source_path", "")).strip()
    scene_id    = str(args.get("scene_id", "")).strip()
    config      = load_config()

    if scene_id:
        scene = find_scene(scene_id)
        scenes = [scene] if scene else []
    elif source_path:
        log(f"Scanning: {source_path}")
        scenes = find_scenes_in_folder(source_path)
        log(f"Found {len(scenes)} scene(s)")
    else:
        err("No source_path or scene_id provided.")
        sys.exit(1)

    plans = plan_moves(scenes, config)

    to_move   = [p for p in plans if not p["skip_reason"]]
    to_skip   = [p for p in plans if p["skip_reason"]]

    log(f"Preview complete: {len(to_move)} to move, {len(to_skip)} to skip")
    for p in to_move:
        dest = os.path.join(p["dest_folder"], p["dest_basename"])
        log(f"MOVE  {p['src_path']}")
        log(f"   -> {dest}")
    for p in to_skip:
        log(f"SKIP  {p['src_path']}")
        log(f"   -> {p['skip_reason']}")

    print(json.dumps({
        "preview":  True,
        "to_move":  len(to_move),
        "to_skip":  len(to_skip),
        "plans":    plans,
    }))

def run_apply():
    source_path = str(args.get("source_path", "")).strip()
    scene_id    = str(args.get("scene_id",    "")).strip()
    scene_ids   = str(args.get("scene_ids",   "")).strip()
    config      = load_config()

    if scene_ids:
        # Bulk: comma-separated list of IDs — process sequentially to avoid _2 rename conflicts
        ids    = [s.strip() for s in scene_ids.split(",") if s.strip()]
        scenes = []
        for sid in ids:
            scene = find_scene(sid)
            if scene:
                scenes.append(scene)
            else:
                err(f"Scene not found: {sid}")
        log(f"Bulk apply: {len(scenes)} scene(s)")
    elif scene_id:
        scene  = find_scene(scene_id)
        scenes = [scene] if scene else []
    elif source_path:
        log(f"Scanning: {source_path}")
        scenes = find_scenes_in_folder(source_path)
        log(f"Found {len(scenes)} scene(s)")
    else:
        err("No source_path, scene_id, or scene_ids provided.")
        sys.exit(1)

    plans   = plan_moves(scenes, config)
    results = apply_moves(plans, config)

    moved    = sum(1 for r in results if r["status"] in ("moved", "moved_fallback"))
    skipped  = sum(1 for r in results if r["status"] == "skipped")
    errors   = sum(1 for r in results if r["status"] == "error")

    log(f"Apply complete: {moved} moved, {skipped} skipped, {errors} errors")
    print(json.dumps({
        "moved":   moved,
        "skipped": skipped,
        "errors":  errors,
        "results": results,
    }))

def run_get_config():
    print(json.dumps(load_config()))

def run_save_config():
    config_json = args.get("config", "")
    log(f"save_config called, config arg length: {len(str(config_json))}")
    log(f"Writing to: {CONFIG_FILE}")
    try:
        if not config_json:
            err("config arg is empty — nothing to save")
            print(json.dumps({"ok": False, "error": "config arg empty"}))
            return
        if isinstance(config_json, str):
            config = json.loads(config_json)
        else:
            config = config_json
        save_config(config)
        log(f"Config saved OK. Roots: {len(config.get('roots',[]))}, Rules: {len(config.get('rules',[]))}")
        print(json.dumps({"ok": True}))
    except json.JSONDecodeError as e:
        err(f"Failed to parse config JSON: {e}")
        err(f"Raw value received: {repr(config_json[:200])}")
        print(json.dumps({"ok": False, "error": str(e)}))
    except Exception as e:
        err(f"Failed to write config file: {e}")
        print(json.dumps({"ok": False, "error": str(e)}))

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if mode == "preview":
    run_preview()
elif mode == "apply":
    run_apply()
elif mode == "get_config":
    run_get_config()
elif mode == "save_config":
    run_save_config()
else:
    err(f"Unknown mode: '{mode}'")
    sys.exit(1)
