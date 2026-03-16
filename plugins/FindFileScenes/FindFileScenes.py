#!/usr/bin/env python3
"""
FindFileScenes - Stash Plugin
Given a file path, find all Stash scenes that contain that file.
"""

import sys
import json
import os
import requests

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

def _log(msg, level="INFO"):
    print(f"[FindFileScenes][{level}] {msg}", file=sys.stderr, flush=True)

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
# Query
# ---------------------------------------------------------------------------

FIND_SCENES_QUERY = """
query FindScenesByPath($path: String!) {
  findScenes(
    scene_filter: { path: { value: $path, modifier: INCLUDES } }
    filter: { per_page: -1 }
  ) {
    count
    scenes {
      id
      title
      date
      studio { name }
      performers { name }
      files { id path basename }
    }
  }
}
"""

def norm(p):
    return p.replace("\\", "/").lower()

def find_scenes_for_file(file_path):
    """
    Find all scenes containing the given exact file path.
    Queries by basename, then verifies full path client-side.
    """
    basename  = os.path.basename(file_path)
    norm_path = norm(file_path)

    data       = gql(FIND_SCENES_QUERY, {"path": basename})
    all_scenes = data.get("findScenes", {}).get("scenes", [])

    matched = []
    for scene in all_scenes:
        for f in scene.get("files", []):
            if norm(f["path"]) == norm_path:
                matched.append(scene)
                break
    return matched

def find_scenes_for_folder(folder_path):
    """
    Find all scenes that have at least one file anywhere under folder_path
    (recursive — matches all subfolders too).
    Queries by folder basename, then verifies prefix client-side.
    """
    folder_name = os.path.basename(folder_path.rstrip("/\\"))
    norm_prefix = norm(folder_path).rstrip("/") + "/"

    data       = gql(FIND_SCENES_QUERY, {"path": folder_name})
    all_scenes = data.get("findScenes", {}).get("scenes", [])

    matched = []
    for scene in all_scenes:
        for f in scene.get("files", []):
            if norm(f["path"]).startswith(norm_prefix):
                matched.append(scene)
                break
    return matched

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

file_path = str(args.get("file_path", "")).strip()

if not file_path:
    err("No file_path provided.")
    print(json.dumps({"error": "No file_path provided."}))
    sys.exit(1)

VIDEO_EXTS = {".mp4",".m4v",".mkv",".avi",".mov",".wmv",".flv",".webm",
              ".ts",".mts",".m2ts",".mpg",".mpeg",".ogv",".3gp",".3g2"}

is_file = os.path.splitext(file_path)[1].lower() in VIDEO_EXTS
mode    = "file" if is_file else "folder"

log(f"Mode: {mode} — path: {file_path}")

try:
    if is_file:
        scenes = find_scenes_for_file(file_path)
    else:
        scenes = find_scenes_for_folder(file_path)
except Exception as e:
    err(f"Query failed: {e}")
    print(json.dumps({"error": str(e)}))
    sys.exit(1)

if not scenes:
    log("No scenes found.")
    print(json.dumps({"count": 0, "scenes": [], "file_path": file_path, "mode": mode}))
    sys.exit(0)

log(f"Found {len(scenes)} scene(s):")
for s in scenes:
    title      = s.get("title") or "(no title)"
    date       = s.get("date") or ""
    studio     = (s.get("studio") or {}).get("name", "")
    performers = ", ".join(p["name"] for p in (s.get("performers") or []))
    log(f"  [{s['id']}] {title} | {date} | {studio} | {performers}")

print(json.dumps({
    "count":     len(scenes),
    "file_path": file_path,
    "mode":      mode,
    "scenes":    [
        {
            "id":         s["id"],
            "title":      s.get("title") or "",
            "date":       s.get("date") or "",
            "studio":     (s.get("studio") or {}).get("name", ""),
            "performers": [p["name"] for p in (s.get("performers") or [])],
            "files":      [f["path"] for f in s.get("files", [])],
        }
        for s in scenes
    ]
}))
