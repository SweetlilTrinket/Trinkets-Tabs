/**
 * RP Distributor — bundled inside Trinket's Tabs
 * Zweihander system — GM-only sidebar tab
 *
 * MODULE_ID is the merged module's Foundry id (used to build the
 * template path under modules/<id>/...). TAB_NAME is the sidebar
 * tab's data-tab attribute and CSS scope; it stays "rp-distributor"
 * so existing CSS selectors keep matching.
 */

const MODULE_ID = "trinket-tabs";
const TEMPLATE  = `modules/${MODULE_ID}/templates/rp-sidebar.hbs`;
const TAB_NAME  = "rp-distributor";

// ── Diagnostic banner — fires the moment Foundry imports this file.
//    If you DON'T see this in the F12 console, the browser is serving
//    a stale cached copy of the module, or the script never loaded.
//    Hard-reload (Ctrl+Shift+R / Cmd+Shift+R) before debugging further.
console.log("%cRP Distributor | script body evaluating (build: trinket-tabs v1.1.0)",
  "color:#c8960c;font-weight:bold;");

const _excluded = new Set();
const _trackerExcluded = new Set();
let _suppressActorRefresh = false;

/* ════════════════════════════════════════════════════════════
   Zweihander stat helpers
   perilCurrent / damageCurrent are objects: { value, max }
   We defensively handle both object and plain-number forms.
   ════════════════════════════════════════════════════════════ */
const TRACKER_MAX = 5;

function _resolveStatValue(raw) {
  if (raw == null) return 0;
  if (typeof raw === "object") return raw.value ?? 0;
  return raw;
}

function _getActorStat(actor, stat) {
  if (stat === "peril") {
    const raw = actor.system?.stats?.secondaryAttributes?.perilCurrent;
    return _resolveStatValue(raw);
  }
  if (stat === "damage") {
    const raw = actor.system?.stats?.secondaryAttributes?.damageCurrent;
    return _resolveStatValue(raw);
  }
  return 0;
}

// Some ZW versions nest value inside the object; try both write paths
function _statUpdatePath(stat) {
  if (stat === "peril")  return "system.stats.secondaryAttributes.perilCurrent.value";
  if (stat === "damage") return "system.stats.secondaryAttributes.damageCurrent.value";
  return null;
}

/* ════════════════════════════════════════════════════════════
   Template data
   ════════════════════════════════════════════════════════════ */
function _getTemplateData() {
  const characters = game.actors
    .filter(a => a.type === "character")
    .sort((a, b) => {
      const aEx = _excluded.has(a.id);
      const bEx = _excluded.has(b.id);
      if (aEx !== bEx) return aEx ? 1 : -1;
      return a.name.localeCompare(b.name);
    })
    .map(a => ({
      id:              a.id,
      name:            a.name,
      img:             a.img && !a.img.includes("mystery-man") ? a.img : null,
      initial:         a.name.charAt(0).toUpperCase(),
      rpTotal:         a.system?.stats?.rewardPoints?.total ?? 0,
      excluded:        _excluded.has(a.id),
      trackerExcluded: _trackerExcluded.has(a.id),
      perilCurrent:    _getActorStat(a, "peril"),
      perilTaken:      TRACKER_MAX - _getActorStat(a, "peril"),
      perilMax:        TRACKER_MAX,
      perilThreshold:  a.system?.stats?.secondaryAttributes?.perilThreshold?.value ?? "?",
      perilThreshold2: (a.system?.stats?.secondaryAttributes?.perilThreshold?.value ?? null) !== null ? a.system.stats.secondaryAttributes.perilThreshold.value + 6  : "?",
      perilThreshold3: (a.system?.stats?.secondaryAttributes?.perilThreshold?.value ?? null) !== null ? a.system.stats.secondaryAttributes.perilThreshold.value + 12 : "?",
      perilThreshold4: (a.system?.stats?.secondaryAttributes?.perilThreshold?.value ?? null) !== null ? a.system.stats.secondaryAttributes.perilThreshold.value + 18 : "?",
      damageCurrent:   _getActorStat(a, "damage"),
      damageTaken:     TRACKER_MAX - _getActorStat(a, "damage"),
      damageMax:       TRACKER_MAX,
      damageThreshold: a.system?.stats?.secondaryAttributes?.damageThreshold?.value ?? "?",
      damageThreshold2: (a.system?.stats?.secondaryAttributes?.damageThreshold?.value ?? null) !== null ? a.system.stats.secondaryAttributes.damageThreshold.value + 6  : "?",
      damageThreshold3: (a.system?.stats?.secondaryAttributes?.damageThreshold?.value ?? null) !== null ? a.system.stats.secondaryAttributes.damageThreshold.value + 12 : "?",
      damageThreshold4: (a.system?.stats?.secondaryAttributes?.damageThreshold?.value ?? null) !== null ? a.system.stats.secondaryAttributes.damageThreshold.value + 18 : "?",
    }));

  return { characters };
}

