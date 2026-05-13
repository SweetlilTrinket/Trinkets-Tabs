// ============================================================
//  ap-tracker.js
//  Zweihander TTRPG — Action Point (AP) tracker
//
//  • Stores current AP on the actor as a flag
//  • Replenishes 3 AP automatically when it's the actor's turn
//    (detected via Foundry's combatTurn / combatRound hooks)
//  • Exports helpers used by luck-tab.js to deduct AP on actions
// ============================================================

const MODULE_ID = "trinket-tabs";
export const AP_FLAG = "actionPoints";
export const MAX_AP  = 3;

// ── AP flag helpers ─────────────────────────────────────────
export function getAP(actor) {
  const v = actor.getFlag(MODULE_ID, AP_FLAG);
  return Math.min(Math.max(Number(v ?? MAX_AP), 0), MAX_AP);
}

export async function setAP(actor, value) {
  const v = Math.min(Math.max(Math.round(Number(value)), 0), MAX_AP);
  await actor.setFlag(MODULE_ID, AP_FLAG, v);
  return v;
}

export async function spendAP(actor, cost) {
  const current = getAP(actor);
  if (cost > current) return false;          // not enough AP
  await setAP(actor, current - cost);
  return true;
}

// ── Resolve numeric AP cost from string label ───────────────
// Returns null for "VARIES" or ranges where the caller must choose
export function resolveAPCost(apLabel) {
  if (!apLabel) return null;
  const s = String(apLabel).trim().toUpperCase();
  if (s === "0")       return 0;
  if (s === "1")       return 1;
  if (s === "2")       return 2;
  if (s === "3")       return 3;
  if (s === "VARIES")  return null;
  // "1-2" or "1–2" — return null so the action can prompt
  if (/^\d[–\-]\d$/.test(s)) return null;
  const n = parseInt(s);
  return isNaN(n) ? null : n;
}

// ── Combat turn hook — replenish AP ─────────────────────────
function getActorForCombatant(combatant) {
  return combatant?.actor ?? game.actors.get(combatant?.actorId) ?? null;
}

async function replenishAP(combatant) {
  const actor = getActorForCombatant(combatant);
  if (!actor) return;
  if (!actor.isOwner && !game.user.isGM) return;

  await setAP(actor, MAX_AP);

  // Announce in chat so the table knows
  const content = `
<div style="
  border:1.5px solid #3a7acd;border-radius:6px;background:#0c1a2e;
  color:#b0d4f8;font-family:'Palatino Linotype',serif;padding:8px 12px;max-width:320px;
  display:flex;align-items:center;gap:10px;
">
  <div style="font-size:1.5em;line-height:1;">⚡</div>
  <div style="font-size:.85em;line-height:1.4;">
    <strong style="color:#6ab4ff;">${actor.name}</strong> begins their turn.<br>
    <span style="color:#7ec8e3;">Action Points restored to
      <strong style="color:#fff;font-size:1.1em;">${MAX_AP} AP</strong>.
    </span>
  </div>
  <div style="
    margin-left:auto;display:flex;gap:5px;align-items:center;
  ">
    ${Array.from({length:MAX_AP},()=>`
      <div style="width:14px;height:14px;border-radius:50%;
        background:radial-gradient(circle at 35% 30%,#72c6ff,#1a6fc4);
        box-shadow:0 0 6px #3a9fffaa,0 0 2px #aaddff;
        border:1.5px solid #5ab0f0;">
      </div>`).join("")}
  </div>
</div>`;

  ChatMessage.create({
    content,
    speaker: ChatMessage.getSpeaker({ actor }),
    flags: { [MODULE_ID]: { apReplenish: true } },
  });
}

// Hook: fires when the active combatant changes.
// In Foundry v13, prevData.turn is the NEW (now-starting) turn index,
// and combat.turn is the OLD index that just ended.
// The combatant NOW starting their turn is at combat.turn + 1.
Hooks.on("combatTurn", (combat, prevData, { direction }) => {
  if (direction < 1) return;
  const newIndex = combat.turn + 1;
  const combatant = combat.turns[newIndex] ?? combat.turns[0]; // wrap round end
  if (!combatant) return;
  replenishAP(combatant);
});

// Round advance — first combatant of the new round starts their turn
Hooks.on("combatRound", (combat, prevData, { direction }) => {
  if (direction < 1) return;
  const combatant = combat.turns[0];
  if (!combatant) return;
  replenishAP(combatant);
});

// When combat starts, give everyone AP
Hooks.on("combatStart", (combat) => {
  const first = combat.combatant;
  if (first) replenishAP(first);
});

Hooks.once("ready", () =>
  console.log(`[${MODULE_ID}] ap-tracker ready — max AP: ${MAX_AP}`)
);
