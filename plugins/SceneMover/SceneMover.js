// v1.5 - SceneMover - floating button + modal
(function () {
  "use strict";
  console.log("[SceneMover] Script loaded v1.5");

  const PLUGIN_ID = "SceneMover";
  const MODAL_ID  = "sm-modal";
  const BTN_ID    = "sm-button";

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

  // taskName = Stash task label, modeValue = Python mode string, extraArgs = extra k/v pairs
  async function runPluginTask(taskName, modeValue, extraArgs = {}) {
    const args = [
      { key: "mode", value: { str: modeValue } },
      ...Object.entries(extraArgs).map(([k, v]) => ({ key: k, value: { str: String(v) } }))
    ];
    return gql(`
      mutation RunPluginTask($plugin_id: ID!, $task_name: String!, $args: [PluginArgInput!]) {
        runPluginTask(plugin_id: $plugin_id, task_name: $task_name, args: $args)
      }
    `, { plugin_id: PLUGIN_ID, task_name: taskName, args });
  }

  // ── Config — stored in SceneMover.json, saved via plugin task ─────────────
  // Config is kept in _config (in-memory) for the session.
  // On first open we use defaults; user saves to persist to disk.

  const LS_KEY = "SceneMover_config";

  function defaultConfig() {
    return { roots: [], rules: [] };
  }

  function loadConfigFromStorage() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      const cfg = JSON.parse(raw);
      if (!cfg.roots) cfg.roots = [];
      if (!cfg.rules) cfg.rules = [];
      return cfg;
    } catch(e) {
      return null;
    }
  }

  function saveConfigToStorage(config) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(config));
    } catch(e) {
      console.warn("[SceneMover] localStorage save failed:", e);
    }
  }

  async function saveConfig(config) {
    // Persist to localStorage immediately (synchronous, always works)
    saveConfigToStorage(config);
    // Also write to SceneMover.json on disk via plugin task (async backup)
    try {
      await runPluginTask("Save Config", "save_config", { config: JSON.stringify(config) });
    } catch(e) {
      console.warn("[SceneMover] File save failed (localStorage still updated):", e);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  function uid() { return "id_" + Math.random().toString(36).slice(2, 9); }

  function el(tag, css, text) {
    const e = document.createElement(tag);
    if (css)  e.style.cssText = css;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function styledInput(value, placeholder, css) {
    const i = document.createElement("input");
    i.type  = "text";
    i.value = value || "";
    i.placeholder = placeholder || "";
    i.style.cssText = "background:#1e2127;border:1px solid #3e4451;border-radius:4px;color:#abb2bf;padding:5px 8px;font-size:0.84em;outline:none;" + (css || "");
    i.addEventListener("focus", () => i.style.borderColor = "#61afef");
    i.addEventListener("blur",  () => i.style.borderColor = "#3e4451");
    return i;
  }

  function styledSelect(options, value, css) {
    const s = document.createElement("select");
    s.style.cssText = "background:#1e2127;border:1px solid #3e4451;border-radius:4px;color:#abb2bf;padding:5px 8px;font-size:0.84em;outline:none;" + (css || "");
    options.forEach(([val, label]) => {
      const o = document.createElement("option");
      o.value = val; o.textContent = label;
      if (val === value) o.selected = true;
      s.appendChild(o);
    });
    return s;
  }

  function mkBtn(label, cls, onClick) {
    const b = document.createElement("button");
    b.className = cls || "btn btn-secondary btn-sm";
    b.textContent = label;
    if (onClick) b.addEventListener("click", onClick);
    return b;
  }

  // ── Token picker ───────────────────────────────────────────────────────────

  const TOKENS = [
    ["{studio}",                     "Studio name"],
    ["{studioFirstLetter}",          "Studio first letter"],
    ["{studioInitial}",              "Studio first letter (alias)"],
    ["{date}",                       "Full date (yyyy-MM-dd)"],
    ["{yyyy}",                       "Year"],
    ["{yyyy-MM}",                    "Year-Month"],
    ["{MM-dd}",                      "Month-Day"],
    ["{title}",                      "Scene title"],
    ["{performers}",                 "All performers"],
    ["{favoritedPerformer}",         "Favourite performer"],
    ["{favoritedPerformerInitial}",  "Favourite performer initial"],
    ["{codec}",                      "Video codec"],
    ["{height}",                     "Resolution height"],
    ["{ext}",                        "File extension"],
    ["{scene_id}",                   "Studio code"],
  ];

  function buildTokenPicker(targetInput) {
    const wrap = el("div","display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;");
    TOKENS.forEach(([token, label]) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.textContent = token;
      chip.title = label;
      chip.style.cssText = "background:#2c313a;border:1px solid #3e4451;border-radius:3px;color:#61afef;font-size:0.72em;font-family:monospace;padding:2px 6px;cursor:pointer;";
      chip.addEventListener("mouseover", () => chip.style.background = "#3e4451");
      chip.addEventListener("mouseout",  () => chip.style.background = "#2c313a");
      chip.addEventListener("click", () => {
        const start = targetInput.selectionStart;
        const end   = targetInput.selectionEnd;
        const val   = targetInput.value;
        targetInput.value = val.slice(0, start) + token + val.slice(end);
        targetInput.selectionStart = targetInput.selectionEnd = start + token.length;
        targetInput.dispatchEvent(new Event("input"));
        targetInput.focus();
      });
      wrap.appendChild(chip);
    });
    return wrap;
  }

  // ── Folder browser (Stash library roots only) ──────────────────────────────

  async function getLibraryPaths() {
    const data = await gql(`query { configuration { general { stashes { path } } } }`);
    return (data?.configuration?.general?.stashes || []).map(s => s.path).filter(Boolean);
  }

  async function browseDirectory(path) {
    const data = await gql(`
      query Directory($path: String!) {
        directory(path: $path) { path parent directories }
      }
    `, { path });
    return data?.directory || { path: "", parent: null, directories: [] };
  }

  function buildFolderBrowser(onSelect, onCancel) {
    const wrap = el("div","background:#1e2127;border:1px solid #3e4451;border-radius:5px;padding:10px;margin-top:6px;");

    const hdr = el("div","display:flex;align-items:center;gap:6px;margin-bottom:6px;");
    const upBtn = mkBtn("↑ Up","btn btn-secondary btn-sm");
    upBtn.disabled = true;
    const pathLabel = el("span","font-size:0.76em;color:#7f848e;flex:1;word-break:break-all;","Loading…");
    const cancelBtn = mkBtn("Cancel","btn btn-secondary btn-sm", onCancel);
    hdr.appendChild(upBtn);
    hdr.appendChild(pathLabel);
    hdr.appendChild(cancelBtn);
    wrap.appendChild(hdr);

    const list = el("div","max-height:200px;overflow-y:auto;font-size:0.82em;background:#282c34;border-radius:3px;");
    wrap.appendChild(list);

    const status = el("p","font-size:0.74em;color:#7f848e;margin-top:4px;min-height:1em;");
    wrap.appendChild(status);

    let currentPath = null;
    let parentPath  = null;
    const libraryRoots = [];

    function dirRow(icon, label, onClick) {
      const r = el("div","padding:5px 10px;cursor:pointer;display:flex;align-items:center;gap:7px;color:#abb2bf;border-bottom:1px solid #2c313a;");
      r.addEventListener("mouseover", () => r.style.background = "#2c313a");
      r.addEventListener("mouseout",  () => r.style.background = "");
      const ic = el("span","flex-shrink:0;", icon);
      const lb = el("span","word-break:break-all;", label);
      r.appendChild(ic); r.appendChild(lb);
      r.addEventListener("click", onClick);
      return r;
    }

    function basename(p) { return p.replace(/\\/g,"/").split("/").pop() || p; }

    async function showLibraryRoots() {
      list.innerHTML = "";
      status.textContent = "Loading…";
      pathLabel.textContent = "(library roots)";
      upBtn.disabled = true;
      currentPath = null;
      parentPath  = null;

      try {
        const paths = await getLibraryPaths();
        libraryRoots.length = 0;
        paths.forEach(p => libraryRoots.push(p));

        if (paths.length === 0) {
          status.textContent = "No library paths configured in Stash.";
          return;
        }

        // "Use this" row for each library root + navigate in
        paths.forEach(p => {
          const r = dirRow("📚", p, () => navigate(p));
          const useBtn = mkBtn("Select","btn btn-primary btn-sm", e => { e.stopPropagation(); onSelect(p); });
          useBtn.style.cssText += ";margin-left:auto;flex-shrink:0;font-size:0.75em;padding:2px 8px;";
          r.appendChild(useBtn);
          list.appendChild(r);
        });
        status.textContent = `${paths.length} library path(s)`;
      } catch(e) {
        status.textContent = "Error: " + e.message;
      }
    }

    async function navigate(path) {
      list.innerHTML = "";
      status.textContent = "Loading…";
      pathLabel.textContent = path;
      upBtn.disabled = true;

      try {
        const dir = await browseDirectory(path);
        currentPath = dir.path;
        parentPath  = dir.parent;
        pathLabel.textContent = currentPath;

        // Is parent a library root or above?
        const isAtLibraryRoot = libraryRoots.some(r => r.replace(/\\/g,"/").toLowerCase() === (currentPath||"").replace(/\\/g,"/").toLowerCase());
        upBtn.disabled = false;

        // "Select this folder" at top
        const selRow = el("div","padding:5px 10px;cursor:pointer;display:flex;align-items:center;gap:7px;color:#e5c07b;border-bottom:2px solid #3e4451;font-size:0.85em;");
        selRow.textContent = "📂 Select this folder";
        selRow.addEventListener("mouseover", () => selRow.style.background = "#2c313a");
        selRow.addEventListener("mouseout",  () => selRow.style.background = "");
        selRow.addEventListener("click", () => onSelect(currentPath));
        list.appendChild(selRow);

        (dir.directories || []).forEach(d => {
          list.appendChild(dirRow("📁", basename(d), () => navigate(d)));
        });

        status.textContent = `${(dir.directories || []).length} subfolder(s)`;
      } catch(e) {
        status.textContent = "Error: " + e.message;
        upBtn.disabled = true;
      }
    }

    upBtn.addEventListener("click", () => {
      if (currentPath === null) return;
      const isAtLibraryRoot = libraryRoots.some(r =>
        r.replace(/\\/g,"/").toLowerCase() === (currentPath||"").replace(/\\/g,"/").toLowerCase()
      );
      if (isAtLibraryRoot || !parentPath) showLibraryRoots();
      else navigate(parentPath);
    });

    showLibraryRoots();
    return wrap;
  }

  // ── Conditions ─────────────────────────────────────────────────────────────

  const CONDITIONS = [
    ["performer_is_favourite", "Performer is favourite"],
    ["studio_equals",          "Studio equals"],
    ["studio_contains",        "Studio contains"],
    ["tag_equals",             "Has tag"],
    ["performer_equals",       "Performer equals"],
  ];
  const NEEDS_VALUE = new Set(["studio_equals","studio_contains","tag_equals","performer_equals"]);

  // ── Settings tab ───────────────────────────────────────────────────────────

  function buildSettingsPane(config, onSaved) {
    const wrap = el("div","");

    // ── Roots ──
    wrap.appendChild(el("p","font-size:0.78em;color:#5c6370;margin-bottom:12px;",
      "Config is saved to SceneMover.json in the plugin folder. It reloads from that file each time Stash restarts — you only need to set this up once."));
    wrap.appendChild(el("p","font-size:0.8em;color:#abb2bf;font-weight:700;letter-spacing:0.06em;margin-bottom:8px;","ROOT FOLDERS"));
    const rootsList = el("div","");
    wrap.appendChild(rootsList);

    function renderRoots() {
      rootsList.innerHTML = "";

      config.roots.forEach((root, idx) => {
        const card = el("div","background:#1e2127;border:1px solid #3e4451;border-radius:5px;padding:10px;margin-bottom:8px;");

        // Row 1: label | path | browse | default | delete
        const r1 = el("div","display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:6px;");
        const labelIn = styledInput(root.label, "Label", "width:110px;");
        labelIn.addEventListener("input", () => root.label = labelIn.value);

        const pathIn = styledInput(root.path, "e.g. I:\\FTVGirls", "flex:1;min-width:160px;");
        pathIn.addEventListener("input", () => root.path = pathIn.value);

        const browseBtn = mkBtn("📂","btn btn-secondary btn-sm", () => {
          // Toggle browser
          if (browserWrap.style.display === "none") {
            browserWrap.style.display = "";
            browseBtn.classList.replace("btn-secondary","btn-primary");
          } else {
            browserWrap.style.display = "none";
            browseBtn.classList.replace("btn-primary","btn-secondary");
          }
        });
        browseBtn.title = "Browse for folder";

        const defWrap = el("label","display:flex;align-items:center;gap:4px;font-size:0.78em;color:#7f848e;cursor:pointer;white-space:nowrap;");
        const defChk  = document.createElement("input");
        defChk.type = "checkbox"; defChk.checked = !!root.isDefault;
        defChk.addEventListener("change", () => {
          config.roots.forEach(r => r.isDefault = false);
          root.isDefault = defChk.checked;
          renderRoots();
        });
        defWrap.appendChild(defChk);
        defWrap.appendChild(document.createTextNode("Default"));

        const delBtn = mkBtn("✕","btn btn-danger btn-sm", () => { config.roots.splice(idx,1); renderRoots(); });

        [labelIn, pathIn, browseBtn, defWrap, delBtn].forEach(x => r1.appendChild(x));
        card.appendChild(r1);

        // Folder browser (hidden by default)
        const browserWrap = el("div","display:none;margin-bottom:6px;");
        let browserBuilt = false;
        card.appendChild(browserWrap);

        // Rebuild browser lazily when shown
        const origBrowseClick = browseBtn.onclick;
        browseBtn.addEventListener("click", () => {
          if (browserWrap.style.display !== "none" && !browserBuilt) {
            browserBuilt = true;
            const browser = buildFolderBrowser(
              (selectedPath) => {
                pathIn.value = selectedPath;
                root.path = selectedPath;
                browserWrap.style.display = "none";
                browseBtn.classList.replace("btn-primary","btn-secondary");
              },
              () => {
                browserWrap.style.display = "none";
                browseBtn.classList.replace("btn-primary","btn-secondary");
              }
            );
            browserWrap.appendChild(browser);
          }
        });

        // Row 2: template
        const r2 = el("div","display:flex;gap:6px;align-items:center;margin-bottom:4px;");
        r2.appendChild(el("span","font-size:0.76em;color:#7f848e;white-space:nowrap;","Template:"));
        const tmplIn = styledInput(root.template,"","flex:1;font-family:monospace;font-size:0.8em;");
        tmplIn.placeholder = "{studio}\\{date}.{title}.{performers}.{codec}.{height}.{ext}";
        tmplIn.addEventListener("input", () => root.template = tmplIn.value);
        r2.appendChild(tmplIn);
        card.appendChild(r2);

        // Token picker
        const pickerLabel = el("div","font-size:0.72em;color:#5c6370;margin-bottom:3px;","Click a token to insert at cursor:");
        card.appendChild(pickerLabel);
        card.appendChild(buildTokenPicker(tmplIn));

        rootsList.appendChild(card);
      });

      rootsList.appendChild(mkBtn("+ Add Root Folder","btn btn-secondary btn-sm", () => {
        config.roots.push({ id: uid(), label:"New Root", path:"", template:"{studio}.{date}.{title}.{performers}.{codec}.{height}.{ext}", isDefault:false });
        renderRoots();
      }));
    }

    renderRoots();

    // ── Rules ──
    wrap.appendChild(el("div","margin-top:16px;"));
    wrap.appendChild(el("p","font-size:0.8em;color:#abb2bf;font-weight:700;letter-spacing:0.06em;margin-bottom:4px;","RULES  (top = highest priority)"));
    wrap.appendChild(el("p","font-size:0.75em;color:#7f848e;margin-bottom:8px;","First matching rule wins. Use ↑↓ to reorder."));

    const rulesList = el("div","");
    wrap.appendChild(rulesList);

    function renderRules() {
      rulesList.innerHTML = "";
      config.rules.forEach((rule, idx) => {
        const card = el("div","background:#1e2127;border:1px solid #3e4451;border-radius:5px;padding:10px;margin-bottom:8px;");
        const r1   = el("div","display:flex;gap:6px;align-items:center;flex-wrap:wrap;");

        const upBtn = mkBtn("↑","btn btn-secondary btn-sm", () => {
          if (idx === 0) return;
          [config.rules[idx-1],config.rules[idx]] = [config.rules[idx],config.rules[idx-1]];
          renderRules();
        });
        const dnBtn = mkBtn("↓","btn btn-secondary btn-sm", () => {
          if (idx >= config.rules.length-1) return;
          [config.rules[idx],config.rules[idx+1]] = [config.rules[idx+1],config.rules[idx]];
          renderRules();
        });

        const enChk = document.createElement("input");
        enChk.type = "checkbox"; enChk.checked = rule.enabled !== false; enChk.title = "Enabled";
        enChk.addEventListener("change", () => rule.enabled = enChk.checked);

        const labelIn = styledInput(rule.label,"Label","width:110px;");
        labelIn.addEventListener("input", () => rule.label = labelIn.value);

        const condSel = styledSelect(CONDITIONS, rule.condition, "");
        const valueIn = styledInput(rule.value,"Value","width:110px;");
        valueIn.style.display = NEEDS_VALUE.has(rule.condition) ? "" : "none";
        condSel.addEventListener("change", () => {
          rule.condition = condSel.value;
          valueIn.style.display = NEEDS_VALUE.has(condSel.value) ? "" : "none";
        });
        valueIn.addEventListener("input", () => rule.value = valueIn.value);

        const rootOpts = [["","— select root —"], ...config.roots.map(r => [r.id, r.label||r.path])];
        const rootSel  = styledSelect(rootOpts, rule.rootId, "");
        rootSel.addEventListener("change", () => rule.rootId = rootSel.value);

        const delBtn = mkBtn("✕","btn btn-danger btn-sm", () => { config.rules.splice(idx,1); renderRules(); });

        [upBtn,dnBtn,enChk,labelIn,condSel,valueIn,
         el("span","font-size:0.8em;color:#7f848e;","→"), rootSel, delBtn]
          .forEach(x => r1.appendChild(x));

        card.appendChild(r1);
        rulesList.appendChild(card);
      });

      rulesList.appendChild(mkBtn("+ Add Rule","btn btn-secondary btn-sm", () => {
        config.rules.push({ id:uid(), label:"New Rule", condition:"studio_equals", value:"", rootId:"", enabled:true });
        renderRules();
      }));
    }

    renderRules();

    // Save
    const saveStatus = el("span","font-size:0.82em;color:#7f848e;margin-left:10px;");
    const saveBtn    = mkBtn("Save Settings","btn btn-success btn-sm", async () => {
      saveBtn.disabled = true; saveBtn.textContent = "Saving…";
      try {
        await saveConfig(config);
        saveStatus.textContent = "✓ Saved"; saveStatus.style.color = "#98c379";
        if (onSaved) onSaved(config);
      } catch(e) {
        saveStatus.textContent = "Error: " + e.message; saveStatus.style.color = "#e06c75";
      }
      saveBtn.disabled = false; saveBtn.textContent = "Save Settings";
    });
    const saveRow = el("div","display:flex;align-items:center;gap:8px;margin-top:12px;");
    saveRow.appendChild(saveBtn);
    saveRow.appendChild(saveStatus);
    wrap.appendChild(saveRow);

    return wrap;
  }

  // ── Move tab ───────────────────────────────────────────────────────────────

  function buildMovePane(getSceneId) {
    const wrap = el("div","");

    // Source path
    const srcRow = el("div","display:flex;gap:8px;align-items:center;margin-bottom:6px;");
    srcRow.appendChild(el("span","font-size:0.82em;color:#7f848e;white-space:nowrap;","Source folder:"));
    const srcIn = styledInput("","Leave blank for current scene or enter a folder path","flex:1;");
    const srcBrowseBtn = mkBtn("📂","btn btn-secondary btn-sm");
    srcBrowseBtn.title = "Browse for folder";
    srcRow.appendChild(srcIn);
    srcRow.appendChild(srcBrowseBtn);
    wrap.appendChild(srcRow);

    // Folder browser for source path
    const srcBrowserWrap = el("div","display:none;margin-bottom:10px;");
    wrap.appendChild(srcBrowserWrap);
    let srcBrowserBuilt = false;

    srcBrowseBtn.addEventListener("click", () => {
      if (srcBrowserWrap.style.display === "none") {
        srcBrowserWrap.style.display = "";
        srcBrowseBtn.classList.replace("btn-secondary","btn-primary");
        if (!srcBrowserBuilt) {
          srcBrowserBuilt = true;
          srcBrowserWrap.appendChild(buildFolderBrowser(
            (selectedPath) => {
              srcIn.value = selectedPath;
              srcBrowserWrap.style.display = "none";
              srcBrowseBtn.classList.replace("btn-primary","btn-secondary");
              runPreview();
            },
            () => {
              srcBrowserWrap.style.display = "none";
              srcBrowseBtn.classList.replace("btn-primary","btn-secondary");
            }
          ));
        }
      } else {
        srcBrowserWrap.style.display = "none";
        srcBrowseBtn.classList.replace("btn-primary","btn-secondary");
      }
    });

    // Preview results list
    const previewEl = el("div","margin:10px 0;");
    wrap.appendChild(previewEl);

    // Action row — Refresh preview + Apply
    const actionRow = el("div","display:flex;gap:8px;margin-bottom:10px;");
    const refreshBtn = mkBtn("↻ Refresh","btn btn-secondary btn-sm");
    const applyBtn   = mkBtn("▶ Apply Moves","btn btn-warning btn-sm");
    applyBtn.disabled = true;
    actionRow.appendChild(refreshBtn);
    actionRow.appendChild(applyBtn);
    wrap.appendChild(actionRow);

    const statusEl = el("p","font-size:0.82em;color:#7f848e;min-height:1.2em;","");
    wrap.appendChild(statusEl);

    let _plans = [];

    async function runPreview() {
      previewEl.innerHTML = "";
      applyBtn.disabled = true;
      refreshBtn.disabled = true;
      statusEl.textContent = "Loading preview…";
      statusEl.style.color = "#7f848e";

      const sceneId = getSceneId ? getSceneId() : null;
      const srcPath = srcIn.value.trim();
      const extraArgs = {};
      if (sceneId) extraArgs.scene_id    = sceneId;
      if (srcPath) extraArgs.source_path = srcPath;

      try {
        // Call preview mode via GraphQL directly so we get the result back
        const args = [
          { key: "mode", value: { str: "preview" } },
          ...Object.entries(extraArgs).map(([k,v]) => ({ key: k, value: { str: String(v) } }))
        ];
        await gql(`mutation R($p:ID!,$t:String!,$a:[PluginArgInput!]){runPluginTask(plugin_id:$p,task_name:$t,args:$a)}`,
          { p: PLUGIN_ID, t: "Preview Moves", a: args });

        // runPluginTask is async — poll for a moment then fetch plans via a second preview
        // Actually we must re-run preview via Python to get structured data.
        // For now display a message directing to logs, but also fetch plans inline via JS rule engine
        const cfg = _config || loadConfigFromStorage() || defaultConfig();
        const plans = await buildPreviewPlans(sceneId, srcPath, cfg);
        _plans = plans;

        if (!plans.length) {
          previewEl.appendChild(el("p","color:#7f848e;font-size:0.85em;","No scenes found."));
          statusEl.textContent = "";
          refreshBtn.disabled = false;
          return;
        }

        const toMove = plans.filter(p => !p.skip);
        const toSkip = plans.filter(p => p.skip);

        statusEl.textContent = `${toMove.length} to move, ${toSkip.length} to skip`;
        statusEl.style.color = toMove.length ? "#e5c07b" : "#98c379";

        toMove.forEach(p => {
          const row = el("div","margin-bottom:10px;padding:8px;background:#1e2127;border-radius:5px;border-left:3px solid #e5c07b;font-size:0.8em;");
          row.appendChild(el("div","color:#7f848e;margin-bottom:2px;", p.title || p.src));
          row.appendChild(el("div","color:#abb2bf;word-break:break-all;margin-bottom:2px;", "📂 " + p.src));
          row.appendChild(el("div","color:#98c379;word-break:break-all;", "→ " + p.dest));
          previewEl.appendChild(row);
        });

        toSkip.forEach(p => {
          const row = el("div","margin-bottom:6px;padding:6px 8px;background:#1e2127;border-radius:5px;border-left:3px solid #4b5263;font-size:0.78em;color:#5c6370;");
          row.appendChild(el("div","", (p.title || p.src) + " — " + p.reason));
          previewEl.appendChild(row);
        });

        applyBtn.disabled = toMove.length === 0;
      } catch(e) {
        statusEl.textContent = "Error: " + e.message;
        statusEl.style.color = "#e06c75";
      }
      refreshBtn.disabled = false;
    }

    async function buildPreviewPlans(sceneId, srcPath, cfg) {
      // Rule engine helpers (mirrors overlay IIFE — can't cross IIFE boundaries)
      function resolveRoot(scene) {
        const rootMap = {};
        (cfg.roots || []).forEach(r => rootMap[r.id] = r);
        for (const rule of (cfg.rules || [])) {
          if (rule.enabled === false) continue;
          const val = (rule.value || "").toLowerCase().trim();
          let hit = false;
          if      (rule.condition === "performer_is_favourite") hit = (scene.performers || []).some(p => p.favorite);
          else if (rule.condition === "studio_equals")          hit = ((scene.studio && scene.studio.name) || "").toLowerCase().trim() === val;
          else if (rule.condition === "studio_contains")        hit = ((scene.studio && scene.studio.name) || "").toLowerCase().includes(val);
          else if (rule.condition === "tag_equals")             hit = (scene.tags || []).some(t => t.name.toLowerCase().trim() === val);
          else if (rule.condition === "performer_equals")       hit = (scene.performers || []).some(p => p.name.toLowerCase().trim() === val);
          if (hit && rootMap[rule.rootId]) return rootMap[rule.rootId];
        }
        return (cfg.roots || []).find(r => r.isDefault) || null;
      }

      function san(s) { return (s || "").replace(/[\\/:*?"<>|]/g, "").trim(); }
      function renderTemplate(tmpl, scene, file) {
        const studio  = san((scene.studio && scene.studio.name) || "");
        const date    = scene.date || "";
        const perfs   = (scene.performers || []).map(p => san(p.name)).filter(Boolean);
        const favs    = (scene.performers || []).filter(p => p.favorite).map(p => san(p.name)).sort((a,b) => a.toLowerCase().localeCompare(b.toLowerCase()));
        const favName = favs[0] || perfs[0] || "";
        const ext     = ((file.basename || file.path || "").split(".").pop());
        const tok = {
          "{studio}": studio, "{studioFirstLetter}": studio ? studio[0].toUpperCase() : "",
          "{studioInitial}": studio ? studio[0].toUpperCase() : "",
          "{date}": san(date), "{yyyy-MM-dd}": san(date),
          "{yyyy-MM}": date.length >= 7 ? date.slice(0,7) : "",
          "{yyyy}": date.length >= 4 ? date.slice(0,4) : "",
          "{MM-dd}": date.length >= 10 ? date.slice(5,10) : "",
          "{title}": san(scene.title || ""), "{performers}": perfs.join(", "),
          "{favoritedPerformer}": favName,
          "{favoritedPerformerInitial}": favName ? favName[0].toUpperCase() : "",
          "{favoritedPerformerFirstLetter}": favName ? favName[0].toUpperCase() : "",
          "{codec}": san((file.video_codec) || ""), "{height}": String(file.height || ""),
          "{ext}": ext, "{scene_id}": (c => c.length < 10 ? c : "")(san(scene.code || "")),
        };
        let r = tmpl;
        Object.entries(tok).forEach(([k,v]) => { r = r.split(k).join(v); });
        return r.replace(/\.{2,}/g, ".").replace(/ {2,}/g, " ");
      }

      // Fetch scenes
      let scenes = [];
      if (sceneId) {
        const d = await gql(`query($id:ID!){findScene(id:$id){id title date code studio{name} performers{name favorite} tags{name} files{path basename video_codec height}}}`, { id: sceneId });
        if (d && d.findScene) scenes = [d.findScene];
      } else if (srcPath) {
        const norm = srcPath.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
        const d = await gql(`query($p:String!){findScenes(scene_filter:{path:{value:$p,modifier:INCLUDES}},filter:{per_page:-1}){scenes{id title date code studio{name} performers{name favorite} tags{name} files{path basename video_codec height}}}}`, { p: srcPath.split(/[/\\]/).pop() });
        scenes = ((d && d.findScenes && d.findScenes.scenes) || []).filter(s =>
          (s.files || []).some(f => f.path.replace(/\\/g,"/").toLowerCase().startsWith(norm))
        );
      }

      const plans = [];
      for (const scene of scenes) {
        const root = resolveRoot(scene);
        for (const file of (scene.files || [])) {
          if (!root) { plans.push({ title: scene.title, src: file.path, skip: true, reason: "No matching root" }); continue; }
          const rendered = renderTemplate(root.template || "", scene, file);
          const parts = rendered.replace(/\\/g, "/").split("/");
          const destFolder = [root.path.replace(/[/\\]+$/, ""), ...parts.slice(0, -1)].join("\\");
          const dest = destFolder + "\\" + parts[parts.length - 1];
          const same = file.path.replace(/\\/g,"/").toLowerCase() === dest.replace(/\\/g,"/").toLowerCase();
          plans.push({ title: scene.title, src: file.path, dest, skip: same, reason: same ? "Already correct" : null });
        }
      }
      return plans;
    }

    refreshBtn.addEventListener("click", runPreview);

    applyBtn.addEventListener("click", async () => {
      applyBtn.disabled = refreshBtn.disabled = true;
      statusEl.textContent = "Moving…";
      statusEl.style.color = "#7f848e";
      try {
        const sceneId = getSceneId ? getSceneId() : null;
        const srcPath = srcIn.value.trim();
        const extraArgs = {};
        if (sceneId) extraArgs.scene_id    = sceneId;
        if (srcPath) extraArgs.source_path = srcPath;
        await runPluginTask("Apply Moves", "apply", extraArgs);
        statusEl.textContent = "✓ Move started — check Stash task queue";
        statusEl.style.color = "#98c379";
        // Re-run preview after delay to update results
        setTimeout(runPreview, 4000);
      } catch(e) {
        statusEl.textContent = "Error: " + e.message;
        statusEl.style.color = "#e06c75";
        applyBtn.disabled = refreshBtn.disabled = false;
      }
    });

    // Auto-run preview when pane is shown
    setTimeout(runPreview, 100);

    return wrap;
  }

  // ── Modal ──────────────────────────────────────────────────────────────────

  let _modal    = null;
  let _config   = null;

  function closeModal() { if (_modal) _modal.style.display = "none"; }

  async function openModal() {
    if (_modal) { _modal.style.display = "flex"; return; }

    // Build modal shell
    const overlay = document.createElement("div");
    overlay.id = MODAL_ID;
    overlay.style.cssText = "position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;";
    overlay.addEventListener("click", e => { if (e.target === overlay) closeModal(); });

    const panel = el("div","background:#282c34;border:1px solid #3e4451;border-radius:8px;padding:20px 24px;width:min(800px,94vw);max-height:88vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,0.5);display:flex;flex-direction:column;gap:0;");

    // Header
    const hdr = el("div","display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;");
    hdr.appendChild(el("h5","color:#abb2bf;margin:0;font-size:1em;","SceneMover"));
    const closeBtn = mkBtn("✕","", closeModal);
    closeBtn.style.cssText = "background:none;border:none;color:#7f848e;cursor:pointer;font-size:1.1em;padding:0 4px;";
    hdr.appendChild(closeBtn);
    panel.appendChild(hdr);

    // Tabs
    const tabRow   = el("div","display:flex;gap:4px;margin-bottom:14px;border-bottom:1px solid #3e4451;padding-bottom:8px;");
    const tabBtns  = {};
    const tabPanes = {};

    ["⚙ Settings","▶ Move"].forEach(label => {
      const b = mkBtn(label,"btn btn-secondary btn-sm");
      tabRow.appendChild(b);
      tabBtns[label] = b;
      const p = el("div","");
      panel.appendChild(p);
      tabPanes[label] = p;

      b.addEventListener("click", () => {
        Object.values(tabBtns).forEach(x  => x.className = "btn btn-secondary btn-sm");
        Object.values(tabPanes).forEach(x => x.style.display = "none");
        b.className = "btn btn-primary btn-sm";
        p.style.display = "";
      });
    });

    panel.insertBefore(tabRow, tabPanes["⚙ Settings"]);

    // Load config from localStorage (fast, synchronous)
    if (!_config) {
      _config = loadConfigFromStorage() || defaultConfig();
    }

    tabPanes["⚙ Settings"].appendChild(buildSettingsPane(_config, cfg => { _config = cfg; }));
    tabPanes["▶ Move"].appendChild(buildMovePane(() => {
      const m = window.location.pathname.match(/^\/scenes\/(\d+)/);
      return m ? m[1] : null;
    }));

    // Default tab: Move if config has roots, Settings if not yet configured
    const hasConfig = _config.roots && _config.roots.length > 0;
    const defaultTab = hasConfig ? "▶ Move" : "⚙ Settings";
    tabBtns[defaultTab].className = "btn btn-primary btn-sm";
    tabPanes[defaultTab === "▶ Move" ? "⚙ Settings" : "▶ Move"].style.display = "none";

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    _modal = overlay;
  }

  // ── Floating button ──────────────────────────────────────────────────────

  function injectButton() {
    if (document.getElementById(BTN_ID)) return;
    const b = document.createElement('button');
    b.id = BTN_ID;
    b.title = 'SceneMover (Ctrl+Shift+M)';
    b.textContent = '📦 Mover';
    b.style.cssText = 'position:fixed;bottom:56px;left:20px;z-index:9999;background:#3a3f4b;border:1px solid #4b5263;border-radius:20px;color:#abb2bf;padding:7px 14px;font-size:0.82em;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,0.4);';
    b.addEventListener('mouseover', () => b.style.background = '#4b5263');
    b.addEventListener('mouseout',  () => b.style.background = '#3a3f4b');
    b.addEventListener('click', openModal);
    document.body.appendChild(b);
  }

  document.addEventListener('keydown', e => {
    if (e.ctrlKey && e.shiftKey && e.key === 'M') {
      e.preventDefault();
      _modal && _modal.style.display === 'flex' ? closeModal() : openModal();
    }
  });

  new MutationObserver(() => { injectButton(); }).observe(document.body, { childList: true });
  injectButton();
  console.log('[SceneMover] Core loaded, button injected');

})();


// ── SceneMover overlay — isolated IIFE ──────────────────────────────────────
(function () {
  "use strict";

  const LS_KEY       = "SceneMover_config";
  const OVERLAY_ATTR = "data-sm-overlay";
  const sceneCache   = {};

  function normPath(p) { return (p || "").replace(/\\/g, "/").toLowerCase(); }
  function san(s)      { return (s || "").replace(/[\\/:*?"<>|]/g, "").trim(); }

  function loadCfg() {
    try {
      const r = localStorage.getItem(LS_KEY);
      if (!r) return null;
      return JSON.parse(r);
    } catch(e) { console.error("[SM-overlay] Config parse error:", e); return null; }
  }

  function resolveRoot(scene, cfg) {
    const rootMap = {};
    (cfg.roots || []).forEach(r => rootMap[r.id] = r);
    for (const rule of (cfg.rules || [])) {
      if (rule.enabled === false) continue;
      const val = (rule.value || "").toLowerCase().trim();
      let hit = false;
      if      (rule.condition === "performer_is_favourite") hit = (scene.performers || []).some(p => p.favorite);
      else if (rule.condition === "studio_equals")          hit = ((scene.studio && scene.studio.name) || "").toLowerCase().trim() === val;
      else if (rule.condition === "studio_contains")        hit = ((scene.studio && scene.studio.name) || "").toLowerCase().includes(val);
      else if (rule.condition === "tag_equals")             hit = (scene.tags || []).some(t => t.name.toLowerCase().trim() === val);
      else if (rule.condition === "performer_equals")       hit = (scene.performers || []).some(p => p.name.toLowerCase().trim() === val);
      if (hit && rootMap[rule.rootId]) return rootMap[rule.rootId];
    }
    return (cfg.roots || []).find(r => r.isDefault) || null;
  }

  const WIN_MAX_PATH = 259;

  function fitToMaxPath(destFolder, basename, tmpl, scene, file) {
    const full = destFolder + "\\" + basename;
    if (full.length <= WIN_MAX_PATH) return basename;

    const studio  = san((scene.studio && scene.studio.name) || "");
    const date    = scene.date || "";
    const perfs   = (scene.performers || []).map(p => san(p.name)).filter(Boolean);
    const favs    = (scene.performers || []).filter(p => p.favorite).map(p => san(p.name)).sort((a,b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    const favName = favs[0] || perfs[0] || "";
    const ext     = ((file.basename || file.path || "").split(".").pop());

    function tryBuild(titleVal, perfsVal) {
      const tok = {
        "{studio}": studio, "{studioFirstLetter}": studio ? studio[0].toUpperCase() : "",
        "{studioInitial}": studio ? studio[0].toUpperCase() : "",
        "{date}": san(date), "{yyyy-MM-dd}": san(date),
        "{yyyy-MM}": date.length >= 7 ? date.slice(0,7) : "",
        "{yyyy}":    date.length >= 4 ? date.slice(0,4) : "",
        "{MM-dd}":   date.length >= 10 ? date.slice(5,10) : "",
        "{title}": titleVal, "{performers}": perfsVal,
        "{favoritedPerformer}": favName,
        "{favoritedPerformerInitial}": favName ? favName[0].toUpperCase() : "",
        "{favoritedPerformerFirstLetter}": favName ? favName[0].toUpperCase() : "",
        "{codec}": san((file.video_codec) || ""), "{height}": String(file.height || ""),
        "{ext}": ext, "{scene_id}": (c => c.length < 10 ? c : "")(san(scene.code || "")),
      };
      let r = tmpl;
      Object.entries(tok).forEach(([k,v]) => { r = r.split(k).join(v); });
      r = r.replace(/\.{2,}/g, ".").replace(/ {2,}/g, " ");
      return r.replace(/\\/g, "/").split("/").pop();
    }

    const titleFull = san(scene.title || "");
    const perfsFull = perfs.join(", ");

    // Step 1: trim title
    const overflow1 = full.length - WIN_MAX_PATH;
    const titleTrimmed = titleFull.slice(0, Math.max(0, titleFull.length - overflow1)).trimEnd();
    const b1 = tryBuild(titleTrimmed, perfsFull);
    if ((destFolder + "\\" + b1).length <= WIN_MAX_PATH) return b1;

    // Step 2: trim performers too
    const full2 = destFolder + "\\" + b1;
    const overflow2 = full2.length - WIN_MAX_PATH;
    const perfsTrimmed = perfsFull.slice(0, Math.max(0, perfsFull.length - overflow2)).trimEnd();
    return tryBuild("", perfsTrimmed);
  }

  function renderTmpl(tmpl, scene, file) {
    const studio  = san((scene.studio && scene.studio.name) || "");
    const date    = scene.date || "";
    const perfs   = (scene.performers || []).map(p => san(p.name)).filter(Boolean);
    const favs    = (scene.performers || []).filter(p => p.favorite).map(p => san(p.name)).sort((a,b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    const favName = favs[0] || perfs[0] || "";
    const ext     = ((file.basename || file.path || "").split(".").pop());
    const tok = {
      "{studio}": studio, "{studioFirstLetter}": studio ? studio[0].toUpperCase() : "",
      "{studioInitial}": studio ? studio[0].toUpperCase() : "",
      "{date}": san(date), "{yyyy-MM-dd}": san(date),
      "{yyyy-MM}": date.length >= 7 ? date.slice(0,7) : "",
      "{yyyy}":    date.length >= 4 ? date.slice(0,4) : "",
      "{MM-dd}":   date.length >= 10 ? date.slice(5,10) : "",
      "{title}": san(scene.title || ""),
      "{performers}": perfs.join(", "),
      "{favoritedPerformer}": favName,
      "{favoritedPerformerInitial}": favName ? favName[0].toUpperCase() : "",
      "{favoritedPerformerFirstLetter}": favName ? favName[0].toUpperCase() : "",
      "{codec}": san((file.video_codec) || ""), "{height}": String(file.height || ""),
      "{ext}": ext, "{scene_id}": (c => c.length < 10 ? c : "")(san(scene.code || "")),
    };
    let r = tmpl;
    Object.entries(tok).forEach(([k,v]) => { r = r.split(k).join(v); });
    return r.replace(/\.{2,}/g, ".").replace(/ {2,}/g, " ");
  }

  // Build dest path applying MAX_PATH truncation, mirrors Python fit_to_max_path
  function buildDest(root, scene, file) {
    const rendered = renderTmpl(root.template || "", scene, file);
    const parts = rendered.replace(/\\/g, "/").split("/");
    const destFolder = [root.path.replace(/[/\\]+$/, ""), ...parts.slice(0, -1)].join("\\");
    const rawBasename = parts[parts.length - 1];
    const basename = fitToMaxPath(destFolder, rawBasename, root.template || "", scene, file);
    return { destFolder, basename, dest: destFolder + "\\" + basename };
  }

  function checkScene(scene, cfg) {
    if (!scene.organized) return null;
    const root = resolveRoot(scene, cfg);
    if (!root || !root.path) return null;
    const normRoot = normPath(root.path);

    let worstStatus = null;
    for (const f of (scene.files || [])) {
      const normFile = normPath(f.path);
      if (normFile.startsWith(normRoot)) {
        if (root.template) {
          const { basename: expBase } = buildDest(root, scene, f);
          const actBase = normPath(f.basename || f.path.split(/[/\\]/).pop());
          if (expBase && actBase === normPath(expBase)) return null;
          worstStatus = worstStatus || "filename";
        } else {
          return null;
        }
      } else {
        const fileDrive = normFile.match(/^([a-z]:)/)?.[1] || "";
        const rootDrive = normRoot.match(/^([a-z]:)/)?.[1] || "";
        if (fileDrive && rootDrive && fileDrive !== rootDrive) {
          worstStatus = "drive";
        } else {
          worstStatus = worstStatus === "drive" ? "drive" : "path";
        }
      }
    }
    return worstStatus;
  }

  async function fetchScenes(ids) {
    if (!ids.length) return;
    try {
      const results = await Promise.all(ids.map(async id => {
        const r = await fetch("/graphql", { method:"POST", headers:{"Content-Type":"application/json"},
          body:JSON.stringify({ query:"query($id:ID!){findScene(id:$id){id title date code organized studio{name} performers{name favorite} tags{name} files{path basename video_codec height}}}", variables:{id} }) });
        const d = await r.json();
        return (d.data && d.data.findScene) || null;
      }));
      results.filter(Boolean).forEach(s => { sceneCache[s.id] = s; });
    } catch(e) {
      console.error("[SM-overlay] fetchScenes failed:", e.message);
    }
  }

  // Find the card container from a thumbnail link, then inject badge into the
  // footer bar that contains the organised/tag/performer counts
  async function applyMove(sceneId, badge) {
    badge.textContent = "⏳";
    badge.style.cursor = "wait";
    badge.title = "Moving...";
    try {
      const args = [
        { key: "mode",     value: { str: "apply"    } },
        { key: "scene_id", value: { str: String(sceneId) } },
      ];
      await fetch("/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `mutation Run($plugin_id:ID!,$task_name:String!,$args:[PluginArgInput!]) { runPluginTask(plugin_id:$plugin_id,task_name:$task_name,args:$args) }`,
          variables: { plugin_id: "SceneMover", task_name: "Apply Moves", args }
        })
      });
      // Mark done — remove from cache so re-scan re-checks the new path
      delete sceneCache[sceneId];
      const card = badge.closest("article") || badge.closest(".card") || badge.parentElement;
      if (card) card.removeAttribute(OVERLAY_ATTR);
      badge.textContent = "✅";
      badge.title = "Moved — scene will update on next scan";
      badge.style.cursor = "default";
      // Re-scan after a short delay to update the badge
      setTimeout(() => schedule(), 3000);
    } catch(e) {
      badge.textContent = "❌";
      badge.title = "Move failed: " + e.message;
      badge.style.cursor = "pointer";
    }
  }

  function getDestination(scene, cfg) {
    const root = resolveRoot(scene, cfg);
    if (!root || !root.path) return null;
    const file = (scene.files || [])[0];
    if (!file) return null;
    return buildDest(root, scene, file).dest;
  }

  function injectBadge(thumbLink, status, sceneId, cfg) {
    const card = thumbLink.closest("article") || thumbLink.closest(".card") || thumbLink.parentElement;
    if (!card) return;
    card.querySelectorAll(".sm-badge").forEach(e => e.remove());
    if (!status) return;

    const scene = sceneCache[sceneId];
    const file  = scene && (scene.files || [])[0];
    const src   = file ? file.path : null;
    const dest  = scene ? getDestination(scene, cfg) : null;

    const badge = document.createElement("div");
    badge.className = "sm-badge";

    const label = status === "drive" ? "Wrong drive" : status === "path" ? "Wrong folder" : "Filename mismatch";
    badge.title = src && dest
      ? `${label}\n\nFrom: ${src}\nTo:   ${dest}\n\nClick to move`
      : `${label} — click to move`;

    // Position absolutely on the card — bottom-left corner, above everything
    badge.style.cssText = "position:absolute;bottom:10px;z-index:100;display:flex;align-items:center;justify-content:center;font-size:14px;line-height:1;cursor:pointer;pointer-events:all;";

    badge.textContent = status === "drive" ? "💾" : status === "path" ? "\u26d4" : "\u26a0";

    badge.addEventListener("mouseenter", e => e.stopPropagation());
    badge.addEventListener("mouseleave", e => e.stopPropagation());
    badge.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      applyMove(sceneId, badge);
    });

    // Ensure the card has position:relative so absolute child is anchored to it
    if (getComputedStyle(card).position === "static") card.style.position = "relative";
    card.appendChild(badge);
  }

  async function scan() {
    const cfg = loadCfg();
    if (!cfg || !cfg.roots.length) return;

    const seen = new Set();
    const batch = [];
    const linkMap = {};   // id -> thumbLink

    document.querySelectorAll("a[href*='/scenes/']").forEach(a => {
      const m = a.href.match(/\/scenes\/(\d+)/);
      if (!m || !a.querySelector("img")) return;
      const id = m[1];
      if (seen.has(id)) return;
      seen.add(id);
      // Check card-level attr to avoid reprocessing
      const card = a.closest("article") || a.closest(".card") || a.parentElement;
      if (card && card.getAttribute(OVERLAY_ATTR)) return;
      if (card) card.setAttribute(OVERLAY_ATTR, "pending");
      linkMap[id] = a;
      if (!sceneCache[id]) batch.push(id);
    });

    const total = Object.keys(linkMap).length;
    if (!total) return;

    for (let i = 0; i < batch.length; i += 50) await fetchScenes(batch.slice(i, i+50));

    Object.entries(linkMap).forEach(([id, thumbLink]) => {
      try {
        const card  = thumbLink.closest("article") || thumbLink.closest(".card") || thumbLink.parentElement;
        const scene = sceneCache[id];
        if (!scene) { if (card) card.setAttribute(OVERLAY_ATTR, "no-data"); return; }
        const status = checkScene(scene, cfg);
        if (card) card.setAttribute(OVERLAY_ATTR, status || "ok");
        injectBadge(thumbLink, status, id, cfg);
      } catch(e) {
        console.error("[SM-overlay] scan error for scene", id, e);
      }
    });
  }

  // ── Scan scheduling — defined early so all code below can reference it ──────

  let _timer = null;

  // ── Bulk action button ────────────────────────────────────────────────────

  function getSelectedSceneIds() {
    // Stash marks selected cards with a checked checkbox input
    const ids = [];
    document.querySelectorAll("input[type='checkbox']:checked").forEach(cb => {
      const card = cb.closest("article") || cb.closest(".card") || cb.parentElement;
      if (!card) return;
      const link = card.querySelector("a[href*='/scenes/']");
      if (!link) return;
      const m = link.href.match(/\/scenes\/(\d+)/);
      if (m) ids.push(m[1]);
    });
    return [...new Set(ids)];
  }

  async function moveSelected(btn) {
    const ids = getSelectedSceneIds();
    if (!ids.length) { alert("No scenes selected."); return; }

    const orig = btn.textContent;
    btn.textContent = `⏳ Moving ${ids.length}...`;
    btn.disabled = true;

    try {
      // Pass all IDs in one task call so Python processes them sequentially
      // — avoids Stash renaming files with _2 suffix due to concurrent moves
      const args = [
        { key: "mode",     value: { str: "apply" } },
        { key: "scene_ids", value: { str: ids.join(",") } },
      ];
      await fetch("/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `mutation Run($plugin_id:ID!,$task_name:String!,$args:[PluginArgInput!]) { runPluginTask(plugin_id:$plugin_id,task_name:$task_name,args:$args) }`,
          variables: { plugin_id: "SceneMover", task_name: "Apply Moves", args }
        })
      });
      ids.forEach(id => delete sceneCache[id]);
      // Deselect all checked scenes
      document.querySelectorAll("input[type='checkbox']:checked").forEach(cb => cb.click());
      btn.textContent = `✅ Move started (${ids.length} scenes)`;
    } catch(e) {
      btn.textContent = `❌ Failed: ${e.message}`;
      console.error("[SM] Bulk move failed:", e.message);
    }

    btn.disabled = false;
    setTimeout(() => {
      document.querySelectorAll("[" + OVERLAY_ATTR + "]").forEach(e => e.removeAttribute(OVERLAY_ATTR));
      schedule();
    }, 3000);
    setTimeout(() => { btn.textContent = orig; }, 6000);
  }

  function injectBulkButton() {
    if (document.getElementById("sm-bulk-btn")) return;

    // Stash's bulk action bar appears when scenes are selected —
    // it's a div/nav containing "Edit", "Delete" etc buttons
    // Look for it by finding a container with multiple action buttons visible
    const bar =
      document.querySelector(".edit-group") ||
      document.querySelector("[class*='operation-group']") ||
      document.querySelector(".scene-select-all")?.closest("div") ||
      document.querySelector("div.btn-group") ;

    if (!bar) return;

    // Check at least one scene is selected before showing
    if (!getSelectedSceneIds().length) return;

    const btn = document.createElement("button");
    btn.id = "sm-bulk-btn";
    btn.className = "btn btn-secondary btn-sm";
    btn.textContent = "📦 Move Selected";
    btn.style.cssText = "margin-left:8px;";
    btn.addEventListener("click", () => moveSelected(btn));
    bar.appendChild(btn);
  }

  // ── Mismatch filter toggle ─────────────────────────────────────────────────

  let _filterActive = false;
  const FILTER_STYLE_ID = "sm-filter-style";

  function applyFilter(active) {
    _filterActive = active;
    let style = document.getElementById(FILTER_STYLE_ID);
    if (active) {
      if (!style) {
        style = document.createElement("style");
        style.id = FILTER_STYLE_ID;
        document.head.appendChild(style);
      }
      // Hide cards that are marked ok, no-data, or pending (not yet evaluated)
      // Only show cards with path or filename issues
      style.textContent = `
        [${OVERLAY_ATTR}="ok"],
        [${OVERLAY_ATTR}="no-data"],
        [${OVERLAY_ATTR}="pending"] { display: none !important; }
      `;
    } else {
      if (style) style.remove();
    }
  }

  function injectFilterButton() {
    if (document.getElementById("sm-filter-btn")) return;

    const toolbar = document.querySelector(".filtered-list-toolbar");
    if (!toolbar) return;

    const btn = document.createElement("button");
    btn.id = "sm-filter-btn";
    btn.type = "button";
    btn.title = "SceneMover: show only misplaced scenes";
    btn.className = "btn btn-secondary";
    btn.style.cssText = "margin-left:0.5rem;";
    btn.textContent = "📦 Misplaced";

    btn.addEventListener("click", () => {
      _filterActive = !_filterActive;
      applyFilter(_filterActive);
      btn.classList.toggle("btn-secondary", !_filterActive);
      btn.classList.toggle("btn-primary",   _filterActive);
      btn.textContent = _filterActive ? "📦 All Scenes" : "📦 Misplaced";
    });

    toolbar.appendChild(btn);
    console.log("[SM] Filter button injected into .filtered-list-toolbar");
  }

  // schedule — uses wrapped scan so filter re-applies after each scan
  async function scanAndFilter() {
    await scan();
    if (_filterActive) applyFilter(true);
  }
  function schedule() { clearTimeout(_timer); _timer = setTimeout(scanAndFilter, 800); }

  injectFilterButton();

  setInterval(() => {
    injectFilterButton();
    injectBulkButton();
    const btn = document.getElementById("sm-bulk-btn");
    if (btn && !getSelectedSceneIds().length) btn.remove();
  }, 600);

  let _lastUrl = location.href;
  setInterval(() => {
    if (location.href !== _lastUrl) {
      _lastUrl = location.href;
      document.querySelectorAll("[" + OVERLAY_ATTR + "]").forEach(e => e.removeAttribute(OVERLAY_ATTR));
      schedule();
    }
  }, 500);

  // Only trigger scan for mutations that aren't our own badges/buttons
  new MutationObserver(muts => {
    const relevant = muts.some(m => Array.from(m.addedNodes).some(n => {
      if (n.nodeType !== 1) return false;
      const cls = n.className || "";
      return !cls.includes("sm-badge") && n.id !== "sm-bulk-btn";
    }));
    if (relevant) schedule();
  }).observe(document.body, { childList: true, subtree: true });

  schedule();

})();