/* ════════════════════════════════════════════════════════════
   Pip rendering
   ════════════════════════════════════════════════════════════ */
function _renderPips(panel) {
  panel.querySelectorAll(".rp-tracker-pips").forEach(container => {
    const actorId = container.dataset.actorId;
    const stat    = container.dataset.stat;
    const max     = parseInt(container.dataset.max, 10) || TRACKER_MAX;
    const current = parseInt(container.dataset.current, 10) || 0;

    container.innerHTML = "";
    // current = ZW value: 5 = unharmed, 0 = slain.
    // damageTaken = TRACKER_MAX - current.
    // Pip i (1..max) fills LEFT-to-RIGHT: lit when i <= damageTaken.
    // Clicking pip i sets damageTaken = i, so ZW value = TRACKER_MAX - i.
    const taken = max - current;
    for (let i = 1; i <= max; i++) {
      const pip = document.createElement("button");
      pip.type = "button";
      pip.classList.add("rp-pip", stat === "peril" ? "rp-pip-peril" : "rp-pip-damage");
      if (i <= taken) pip.classList.add("rp-pip-filled");
      pip.dataset.value   = i;
      pip.dataset.actorId = actorId;
      pip.dataset.stat    = stat;
      pip.title = `Set ${stat} taken to ${i}`;
      pip.addEventListener("click", () => {
        // Toggle off if clicking the highest currently-filled pip, otherwise fill to i.
        const currentTaken = TRACKER_MAX - (parseInt(container.dataset.current, 10) || 0);
        const newTaken = (i === currentTaken) ? i - 1 : i;
        _trackerSet(panel, actorId, stat, TRACKER_MAX - newTaken);
      });
      container.appendChild(pip);
    }
  });
}

/* ════════════════════════════════════════════════════════════
   Render / refresh
   ════════════════════════════════════════════════════════════ */
async function _renderPanel(panel) {
  panel.innerHTML = await renderTemplate(TEMPLATE, _getTemplateData());
  _bindEvents(panel);
  _renderPips(panel);
  _restoreSubtab(panel);
}

async function _refreshPanel() {
  const panel = document.querySelector(`#sidebar-content [data-tab="${TAB_NAME}"]`);
  if (!panel) return;

  const activeSubtab = panel.querySelector(".rp-subtab-btn.rp-subtab-active")?.dataset.subtab ?? "rp";
  const bulkVal      = panel.querySelector("#bulk-rp-value")?.value ?? "0";

  panel.innerHTML = await renderTemplate(TEMPLATE, _getTemplateData());
  _bindEvents(panel);
  _renderPips(panel);
  _switchSubtab(panel, activeSubtab);

  const bulkInput = panel.querySelector("#bulk-rp-value");
  if (bulkInput) bulkInput.value = bulkVal;
}

/* ════════════════════════════════════════════════════════════
   Sub-tab switching
   ════════════════════════════════════════════════════════════ */
let _lastSubtab = "rp";

function _switchSubtab(panel, name) {
  _lastSubtab = name;
  panel.querySelectorAll(".rp-subtab-btn").forEach(btn =>
    btn.classList.toggle("rp-subtab-active", btn.dataset.subtab === name)
  );
  panel.querySelectorAll(".rp-subtab-panel").forEach(p =>
    p.classList.toggle("rp-subtab-panel-active", p.dataset.subtabPanel === name)
  );
}

