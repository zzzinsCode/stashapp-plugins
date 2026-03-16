// v1.1 - DupeFinder - floating button + modal
(function () {
  "use strict";
  console.log("[DupeFinder] Script loaded v1.1");

  const MODAL_ID = "df-modal";
  const BTN_ID   = "df-button";

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

  async function destroyScene(id, deleteFile) {
    return gql(`
      mutation SceneDestroy($input: SceneDestroyInput!) {
        sceneDestroy(input: $input)
      }
    `, { input: { id: String(id), delete_file: deleteFile } });
  }

  async function mergeScenes(sourceIds, destinationId) {
    return gql(`
      mutation MergeScenes($source: [ID!]!, $destination: ID!) {
        sceneMerge(input: { source: $source, destination: $destination }) { id }
      }
    `, { source: sourceIds.map(String), destination: String(destinationId) });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  function el(tag, css, text) {
    const e = document.createElement(tag);
    if (css)  e.style.cssText = css;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function mkBtn(label, bg, onClick) {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText = `background:${bg};border:none;border-radius:4px;color:#fff;padding:4px 11px;font-size:0.8em;cursor:pointer;white-space:nowrap;flex-shrink:0;`;
    b.addEventListener("click", onClick);
    return b;
  }

  function formatBytes(bytes) {
    if (!bytes) return "";
    const gb = bytes / 1073741824;
    if (gb >= 1) return gb.toFixed(2) + " GB";
    return (bytes / 1048576).toFixed(1) + " MB";
  }

  function sceneUrl(id) { return `/scenes/${id}`; }

  function toast(msg, color) {
    const t = el("div",
      `position:fixed;bottom:130px;left:24px;z-index:99999;background:${color || "#3e4451"};` +
      `color:#fff;padding:9px 16px;border-radius:6px;font-size:0.85em;box-shadow:0 2px 8px rgba(0,0,0,0.4);`,
      msg);
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }

  // ── Data fetching ──────────────────────────────────────────────────────────

  const SCENE_FRAGMENT = `
    id title date organized
    studio { name }
    performers { name }
    files { id path basename size video_codec height duration }
  `;

  async function fetchAllScenes(onProgress) {
    const PER_PAGE = 500;
    let page = 1, all = [], total = null;
    while (true) {
      const d = await gql(`
        query($filter: FindFilterType!) {
          findScenes(filter: $filter) {
            count
            scenes { ${SCENE_FRAGMENT} }
          }
        }
      `, { filter: { per_page: PER_PAGE, page, sort: "title" } });
      const { count, scenes } = d.findScenes;
      if (total === null) total = count;
      all = all.concat(scenes);
      if (onProgress) onProgress(all.length, total);
      if (all.length >= total) break;
      page++;
    }
    return all;
  }

  // ── Analysis ───────────────────────────────────────────────────────────────

  function findMultiFileScenes(scenes) {
    return scenes
      .filter(s => s.files && s.files.length > 1)
      .sort((a, b) => b.files.length - a.files.length);
  }

  function findDuplicateScenes(scenes) {
    const groups = {};
    for (const s of scenes) {
      const title  = (s.title  || "").trim().toLowerCase();
      const date   = (s.date   || "").trim();
      const studio = (s.studio ? s.studio.name : "").trim().toLowerCase();
      if (!title && !(date && studio)) continue;
      const key = `${title}||${date}||${studio}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(s);
    }
    return Object.values(groups)
      .filter(g => g.length > 1)
      .sort((a, b) => b.length - a.length);
  }

  // Preferred codecs — lower index = better
  const CODEC_RANK = ["av1", "hevc", "h265", "vp9", "h264", "avc", "mpeg4", "mpeg2"];
  function codecScore(scene) {
    const codec = ((scene.files || [])[0] || {}).video_codec || "";
    const idx = CODEC_RANK.indexOf(codec.toLowerCase());
    return idx === -1 ? CODEC_RANK.length : idx; // lower = better
  }

  // Pick the scene to keep: highest res, then smallest size (efficient encode), then codec rank
  function bestScene(group) {
    return [...group].sort((a, b) => {
      const aRes  = Math.max(...(a.files || []).map(f => f.height || 0));
      const bRes  = Math.max(...(b.files || []).map(f => f.height || 0));
      if (bRes !== aRes) return bRes - aRes;                                         // higher res first
      const aSize = (a.files || []).reduce((n, f) => n + (f.size || 0), 0);
      const bSize = (b.files || []).reduce((n, f) => n + (f.size || 0), 0);
      if (aSize !== bSize) return aSize - bSize;                                     // smaller size first
      return codecScore(a) - codecScore(b);                                          // better codec first
    })[0];
  }

  // ── Styles ─────────────────────────────────────────────────────────────────

  const STYLE = {
    overlay:  "position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9998;display:flex;align-items:center;justify-content:center;",
    modal:    "background:#21252b;border:1px solid #3e4451;border-radius:8px;width:92vw;max-width:1100px;height:88vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.6);z-index:9999;",
    header:   "display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid #3e4451;flex-shrink:0;",
    tabs:     "display:flex;gap:4px;padding:10px 18px 0;border-bottom:1px solid #3e4451;flex-shrink:0;",
    body:     "flex:1;overflow-y:auto;padding:14px 18px;",
    table:    "width:100%;border-collapse:collapse;font-size:0.83em;color:#abb2bf;",
    th:       "text-align:left;padding:7px 10px;border-bottom:1px solid #3e4451;color:#61afef;font-weight:600;white-space:nowrap;",
    td:       "padding:6px 10px;border-bottom:1px solid #2c313a;vertical-align:middle;",
    groupHdr: "background:#2c313a;padding:8px 10px;border-radius:4px;margin:10px 0 4px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;",
    badge:    "display:inline-block;padding:2px 7px;border-radius:10px;font-size:0.78em;font-weight:600;flex-shrink:0;",
    link:     "color:#61afef;text-decoration:none;cursor:pointer;",
    keepBadge:"display:inline-block;padding:1px 6px;border-radius:3px;font-size:0.75em;background:#98c379;color:#21252b;font-weight:700;margin-left:4px;vertical-align:middle;",
  };

  function tabBtn(label, active, onClick) {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText = `background:${active ? "#61afef" : "transparent"};color:${active ? "#21252b" : "#abb2bf"};border:none;border-radius:4px 4px 0 0;padding:7px 16px;font-size:0.85em;cursor:pointer;font-weight:${active ? 700 : 400};`;
    b.addEventListener("click", onClick);
    return b;
  }

  // ── Multi-file tab ─────────────────────────────────────────────────────────

  function renderMultiFileTable(scenes) {
    if (!scenes.length) {
      return el("div", "color:#5c6370;padding:20px 0;text-align:center;", "No multi-file scenes found ✓");
    }

    const wrap = document.createElement("div");
    wrap.appendChild(el("div", "color:#5c6370;font-size:0.83em;margin-bottom:12px;",
      `${scenes.length} scene${scenes.length !== 1 ? "s" : ""} with multiple files`));

    for (const scene of scenes) {
      const sceneWrap = document.createElement("div");

      // Header
      const hdr = el("div", STYLE.groupHdr);
      const link = document.createElement("a");
      link.href = sceneUrl(scene.id);
      link.target = "_blank";
      link.style.cssText = STYLE.link + "font-size:1em;font-weight:600;color:#e5c07b;";
      link.textContent = scene.title || "(untitled)";
      hdr.appendChild(link);
      hdr.appendChild(el("span", STYLE.badge + "background:#e06c75;color:#fff;", `${scene.files.length} files`));
      if (scene.date)   hdr.appendChild(el("span", "color:#5c6370;font-size:0.85em;", scene.date));
      if (scene.studio) hdr.appendChild(el("span", "color:#5c6370;font-size:0.85em;", scene.studio.name));

      // Spacer to push delete to right
      hdr.appendChild(el("span", "flex:1;"));

      // Delete whole scene button
      const delBtn = mkBtn("🗑 Delete scene", "#e06c75", async () => {
        if (!confirm(`Delete scene "${scene.title || "#" + scene.id}" and ALL its files from disk?`)) return;
        delBtn.textContent = "Deleting…"; delBtn.disabled = true;
        try {
          await destroyScene(scene.id, true);
          sceneWrap.remove();
          toast(`Deleted scene #${scene.id}`, "#e06c75");
        } catch(e) {
          toast(`Error: ${e.message}`, "#e06c75");
          delBtn.textContent = "🗑 Delete scene"; delBtn.disabled = false;
        }
      });
      hdr.appendChild(delBtn);
      sceneWrap.appendChild(hdr);

      // File table
      const table = el("table", STYLE.table);
      table.innerHTML = `<thead><tr>
        <th style="${STYLE.th}">Path</th>
        <th style="${STYLE.th}">Res</th>
        <th style="${STYLE.th}">Codec</th>
        <th style="${STYLE.th}">Duration</th>
        <th style="${STYLE.th}">Size</th>
      </tr></thead>`;
      const tbody = document.createElement("tbody");
      const sorted = [...scene.files].sort((a, b) => (b.height || 0) - (a.height || 0));
      sorted.forEach((f, i) => {
        const tr = document.createElement("tr");
        tr.style.background = i > 0 ? "rgba(224,108,117,0.06)" : "";
        const basename = f.basename || f.path.split(/[/\\]/).pop();
        const dir      = f.path.replace(/[/\\][^/\\]+$/, "");
        const keepMark = i === 0 ? `<span style="${STYLE.keepBadge}">best</span>` : "";
        tr.innerHTML = `
          <td style="${STYLE.td}">
            <div style="color:#98c379;font-size:0.9em;">${basename}${keepMark}</div>
            <div style="color:#5c6370;font-size:0.78em;margin-top:2px;">${dir}</div>
          </td>
          <td style="${STYLE.td}color:#abb2bf;">${f.height ? f.height + "p" : ""}</td>
          <td style="${STYLE.td}color:#abb2bf;">${f.video_codec || ""}</td>
          <td style="${STYLE.td}color:#abb2bf;">${f.duration ? Math.round(f.duration / 60) + "m" : ""}</td>
          <td style="${STYLE.td}color:#abb2bf;">${formatBytes(f.size)}</td>
        `;
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      sceneWrap.appendChild(table);
      wrap.appendChild(sceneWrap);
    }

    return wrap;
  }

  // ── Duplicates tab ─────────────────────────────────────────────────────────

  function renderDuplicatesTable(groups) {
    if (!groups.length) {
      return el("div", "color:#5c6370;padding:20px 0;text-align:center;", "No duplicate scenes found ✓");
    }

    const wrap = document.createElement("div");
    wrap.appendChild(el("div", "color:#5c6370;font-size:0.83em;margin-bottom:12px;",
      `${groups.length} group${groups.length !== 1 ? "s" : ""} of duplicates ` +
      `(${groups.reduce((n, g) => n + g.length, 0)} scenes total)`));

    for (const group of groups) {
      const groupWrap = document.createElement("div");
      groupWrap.style.marginBottom = "16px";

      const first    = group[0];
      const keeper   = bestScene(group);
      const titleStr = (first.title  || "(untitled)").trim();
      const dateStr  = first.date    || "";
      const stuStr   = first.studio  ? first.studio.name : "";

      // Group header
      const hdr = el("div", STYLE.groupHdr);
      hdr.appendChild(el("span", "font-size:1em;color:#e5c07b;font-weight:700;", titleStr));
      const countBadge = el("span", STYLE.badge + "background:#c678dd;color:#fff;", `${group.length} scenes`);
      hdr.appendChild(countBadge);
      if (dateStr) hdr.appendChild(el("span", "color:#5c6370;font-size:0.85em;", dateStr));
      if (stuStr)  hdr.appendChild(el("span", "color:#5c6370;font-size:0.85em;", stuStr));
      hdr.appendChild(el("span", "flex:1;"));

      // Merge all into best scene
      const mergeBtn = mkBtn("⚡ Merge all", "#61afef", async () => {
        const sources   = group.filter(s => s.id !== keeper.id);
        const keepTitle = keeper.title || "#" + keeper.id;
        if (!confirm(
          `Merge ${sources.length} scene(s) into "${keepTitle}" (highest resolution)?\n\n` +
          `Source scenes will be removed after merge. Metadata will be combined.`
        )) return;
        mergeBtn.textContent = "Merging…"; mergeBtn.disabled = true;
        try {
          await mergeScenes(sources.map(s => s.id), keeper.id);
          groupWrap.remove();
          toast(`Merged ${sources.length} scene(s) into #${keeper.id}`, "#61afef");
        } catch(e) {
          toast(`Merge error: ${e.message}`, "#e06c75");
          mergeBtn.textContent = "⚡ Merge all"; mergeBtn.disabled = false;
        }
      });
      hdr.appendChild(mergeBtn);
      groupWrap.appendChild(hdr);

      // Scenes table
      const table = el("table", STYLE.table);
      table.innerHTML = `<thead><tr>
        <th style="${STYLE.th}">Scene</th>
        <th style="${STYLE.th}">Files</th>
        <th style="${STYLE.th}">Res</th>
        <th style="${STYLE.th}">Codec</th>
        <th style="${STYLE.th}">Size</th>
        <th style="${STYLE.th}">Organized</th>
        <th style="${STYLE.th}">Performers</th>
        <th style="${STYLE.th}"></th>
      </tr></thead>`;
      const tbody = document.createElement("tbody");

      for (const scene of group) {
        const isKeeper  = scene.id === keeper.id;
        const bestFile  = [...(scene.files || [])].sort((a,b) => (b.height||0)-(a.height||0))[0] || {};
        const totalSize = (scene.files || []).reduce((n,f) => n+(f.size||0), 0);
        const perfs     = (scene.performers || []).map(p => p.name).join(", ");
        const filenames = (scene.files || []).map(f => f.basename || f.path.split(/[/\\]/).pop()).join("<br>");

        const tr = document.createElement("tr");
        tr.style.background = isKeeper ? "rgba(152,195,121,0.07)" : "";

        const tdId = el("td", STYLE.td);
        const idLink = document.createElement("a");
        idLink.href = sceneUrl(scene.id);
        idLink.target = "_blank";
        idLink.style.cssText = STYLE.link;
        idLink.textContent = `#${scene.id}`;
        tdId.appendChild(idLink);
        if (isKeeper) tdId.appendChild(el("span", STYLE.keepBadge, "keep"));

        const tdFiles  = el("td", STYLE.td + "color:#5c6370;font-size:0.78em;");
        tdFiles.innerHTML = filenames;

        const tdRes    = el("td", STYLE.td + "color:#abb2bf;", bestFile.height ? bestFile.height + "p" : "");
        const tdCodec  = el("td", STYLE.td + "color:#abb2bf;", bestFile.video_codec || "");
        const tdSize   = el("td", STYLE.td + "color:#abb2bf;", formatBytes(totalSize));
        const tdOrg    = el("td", STYLE.td + "text-align:center;color:#98c379;", scene.organized ? "✓" : "");
        const tdPerf   = el("td", STYLE.td + "color:#abb2bf;", perfs);

        // Delete button on every row — including the keeper
        const tdAct = el("td", STYLE.td);
        const delBtn = mkBtn("🗑 Delete", "#e06c75", async () => {
          if (!confirm(`Delete scene #${scene.id} "${scene.title || ""}" and its file(s) from disk?`)) return;
          delBtn.textContent = "Deleting…"; delBtn.disabled = true;
          try {
            await destroyScene(scene.id, true);
            tr.remove();
            const idx = group.indexOf(scene);
            if (idx !== -1) group.splice(idx, 1);
            countBadge.textContent = `${group.length} scenes`;
            if (group.length <= 1) groupWrap.remove();
            toast(`Deleted scene #${scene.id}`, "#e06c75");
          } catch(e) {
            toast(`Error: ${e.message}`, "#e06c75");
            delBtn.textContent = "🗑 Delete"; delBtn.disabled = false;
          }
        });
        tdAct.appendChild(delBtn);

        tr.append(tdId, tdFiles, tdRes, tdCodec, tdSize, tdOrg, tdPerf, tdAct);
        tbody.appendChild(tr);
      }

      table.appendChild(tbody);
      groupWrap.appendChild(table);
      wrap.appendChild(groupWrap);
    }

    return wrap;
  }

  // ── Main modal ─────────────────────────────────────────────────────────────

  function openModal() {
    if (document.getElementById(MODAL_ID)) return;

    const overlay = el("div", STYLE.overlay);
    overlay.id = MODAL_ID;
    overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);

    const modal = el("div", STYLE.modal);
    overlay.appendChild(modal);

    const header = el("div", STYLE.header);
    header.appendChild(el("span", "color:#e5c07b;font-weight:700;font-size:1.1em;", "🔍 DupeFinder"));
    header.appendChild(mkBtn("✕", "#3e4451", () => overlay.remove()));
    modal.appendChild(header);

    const tabBar = el("div", STYLE.tabs);
    modal.appendChild(tabBar);

    const body = el("div", STYLE.body);
    modal.appendChild(body);

    body.appendChild(el("div", "color:#5c6370;padding:40px 0;text-align:center;font-size:0.9em;", "Loading scenes… 0 / ?"));

    let multiFileScenes = [], dupGroups = [];

    function showTab(tab) {
      tabBar.innerHTML = "";
      tabBar.appendChild(tabBtn(`Multi-file (${multiFileScenes.length})`, tab === "multi", () => showTab("multi")));
      tabBar.appendChild(tabBtn(`Duplicates (${dupGroups.length})`,       tab === "dupes", () => showTab("dupes")));
      body.innerHTML = "";
      if (tab === "multi") body.appendChild(renderMultiFileTable(multiFileScenes));
      else                 body.appendChild(renderDuplicatesTable(dupGroups));
    }

    fetchAllScenes((loaded, total) => {
      const p = body.querySelector("div");
      if (p) p.textContent = `Loading scenes… ${loaded} / ${total}`;
    }).then(scenes => {
      multiFileScenes = findMultiFileScenes(scenes);
      dupGroups       = findDuplicateScenes(scenes);
      showTab("multi");
    }).catch(err => {
      body.innerHTML = "";
      body.appendChild(el("div", "color:#e06c75;padding:20px 0;", `Error: ${err.message}`));
      console.error("[DupeFinder]", err);
    });
  }

  // ── Floating button ────────────────────────────────────────────────────────

  function injectButton() {
    if (document.getElementById(BTN_ID)) return;
    const btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.textContent = "🔍 Dupes";
    btn.style.cssText = [
      "position:fixed;bottom:80px;left:24px;z-index:9990;",
      "background:#c678dd;color:#fff;border:none;border-radius:20px;",
      "padding:9px 16px;font-size:0.85em;font-weight:600;cursor:pointer;",
      "box-shadow:0 2px 8px rgba(0,0,0,0.4);",
    ].join("");
    btn.addEventListener("click", openModal);
    btn.addEventListener("mouseenter", () => btn.style.background = "#d896e8");
    btn.addEventListener("mouseleave", () => btn.style.background = "#c678dd");
    document.body.appendChild(btn);
  }

  // ── Init ───────────────────────────────────────────────────────────────────

  function schedule() {
    if (document.readyState === "complete" || document.readyState === "interactive") {
      injectButton();
    } else {
      document.addEventListener("DOMContentLoaded", injectButton);
    }
    const obs = new MutationObserver(() => {
      if (!document.getElementById(BTN_ID)) injectButton();
    });
    obs.observe(document.body, { childList: true, subtree: false });
  }

  schedule();

})();
