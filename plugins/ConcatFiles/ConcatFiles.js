/**
 * ConcatFiles - Stash Plugin UI
 * Injects two buttons into the File Info tab:
 *   1. "Merge N Files" - merges files already attached to this scene
 *   2. "Merge All Files from Folder" - merges ALL video files in the primary
 *      file's folder, regardless of which scene they belong to
 */
// v2.1
(function () {
  "use strict";

  const PLUGIN_ID          = "ConcatFiles";
  const TASK_MERGE_SCENE   = "Merge Scene Files";
  const TASK_MERGE_FOLDER  = "Merge Folder Files";
  const CONTAINER_ID       = "concat-merge-container";

  const VIDEO_EXTS = new Set([
    "mp4","m4v","mkv","avi","mov","wmv","flv","webm",
    "ts","mts","m2ts","mpg","mpeg","ogv","3gp","3g2"
  ]);

  // ── GraphQL ────────────────────────────────────────────────────────────────

  async function gql(query, variables = {}) {
    const res = await fetch("/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.errors) throw new Error(data.errors.map((e) => e.message).join(", "));
    return data.data;
  }

  async function getScene(id) {
    const data = await gql(`
      query FindScene($id: ID!) {
        findScene(id: $id) {
          id title date
          studio { name }
          performers { name }
          files { id path basename video_codec height }
        }
      }
    `, { id });
    return data?.findScene;
  }

  async function getPluginSettings() {
    const data = await gql(`query { configuration { plugins } }`);
    return data?.configuration?.plugins?.[PLUGIN_ID] || {};
  }

  /** Find all scenes that have files in a given folder path */
  async function getScenesInFolder(folderPath) {
    // Stash path filter: find scenes whose file path starts with folderPath
    const data = await gql(`
      query FindScenesInPath($filter: SceneFilterType!) {
        findScenes(scene_filter: $filter, filter: { per_page: -1 }) {
          scenes {
            id title
            files { id path basename }
          }
        }
      }
    `, {
      filter: {
        path: { value: folderPath, modifier: "INCLUDES" }
      }
    });
    return data?.findScenes?.scenes || [];
  }

  function sanitisePart(s) {
    if (!s) return "";
    // Strip Windows-illegal chars, trim whitespace
    return s.replace(/[\\/:*?"<>|]/g, "").trim();
  }

  function predictFilename(scene, filePaths) {
    // Mirror the Python build_output_path metadata logic
    const ext = (filePaths[0] || "").match(/\.[^.]+$/)?.[0] || ".mp4";

    if (scene) {
      const parts = [];
      const studio = sanitisePart(scene.studio?.name || "");
      if (studio) parts.push(studio);

      const date = sanitisePart(scene.date || "");
      if (date) parts.push(date);

      const title = sanitisePart(scene.title || "");
      if (title) parts.push(title);

      const performers = (scene.performers || [])
        .map(p => sanitisePart(p.name || ""))
        .filter(Boolean);
      if (performers.length) parts.push(performers.join(", "));

      // Codec + height from first scene file (what Python gets from ffprobe fallback)
      const firstFile = (scene.files || [])[0];
      if (firstFile?.video_codec) parts.push(sanitisePart(firstFile.video_codec));
      if (firstFile?.height)      parts.push(String(firstFile.height));

      if (parts.length >= 3) {
        return parts.filter(Boolean).join(".") + ext;
      }
    }

    // Fallback: X/XX/XXX variant name from file basenames
    const bases = filePaths.map(p => p.replace(/\\/g, "/").split("/").pop().replace(/\.[^.]+$/, ""));
    if (bases.length < 2) return bases[0] + ext;

    // Tokenise and find variant positions
    const tokenize = s => s.match(/[A-Za-z0-9]+|[^A-Za-z0-9]+/g) || [];
    const tokenized = bases.map(tokenize);
    const minTok = Math.min(...tokenized.map(t => t.length));
    const trimmed = tokenized.map(t => t.slice(0, minTok));

    const resultParts = [];
    for (let i = 0; i < minTok; i++) {
      const vals = trimmed.map(t => t[i]);
      const isSep = /^[^A-Za-z0-9]+$/.test(vals[0]);
      const allSame = new Set(vals).size === 1;
      if (allSame || isSep) {
        resultParts.push(vals[0]);
      } else {
        // Find common prefix/suffix, strip trailing digits from prefix
        const minLen = Math.min(...vals.map(v => v.length));
        let p = 0;
        while (p < minLen && new Set(vals.map(v => v[p])).size === 1) p++;
        let prefix = vals[0].slice(0, p).replace(/\d+$/, "");
        let s = 0;
        while (s < minLen && new Set(vals.map(v => v[v.length - 1 - s])).size === 1) s++;
        const suffix = s ? vals[0].slice(vals[0].length - s) : "";
        const removed = vals[0].length - prefix.length - suffix.length;
        const xCount = Math.min(Math.max(removed, 1), 3);
        resultParts.push(prefix + "X".repeat(xCount) + suffix);
      }
    }

    let result = resultParts.join("").replace(/[ _\-.]{2,}/g, m => m[0]).replace(/^[ _\-.]+|[ _\-.]+$/g, "");
    return (result.length >= 2 ? result : bases[0] + "_merged") + ext;
  }

  async function runTask(taskName, taskArgs) {
    return gql(`
      mutation RunPluginTask($plugin_id: ID!, $task_name: String!, $args: [PluginArgInput!]) {
        runPluginTask(plugin_id: $plugin_id, task_name: $task_name, args: $args)
      }
    `, { plugin_id: PLUGIN_ID, task_name: taskName, args: taskArgs });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  function getSceneIdFromUrl() {
    const match = window.location.pathname.match(/^\/scenes\/(\d+)/);
    return match ? match[1] : null;
  }

  function folderOf(filePath) {
    // Works for both / and \ separators
    return filePath.replace(/[\\/][^\\/]+$/, "");
  }

  function isVideoFile(path) {
    const ext = path.split(".").pop().toLowerCase();
    return VIDEO_EXTS.has(ext);
  }

  // ── Build UI ───────────────────────────────────────────────────────────────

  function makeStatusEl() {
    const el = document.createElement("div");
    el.style.cssText = "font-size:0.83em; margin-top:6px;";
    return el;
  }

  function setStatus(el, msg, colour) {
    el.style.color = colour || "#abb2bf";
    el.textContent = msg;
  }

  function makeDivider() {
    const hr = document.createElement("hr");
    hr.style.cssText = "border-color:#3e4451; margin:14px 0 10px;";
    return hr;
  }

  function makeHeading(text) {
    const h = document.createElement("p");
    h.style.cssText = "color:#abb2bf; font-size:0.85em; margin-bottom:6px; font-weight:600;";
    h.textContent = text;
    return h;
  }

  function makeFileList(files) {
    const ol = document.createElement("ol");
    ol.style.cssText = "padding-left:20px; margin-bottom:10px;";
    files.forEach(f => {
      const li = document.createElement("li");
      li.style.cssText = "font-size:0.78em; color:#7f848e; word-break:break-all; margin-bottom:2px;";
      li.textContent = f;
      ol.appendChild(li);
    });
    return ol;
  }

  function makeButton(label, cls) {
    const btn = document.createElement("button");
    btn.className = cls || "btn btn-primary btn-sm";
    btn.textContent = label;
    btn.style.cssText = "margin-bottom:8px; margin-right:6px;";
    return btn;
  }

  // ── Section 1: Merge scene files ──────────────────────────────────────────

  function buildSceneMergeSection(scene, settings) {
    const wrap = document.createElement("div");

    const headingText = scene.files.length === 1
      ? `Merge attached files — 1 file attached:`
      : `Merge attached files — ${scene.files.length} files will be merged in this order:`;
    wrap.appendChild(makeHeading(headingText));
    wrap.appendChild(makeFileList(scene.files.map(f => f.path)));

    // For single-file scenes, show a hint rather than a disabled button
    if (scene.files.length === 1) {
      const hint = document.createElement("p");
      hint.style.cssText = "font-size:0.82em; color:#e5c07b; margin-bottom:8px;";
      hint.textContent = "⚠ Only 1 file attached — use the folder merge below to include other files from the same folder, then re-open this tab to merge them all.";
      wrap.appendChild(hint);
      return wrap;
    }

    // Show predicted output filename
    let predictedName;
    try {
      predictedName = predictFilename(scene, scene.files.map(f => f.path));
      console.log("[ConcatFiles] Scene predicted filename:", predictedName);
    } catch(predErr) {
      console.error("[ConcatFiles] predictFilename threw:", predErr);
      predictedName = "(could not predict — check console)";
    }
    const namePreview = document.createElement("p");
    namePreview.style.cssText = "font-size:0.82em; color:#61afef; margin-bottom:10px; font-weight:bold;";
    namePreview.innerHTML = `&#128190; <strong>Output filename:</strong> ${predictedName}`;
    wrap.appendChild(namePreview);

    const btn    = makeButton(`Merge ${scene.files.length} Files with FFmpeg`);
    const status = makeStatusEl();

    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Starting merge…";
      setStatus(status, "Fetching settings…");

      try {
        const location = (settings.outputLocation || "first").trim().toLowerCase();
        let outputPath = null;

        if (location === "prompt") {
          const firstDir = folderOf(scene.files[0].path);
          outputPath = window.prompt(
            `Enter the output directory for the merged file:\n(${scene.files.length} files will be joined in order)`,
            firstDir
          );
          if (outputPath === null) {
            btn.disabled = false;
            btn.textContent = `Merge ${scene.files.length} Files with FFmpeg`;
            setStatus(status, "Cancelled.");
            return;
          }
          outputPath = outputPath.trim();
        }

        const taskArgs = [{ key: "scene_id", value: { str: String(scene.id) } }];
        if (outputPath) taskArgs.push({ key: "output_path", value: { str: outputPath } });

        await runTask(TASK_MERGE_SCENE, taskArgs);
        setStatus(status,
          "✓ Merge task started! Check Settings → Tasks → Logs for progress.",
          "#98c379"
        );
        btn.textContent = "Merge task running…";
      } catch (e) {
        btn.disabled = false;
        btn.textContent = `Merge ${scene.files.length} Files with FFmpeg`;
        setStatus(status, `Error: ${e.message}`, "#e06c75");
      }
    });

    wrap.appendChild(btn);
    wrap.appendChild(status);
    return wrap;
  }

  // ── Section 2: Merge folder files ─────────────────────────────────────────

  function buildFolderMergeSection(scene, settings) {
    const wrap = document.createElement("div");
    wrap.appendChild(makeDivider());

    const primaryPath = scene.files[0].path;
    const folder      = folderOf(primaryPath);

    wrap.appendChild(makeHeading(`Merge all files from folder — includes files from other scenes:`));

    const folderLabel = document.createElement("p");
    folderLabel.style.cssText = "font-size:0.78em; color:#7f848e; word-break:break-all; margin-bottom:10px;";
    folderLabel.textContent = folder;
    wrap.appendChild(folderLabel);

    const btn    = makeButton("Scan Folder & Preview Merge", "btn btn-secondary btn-sm");
    const status = makeStatusEl();
    const previewArea = document.createElement("div");

    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Scanning folder…";
      setStatus(status, "Querying Stash for files in this folder…");
      previewArea.innerHTML = "";

      try {
        const scenes = await getScenesInFolder(folder);

        // Collect all video file paths from all scenes in this folder
        const allFiles = [];
        for (const s of scenes) {
          for (const f of s.files) {
            if (isVideoFile(f.path) && folderOf(f.path) === folder) {
              allFiles.push({
                path:    f.path,
                basename: f.basename,
                sceneId:  s.id,
                sceneTitle: s.title || `Scene ${s.id}`,
                isCurrent: s.id === scene.id,
              });
            }
          }
        }

        // Sort naturally by filename
        allFiles.sort((a, b) => a.basename.localeCompare(b.basename, undefined, { numeric: true }));

        if (allFiles.length < 2) {
          btn.disabled = false;
          btn.textContent = "Scan Folder & Preview Merge";
          setStatus(status,
            allFiles.length === 0
              ? "No video files found in this folder via Stash."
              : "Only 1 video file found in this folder — nothing to merge.",
            "#e5c07b"
          );
          return;
        }

        // Show preview
        previewArea.appendChild(makeHeading(
          `Found ${allFiles.length} video files — will be merged in this order:`
        ));

        const ol = document.createElement("ol");
        ol.style.cssText = "padding-left:20px; margin-bottom:10px;";
        allFiles.forEach(f => {
          const li = document.createElement("li");
          li.style.cssText = "font-size:0.78em; word-break:break-all; margin-bottom:2px;";
          const tag = f.isCurrent ? " ← this scene" : ` (scene ${f.sceneId})`;
          li.style.color = f.isCurrent ? "#98c379" : "#7f848e";
          li.textContent = f.basename + tag;
          ol.appendChild(li);
        });
        previewArea.appendChild(ol);

        // Warning if files span multiple scenes
        const otherScenes = [...new Set(allFiles.filter(f => !f.isCurrent).map(f => f.sceneId))];
        if (otherScenes.length > 0) {
          const warn = document.createElement("p");
          warn.style.cssText = "font-size:0.82em; color:#e5c07b; margin-bottom:10px;";
          warn.textContent = `⚠ ${otherScenes.length} file(s) belong to other scene(s). They will be included in the merge.`;
          previewArea.appendChild(warn);
        }

        // Show predicted filename
        let folderPredictedName;
        try {
          folderPredictedName = predictFilename(scene, allFiles.map(f => f.path));
          console.log("[ConcatFiles] Predicted filename:", folderPredictedName, "scene:", JSON.stringify(scene));
        } catch(predErr) {
          console.error("[ConcatFiles] predictFilename threw:", predErr);
          folderPredictedName = "(could not predict — check console)";
        }
        const folderNamePreview = document.createElement("p");
        folderNamePreview.style.cssText = "font-size:0.82em; color:#61afef; margin-bottom:10px; font-weight:bold;";
        folderNamePreview.innerHTML = `&#128190; <strong>Output filename:</strong> ${folderPredictedName}`;
        previewArea.appendChild(folderNamePreview);

        // Confirm button
        const confirmBtn = makeButton(
          `Merge ${allFiles.length} Files from Folder`,
          "btn btn-warning btn-sm"
        );
        const confirmStatus = makeStatusEl();

        confirmBtn.addEventListener("click", async () => {
          confirmBtn.disabled = true;
          confirmBtn.textContent = "Starting merge…";
          setStatus(confirmStatus, "Fetching settings…");

          try {
            const location = (settings.outputLocation || "first").trim().toLowerCase();
            let outputPath = null;

            if (location === "prompt") {
              outputPath = window.prompt(
                `Enter the output directory for the merged file:`,
                folder
              );
              if (outputPath === null) {
                confirmBtn.disabled = false;
                confirmBtn.textContent = `Merge ${allFiles.length} Files from Folder`;
                setStatus(confirmStatus, "Cancelled.");
                return;
              }
              outputPath = outputPath.trim();
            }

            const taskArgs = [
              { key: "folder_path", value: { str: folder } },
              { key: "scene_id",    value: { str: String(scene.id) } },
            ];
            if (outputPath) taskArgs.push({ key: "output_path", value: { str: outputPath } });

            await runTask(TASK_MERGE_FOLDER, taskArgs);
            setStatus(confirmStatus,
              "✓ Folder merge task started! Check Settings → Tasks → Logs for progress.",
              "#98c379"
            );
            confirmBtn.textContent = "Merge task running…";
          } catch (e) {
            confirmBtn.disabled = false;
            confirmBtn.textContent = `Merge ${allFiles.length} Files from Folder`;
            setStatus(confirmStatus, `Error: ${e.message}`, "#e06c75");
          }
        });

        previewArea.appendChild(confirmBtn);
        previewArea.appendChild(confirmStatus);

        btn.disabled = false;
        btn.textContent = "Re-scan Folder";
        setStatus(status, "");

      } catch (e) {
        btn.disabled = false;
        btn.textContent = "Scan Folder & Preview Merge";
        setStatus(status, `Error scanning folder: ${e.message}`, "#e06c75");
      }
    });

    wrap.appendChild(btn);
    wrap.appendChild(status);
    wrap.appendChild(previewArea);
    return wrap;
  }

  // ── Inject into File Info tab ──────────────────────────────────────────────

  async function injectUI(sceneId, tabContent) {
    if (document.getElementById(CONTAINER_ID)) return;

    let scene;
    try {
      scene = await getScene(sceneId);
    } catch (e) {
      console.error("[ConcatFiles] Failed to fetch scene:", e);
      return;
    }
    if (!scene) return;
    if (document.getElementById(CONTAINER_ID)) return;

    const settings = await getPluginSettings().catch(() => ({}));

    const container = document.createElement("div");
    container.id = CONTAINER_ID;
    container.style.cssText = "margin-top:16px; padding-top:14px; border-top:1px solid #3e4451;";

    // Section 1: show for any scene with files (even 1 - user may want to merge with folder files first)
    if (scene.files && scene.files.length >= 1) {
      container.appendChild(buildSceneMergeSection(scene, settings));
    }

    // Section 2: always show if scene has at least 1 file (to enable folder merge)
    if (scene.files && scene.files.length >= 1) {
      container.appendChild(buildFolderMergeSection(scene, settings));
    }

    if (container.children.length > 0) {
      tabContent.appendChild(container);
      console.log("[ConcatFiles] UI injected.");
    }
  }

  // ── Tab click listener & SPA watcher ──────────────────────────────────────

  document.body.addEventListener("click", function (e) {
    if (e.target.dataset.rbEventKey !== "scene-file-info-panel") return;
    const sceneId = getSceneIdFromUrl();
    if (!sceneId) return;
    const old = document.getElementById(CONTAINER_ID);
    if (old) old.remove();
    setTimeout(() => {
      const tabContent = document.querySelector("div.tab-content");
      if (tabContent) injectUI(sceneId, tabContent);
    }, 300);
  });

  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      const old = document.getElementById(CONTAINER_ID);
      if (old) old.remove();
    }
  }).observe(document.body, { childList: true, subtree: true });

})();