function _restoreSubtab(panel) {
  _switchSubtab(panel, _lastSubtab);
}

/* ════════════════════════════════════════════════════════════
   Event binding
   ════════════════════════════════════════════════════════════ */
function _bindEvents(panel) {
  panel.querySelectorAll(".rp-subtab-btn").forEach(btn =>
    btn.addEventListener("click", () => _switchSubtab(panel, btn.dataset.subtab))
  );
  panel.querySelector('[data-action="set-all"]')
    ?.addEventListener("click", () => _bulkAction(panel, "set"));
  panel.querySelector('[data-action="add-all"]')
    ?.addEventListener("click", () => _bulkAction(panel, "add"));
  _bindListEvents(panel);
  _bindTrackerEvents(panel);
}

function _bindListEvents(panel) {
  panel.querySelectorAll(".rp-include-check").forEach(cb =>
    cb.addEventListener("change", async ev => {
      const id = ev.currentTarget.dataset.actorId;
      ev.currentTarget.checked ? _excluded.delete(id) : _excluded.add(id);
      await _refreshPanel();
    })
  );
  panel.querySelectorAll('[data-action="set-one"]').forEach(btn =>
    btn.addEventListener("click", ev => {
      const id = ev.currentTarget.dataset.actorId;
      _setActorRP(panel, id, _getCharVal(panel, id), "set");
    })
  );
  panel.querySelectorAll('[data-action="add-one"]').forEach(btn =>
    btn.addEventListener("click", ev => {
      const id = ev.currentTarget.dataset.actorId;
      _setActorRP(panel, id, _getCharVal(panel, id), "add");
    })
  );
  panel.querySelectorAll(".rp-char-input").forEach(input =>
    input.addEventListener("keydown", ev => {
      if (ev.key === "Enter")
        _setActorRP(panel, input.dataset.actorId, parseInt(input.value || 0, 10), "set");
    })
  );
}

function _bindTrackerEvents(panel) {
  // Tracker exclude toggles
  panel.querySelectorAll(".rp-tracker-include-check").forEach(cb =>
    cb.addEventListener("change", async ev => {
      const id = ev.currentTarget.dataset.actorId;
      ev.currentTarget.checked ? _trackerExcluded.delete(id) : _trackerExcluded.add(id);
      await _refreshPanel();
    })
  );

  panel.querySelectorAll('[data-action="tracker-inc"]').forEach(btn =>
    btn.addEventListener("click", ev => {
      const { actorId, stat } = ev.currentTarget.dataset;
      const actor = game.actors.get(actorId);
      if (!actor) return;
      // + = more damage/peril taken → ZW value decreases
      _trackerSet(panel, actorId, stat, Math.max(0, _getActorStat(actor, stat) - 1));
    })
  );
  panel.querySelectorAll('[data-action="tracker-dec"]').forEach(btn =>
    btn.addEventListener("click", ev => {
      const { actorId, stat } = ev.currentTarget.dataset;
      const actor = game.actors.get(actorId);
      if (!actor) return;
      // - = less damage/peril taken → ZW value increases
      _trackerSet(panel, actorId, stat, Math.min(TRACKER_MAX, _getActorStat(actor, stat) + 1));
    })
  );
  panel.querySelectorAll(".rp-tracker-input").forEach(input =>
    input.addEventListener("keydown", ev => {
      if (ev.key === "Enter")
        _trackerSet(panel, input.dataset.actorId, input.dataset.stat, TRACKER_MAX - parseInt(input.value ?? 0, 10));
    })
  );
}

function _getCharVal(panel, id) {
  return parseInt(panel.querySelector(`.rp-char-input[data-actor-id="${id}"]`)?.value || 0, 10);
}

/* ════════════════════════════════════════════════════════════
   Tracker logic
   ════════════════════════════════════════════════════════════ */
