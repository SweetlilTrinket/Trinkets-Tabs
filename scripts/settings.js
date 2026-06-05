// ============================================================
//  settings.js
//  Trinket's Tabs — module settings registration
// ============================================================

const MODULE_ID = "trinket-tabs";

export const SETTINGS = {
  LUCK_ENABLED: "luckEnabled",
};

export function isLuckEnabled() {
  return game.settings.get(MODULE_ID, SETTINGS.LUCK_ENABLED);
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, SETTINGS.LUCK_ENABLED, {
    name:    "Enable Luck",
    hint:    "When disabled, the Luck tab and Spend Luck chat button are hidden entirely. Resting still clears Peril but does not roll for Luck recovery.",
    scope:   "world",       // GM-only, stored server-side
    config:  true,          // show in Module Settings UI
    type:    Boolean,
    default: true,
    requiresReload: true,   // reload so all clients pick up the change cleanly
  });
});

Hooks.once("ready", () =>
  console.log(`[${MODULE_ID}] settings ready — luckEnabled: ${isLuckEnabled()}`)
);
