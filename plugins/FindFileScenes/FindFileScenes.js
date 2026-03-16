// v1.3 - FindFileScenes - bottom-left button, modal with folder browser
(function () {
  "use strict";

  const MODAL_ID  = "ffs-modal";
  const BUTTON_ID = "ffs-button";

  // ── GraphQL ────────────────────────────────────────────────────────────────

  async function gql(query, variables = {}) {
    const res = await fetch("/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.errors) throw new Error(data.errors.map(e => e.message).join(", "));
    return data.data;
  }

  async function findScenesByPath(filePath) {
    const basename = filePath.replace(/\\/g, "/").split("/").pop();
    const data = await gql(`
      query FindScenesByPath($path: String!) {
        findScenes(
          scene_filter: { path: { value: $path, modifier: INCLUDES } }
          filter: { per_page: -1 }
        ) {
          scenes {
            id title date
            studio { name }
            performers { name }
            files { path }
          }
        }
      }
    `, { path: basename });

    const norm = p => p.replace(/\\/g, "/").toLowerCase();
    const normTarget = norm(filePath);
    return (data?.findScenes?.scenes || []).filter(scene =>
      scene.files.some(f => norm(f.path) === normTarget)
    );
  }

  async function findScenesByFolder(folderPath, maxResults) {
    // Search by the last folder component to cast a wide net, then
    // filter client-side to scenes whose file path STARTS WITH the full
    // folder path — this covers all subfolders recursively.
    const folderName = folderPath.replace(/\\/g, "/").split("/").pop();
    const data = await gql(`
      query FindScenesInFolder($path: String!) {
        findScenes(
          scene_filter: { path: { value: $path, modifier: INCLUDES } }
          filter: { per_page: -1 }
        ) {
          count
          scenes {
            id title date
            studio { name }
            performers { name }
            files { path }
          }
        }
      }
    `, { path: folderName });

    const norm = p => p.replace(/\\/g, "/").toLowerCase();
    const normFolder = norm(folderPath).replace(/\/$/, "") + "/";

    // Include scenes that have at least one file anywhere under this folder (recursive)
    const matched = (data?.findScenes?.scenes || []).filter(scene =>
      scene.files.some(f => norm(f.path).startsWith(normFolder))
    );

    return { scenes: matched.slice(0, maxResults), total: matched.length };
  }

  async function browseDirectory(path) {
    const data = await gql(`
      query Directory($path: String!) {
        directory(path: $path) {
          path
          parent
          directories
        }
      }
    `, { path: path || "" });
    return data?.directory || { path: "", parent: null, directories: [] };
  }

  async function getLibraryPaths() {
    const data = await gql(`
      query { configuration { general { stashes { path } } } }
    `);
    return (data?.configuration?.general?.stashes || []).map(s => s.path).filter(Boolean);
  }

  // ── Folder browser ─────────────────────────────────────────────────────────

  const VIDEO_EXTS = new Set([
    "mp4","m4v","mkv","avi","mov","wmv","flv","webm",
    "ts","mts","m2ts","mpg","mpeg","ogv","3gp","3g2"
  ]);

  function isVideo(name) {
    return VIDEO_EXTS.has(name.split(".").pop().toLowerCase());
  }

  function basename(p) {
    return p.replace(/\\/g, "/").split("/").pop();
  }

  async function getFilesInDir(dirPath) {
    // Stash directory query doesn't return files directly.
    // Use findScenes with INCLUDES on the folder basename to get video files.
    const folderName = basename(dirPath);
    const data = await gql(`
      query FindFilesInFolder($path: String!) {
        findScenes(
          scene_filter: { path: { value: $path, modifier: INCLUDES } }
          filter: { per_page: -1 }
        ) {
          scenes { files { path } }
        }
      }
    `, { path: folderName });

    const norm = p => p.replace(/\\/g, "/").toLowerCase();
    const normDir = norm(dirPath);

    const files = new Set();
    for (const scene of (data?.findScenes?.scenes || [])) {
      for (const f of scene.files) {
        const fNorm = norm(f.path);
        const fDir  = fNorm.substring(0, fNorm.lastIndexOf("/"));
        if (fDir === normDir && isVideo(f.path)) {
          files.add(f.path);
        }
      }
    }
    return [...files].sort((a, b) =>
      basename(a).localeCompare(basename(b), undefined, { numeric: true })
    );
  }

  function buildBrowser(onSelect) {
    const wrap = document.createElement("div");
    wrap.style.cssText = "margin-top:12px;";

    const header = document.createElement("div");
    header.style.cssText = "display:flex; align-items:center; gap:6px; margin-bottom:6px;";

    const pathLabel = document.createElement("span");
    pathLabel.style.cssText = "font-size:0.78em; color:#7f848e; flex:1; word-break:break-all;";
    pathLabel.textContent = "Loading…";

    const upBtn = document.createElement("button");
    upBtn.textContent = "↑ Up";
    upBtn.className = "btn btn-secondary btn-sm";
    upBtn.style.cssText = "font-size:0.75em; padding:2px 8px;";
    upBtn.disabled = true;

    header.appendChild(upBtn);
    header.appendChild(pathLabel);
    wrap.appendChild(header);

    const list = document.createElement("div");
    list.style.cssText = [
      "background:#1e2127",
      "border:1px solid #3e4451",
      "border-radius:4px",
      "max-height:220px",
      "overflow-y:auto",
      "font-size:0.82em",
    ].join(";");
    wrap.appendChild(list);

    const status = document.createElement("p");
    status.style.cssText = "font-size:0.75em; color:#7f848e; margin-top:5px; min-height:1.2em;";
    wrap.appendChild(status);

    let currentPath = "";
    let parentPath  = null;

    function row(icon, label, onClick, colour) {
      const r = document.createElement("div");
      r.style.cssText = [
        "padding:5px 10px",
        "cursor:pointer",
        "display:flex", "align-items:center", "gap:8px",
        `color:${colour || "#abb2bf"}`,
        "border-bottom:1px solid #2c313a",
      ].join(";");
      r.addEventListener("mouseover", () => r.style.background = "#2c313a");
      r.addEventListener("mouseout",  () => r.style.background = "");
      const ic = document.createElement("span");
      ic.style.cssText = "font-size:0.95em; flex-shrink:0;";
      ic.textContent = icon;
      const lb = document.createElement("span");
      lb.style.cssText = "word-break:break-all;";
      lb.textContent = label;
      r.appendChild(ic);
      r.appendChild(lb);
      r.addEventListener("click", onClick);
      return r;
    }

    async function navigate(path) {
      list.innerHTML = "";
      status.textContent = "Loading…";
      pathLabel.textContent = path || "(root)";
      upBtn.disabled = true;

      try {
        const dir = await browseDirectory(path);
        currentPath = dir.path;
        parentPath  = dir.parent;
        pathLabel.textContent = currentPath || "(root)";
        upBtn.disabled = !parentPath;

        // Subdirectories
        for (const d of (dir.directories || [])) {
          const r = row("📁", basename(d), () => navigate(d));
          // Add a small "search folder" button on the right
          const useBtn = document.createElement("button");
          useBtn.textContent = "Search folder";
          useBtn.style.cssText = "margin-left:auto; flex-shrink:0; background:#2c313a; border:1px solid #4b5263; border-radius:3px; color:#abb2bf; font-size:0.72em; padding:2px 7px; cursor:pointer;";
          useBtn.addEventListener("mouseover", e => { e.stopPropagation(); useBtn.style.background = "#3a3f4b"; });
          useBtn.addEventListener("mouseout",  e => { e.stopPropagation(); useBtn.style.background = "#2c313a"; });
          useBtn.addEventListener("click", e => { e.stopPropagation(); onSelect(d, true); });
          r.appendChild(useBtn);
          list.appendChild(r);
        }

        // "Search this folder" shortcut for current directory
        if (currentPath) {
          const thisBtn = document.createElement("div");
          thisBtn.style.cssText = [
            "padding:5px 10px",
            "cursor:pointer",
            "display:flex", "align-items:center", "gap:8px",
            "color:#e5c07b",
            "border-bottom:2px solid #3e4451",
            "font-size:0.82em",
          ].join(";");
          thisBtn.textContent = "📂 Search all scenes in this folder";
          thisBtn.addEventListener("mouseover", () => thisBtn.style.background = "#2c313a");
          thisBtn.addEventListener("mouseout",  () => thisBtn.style.background = "");
          thisBtn.addEventListener("click", () => onSelect(currentPath, true));
          list.insertBefore(thisBtn, list.firstChild);
        }

        // Video files in this directory (from Stash index)
        if (currentPath) {
          const files = await getFilesInDir(currentPath);
          if (files.length) {
            const divider = document.createElement("div");
            divider.style.cssText = "border-top:2px solid #3e4451; margin:2px 0;";
            list.appendChild(divider);
            for (const f of files) {
              list.appendChild(row("🎬", basename(f), () => {
                onSelect(f, false);
              }, "#98c379"));
            }
          }
          status.textContent = `${(dir.directories || []).length} folder(s), ${files.length} video file(s)`;
        } else {
          status.textContent = `${(dir.directories || []).length} drive(s)/folder(s)`;
        }
      } catch (e) {
        status.textContent = `Error: ${e.message}`;
      }
    }

    // Start at library roots instead of filesystem root
    async function navigateToLibraryRoot() {
      list.innerHTML = "";
      status.textContent = "Loading library paths…";
      pathLabel.textContent = "(library roots)";
      upBtn.disabled = true;

      try {
        const libraryPaths = await getLibraryPaths();
        if (!libraryPaths.length) {
          // No library paths configured — fall back to filesystem root
          return navigate("");
        }

        if (libraryPaths.length === 1) {
          // Only one library path — go straight in
          return navigate(libraryPaths[0]);
        }

        // Multiple library paths — show them as the top level
        currentPath = "";
        parentPath  = null;
        upBtn.disabled = true;

        for (const p of libraryPaths) {
          list.appendChild(row("📚", p, () => navigate(p)));
        }
        status.textContent = `${libraryPaths.length} library path(s)`;
      } catch (e) {
        status.textContent = `Error loading library paths: ${e.message}`;
      }
    }

    // Override Up button to return to library root when at a top-level lib path
    upBtn.addEventListener("click", async () => {
      if (parentPath !== null) {
        navigate(parentPath);
      } else {
        navigateToLibraryRoot();
      }
    });

    navigateToLibraryRoot();

    return wrap;
  }

  // ── Modal ──────────────────────────────────────────────────────────────────

  function createModal() {
    const overlay = document.createElement("div");
    overlay.id = MODAL_ID;
    overlay.style.cssText = [
      "position:fixed", "inset:0", "z-index:99999",
      "background:rgba(0,0,0,0.7)",
      "display:flex", "align-items:center", "justify-content:center",
    ].join(";");

    const panel = document.createElement("div");
    panel.style.cssText = [
      "background:#282c34",
      "border:1px solid #3e4451",
      "border-radius:8px",
      "padding:20px 24px",
      "width:min(720px,92vw)",
      "max-height:85vh",
      "overflow-y:auto",
      "box-shadow:0 8px 32px rgba(0,0,0,0.5)",
      "display:flex",
      "flex-direction:column",
      "gap:0",
    ].join(";");

    // Header
    const header = document.createElement("div");
    header.style.cssText = "display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;";
    const title = document.createElement("h5");
    title.style.cssText = "color:#abb2bf; margin:0; font-size:1em;";
    title.textContent = "Find Scenes For File";
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    closeBtn.style.cssText = "background:none; border:none; color:#7f848e; cursor:pointer; font-size:1.1em; padding:0 4px;";
    closeBtn.addEventListener("click", closeModal);
    header.appendChild(title);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    const VIDEO_EXTS_INPUT = new Set([
      "mp4","m4v","mkv","avi","mov","wmv","flv","webm",
      "ts","mts","m2ts","mpg","mpeg","ogv","3gp","3g2"
    ]);

    function isFilePath(p) {
      const ext = p.replace(/\\/g, "/").split("/").pop().split(".").pop().toLowerCase();
      return VIDEO_EXTS_INPUT.has(ext);
    }

    const inputLabel = document.createElement("p");
    inputLabel.style.cssText = "font-size:0.82em; color:#7f848e; margin-bottom:5px;";
    inputLabel.textContent = "Paste a file or folder path, or click a file below:";
    panel.appendChild(inputLabel);

    const inputRow = document.createElement("div");
    inputRow.style.cssText = "display:flex; gap:8px; margin-bottom:6px;";

    const input = document.createElement("input");
    input.id = "ffs-input";
    input.type = "text";
    input.placeholder = "e.g. I:\\FTVGirls\\2024\\scene.mp4  or  I:\\FTVGirls\\2024\\";
    input.style.cssText = [
      "flex:1",
      "background:#1e2127",
      "border:1px solid #3e4451",
      "border-radius:4px",
      "color:#abb2bf",
      "padding:7px 10px",
      "font-size:0.88em",
      "outline:none",
    ].join(";");
    input.addEventListener("focus", () => input.style.borderColor = "#61afef");
    input.addEventListener("blur",  () => input.style.borderColor = "#3e4451");

    const searchBtn = document.createElement("button");
    searchBtn.className = "btn btn-primary btn-sm";
    searchBtn.textContent = "Search";
    inputRow.appendChild(input);
    inputRow.appendChild(searchBtn);
    panel.appendChild(inputRow);

    // Max results row (shown only in folder mode)
    const maxRow = document.createElement("div");
    maxRow.style.cssText = "display:flex; align-items:center; gap:8px; margin-bottom:10px;";
    const maxLabel = document.createElement("label");
    maxLabel.style.cssText = "font-size:0.8em; color:#7f848e;";
    maxLabel.textContent = "Max scenes:";
    const maxInput = document.createElement("input");
    maxInput.type = "number";
    maxInput.value = "20";
    maxInput.min = "1";
    maxInput.max = "200";
    maxInput.style.cssText = [
      "width:60px",
      "background:#1e2127",
      "border:1px solid #3e4451",
      "border-radius:4px",
      "color:#abb2bf",
      "padding:4px 6px",
      "font-size:0.85em",
      "outline:none",
    ].join(";");
    maxRow.appendChild(maxLabel);
    maxRow.appendChild(maxInput);
    panel.appendChild(maxRow);

    // Results area
    const results = document.createElement("div");
    results.style.marginBottom = "14px";
    panel.appendChild(results);

    // Folder browser section
    const browserToggle = document.createElement("button");
    browserToggle.className = "btn btn-secondary btn-sm";
    browserToggle.style.cssText = "margin-bottom:8px; font-size:0.82em;";
    browserToggle.textContent = "📂 Browse Files…";
    panel.appendChild(browserToggle);

    const browserWrap = document.createElement("div");
    browserWrap.style.display = "none";
    panel.appendChild(browserWrap);

    let browserBuilt = false;
    browserToggle.addEventListener("click", () => {
      if (browserWrap.style.display === "none") {
        browserWrap.style.display = "block";
        browserToggle.textContent = "📂 Hide Browser";
        if (!browserBuilt) {
          browserWrap.appendChild(buildBrowser((filePath, isDir) => {
            input.value = filePath;
            doSearch();
          }));
          browserBuilt = true;
        }
      } else {
        browserWrap.style.display = "none";
        browserToggle.textContent = "📂 Browse Files…";
      }
    });

    function renderSceneCard(scene) {
      const card = document.createElement("div");
      card.style.cssText = [
        "background:#1e2127",
        "border:1px solid #3e4451",
        "border-radius:5px",
        "padding:10px 12px",
        "margin-bottom:8px",
      ].join(";");

      const titleLink = document.createElement("a");
      titleLink.href = `/scenes/${scene.id}`;
      titleLink.textContent = scene.title || "(no title)";
      titleLink.style.cssText = "color:#61afef; font-weight:600; font-size:0.92em; text-decoration:none; display:block; margin-bottom:4px;";
      titleLink.addEventListener("click", closeModal);
      card.appendChild(titleLink);

      const metaParts = [`#${scene.id}`];
      if (scene.date)               metaParts.push(scene.date);
      if (scene.studio?.name)       metaParts.push(scene.studio.name);
      if (scene.performers?.length) metaParts.push(scene.performers.map(p => p.name).join(", "));
      const meta = document.createElement("div");
      meta.style.cssText = "font-size:0.78em; color:#7f848e; margin-bottom:5px;";
      meta.textContent = metaParts.join("  ·  ");
      card.appendChild(meta);

      scene.files.forEach(f => {
        const fileEl = document.createElement("div");
        fileEl.style.cssText = "font-size:0.73em; color:#5c6370; word-break:break-all; padding-left:8px;";
        fileEl.textContent = f.path;
        card.appendChild(fileEl);
      });

      return card;
    }

    async function doSearch() {
      const pathVal = input.value.trim().replace(/^["']+|["']+$/g, "");
      if (!pathVal) return;
      const isFolder = !isFilePath(pathVal);

      searchBtn.disabled = true;
      searchBtn.textContent = "Searching…";
      results.innerHTML = "";

      // Show a small indicator of detected mode
      const modeIndicator = document.createElement("p");
      modeIndicator.style.cssText = "font-size:0.78em; color:#7f848e; margin-bottom:6px;";
      modeIndicator.textContent = isFolder ? "📁 Searching folder recursively…" : "🎬 Searching for file…";
      results.appendChild(modeIndicator);

      try {
        if (isFolder) {
          const maxResults = Math.max(1, parseInt(maxInput.value, 10) || 20);
          const { scenes, total } = await findScenesByFolder(pathVal, maxResults);

          modeIndicator.remove();
          if (!scenes.length) {
            const msg = document.createElement("p");
            msg.style.cssText = "font-size:0.85em; color:#e5c07b; margin:0;";
            msg.textContent = "No scenes found in that folder or its subfolders.";
            results.appendChild(msg);
          } else {
            const summary = document.createElement("p");
            summary.style.cssText = "font-size:0.83em; color:#98c379; margin-bottom:10px;";
            summary.textContent = total > maxResults
              ? `Showing ${scenes.length} of ${total} scenes (increase Max scenes to see more):`
              : `Found ${total} scene${total !== 1 ? "s" : ""} (including subfolders):`;
            results.appendChild(summary);
            scenes.forEach(s => results.appendChild(renderSceneCard(s)));
          }
        } else {
          const scenes = await findScenesByPath(pathVal);

          modeIndicator.remove();
          if (!scenes.length) {
            const msg = document.createElement("p");
            msg.style.cssText = "font-size:0.85em; color:#e5c07b; margin:0;";
            msg.textContent = "No scenes found containing that file path.";
            results.appendChild(msg);
          } else {
            const summary = document.createElement("p");
            summary.style.cssText = "font-size:0.83em; color:#98c379; margin-bottom:10px;";
            summary.textContent = `Found ${scenes.length} scene${scenes.length !== 1 ? "s" : ""}:`;
            results.appendChild(summary);
            scenes.forEach(s => results.appendChild(renderSceneCard(s)));
          }
        }
      } catch (e) {
        const errEl = document.createElement("p");
        errEl.style.cssText = "font-size:0.85em; color:#e06c75; margin:0;";
        errEl.textContent = `Error: ${e.message}`;
        results.appendChild(errEl);
      }

      searchBtn.disabled = false;
      searchBtn.textContent = "Search";
    }

    searchBtn.addEventListener("click", doSearch);
    input.addEventListener("keydown", e => { if (e.key === "Enter") doSearch(); });
    overlay.addEventListener("click", e => { if (e.target === overlay) closeModal(); });

    overlay.appendChild(panel);
    return overlay;
  }

  let _modal = null;

  function openModal() {
    if (!_modal) {
      _modal = createModal();
      document.body.appendChild(_modal);
    }
    _modal.style.display = "flex";
    setTimeout(() => document.getElementById("ffs-input")?.focus(), 50);
  }

  function closeModal() {
    if (_modal) _modal.style.display = "none";
  }

  // ── Floating button (bottom-left) ──────────────────────────────────────────

  function injectButton() {
    if (document.getElementById(BUTTON_ID)) return;
    const btn = document.createElement("button");
    btn.id = BUTTON_ID;
    btn.title = "Find Scenes For File (Ctrl+Shift+F)";
    btn.textContent = "🔍 File";
    btn.style.cssText = [
      "position:fixed",
      "bottom:20px",
      "left:20px",
      "z-index:9999",
      "background:#3a3f4b",
      "border:1px solid #4b5263",
      "border-radius:20px",
      "color:#abb2bf",
      "padding:7px 14px",
      "font-size:0.82em",
      "cursor:pointer",
      "box-shadow:0 2px 8px rgba(0,0,0,0.4)",
    ].join(";");
    btn.addEventListener("mouseover", () => btn.style.background = "#4b5263");
    btn.addEventListener("mouseout",  () => btn.style.background = "#3a3f4b");
    btn.addEventListener("click", openModal);
    document.body.appendChild(btn);
  }

  document.addEventListener("keydown", e => {
    if (e.ctrlKey && e.shiftKey && e.key === "F") {
      e.preventDefault();
      document.getElementById(MODAL_ID) ? closeModal() : openModal();
    }
  });

  new MutationObserver(() => injectButton())
    .observe(document.body, { childList: true });
  injectButton();

})();