async function _trackerSet(panel, actorId, stat, value) {
  const actor = game.actors.get(actorId);
  if (!actor) return _showStatus(panel, "Actor not found.", "error");

  const clamped = Math.max(0, Math.min(TRACKER_MAX, value));
  const path    = _statUpdatePath(stat);

  try {
    _suppressActorRefresh = true;
    await actor.update({ [path]: clamped });
    _suppressActorRefresh = false;
    _updateTrackerUI(panel, actorId, stat, clamped);
    const label = stat.charAt(0).toUpperCase() + stat.slice(1);
    _showStatus(panel, `✦ ${actor.name}: ${label} → ${clamped}`, "success");
  } catch (err) {
    _suppressActorRefresh = false;
    console.error("RP Distributor | Tracker error:", err);
    _showStatus(panel, `Error updating ${stat}. Check console.`, "error");
  }
}

function _updateTrackerUI(panel, actorId, stat, value) {
  // Badge now shows static threshold (PT/DT), not a live counter — no update needed.

  const input = panel.querySelector(`.rp-tracker-input[data-actor-id="${actorId}"][data-stat="${stat}"]`);
  if (input) input.value = TRACKER_MAX - value;

  const pipContainer = panel.querySelector(`.rp-tracker-pips[data-actor-id="${actorId}"][data-stat="${stat}"]`);
  if (pipContainer) {
    const max = parseInt(pipContainer.dataset.max, 10) || TRACKER_MAX;
    pipContainer.dataset.current = value;
    const taken = max - value;
    pipContainer.querySelectorAll(".rp-pip").forEach(pip =>
      pip.classList.toggle("rp-pip-filled", parseInt(pip.dataset.value, 10) <= taken)
    );
  }
}

/* ════════════════════════════════════════════════════════════
   RP logic
   ════════════════════════════════════════════════════════════ */
async function _bulkAction(panel, mode) {
  const value = parseInt(panel.querySelector("#bulk-rp-value")?.value || 0, 10);
  if (isNaN(value)) return _showStatus(panel, "Invalid value.", "error");
  const targets = game.actors.filter(a => a.type === "character" && !_excluded.has(a.id));
  if (!targets.length) return _showStatus(panel, "No characters selected.", "error");
  try {
    await Promise.all(targets.map(a => _applyRP(a, value, mode)));
    _showStatus(panel, `✦ ${mode === "set" ? "Set" : "Added"} RP for ${targets.length} character(s).`, "success");
    await _refreshPanel();
  } catch (err) {
    console.error("RP Distributor |", err);
    _showStatus(panel, "Error updating RP. Check console.", "error");
  }
}

async function _setActorRP(panel, actorId, value, mode) {
  if (isNaN(value)) return _showStatus(panel, "Invalid value.", "error");
  const actor = game.actors.get(actorId);
  if (!actor) return _showStatus(panel, "Actor not found.", "error");
  try {
    await _applyRP(actor, value, mode);
    _showStatus(panel, `✦ ${mode === "set" ? "Set" : "Added"} ${value} RP → ${actor.name}`, "success");
    await _refreshPanel();
  } catch (err) {
    console.error("RP Distributor |", err);
    _showStatus(panel, "Error updating RP. Check console.", "error");
  }
}

async function _applyRP(actor, value, mode) {
  const current = actor.system?.stats?.rewardPoints?.total ?? 0;
  await actor.update({
    "system.stats.rewardPoints.total": Math.max(0, mode === "add" ? current + value : value)
  });
}

function _showStatus(panel, message, type = "success") {
  const el = panel.querySelector("#rp-status");
  if (!el) return;
  el.textContent = message;
  el.className = `rp-status visible ${type}`;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove("visible"), 3000);
}

/* ════════════════════════════════════════════════════════════
   Tab switching
   ════════════════════════════════════════════════════════════ */
function _deactivateTab() {
  const sidebarContent = document.querySelector("#sidebar-content");
  if (!sidebarContent) return;
  sidebarContent.classList.remove(`active-${TAB_NAME}`);
  const ourBtn = document.querySelector(`#sidebar-tabs menu button[data-tab="${TAB_NAME}"]`);
  if (ourBtn) {
    ourBtn.classList.remove("active");
    ourBtn.setAttribute("aria-pressed", "false");
  }
}

