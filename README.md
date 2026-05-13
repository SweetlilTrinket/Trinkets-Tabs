# Trinket's Tabs

A Foundry VTT v13 quality-of-life bundle for the Zweihander system. Combines the former **Trinket's Tabs** and **RP Distributor** modules into one.

---

## Features

### On every actor sheet
- **Luck panel** — floating tab beside the sheet that tracks a 0–20 Luck score per actor.
- **Rest panel** — one-click rest that clears Peril to Unhindered and rolls `1d10 + PB` to recover Luck.
- **Combat panel** — embedded action cards (Movement / Attack / Perilous Stunts / Special / Reactions) with built-in chat output and skill/weapon roll triggers.
- **Action Point tracker** — 3 AP per character, auto-replenishes at the start of their turn via combat hooks.

### In chat
- **Spend Luck on failures** — when a Zweihander skill roll fails (and isn't a fumble), a button on the message lets the actor's owner spend Luck equal to the margin of failure to flip the result to a success.

### In the sidebar (GM only)
- **RP Distributor tab** — Reward Points distribution to all PCs (set / add, bulk or per-character) plus a Peril & Damage tracker with click-to-fill pip controls.

---

## Install

Drop the folder into your Foundry `Data/modules/` directory or install via manifest URL.

## Compatibility

- Foundry VTT **v13**
- System: **Zweihander** (`zweihander`)

## Version

`1.1.0` — first merged release. Stored Luck and AP from the prior `trinket-tabs` v1.0.0 carry over (same `trinket-tabs` flag namespace).

---

# Merge history & implementation notes

This module is the result of merging two previously-separate Foundry v13 modules — **Trinket's Tabs** (`trinket-tabs`) and **RP Distributor** (`rp-distributor`) — into a single distribution.

The user's instruction was: *"Combine them into one mod with the same ID 'Trinkets tabs v1.0' and make sure the rp tab does not stop working as it needs to be injected before the tabs on the character sheet."*

This section documents what was discussed, what risks were identified, what was decided, and how the merge was carried out, so a future maintainer (or your friend) can see exactly what changed and why.

## What each module contributed

### `trinket-tabs` (kept ID — Luck/Rest/Combat/AP/Spend)
| File | Role |
| --- | --- |
| `scripts/luck-tab.js` (1,987 lines) | Luck/Rest/Combat floating panels beside open actor sheets, plus all embedded combat-action chat cards and roll triggers. |
| `scripts/luck-spend.js` (369 lines) | `renderChatMessage` hook that adds a "Spend Luck" button on failed Zweihander rolls. |
| `scripts/ap-tracker.js` (126 lines) | Action Points stored as actor flag, replenished by `combatTurn` / `combatRound` / `combatStart` hooks. |
| `styles/luck-tab.css`, `lang/en.json`, `module.json` | Styles, lang, manifest. |

### `rp-distributor` (folded in — sidebar tab)
| File | Role |
| --- | --- |
| `scripts/main.js` (439 lines) | `renderSidebar` hook that injects a GM-only Foundry sidebar tab (`<button data-tab="rp-distributor">`) into `#sidebar-tabs menu`. |
| `templates/rp-sidebar.hbs` (199 lines) | Handlebars template with two subtabs: Reward Points and Peril/Damage Tracker. |
| `styles/rp-distributor.css` (630 lines) | Full styling for the sidebar panel. |
| `module.json` | Manifest, declared `system: ["zweihander"]`. |

## Risks identified before any change was made

These were the things that would break if the merge had been done naïvely:

1. **Hardcoded template path.** `rp-distributor/scripts/main.js:7` read:
   ```js
   const TEMPLATE = `modules/${MODULE_ID}/templates/rp-sidebar.hbs`;
   ```
   with `MODULE_ID = "rp-distributor"`. Once the file lives under the merged module's folder, that path resolves to `modules/rp-distributor/templates/...`, which no longer exists. `loadTemplates` and `renderTemplate` would 404 silently and the sidebar tab button would render but click into an empty panel — almost certainly the "rp tab stops working" failure mode the friend warned about.

2. **Two different `MODULE_ID` constants in the codebase.**
   - `"trinket-tabs"` — used in `luck-tab.js`, `luck-spend.js`, `ap-tracker.js` as the **actor-flag namespace** (`actor.setFlag("trinket-tabs", "luck", ...)` and `..."actionPoints", ...`). Changing this would orphan every player's stored Luck and AP.
   - `"rp-distributor"` — used in `main.js` only to build the template path and as a CSS scope.

   The merge had to keep `"trinket-tabs"` as the flag namespace and only retarget the path-building constant in the rp-distributor file.

3. **Module ID format.** The user wrote *"Trinkets tabs v1.0"* but Foundry module IDs must be lowercase, no spaces, no dots — that string would make the module fail to load. Confirmed with the user (see "Decisions").

4. **Hook ordering.** Foundry loads `esmodules` in the order listed in `module.json`. The friend asked that the RP injection happen first. The two modules use *different* hooks (`renderSidebar` vs `renderActorSheet` / `renderApplicationV2`), so they don't conflict by event — but listing the RP entry first makes its `Hooks.once("init")` template preload and `renderSidebar` listener register before any other module work, satisfying the constraint and matching the friend's request.

5. **`renderApplicationV2` collision.** `luck-tab.js` listens on `renderApplicationV2` for actor sheets. The Foundry v13 sidebar is also an ApplicationV2 — but luck-tab guards immediately with `if (!getActorFromApp(app)) return;`, so it bails out for the sidebar. Verified during code review; left as-is.

6. **System lock.** The original `trinket-tabs` manifest had no `system` field. `rp-distributor` declared `system: ["zweihander"]`. Both halves are Zweihander-specific in practice (Zweihander skill names are hardcoded in `luck-spend.js`, perilCurrent paths in `rp-distributor.js`, etc.), so the merged manifest now declares `system: ["zweihander"]` — which is correct.

## Decisions (asked of the user)

| Question | User's choice | Why |
| --- | --- | --- |
| Module ID for the merged module — keep `trinket-tabs`, switch to `trinkets-tabs`, or `trinkets-tabs-v1`? | **Keep `trinket-tabs`** | Existing actor flags (Luck, AP) stay intact — no migration shim needed, no player loses data. The Foundry-displayed *title* remains "Trinket's Tabs". |
| RP injection — load RP first, or stop and ask? | **Load order: RP first** | Confirmed the friend's note was about ESM load order, not a character-sheet injection. `scripts/rp-distributor.js` is listed first in `esmodules`. |

## How the merge was implemented

Step-by-step, in the exact order the changes were made:

1. **Copied files into `Trinkets-Tabs/`:**
   - `RP-Distributor/scripts/main.js` → `Trinkets-Tabs/scripts/rp-distributor.js`
   - `RP-Distributor/templates/rp-sidebar.hbs` → `Trinkets-Tabs/templates/rp-sidebar.hbs` (new `templates/` folder)
   - `RP-Distributor/styles/rp-distributor.css` → `Trinkets-Tabs/styles/rp-distributor.css`

2. **Fixed the template path in `scripts/rp-distributor.js` (the critical fix):**
   - `MODULE_ID = "rp-distributor"` → `MODULE_ID = "trinket-tabs"`. This is the only `MODULE_ID` in that file; `grep` confirmed it's used solely to build `TEMPLATE`. After the change, `TEMPLATE` resolves to `modules/trinket-tabs/templates/rp-sidebar.hbs`, which now exists.
   - `TAB_NAME = "rp-distributor"` was **kept** — it's the `data-tab` attribute, the `<div id="rp-distributor">` panel id, the CSS scope (`#sidebar-content.active-rp-distributor`), and is referenced in many CSS rules that travelled untouched. Renaming it would have required changes across the CSS too. Leaving it means the entire RP DOM/CSS contract is unchanged.
   - Added a header comment explaining the distinction so future readers don't conflate the two constants.

3. **Rewrote `module.json`:**
   - `id: "trinket-tabs"` (unchanged — preserves flags).
   - `version: "1.0.0"` → `"1.1.0"` to mark the merged release.
   - `description` rewritten to describe the combined feature set.
   - `esmodules` now lists four files in deliberate order: `rp-distributor.js`, `ap-tracker.js`, `luck-tab.js`, `luck-spend.js`. RP first per the friend's instruction; `ap-tracker.js` before `luck-tab.js` because luck-tab `import`s from it.
   - `styles` now lists both `luck-tab.css` and `rp-distributor.css`.
   - Added `system: ["zweihander"]`.
   - Note: there is no top-level `templates` field in Foundry v13 manifests — templates are loaded programmatically via `loadTemplates([...])` in the rp-distributor `init` hook, which is enough.

4. **Did not modify** `luck-tab.js`, `luck-spend.js`, `ap-tracker.js`, `styles/luck-tab.css`, `lang/en.json`, `templates/rp-sidebar.hbs`, or `styles/rp-distributor.css`. None of them reference either module's ID via the file system, so no edits were needed.

5. **Did not delete** the original `RP-Distributor/` folder. Once the merged module is verified working in-game, that folder can be removed (and the old module disabled/uninstalled in Foundry first to avoid both modules registering the sidebar button at once).

## Sanity checks run after the merge

```
$ grep -rn "modules/rp-distributor" Trinkets-Tabs/
(none — no stale module-path references remain)

$ grep -n 'MODULE_ID = ' Trinkets-Tabs/scripts/luck-*.js Trinkets-Tabs/scripts/ap-tracker.js
luck-tab.js:9:    const MODULE_ID = "trinket-tabs";
luck-spend.js:11: const MODULE_ID = "trinket-tabs";
ap-tracker.js:11: const MODULE_ID = "trinket-tabs";
(actor-flag namespace preserved on all three luck/AP files)
```

## Final layout

```
Trinkets-Tabs/
├── module.json                       ← rewritten, v1.1.0, system=zweihander
├── README.md                         ← this file
├── lang/
│   └── en.json                       ← unchanged
├── scripts/
│   ├── rp-distributor.js             ← from RP-Distributor/scripts/main.js, MODULE_ID flipped
│   ├── ap-tracker.js                 ← unchanged
│   ├── luck-tab.js                   ← unchanged
│   └── luck-spend.js                 ← unchanged
├── styles/
│   ├── luck-tab.css                  ← unchanged
│   └── rp-distributor.css            ← copied verbatim from RP-Distributor
└── templates/
    └── rp-sidebar.hbs                ← copied verbatim from RP-Distributor
```

## Module load order (as listed in `module.json`)

1. `scripts/rp-distributor.js` — sidebar tab + RP/Peril/Damage panels (RP first per friend's instruction)
2. `scripts/ap-tracker.js` — Action Point flag helpers + combat hooks (must load before luck-tab, which `import`s from it)
3. `scripts/luck-tab.js` — actor-sheet floaters (Luck / Rest / Combat)
4. `scripts/luck-spend.js` — failed-roll chat button

## Test checklist before retiring the old module

1. Enable only `trinket-tabs` in your Foundry world; **disable** the old `rp-distributor` so they don't both inject the sidebar button.
2. As GM, open the sidebar — the coin (`fa-coins`) tab should appear, and clicking it should show both Reward Points and Tracker subtabs with the world's character actors listed.
3. Open a character sheet — Luck / Rest / Combat circular buttons should float on the right edge.
4. Verify the existing Luck score on a character is still there (it lives under `flags.trinket-tabs.luck`, untouched by the merge).
5. Make a failing Zweihander skill roll — the Spend Luck banner should appear in chat.
6. Start combat — the AP-replenish chat card should fire on each turn.

If all six pass, the old `RP-Distributor/` folder is safe to delete.