function _activateTab() {
  const sidebarContent = document.querySelector("#sidebar-content");
  const tabsNav        = document.querySelector("#sidebar-tabs menu");
  if (!sidebarContent || !tabsNav) return;
  const toRemove = [...sidebarContent.classList].filter(c => c.startsWith("active-"));
  sidebarContent.classList.remove(...toRemove);
  sidebarContent.classList.add(`active-${TAB_NAME}`);
  tabsNav.querySelectorAll("button[data-action='tab']").forEach(b => {
    b.setAttribute("aria-pressed", b.getAttribute("data-tab") === TAB_NAME ? "true" : "false");
    b.classList.toggle("active", b.getAttribute("data-tab") === TAB_NAME);
  });
}

/* ════════════════════════════════════════════════════════════
   CSS injection
   ════════════════════════════════════════════════════════════ */
function _injectCSS() {
  if (document.getElementById("rp-distributor-tab-css")) return;
  const style = document.createElement("style");
  style.id = "rp-distributor-tab-css";
  style.textContent = `
    #sidebar-content [data-tab="${TAB_NAME}"] { display: none !important; }
    #sidebar-content.active-${TAB_NAME} > *:not([data-tab="${TAB_NAME}"]) {
      display: none !important;
    }
    #sidebar-content.active-${TAB_NAME} [data-tab="${TAB_NAME}"] {
      display: flex !important;
      flex-direction: column;
      position: static !important;
      width: 300px !important;
      height: 100% !important;
      overflow: hidden !important;
      padding: 0 !important;
      margin: 0 !important;
      box-sizing: border-box;
      background: #110a04;
    }
    #${TAB_NAME} .rp-distributor-app {
      flex: 1 1 auto;
      width: 100% !important;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
      box-sizing: border-box;
    }
  `;
  document.head.appendChild(style);
}

/* ════════════════════════════════════════════════════════════
   Sidebar injection
   ────────────────────────────────────────────────────────────
   Foundry v13 renders the sidebar as an ApplicationV2. The
   `renderSidebar` hook is not always fired AFTER our esmodule
   has finished registering listeners — when it isn't, the tab
   silently never appears (this is the "rp tab not showing up"
   regression after merging Trinket's Tabs + RP Distributor).
   Mitigation: extract the injection into an idempotent
   `_ensureSidebarTab()` and call it from every realistic
   trigger (renderSidebar, ready, renderApplicationV2 of the
   sidebar app). The existing DOM-level guard makes repeat
   calls cheap and safe.
   ════════════════════════════════════════════════════════════ */
Hooks.once("init", () => {
  console.log("RP Distributor | init hook fired — preloading template:", TEMPLATE);
  try { loadTemplates([TEMPLATE]); }
  catch (err) { console.error("RP Distributor | loadTemplates failed:", err); }
});

let _sidebarInjected = false;

async function _ensureSidebarTab(source = "?") {
  console.log(`RP Distributor | _ensureSidebarTab called from: ${source}`);

  if (_sidebarInjected) {
    console.log("RP Distributor | already injected — skipping");
    return;
  }
  if (!game?.user?.isGM) {
    console.log(`RP Distributor | not GM (user=${game?.user?.name ?? "?"} role=${game?.user?.role ?? "?"}) — skipping`);
    return;
  }

  _injectCSS();

  // If the tab panel is already in the DOM, the sidebar re-rendered.
  // Reset the flag so we re-inject fresh (moves the button to the right slot).
  if (document.querySelector(`#sidebar-content [data-tab="${TAB_NAME}"]`)) {
    console.log("RP Distributor | tab already in DOM — removing and re-injecting to ensure correct position");
    document.querySelector(`#sidebar-content [data-tab="${TAB_NAME}"]`)?.remove();
    const oldBtn = document.querySelector(`#sidebar-tabs menu button[data-tab="${TAB_NAME}"]`);
    oldBtn?.closest("li")?.remove();
    _sidebarInjected = false;
  }

  const menu = document.querySelector("#sidebar-tabs menu");
  if (!menu) {
    console.warn(`RP Distributor | #sidebar-tabs menu not found from ${source} — will retry. ` +
      `(querySelector("#sidebar-tabs") = ${document.querySelector("#sidebar-tabs") ? "found" : "MISSING"})`);
    return;
  }

  const sidebarContent = document.querySelector("#sidebar-content");
  if (!sidebarContent) {
    console.warn(`RP Distributor | #sidebar-content not found from ${source} — will retry.`);
    return;
  }

  const li  = document.createElement("li");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.classList.add("ui-control", "plain", "icon", "fa-solid", "fa-coins");
  btn.setAttribute("data-action",   "tab");
  btn.setAttribute("data-tab",      TAB_NAME);
  btn.setAttribute("data-group",    "primary");
  btn.setAttribute("aria-pressed",  "false");
  btn.setAttribute("aria-label",    "GM Panel");
  btn.setAttribute("aria-controls", TAB_NAME);
  btn.setAttribute("data-tooltip",  "GM Panel");
  btn.setAttribute("role",          "tab");
  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    if (!ui.sidebar.expanded) ui.sidebar.expand();
    _activateTab();
  });
  li.appendChild(btn);
  // Insert between Scenes and Actors. Log all tab buttons for debugging.
  const allBtns = [...menu.querySelectorAll("button[data-action='tab']")];
  console.log("RP Distributor | sidebar tab buttons found:", allBtns.map(b => `tab=${b.dataset.tab} tooltip=${b.dataset.tooltip}`));
  const actorsBtn = allBtns.find(b => b.dataset.tab === "actors" || b.dataset.tooltip?.toLowerCase() === "actors");
  const actorsLi  = actorsBtn?.closest("li");
  if (actorsLi) {
    console.log("RP Distributor | inserting before actors tab");
    menu.insertBefore(li, actorsLi);
  } else {
    console.warn("RP Distributor | actors tab not found, appending to end");
    menu.appendChild(li);
  }

  // When any native sidebar tab is clicked, strip our active class so
  // Foundry's own show/hide logic is no longer blocked by our CSS rule.
  menu.querySelectorAll("button[data-action='tab']").forEach(nativeBtn => {
    if (nativeBtn.dataset.tab === TAB_NAME) return; // skip our own button
    nativeBtn.addEventListener("click", _deactivateTab);
  });

  const panel = document.createElement("div");
  panel.setAttribute("data-tab",   TAB_NAME);
  panel.setAttribute("data-group", "primary");
  panel.setAttribute("id",         TAB_NAME);
  panel.setAttribute("role",       "tabpanel");
  sidebarContent.appendChild(panel);

  await _renderPanel(panel);

  _sidebarInjected = true;
  console.log("RP Distributor | sidebar tab injected");
}

// Primary trigger — fires whenever the sidebar (re-)renders.
Hooks.on("renderSidebar", () => _ensureSidebarTab("renderSidebar"));

// v13 fallback: in case the sidebar already rendered before our
// listener registered, run on `ready` and a few delayed retries
// to absorb slow DOM construction.
Hooks.once("ready", () => {
  console.log("RP Distributor | ready hook fired");
  _ensureSidebarTab("ready");
  setTimeout(() => _ensureSidebarTab("ready+200ms"), 200);
  setTimeout(() => _ensureSidebarTab("ready+800ms"), 800);
  setTimeout(() => _ensureSidebarTab("ready+2000ms"), 2000);
});

// Any sidebar-flavoured ApplicationV2 render is also a chance to inject.
Hooks.on("renderApplicationV2", (app) => {
  const name = app?.constructor?.name ?? "";
  const id   = app?.id ?? "";
  if (/sidebar/i.test(name) || id === "sidebar") {
    _ensureSidebarTab(`renderApplicationV2:${name || id}`);
  }
});

console.log("RP Distributor | hooks registered (renderSidebar, ready, renderApplicationV2, updateActor)");

Hooks.on("updateActor", (actor) => {
  if (!game.user.isGM || actor.type !== "character") return;
  if (_suppressActorRefresh) return;
  _refreshPanel();
});
