// ============================================================
//  luck-tab.js  (with integrated Rest panel + embedded Combat macros)
//  Zweihander TTRPG — Luck tracking + resting + combat actions
//  Floaters appear ONLY on open actor character sheets.
// ============================================================

import { getAP, setAP, spendAP, resolveAPCost, MAX_AP, AP_FLAG } from "./ap-tracker.js";

const MODULE_ID = "trinket-tabs";
const FLAG_KEY  = "luck";
const MAX_LUCK  = 20;

// ── Luck helpers ────────────────────────────────────────────
function clamp(v, min, max) { return Math.min(Math.max(Number(v), min), max); }
function getLuck(actor)      { return clamp(actor.getFlag(MODULE_ID, FLAG_KEY) ?? 0, 0, MAX_LUCK); }
async function setLuck(actor, value) {
  const v = clamp(Math.round(Number(value)), 0, MAX_LUCK);
  await actor.setFlag(MODULE_ID, FLAG_KEY, v);
  return v;
}

// ── Zweihander: Perception Bonus (PB) ───────────────────────
function getPerceptionBonus(actor) {
  const pa = actor.system?.stats?.primaryAttributes;
  const bonusField =
    pa?.perception?.bonus ?? pa?.per?.bonus ?? actor.system?.perception?.bonus ?? null;
  if (bonusField !== null && bonusField !== undefined) return Number(bonusField);
  const rawScore =
    pa?.perception?.value ?? pa?.per?.value ?? actor.system?.perception?.value ?? null;
  if (rawScore !== null && rawScore !== undefined) return Math.floor(Number(rawScore) / 10);
  console.warn(`[${MODULE_ID}] Could not find Perception Bonus for "${actor.name}".`);
  return 0;
}

// ── Zweihander: Peril helpers ────────────────────────────────
function getPerilCurrent(actor) {
  return (
    actor.system?.stats?.secondaryAttributes?.perilCurrent?.value ??
    actor.system?.peril?.current ??
    actor.system?.attributes?.peril?.value ?? 0
  );
}
function getUnhinderedPeril() { return 5; }
async function setPeril(actor, value) {
  const candidates = [
    "system.stats.secondaryAttributes.perilCurrent.value",
    "system.peril.current",
    "system.attributes.peril.value",
  ];
  for (const path of candidates) {
    if (foundry.utils.getProperty(actor, path) !== undefined) {
      await actor.update({ [path]: value }); return;
    }
  }
  await actor.update({ [candidates[0]]: value });
}

// ── Exploding Fury Die (shared by Charge / Takedown) ────────
async function rollFuryDie() {
  const rolls = []; let total = 0; let exploded = false; let result = null;
  do {
    const roll = new Roll("1d6"); await roll.evaluate();
    result = roll.total; rolls.push(result); total += result;
    if (result === 6) exploded = true;
  } while (result === 6);
  return { rolls, total, exploded };
}

// ── Weapon roll helper (shared by Take Aim / Called Shot / Opportunity Attack) ──
// weapon.roll() is confirmed to exist on ZweihanderItem.
// modifier is a % adjustment (e.g. -10, +20).
async function triggerWeaponRoll(actor, weapon, modifier) {
  try {
    if (modifier !== 0) {
      await weapon.roll({ modifier, additionalModifier: modifier });
    } else {
      await weapon.roll();
    }
  } catch (err) {
    const sign = modifier >= 0 ? `+${modifier}` : `${modifier}`;
    console.error(`[${MODULE_ID}] triggerWeaponRoll error:`, err);
    ui.notifications.warn(
      `Roll trigger failed. Roll ${weapon.name} manually${modifier !== 0 ? ` and apply ${sign}% to Base Chance` : ""}. (See console.)`
    );
  }
}

// ── Named skill roll helper ──────────────────────────────────
// Confirmed working: skillItem.roll() exists on ZweihanderItem.
async function triggerSkillRoll(actor, skillName) {
  const skillItem = actor.items.find(
    i => i.type === "skill" && i.name.toLowerCase() === skillName.toLowerCase()
  );
  if (!skillItem) {
    ui.notifications.warn(`"${skillName}" skill not found on ${actor.name}. Roll it manually.`);
    return;
  }
  try {
    await skillItem.roll();
  } catch (err) {
    console.error(`[${MODULE_ID}] triggerSkillRoll error (${skillName}):`, err);
    ui.notifications.warn(`Roll trigger failed for "${skillName}" — roll manually. (See console.)`);
  }
}

// ── Parry roll helper ────────────────────────────────────────
// Uses game.zweihander.rollItemMacro — the same entry point the sheet uses —
// which opens the standard Zweihander roll dialog where the player picks
// Attack or Parry, exactly as if they clicked the weapon on their sheet.
async function triggerParryRoll(actor, weapon) {
  try {
    if (typeof game.zweihander?.rollItemMacro === "function") {
      await game.zweihander.rollItemMacro(weapon.name, "weapon");
    } else {
      // Fallback: weapon.roll() confirmed to exist
      await weapon.roll();
    }
  } catch (err) {
    console.error(`[${MODULE_ID}] triggerParryRoll error:`, err);
    ui.notifications.warn(`Parry roll failed — click the weapon on your sheet instead. (See console.)`);
  }
}

// ── Sheet skill-click helper ─────────────────────────────────
// Clicks the matching .skill-roll on the open sheet, falls back to item.roll().
async function rollSkillByName(actor, skillName) {
  const el = document.querySelector(`.skill-roll[data-label="${skillName}"]`);
  if (el) { el.click(); return; }
  const skill = actor.items.find(i => i.type === "skill" && i.name.toLowerCase() === skillName.toLowerCase());
  if (skill) { await skill.roll(); return; }
  ui.notifications.warn(`"${skillName}" skill not found on ${actor.name}.`);
}

// ────────────────────────────────────────────────────────────
//  EMBEDDED COMBAT ACTIONS
//  Each entry:
//    card   – HTML string for the chat card (also used as tooltip)
//    run    – async (actor) => void  — the action logic
// ────────────────────────────────────────────────────────────
const COMBAT_ACTIONS = {

  // ── REACTIONS ──────────────────────────────────────────────

  "Parry": {
    card: `
<div style="border:2px solid #b8860b;border-radius:6px;background:#1a1500;color:#f0e0a0;font-family:'Palatino Linotype',serif;padding:10px 14px;max-width:340px;">
  <div style="background:#8a6200;color:#f0e0a0;font-size:1.1em;font-weight:bold;letter-spacing:1px;text-align:center;padding:4px 8px;margin:-10px -14px 10px -14px;border-radius:4px 4px 0 0;">🛡 PARRY</div>
  <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
    <span style="background:#261a00;border:1px solid #b8860b;border-radius:4px;padding:2px 10px;font-size:0.9em;">REACTION</span>
    <span style="background:#261a00;border:1px solid #b8860b;border-radius:4px;padding:2px 10px;font-size:0.9em;">1 AP</span>
  </div>
  <div style="font-size:0.85em;color:#d4b860;margin-bottom:8px;">
    Make a <strong style="color:#f0e0a0;">Combat-based Skill Test</strong> to Parry a melee weapon attack at a <strong style="color:#f0e0a0;">1 AP deficit</strong>.
  </div>
  <div style="background:#261a00;border:1px solid #b8860b;border-radius:4px;padding:6px 10px;font-size:0.8em;color:#a08030;">
    ✔ On success, <strong style="color:#f0e0a0;">avoids all Damage</strong> from the triggering attack.
  </div>
</div>`,
    run: async (actor) => {
      // Find the actor's open sheet in the DOM and click its parry-roll button directly —
      // this is identical to the player clicking Parry on their character sheet.
      const sheetEl = document.querySelector(`[id*="${actor.id}"] .parry-roll`)
        ?? document.querySelector(`.parry-roll`);
      if (sheetEl) {
        sheetEl.click();
      } else {
        ui.notifications.warn("Could not find the Parry button — is the character sheet open?");
        ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: COMBAT_ACTIONS["Parry"].card });
      }
    },
  },

  "Dodge": {
    card: `
<div style="border:2px solid #b8860b;border-radius:6px;background:#1a1500;color:#f0e0a0;font-family:'Palatino Linotype',serif;padding:10px 14px;max-width:340px;">
  <div style="background:#8a6200;color:#f0e0a0;font-size:1.1em;font-weight:bold;letter-spacing:1px;text-align:center;padding:4px 8px;margin:-10px -14px 10px -14px;border-radius:4px 4px 0 0;">💨 DODGE</div>
  <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
    <span style="background:#261a00;border:1px solid #b8860b;border-radius:4px;padding:2px 10px;font-size:0.9em;">REACTION</span>
    <span style="background:#261a00;border:1px solid #b8860b;border-radius:4px;padding:2px 10px;font-size:0.9em;">1 AP</span>
  </div>
  <div style="font-size:0.85em;color:#d4b860;margin-bottom:8px;">
    Make a <strong style="color:#f0e0a0;">Coordination Test</strong> to Dodge a ranged weapon attack at a <strong style="color:#f0e0a0;">1 AP deficit</strong>.
  </div>
  <div style="background:#261a00;border:1px solid #b8860b;border-radius:4px;padding:6px 10px;font-size:0.8em;color:#a08030;">
    ✔ On success, <strong style="color:#f0e0a0;">avoids all Damage</strong> from the triggering attack.
  </div>
</div>`,
    run: async (actor) => {
      const sheetEl = document.querySelector(`[id*="${actor.id}"] .dodge-roll`)
        ?? document.querySelector(`.dodge-roll`);
      if (sheetEl) {
        sheetEl.click();
      } else {
        ui.notifications.warn("Could not find the Dodge button — is the character sheet open?");
        ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: COMBAT_ACTIONS["Dodge"].card });
      }
    },
  },

  "Assist": {
    card: `
<div style="border:2px solid #b8860b;border-radius:6px;background:#1a1500;color:#f0e0a0;font-family:'Palatino Linotype',serif;padding:10px 14px;max-width:340px;">
  <div style="background:#8a6200;color:#f0e0a0;font-size:1.1em;font-weight:bold;letter-spacing:1px;text-align:center;padding:4px 8px;margin:-10px -14px 10px -14px;border-radius:4px 4px 0 0;">🤝 ASSIST</div>
  <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
    <span style="background:#261a00;border:1px solid #b8860b;border-radius:4px;padding:2px 10px;font-size:0.9em;">REACTION</span>
    <span style="background:#261a00;border:1px solid #b8860b;border-radius:4px;padding:2px 10px;font-size:0.9em;">VARIES</span>
  </div>
  <div style="font-size:0.85em;color:#d4b860;margin-bottom:8px;">
    You attempt to <strong style="color:#f0e0a0;">Assist an ally's Skill Test</strong>.
  </div>
  <div style="background:#261a00;border:1px solid #b8860b;border-radius:4px;padding:6px 10px;font-size:0.8em;color:#a08030;">
    ℹ AP cost and specific rules depend on the Skill Test being assisted. Consult your GM.
  </div>
</div>`,
    run: async (actor) => {
      ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: COMBAT_ACTIONS["Assist"].card });
    },
  },

  "Opportunity Attack": {
    card: `
<div style="border:2px solid #b8860b;border-radius:6px;background:#1a1500;color:#f0e0a0;font-family:'Palatino Linotype',serif;padding:10px 14px;max-width:340px;">
  <div style="background:#8a6200;color:#f0e0a0;font-size:1.1em;font-weight:bold;letter-spacing:1px;text-align:center;padding:4px 8px;margin:-10px -14px 10px -14px;border-radius:4px 4px 0 0;">⚔ OPPORTUNITY ATTACK</div>
  <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
    <span style="background:#261a00;border:1px solid #b8860b;border-radius:4px;padding:2px 10px;font-size:0.9em;">REACTION</span>
    <span style="background:#261a00;border:1px solid #b8860b;border-radius:4px;padding:2px 10px;font-size:0.9em;">0 AP</span>
  </div>
  <div style="font-size:0.85em;color:#d4b860;margin-bottom:8px;">
    Make a <strong style="color:#f0e0a0;">melee attack</strong> against a foe who has left themselves <strong style="color:#f0e0a0;">Defenseless</strong>.
  </div>
  <div style="background:#261a00;border:1px solid #b8860b;border-radius:4px;padding:6px 10px;font-size:0.8em;color:#a08030;">
    ⚠ Only triggered in <strong style="color:#f0e0a0;">specific situations</strong> — typically when a foe moves out of an Engagement without using Maneuver.
  </div>
</div>`,
    run: async (actor) => {
      const weapons = actor.items.filter(i => i.type === "weapon");
      if (!weapons.length) { ui.notifications.warn("No weapons found on this character."); return; }
      const weaponOptions = weapons.map((w, idx) => `<option value="${idx}">${w.name}</option>`).join("");
      new Dialog({
        title: "⚔ Opportunity Attack",
        content: `
          <style>
            #opp-dialog { font-family:'Palatino Linotype',serif;color:#f0e0a0;background:#1a1500;padding:8px; }
            #opp-dialog label { display:block;font-size:0.82em;color:#d4b860;margin-bottom:3px;margin-top:10px; }
            #opp-dialog select { width:100%;background:#261a00;border:1px solid #b8860b;color:#f0e0a0;border-radius:4px;padding:4px 8px;font-family:inherit; }
          </style>
          <div id="opp-dialog">
            <label>Select Weapon</label>
            <select id="weapon-select">${weaponOptions}</select>
          </div>`,
        buttons: {
          cancel: { label: "Cancel", icon: '<i class="fas fa-times"></i>' },
          roll: {
            label: "⚔ Strike!", icon: '<i class="fas fa-dice"></i>',
            callback: async (html) => {
              const weapon = weapons[parseInt(html.find("#weapon-select").val())];
              ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: COMBAT_ACTIONS["Opportunity Attack"].card });
              await weapon.roll();
            },
          },
        },
        default: "roll",
      }).render(true);
    },
  },

  "Resist": {
    card: `
<div style="border:2px solid #b8860b;border-radius:6px;background:#1a1500;color:#f0e0a0;font-family:'Palatino Linotype',serif;padding:10px 14px;max-width:340px;">
  <div style="background:#8a6200;color:#f0e0a0;font-size:1.1em;font-weight:bold;letter-spacing:1px;text-align:center;padding:4px 8px;margin:-10px -14px 10px -14px;border-radius:4px 4px 0 0;">💪 RESIST</div>
  <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
    <span style="background:#261a00;border:1px solid #b8860b;border-radius:4px;padding:2px 10px;font-size:0.9em;">REACTION</span>
    <span style="background:#261a00;border:1px solid #b8860b;border-radius:4px;padding:2px 10px;font-size:0.9em;">0 AP</span>
  </div>
  <div style="font-size:0.85em;color:#d4b860;margin-bottom:8px;">
    Resist the effects of <strong style="color:#f0e0a0;">Perilous Stunts</strong> and <strong style="color:#f0e0a0;">Special Actions</strong> used against you.
  </div>
  <div style="background:#261a00;border:1px solid #b8860b;border-radius:4px;padding:6px 10px;font-size:0.8em;color:#a08030;">
    ℹ The specific Skill used to Resist depends on the Stunt or Action being resisted — check the triggering effect.
  </div>
</div>`,
    run: async (actor) => {
      ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: COMBAT_ACTIONS["Resist"].card });
    },
  },

  "Counterspell": {
    card: `
<div style="border:2px solid #b8860b;border-radius:6px;background:#1a1500;color:#f0e0a0;font-family:'Palatino Linotype',serif;padding:10px 14px;max-width:340px;">
  <div style="background:#8a6200;color:#f0e0a0;font-size:1.1em;font-weight:bold;letter-spacing:1px;text-align:center;padding:4px 8px;margin:-10px -14px 10px -14px;border-radius:4px 4px 0 0;">✨ COUNTERSPELL</div>
  <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
    <span style="background:#261a00;border:1px solid #b8860b;border-radius:4px;padding:2px 10px;font-size:0.9em;">REACTION</span>
    <span style="background:#261a00;border:1px solid #b8860b;border-radius:4px;padding:2px 10px;font-size:0.9em;">1 AP</span>
  </div>
  <div style="font-size:0.85em;color:#d4b860;margin-bottom:8px;">
    Make an <strong style="color:#f0e0a0;">Incantation Test</strong>. On success, <strong style="color:#f0e0a0;">dispel the Magick immediately</strong>.
  </div>
  <div style="background:#261a00;border:1px solid #b8860b;border-radius:4px;padding:6px 10px;font-size:0.8em;color:#a08030;">
    ⚡ Must be declared in response to an enemy casting Magick, before its effects resolve.
  </div>
</div>`,
    run: async (actor) => {
      // Find and click the Incantation skill roll link on the open character sheet
      const sheetEl = document.querySelector(`[id*="${actor.id}"] .skill-roll[data-label="Incantation"]`)
        ?? document.querySelector(`.skill-roll[data-label="Incantation"]`);
      if (sheetEl) {
        sheetEl.click();
      } else {
        // Fallback: use skillItem.roll() which confirmed works
        const skillItem = actor.items.find(i => i.type === "skill" && i.name.toLowerCase() === "incantation");
        if (skillItem) { await skillItem.roll(); }
        else {
          ui.notifications.warn('"Incantation" skill not found on this character.');
          ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: COMBAT_ACTIONS["Counterspell"].card });
        }
      }
    },
  },

  // ── MOVEMENT ACTIONS ───────────────────────────────────────

  "Hustle": {
    card: `
<div style="border:2px solid #8b0000;border-radius:6px;background:#1a1a1a;color:#e8d5a3;font-family:'Palatino Linotype',serif;padding:10px 14px;max-width:340px;">
  <div style="background:#8b0000;color:#e8d5a3;font-size:1.1em;font-weight:bold;letter-spacing:1px;text-align:center;padding:4px 8px;margin:-10px -14px 10px -14px;border-radius:4px 4px 0 0;">🏃 HUSTLE</div>
  <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
    <span style="background:#3a1a1a;border:1px solid #8b0000;border-radius:4px;padding:2px 10px;font-size:0.9em;">MOVEMENT ACTION</span>
    <span style="background:#3a1a1a;border:1px solid #8b0000;border-radius:4px;padding:2px 10px;font-size:0.9em;">1 AP</span>
  </div>
  <div style="font-size:0.85em;color:#c0a060;margin-bottom:10px;">
    Move at <strong style="color:#e8d5a3;">×1 Movement</strong>.
  </div>
  <div style="background:#2a0000;border:1px solid #8b0000;border-radius:4px;padding:6px 10px;font-size:0.8em;color:#ff9999;">
    ⚠ Invokes an <strong>Opportunity Attack</strong> if moving out of an Engagement.
  </div>
</div>`,
    run: async (actor) => {
      ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: COMBAT_ACTIONS["Hustle"].card });
    },
  },

  "Run": {
    card: `
<div style="border:2px solid #8b0000;border-radius:6px;background:#1a1a1a;color:#e8d5a3;font-family:'Palatino Linotype',serif;padding:10px 14px;max-width:340px;">
  <div style="background:#8b0000;color:#e8d5a3;font-size:1.1em;font-weight:bold;letter-spacing:1px;text-align:center;padding:4px 8px;margin:-10px -14px 10px -14px;border-radius:4px 4px 0 0;">💨 RUN</div>
  <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
    <span style="background:#3a1a1a;border:1px solid #8b0000;border-radius:4px;padding:2px 10px;font-size:0.9em;">MOVEMENT ACTION</span>
    <span style="background:#3a1a1a;border:1px solid #8b0000;border-radius:4px;padding:2px 10px;font-size:0.9em;">1 AP</span>
  </div>
  <div style="font-size:0.85em;color:#c0a060;margin-bottom:10px;">
    Move at <strong style="color:#e8d5a3;">×3 Movement</strong> and gain <strong style="color:#e8d5a3;">+3 Damage Threshold</strong>.
  </div>
  <div style="background:#2a0000;border:1px solid #8b0000;border-radius:4px;padding:6px 10px;font-size:0.8em;color:#ff9999;">
    ⚠ Invokes an <strong>Opportunity Attack</strong> if moving out of an Engagement.
  </div>
</div>`,
    run: async (actor) => {
      ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: COMBAT_ACTIONS["Run"].card });
    },
  },

  "Maneuver": {
    card: `
<div style="border:2px solid #8b0000;border-radius:6px;background:#1a1a1a;color:#e8d5a3;font-family:'Palatino Linotype',serif;padding:10px 14px;max-width:340px;">
  <div style="background:#8b0000;color:#e8d5a3;font-size:1.1em;font-weight:bold;letter-spacing:1px;text-align:center;padding:4px 8px;margin:-10px -14px 10px -14px;border-radius:4px 4px 0 0;">🔄 MANEUVER</div>
  <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
    <span style="background:#3a1a1a;border:1px solid #8b0000;border-radius:4px;padding:2px 10px;font-size:0.9em;">MOVEMENT ACTION</span>
    <span style="background:#3a1a1a;border:1px solid #8b0000;border-radius:4px;padding:2px 10px;font-size:0.9em;">2 AP</span>
  </div>
  <div style="font-size:0.85em;color:#c0a060;margin-bottom:10px;">
    Move <strong style="color:#e8d5a3;">1 yard</strong> out of an Engagement.
  </div>
  <div style="background:#1a2a1a;border:1px solid #2a6b2a;border-radius:4px;padding:6px 10px;font-size:0.8em;color:#99ff99;">
    ✔ Avoids <strong>all Opportunity Attacks</strong>.
  </div>
</div>`,
    run: async (actor) => {
      ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: COMBAT_ACTIONS["Maneuver"].card });
    },
  },

  "Get Up": {
    card: `
<div style="border:2px solid #8b0000;border-radius:6px;background:#1a1a1a;color:#e8d5a3;font-family:'Palatino Linotype',serif;padding:10px 14px;max-width:340px;">
  <div style="background:#8b0000;color:#e8d5a3;font-size:1.1em;font-weight:bold;letter-spacing:1px;text-align:center;padding:4px 8px;margin:-10px -14px 10px -14px;border-radius:4px 4px 0 0;">🛡 GET UP</div>
  <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
    <span style="background:#3a1a1a;border:1px solid #8b0000;border-radius:4px;padding:2px 10px;font-size:0.9em;">MOVEMENT ACTION</span>
    <span style="background:#3a1a1a;border:1px solid #8b0000;border-radius:4px;padding:2px 10px;font-size:0.9em;">2 AP</span>
  </div>
  <div style="font-size:0.85em;color:#c0a060;margin-bottom:10px;">
    Stand up from <strong style="color:#e8d5a3;">Prone</strong> and move 1 yard, step into a vehicle or mount an animal.
  </div>
  <div style="background:#2a0000;border:1px solid #8b0000;border-radius:4px;padding:6px 10px;font-size:0.8em;color:#ff9999;">
    ⚠ Invokes an <strong>Opportunity Attack</strong> if moving out of an Engagement.
  </div>
</div>`,
    run: async (actor) => {
      ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: COMBAT_ACTIONS["Get Up"].card });
    },
  },

  "Take Cover": {
    card: `
<div style="border:2px solid #8b0000;border-radius:6px;background:#1a1a1a;color:#e8d5a3;font-family:'Palatino Linotype',serif;padding:10px 14px;max-width:340px;">
  <div style="background:#8b0000;color:#e8d5a3;font-size:1.1em;font-weight:bold;letter-spacing:1px;text-align:center;padding:4px 8px;margin:-10px -14px 10px -14px;border-radius:4px 4px 0 0;">🪨 TAKE COVER</div>
  <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
    <span style="background:#3a1a1a;border:1px solid #8b0000;border-radius:4px;padding:2px 10px;font-size:0.9em;">MOVEMENT ACTION</span>
    <span style="background:#3a1a1a;border:1px solid #8b0000;border-radius:4px;padding:2px 10px;font-size:0.9em;">1 AP</span>
  </div>
  <div style="font-size:0.85em;color:#c0a060;margin-bottom:6px;">
    Choose cover height for Damage Threshold bonus.
  </div>
  <div style="font-size:0.8em;color:#c0a060;margin-bottom:4px;">Low +3 &nbsp;|&nbsp; Medium +6 &nbsp;|&nbsp; High +9</div>
  <div style="background:#2a0000;border:1px solid #8b0000;border-radius:4px;padding:6px 10px;font-size:0.8em;color:#ff9999;">
    ⚠ Invokes an <strong>Opportunity Attack</strong> if moving out of an Engagement.
  </div>
</div>`,
    run: async (actor) => {
      const coverOptions = await new Promise((resolve) => {
        new Dialog({
          title: "Take Cover — Cover Height",
          content: `
            <p style="font-family:'Palatino Linotype',serif;margin-bottom:8px;color:#e8e8e8;">Select the height of cover taken:</p>
            <div style="display:flex;flex-direction:column;gap:6px;font-family:'Palatino Linotype',serif;">
              <label style="color:#e8e8e8;"><input type="radio" name="cover" value="low" checked> <strong>Low</strong> — +3 Damage Threshold</label>
              <label style="color:#e8e8e8;"><input type="radio" name="cover" value="medium"> <strong>Medium</strong> — +6 Damage Threshold</label>
              <label style="color:#e8e8e8;"><input type="radio" name="cover" value="high"> <strong>High</strong> — +9 Damage Threshold</label>
            </div>`,
          buttons: {
            ok: { label: "Take Cover!", callback: (html) => resolve(html.find("input[name=cover]:checked").val()) },
            cancel: { label: "Cancel", callback: () => resolve(null) },
          },
          default: "ok",
        }).render(true);
      });
      if (!coverOptions) return;
      const coverMap = {
        low:    { label: "Low Cover",    bonus: "+3", color: "#c8a000" },
        medium: { label: "Medium Cover", bonus: "+6", color: "#c86000" },
        high:   { label: "High Cover",   bonus: "+9", color: "#c83000" },
      };
      const cover = coverMap[coverOptions];
      const card = `
<div style="border:2px solid #8b0000;border-radius:6px;background:#1a1a1a;color:#e8d5a3;font-family:'Palatino Linotype',serif;padding:10px 14px;max-width:340px;">
  <div style="background:#8b0000;color:#e8d5a3;font-size:1.1em;font-weight:bold;letter-spacing:1px;text-align:center;padding:4px 8px;margin:-10px -14px 10px -14px;border-radius:4px 4px 0 0;">🪨 TAKE COVER</div>
  <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
    <span style="background:#3a1a1a;border:1px solid #8b0000;border-radius:4px;padding:2px 10px;font-size:0.9em;">MOVEMENT ACTION</span>
    <span style="background:#3a1a1a;border:1px solid #8b0000;border-radius:4px;padding:2px 10px;font-size:0.9em;">1 AP</span>
  </div>
  <div style="font-size:0.85em;color:#c0a060;margin-bottom:10px;">
    Take cover 1 yard away behind <strong style="color:#e8d5a3;">${cover.label}</strong>.
  </div>
  <div style="text-align:center;font-size:0.8em;color:#c0a060;margin-bottom:4px;">DAMAGE THRESHOLD BONUS</div>
  <div style="text-align:center;font-size:2em;font-weight:bold;color:${cover.color};background:#2a0000;border:2px solid #8b0000;border-radius:6px;padding:4px;margin-bottom:10px;">${cover.bonus}</div>
  <div style="background:#2a0000;border:1px solid #8b0000;border-radius:4px;padding:6px 10px;font-size:0.8em;color:#ff9999;">
    ⚠ Invokes an <strong>Opportunity Attack</strong> if moving out of an Engagement.
  </div>
</div>`;
      ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: card });
    },
  },

  "Charge": {
    card: `
<div style="border:2px solid #8b0000;border-radius:6px;background:#1a1a1a;color:#e8d5a3;font-family:'Palatino Linotype',serif;padding:10px 14px;max-width:340px;">
  <div style="background:#8b0000;color:#e8d5a3;font-size:1.1em;font-weight:bold;letter-spacing:1px;text-align:center;padding:4px 8px;margin:-10px -14px 10px -14px;border-radius:4px 4px 0 0;">⚔ CHARGE</div>
  <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
    <span style="background:#3a1a1a;border:1px solid #8b0000;border-radius:4px;padding:2px 10px;font-size:0.9em;">MOVEMENT ACTION</span>
    <span style="background:#3a1a1a;border:1px solid #8b0000;border-radius:4px;padding:2px 10px;font-size:0.9em;">2 AP</span>
  </div>
  <div style="font-size:0.85em;color:#c0a060;margin-bottom:10px;border-bottom:1px solid #5a2a2a;padding-bottom:8px;">
    Move at ×2 Movement. Invokes an Opportunity Attack if moving out of an Engagement.
  </div>
  <div style="font-size:0.85em;color:#c0a060;text-align:center;">Rolls an exploding Fury Die — add result to next attack Damage.</div>
</div>`,
    run: async (actor) => {
      const fury = await rollFuryDie();
      const diceBreakdown = fury.rolls.length > 1
        ? fury.rolls.join(" + ") + " = " + fury.total : String(fury.total);
      const explosionNote = fury.exploded
        ? `<div style="text-align:center;font-size:0.8em;color:#ffaa00;margin-bottom:6px;">🔥 FURY DIE EXPLODED! Rolled ${fury.rolls.length}x</div>`
        : "";
      const card = `
<div style="border:2px solid #8b0000;border-radius:6px;background:#1a1a1a;color:#e8d5a3;font-family:'Palatino Linotype',serif;padding:10px 14px;max-width:340px;">
  <div style="background:#8b0000;color:#e8d5a3;font-size:1.1em;font-weight:bold;letter-spacing:1px;text-align:center;padding:4px 8px;margin:-10px -14px 10px -14px;border-radius:4px 4px 0 0;">⚔ CHARGE</div>
  <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
    <span style="background:#3a1a1a;border:1px solid #8b0000;border-radius:4px;padding:2px 10px;font-size:0.9em;">MOVEMENT ACTION</span>
    <span style="background:#3a1a1a;border:1px solid #8b0000;border-radius:4px;padding:2px 10px;font-size:0.9em;">2 AP</span>
  </div>
  <div style="font-size:0.85em;color:#c0a060;margin-bottom:10px;border-bottom:1px solid #5a2a2a;padding-bottom:8px;">
    Move at ×2 Movement. Invokes an Opportunity Attack if moving out of an Engagement.
  </div>
  <div style="text-align:center;margin-bottom:6px;font-size:0.85em;color:#c0a060;">FURY DIE RESULT</div>
  ${explosionNote}
  <div style="text-align:center;font-size:2.2em;font-weight:bold;color:${fury.exploded ? "#ffaa00" : "#ff4444"};background:#2a0000;border:2px solid ${fury.exploded ? "#ffaa00" : "#8b0000"};border-radius:6px;padding:6px;margin-bottom:6px;text-shadow:0 0 8px ${fury.exploded ? "#ffaa00aa" : "#ff0000aa"};">+${fury.total}</div>
  <div style="text-align:center;font-size:0.75em;color:#888;margin-bottom:8px;">🎲 ${diceBreakdown}</div>
  <div style="font-size:0.8em;color:#a08050;text-align:center;">Add <strong style="color:#e8d5a3;">${fury.total}</strong> to your Damage on this attack.</div>
</div>`;
      ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: card, rollMode: game.settings.get("core", "rollMode") });
    },
  },

  // ── ATTACK ACTIONS ─────────────────────────────────────────

  "Melee Attack": {
    card: `
<div style="border:2px solid #1a4a6b;border-radius:6px;background:#0d1a24;color:#d0e8f0;font-family:'Palatino Linotype',serif;padding:10px 14px;max-width:340px;">
  <div style="background:#1a4a6b;color:#d0e8f0;font-size:1.1em;font-weight:bold;letter-spacing:1px;text-align:center;padding:4px 8px;margin:-10px -14px 10px -14px;border-radius:4px 4px 0 0;">⚔ MELEE ATTACK</div>
  <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
    <span style="background:#0d2233;border:1px solid #1a4a6b;border-radius:4px;padding:2px 10px;font-size:0.9em;">ATTACK ACTION</span>
    <span style="background:#0d2233;border:1px solid #1a4a6b;border-radius:4px;padding:2px 10px;font-size:0.9em;">1 AP</span>
  </div>
  <div style="font-size:0.85em;color:#a0c8e0;margin-bottom:10px;">
    Make a <strong style="color:#d0e8f0;">Combat-based Skill Test</strong>. On success, refer to <strong style="color:#d0e8f0;">[CB]</strong> and add <strong style="color:#d0e8f0;">1D6 Fury Die</strong> for Total Damage.
  </div>
  <div style="background:#0d2233;border:1px solid #1a4a6b;border-radius:4px;padding:6px 10px;font-size:0.78em;color:#6a9ab0;">
    ⚠ Foe may attempt to <strong style="color:#a0c8e0;">Parry</strong>.<br>
    ⚠ Cannot attack outside an Engagement unless weapon has <strong style="color:#a0c8e0;">Reach</strong>.
  </div>
</div>`,
    run: async (actor) => {
      const weapons = actor.items.filter(i => i.type === "weapon");
      if (!weapons.length) { ui.notifications.warn("No weapons found on this character."); return; }
      const weaponOptions = weapons.map((w, idx) => `<option value="${idx}">${w.name}</option>`).join("");
      new Dialog({
        title: "⚔ Melee Attack Setup",
        content: `
          <style>
            #melee-dialog { font-family:'Palatino Linotype',serif;color:#d0e8f0;background:#0d1a24;padding:8px; }
            #melee-dialog label { display:block;font-size:0.82em;color:#88b8d0;margin-bottom:3px;margin-top:10px; }
            #melee-dialog select { width:100%;background:#0d2233;border:1px solid #1a4a6b;color:#d0e8f0;border-radius:4px;padding:4px 8px;font-family:inherit; }
          </style>
          <div id="melee-dialog">
            <label>Select Weapon</label>
            <select id="weapon-select">${weaponOptions}</select>
          </div>`,
        buttons: {
          cancel: { label: "Cancel", icon: '<i class="fas fa-times"></i>' },
          roll: {
            label: "Attack ⚔", icon: '<i class="fas fa-dice"></i>',
            callback: async (html) => {
              const weapon = weapons[parseInt(html.find("#weapon-select").val())];
              const card = `
<div style="border:2px solid #1a4a6b;border-radius:6px;background:#0d1a24;color:#d0e8f0;font-family:'Palatino Linotype',serif;padding:10px 14px;max-width:340px;">
  <div style="background:#1a4a6b;color:#d0e8f0;font-size:1.1em;font-weight:bold;letter-spacing:1px;text-align:center;padding:4px 8px;margin:-10px -14px 10px -14px;border-radius:4px 4px 0 0;">⚔ MELEE ATTACK</div>
  <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
    <span style="background:#0d2233;border:1px solid #1a4a6b;border-radius:4px;padding:2px 10px;font-size:0.9em;">ATTACK ACTION</span>
    <span style="background:#0d2233;border:1px solid #1a4a6b;border-radius:4px;padding:2px 10px;font-size:0.9em;">1 AP</span>
  </div>
  <div style="font-size:0.8em;color:#88b8d0;margin-bottom:6px;"><strong style="color:#d0e8f0;">Weapon:</strong> ${weapon.name}</div>
  <div style="font-size:0.85em;color:#a0c8e0;margin-bottom:10px;">
    Make a <strong style="color:#d0e8f0;">Combat-based Skill Test</strong>. On success, refer to <strong style="color:#d0e8f0;">[CB]</strong> and add <strong style="color:#d0e8f0;">1D6 Fury Die</strong> for Total Damage.
  </div>
  <div style="background:#0d2233;border:1px solid #1a4a6b;border-radius:4px;padding:6px 10px;font-size:0.78em;color:#6a9ab0;">
    ⚠ Foe may attempt to <strong style="color:#a0c8e0;">Parry</strong>.<br>
    ⚠ Cannot attack outside an Engagement unless weapon has <strong style="color:#a0c8e0;">Reach</strong>.
  </div>
</div>`;
              ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: card });
              await weapon.roll();
            },
          },
        },
        default: "roll",
      }).render(true);
    },
  },

  "Ranged Attack": {
    card: `
<div style="border:2px solid #1a4a6b;border-radius:6px;background:#0d1a24;color:#d0e8f0;font-family:'Palatino Linotype',serif;padding:10px 14px;max-width:340px;">
  <div style="background:#1a4a6b;color:#d0e8f0;font-size:1.1em;font-weight:bold;letter-spacing:1px;text-align:center;padding:4px 8px;margin:-10px -14px 10px -14px;border-radius:4px 4px 0 0;">🏹 RANGED ATTACK</div>
  <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
    <span style="background:#0d2233;border:1px solid #1a4a6b;border-radius:4px;padding:2px 10px;font-size:0.9em;">ATTACK ACTION</span>
    <span style="background:#0d2233;border:1px solid #1a4a6b;border-radius:4px;padding:2px 10px;font-size:0.9em;">1 AP</span>
  </div>
  <div style="font-size:0.85em;color:#a0c8e0;margin-bottom:10px;">
    Make a <strong style="color:#d0e8f0;">Combat-based Skill Test</strong>. On success, refer to <strong style="color:#d0e8f0;">[CB]</strong> and add <strong style="color:#d0e8f0;">1D6 Fury Die</strong> for Total Damage.
  </div>
  <div style="background:#0d2233;border:1px solid #1a4a6b;border-radius:4px;padding:6px 10px;font-size:0.78em;color:#6a9ab0;">
    ⚠ Foe may <strong style="color:#a0c8e0;">Dodge</strong> or <strong style="color:#a0c8e0;">Parry with a shield</strong>.<br>
    ⚠ Cannot be used in an Engagement unless weapon has <strong style="color:#a0c8e0;">Gunpowder</strong> quality.<br>
    ⚠ Weapon must be <strong style="color:#a0c8e0;">loaded</strong> to fire.
  </div>
</div>`,
    run: async (actor) => {
      const weapons = actor.items.filter(i => i.type === "weapon");
      if (!weapons.length) { ui.notifications.warn("No weapons found on this character."); return; }
      const weaponOptions = weapons.map((w, idx) => `<option value="${idx}">${w.name}</option>`).join("");
      new Dialog({
        title: "🏹 Ranged Attack Setup",
        content: `
          <style>
            #ranged-dialog { font-family:'Palatino Linotype',serif;color:#d0e8f0;background:#0d1a24;padding:8px; }
            #ranged-dialog label { display:block;font-size:0.82em;color:#88b8d0;margin-bottom:3px;margin-top:10px; }
            #ranged-dialog select { width:100%;background:#0d2233;border:1px solid #1a4a6b;color:#d0e8f0;border-radius:4px;padding:4px 8px;font-family:inherit; }
          </style>
          <div id="ranged-dialog">
            <label>Select Weapon</label>
            <select id="weapon-select">${weaponOptions}</select>
          </div>`,
        buttons: {
          cancel: { label: "Cancel", icon: '<i class="fas fa-times"></i>' },
          roll: {
            label: "Attack 🏹", icon: '<i class="fas fa-dice"></i>',
            callback: async (html) => {
              const weapon = weapons[parseInt(html.find("#weapon-select").val())];
              const card = `
<div style="border:2px solid #1a4a6b;border-radius:6px;background:#0d1a24;color:#d0e8f0;font-family:'Palatino Linotype',serif;padding:10px 14px;max-width:340px;">
  <div style="background:#1a4a6b;color:#d0e8f0;font-size:1.1em;font-weight:bold;letter-spacing:1px;text-align:center;padding:4px 8px;margin:-10px -14px 10px -14px;border-radius:4px 4px 0 0;">🏹 RANGED ATTACK</div>
  <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
    <span style="background:#0d2233;border:1px solid #1a4a6b;border-radius:4px;padding:2px 10px;font-size:0.9em;">ATTACK ACTION</span>
    <span style="background:#0d2233;border:1px solid #1a4a6b;border-radius:4px;padding:2px 10px;font-size:0.9em;">1 AP</span>
  </div>
  <div style="font-size:0.8em;color:#88b8d0;margin-bottom:6px;"><strong style="color:#d0e8f0;">Weapon:</strong> ${weapon.name}</div>
  <div style="font-size:0.85em;color:#a0c8e0;margin-bottom:10px;">
    Make a <strong style="color:#d0e8f0;">Combat-based Skill Test</strong>. On success, refer to <strong style="color:#d0e8f0;">[CB]</strong> and add <strong style="color:#d0e8f0;">1D6 Fury Die</strong> for Total Damage.
  </div>
  <div style="background:#0d2233;border:1px solid #1a4a6b;border-radius:4px;padding:6px 10px;font-size:0.78em;color:#6a9ab0;">
    ⚠ Foe may <strong style="color:#a0c8e0;">Dodge</strong> or <strong style="color:#a0c8e0;">Parry with a shield</strong>.<br>
    ⚠ Cannot be used in an Engagement unless weapon has <strong style="color:#a0c8e0;">Gunpowder</strong> quality.<br>
    ⚠ Weapon must be <strong style="color:#a0c8e0;">loaded</strong> to fire.
  </div>
</div>`;
              ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: card });
              await weapon.roll();
            },
          },
        },
        default: "roll",
      }).render(true);
    },
  },

  "Cast Magic": {
    card: `
<div style="border:2px solid #1a4a6b;border-radius:6px;background:#0d1a24;color:#d0e8f0;font-family:'Palatino Linotype',serif;padding:10px 14px;max-width:340px;">
  <div style="background:#1a4a6b;color:#d0e8f0;font-size:1.1em;font-weight:bold;letter-spacing:1px;text-align:center;padding:4px 8px;margin:-10px -14px 10px -14px;border-radius:4px 4px 0 0;">✨ CAST MAGICK</div>
  <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
    <span style="background:#0d2233;border:1px solid #1a4a6b;border-radius:4px;padding:2px 10px;font-size:0.9em;">ATTACK ACTION</span>
    <span style="background:#0d2233;border:1px solid #1a4a6b;border-radius:4px;padding:2px 10px;font-size:0.9em;">VARIES</span>
  </div>
  <div style="font-size:0.85em;color:#a0c8e0;margin-bottom:10px;">
    Make an <strong style="color:#d0e8f0;">Incantation Test</strong>. See your Grimoire for specific spell effects.
  </div>
  <div style="background:#0d2233;border:1px solid #1a4a6b;border-radius:4px;padding:6px 10px;font-size:0.78em;color:#6a9ab0;">
    📖 <strong style="color:#a0c8e0;">Generalist &amp; Petty Magicks:</strong> 1 AP<br>
    📖 <strong style="color:#a0c8e0;">Lesser Magicks:</strong> 2 AP<br>
    📖 <strong style="color:#a0c8e0;">Greater Magicks:</strong> 3 AP
  </div>
</div>`,
    run: async (actor) => {
      const spells = actor.items.filter(i => i.type === "spell");
      // Build spell picker if they have spells, otherwise just roll Incantation
      if (spells.length) {
        const spellOptions = spells.map((s, idx) => `<option value="${idx}">${s.name}</option>`).join("");
        new Dialog({
          title: "✨ Cast Magick — Choose Spell",
          content: `
            <style>#cm-dialog{font-family:'Palatino Linotype',serif;color:#d0e8f0;background:#0d1a24;padding:8px;}
            #cm-dialog label{display:block;font-size:0.82em;color:#88b8d0;margin-bottom:3px;margin-top:10px;}
            #cm-dialog select{width:100%;background:#0d2233;border:1px solid #1a4a6b;color:#d0e8f0;border-radius:4px;padding:4px 8px;font-family:inherit;}</style>
            <div id="cm-dialog"><label>Select Spell</label>
            <select id="spell-select">${spellOptions}</select></div>`,
          buttons: {
            cancel: { label: "Cancel", icon: '<i class="fas fa-times"></i>' },
            roll: {
              label: "✨ Cast!", icon: '<i class="fas fa-dice"></i>',
              callback: async (html) => {
                const spell = spells[parseInt(html.find("#spell-select").val())];
                const card = COMBAT_ACTIONS["Cast Magic"].card.replace("✨ CAST MAGICK", `✨ CAST MAGICK — ${spell.name}`);
                ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: card });
                await rollSkillByName(actor, "Incantation");
              },
            },
          },
          default: "roll",
        }).render(true);
      } else {
        ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: COMBAT_ACTIONS["Cast Magic"].card });
        await rollSkillByName(actor, "Incantation");
      }
    },
  },

  "Called Shot": {
    card: `
<div style="border:2px solid #1a4a6b;border-radius:6px;background:#0d1a24;color:#d0e8f0;font-family:'Palatino Linotype',serif;padding:10px 14px;max-width:340px;">
  <div style="background:#1a4a6b;color:#d0e8f0;font-size:1.1em;font-weight:bold;letter-spacing:1px;text-align:center;padding:4px 8px;margin:-10px -14px 10px -14px;border-radius:4px 4px 0 0;">🎯 CALLED SHOT</div>
  <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
    <span style="background:#0d2233;border:1px solid #1a4a6b;border-radius:4px;padding:2px 10px;font-size:0.9em;">ATTACK ACTION</span>
    <span style="background:#0d2233;border:1px solid #1a4a6b;border-radius:4px;padding:2px 10px;font-size:0.9em;">2 AP</span>
  </div>
  <div style="font-size:0.85em;color:#a0c8e0;margin-bottom:6px;">
    Arms/Body −10% +1 Fury Die &nbsp;|&nbsp; Legs −20% +1 Fury Die + Prone &nbsp;|&nbsp; Head −30% +2 Fury Dice
  </div>
  <div style="background:#0d2233;border:1px solid #1a4a6b;border-radius:4px;padding:6px 10px;font-size:0.78em;color:#6a9ab0;">
    ⚠ Foe <strong style="color:#a0c8e0;">cannot Dodge or Parry</strong>.
  </div>
</div>`,
    run: async (actor) => {
      const locationMap = {
        arms: { label: "Arms", penalty: "-10%", modifier: -10, color: "#6a9ab0", extra: "🎲 Add <strong>1 Fury Die</strong> to damage on a successful hit." },
        body: { label: "Body", penalty: "-10%", modifier: -10, color: "#6a9ab0", extra: "🎲 Add <strong>1 Fury Die</strong> to damage on a successful hit." },
        legs: { label: "Legs", penalty: "-20%", modifier: -20, color: "#c8a000", extra: "🦵 Foe knocked <strong>Prone</strong> on a successful hit.<br>🎲 Add <strong>1 Fury Die</strong> to damage on a successful hit." },
        head: { label: "Head", penalty: "-30%", modifier: -30, color: "#c84000", extra: "💀 Add <strong>2 Fury Dice</strong> to damage on a successful hit." },
      };
      const targetLocation = await new Promise((resolve) => {
        new Dialog({
          title: "Called Shot — Target Location",
          content: `
            <p style="font-family:'Palatino Linotype',serif;margin-bottom:8px;color:#e8e8e8;">Where are you targeting?</p>
            <div style="display:flex;flex-direction:column;gap:6px;font-family:'Palatino Linotype',serif;color:#e8e8e8;">
              <label style="color:#e8e8e8;"><input type="radio" name="target" value="arms" checked> <strong>Arms</strong> — -10% to Skill | +1 Fury Die on hit</label>
              <label style="color:#e8e8e8;"><input type="radio" name="target" value="body"> <strong>Body</strong> — -10% to Skill | +1 Fury Die on hit</label>
              <label style="color:#e8e8e8;"><input type="radio" name="target" value="legs"> <strong>Legs</strong> — -20% to Skill | +1 Fury Die &amp; Knock Prone on hit</label>
              <label style="color:#e8e8e8;"><input type="radio" name="target" value="head"> <strong>Head</strong> — -30% to Skill | +2 Fury Dice on hit</label>
            </div>`,
          buttons: {
            ok:     { label: "Declare Shot!", callback: (html) => resolve(html.find("input[name=target]:checked").val()) },
            cancel: { label: "Cancel",        callback: () => resolve(null) },
          },
          default: "ok",
        }).render(true);
      });
      if (!targetLocation) return;
      const loc = locationMap[targetLocation];

      const weapons = actor.items.filter(i => i.type === "weapon");
      if (!weapons.length) { ui.notifications.warn("No weapons found on this character."); return; }
      const weaponOptions = weapons.map(w => `<option value="${w.id}">${w.name}</option>`).join("");
      const weaponId = await new Promise((resolve) => {
        new Dialog({
          title: "Called Shot — Choose Weapon",
          content: `
            <div style="font-family:'Palatino Linotype',serif;padding:4px 0 8px;">
              <p style="margin-bottom:8px;">Which weapon are you using?</p>
              <select name="weapon" style="width:100%;padding:4px;font-family:'Palatino Linotype',serif;background:#0d2233;color:#d0e8f0;border:1px solid #1a4a6b;border-radius:4px;">
                ${weaponOptions}
              </select>
            </div>`,
          buttons: {
            ok:     { label: "🎯 Declare & Roll", callback: (html) => resolve(html.find("select[name=weapon]").val()) },
            cancel: { label: "Cancel",            callback: () => resolve(null) },
          },
          default: "ok",
        }).render(true);
      });
      if (!weaponId) return;
      const weapon = actor.items.get(weaponId);

      const card = `
<div style="border:2px solid #1a4a6b;border-radius:6px;background:#0d1a24;color:#d0e8f0;font-family:'Palatino Linotype',serif;padding:10px 14px;max-width:340px;">
  <div style="background:#1a4a6b;color:#d0e8f0;font-size:1.1em;font-weight:bold;letter-spacing:1px;text-align:center;padding:4px 8px;margin:-10px -14px 10px -14px;border-radius:4px 4px 0 0;">🎯 CALLED SHOT</div>
  <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
    <span style="background:#0d2233;border:1px solid #1a4a6b;border-radius:4px;padding:2px 10px;font-size:0.9em;">ATTACK ACTION</span>
    <span style="background:#0d2233;border:1px solid #1a4a6b;border-radius:4px;padding:2px 10px;font-size:0.9em;">2 AP</span>
  </div>
  <div style="font-size:0.85em;color:#b0b0c8;margin-bottom:8px;">Weapon: <strong style="color:#d0e8f0;">${weapon.name}</strong></div>
  <div style="display:flex;justify-content:space-between;align-items:center;background:#0d2233;border:2px solid #1a4a6b;border-radius:6px;padding:6px 14px;margin-bottom:10px;">
    <span style="font-size:1.3em;font-weight:bold;color:#d0e8f0;">${loc.label}</span>
    <span style="font-size:1.2em;font-weight:bold;color:${loc.color};">${loc.penalty} to Skill</span>
  </div>
  <div style="background:#0d2233;border:1px solid ${loc.color};border-radius:4px;padding:6px 10px;font-size:0.85em;color:#d0e8f0;margin-bottom:10px;text-align:center;">${loc.extra}</div>
  <div style="background:#0d2233;border:1px solid #1a4a6b;border-radius:4px;padding:6px 10px;font-size:0.78em;color:#6a9ab0;">
    ⚠ Foe <strong style="color:#a0c8e0;">cannot Dodge or Parry</strong>.<br>
    ⚠ Ranged requires <strong style="color:#a0c8e0;">Gunpowder</strong> quality if in Engagement. Weapon must be loaded.
  </div>
</div>`;
      await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: card });
      await triggerWeaponRoll(actor, weapon, loc.modifier);
    },
  },

  // ── PERILOUS STUNTS ────────────────────────────────────────

  "Chokehold": {
    card: `
<div style="border:2px solid #6a0dad;border-radius:6px;background:#110d1a;color:#e8d0f0;font-family:'Palatino Linotype',serif;padding:10px 14px;max-width:340px;">
  <div style="background:#6a0dad;color:#e8d0f0;font-size:1.1em;font-weight:bold;letter-spacing:1px;text-align:center;padding:4px 8px;margin:-10px -14px 10px -14px;border-radius:4px 4px 0 0;">🤜 CHOKEHOLD</div>
  <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
    <span style="background:#1d0d2e;border:1px solid #6a0dad;border-radius:4px;padding:2px 10px;font-size:0.9em;">PERILOUS STUNT</span>
    <span style="background:#1d0d2e;border:1px solid #6a0dad;border-radius:4px;padding:2px 10px;font-size:0.9em;">1 AP</span>
  </div>
  <div style="font-size:0.85em;color:#c0a0d8;margin-bottom:8px;">
    Make an <strong style="color:#e8d0f0;">Athletics Test</strong>. Foe must <strong style="color:#e8d0f0;">Resist Athletics</strong> or be <strong style="color:#e8d0f0;">Choked</strong>.
  </div>
  <div style="background:#1d0d2e;border:1px solid #6a0dad;border-radius:4px;padding:6px 10px;font-size:0.8em;color:#c0a0d8;margin-bottom:6px;">
    💀 On failure, foe suffers <strong style="color:#e8d0f0;">1D10+[BB] Peril</strong> immediately.
  </div>
  <div style="background:#1d0d2e;border:1px solid #6a0dad;border-radius:4px;padding:6px 10px;font-size:0.8em;color:#c0a0d8;">
    🔁 Peril is reapplied <strong style="color:#e8d0f0;">each of your Turns</strong> while the hold is maintained, until Resisted.
  </div>
</div>`,
    run: async (actor) => {
      ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: COMBAT_ACTIONS["Chokehold"].card });
      await rollSkillByName(actor, "Athletics");
    },
  },

  "Dirty Tricks": {
    card: `
<div style="border:2px solid #6a0dad;border-radius:6px;background:#110d1a;color:#e8d0f0;font-family:'Palatino Linotype',serif;padding:10px 14px;max-width:340px;">
  <div style="background:#6a0dad;color:#e8d0f0;font-size:1.1em;font-weight:bold;letter-spacing:1px;text-align:center;padding:4px 8px;margin:-10px -14px 10px -14px;border-radius:4px 4px 0 0;">🃏 DIRTY TRICKS</div>
  <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
    <span style="background:#1d0d2e;border:1px solid #6a0dad;border-radius:4px;padding:2px 10px;font-size:0.9em;">PERILOUS STUNT</span>
    <span style="background:#1d0d2e;border:1px solid #6a0dad;border-radius:4px;padding:2px 10px;font-size:0.9em;">1 AP</span>
  </div>
  <div style="font-size:0.85em;color:#c0a0d8;margin-bottom:8px;">
    Make a <strong style="color:#e8d0f0;">Guile Test</strong>. Foe must <strong style="color:#e8d0f0;">Resist Awareness</strong> or be <strong style="color:#e8d0f0;">Blinded</strong>.
  </div>
  <div style="background:#1d0d2e;border:1px solid #6a0dad;border-radius:4px;padding:6px 10px;font-size:0.8em;color:#c0a0d8;">
    ⚠ While Blinded, foe <strong style="color:#e8d0f0;">cannot Counterspell, Dodge or Parry</strong> until their next Turn.
  </div>
</div>`,
    run: async (actor) => {
      ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: COMBAT_ACTIONS["Dirty Tricks"].card });
      await rollSkillByName(actor, "Guile");
    },
  },

  "Disarm": {
    card: `
<div style="border:2px solid #6a0dad;border-radius:6px;background:#110d1a;color:#e8d0f0;font-family:'Palatino Linotype',serif;padding:10px 14px;max-width:340px;">
  <div style="background:#6a0dad;color:#e8d0f0;font-size:1.1em;font-weight:bold;letter-spacing:1px;text-align:center;padding:4px 8px;margin:-10px -14px 10px -14px;border-radius:4px 4px 0 0;">🗡 DISARM</div>
  <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
    <span style="background:#1d0d2e;border:1px solid #6a0dad;border-radius:4px;padding:2px 10px;font-size:0.9em;">PERILOUS STUNT</span>
    <span style="background:#1d0d2e;border:1px solid #6a0dad;border-radius:4px;padding:2px 10px;font-size:0.9em;">1 AP</span>
  </div>
  <div style="font-size:0.85em;color:#c0a0d8;margin-bottom:8px;">
    Make a <strong style="color:#e8d0f0;">Coordination Test</strong>. Foe must <strong style="color:#e8d0f0;">Resist Coordination</strong> or be <strong style="color:#e8d0f0;">Disarmed</strong>.
  </div>
  <div style="background:#1d0d2e;border:1px solid #6a0dad;border-radius:4px;padding:6px 10px;font-size:0.8em;color:#c0a0d8;">
    ⚠ Foe <strong style="color:#e8d0f0;">loses their weapon</strong> and cannot use their primary hand until next Turn.
  </div>
</div>`,
    run: async (actor) => {
      ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: COMBAT_ACTIONS["Disarm"].card });
      await rollSkillByName(actor, "Coordination");
    },
  },

  "Knockout": {
    card: `
<div style="border:2px solid #6a0dad;border-radius:6px;background:#110d1a;color:#e8d0f0;font-family:'Palatino Linotype',serif;padding:10px 14px;max-width:340px;">
  <div style="background:#6a0dad;color:#e8d0f0;font-size:1.1em;font-weight:bold;letter-spacing:1px;text-align:center;padding:4px 8px;margin:-10px -14px 10px -14px;border-radius:4px 4px 0 0;">👊 KNOCKOUT</div>
  <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
    <span style="background:#1d0d2e;border:1px solid #6a0dad;border-radius:4px;padding:2px 10px;font-size:0.9em;">PERILOUS STUNT</span>
    <span style="background:#1d0d2e;border:1px solid #6a0dad;border-radius:4px;padding:2px 10px;font-size:0.9em;">1 AP</span>
  </div>
  <div style="font-size:0.85em;color:#c0a0d8;margin-bottom:8px;">
    Foe must be <strong style="color:#e8d0f0;">Defenseless or Surprised</strong>. Make an <strong style="color:#e8d0f0;">Athletics Test</strong> or foe is <strong style="color:#e8d0f0;">Knocked Out</strong>.
  </div>
  <div style="background:#1d0d2e;border:1px solid #6a0dad;border-radius:4px;padding:6px 10px;font-size:0.8em;color:#c0a0d8;margin-bottom:6px;">
    😴 Foe is left <strong style="color:#e8d0f0;">Helpless</strong> and rendered <strong style="color:#e8d0f0;">unconscious</strong> for <strong style="color:#e8d0f0;">[BB] Turns</strong>.
  </div>
  <div style="background:#1d0d2e;border:1px solid #6a0dad;border-radius:4px;padding:6px 10px;font-size:0.8em;color:#c0a0d8;">
    💀 Foe suffers <strong style="color:#e8d0f0;">2D10+[BB] Peril</strong> on failure.
  </div>
</div>`,
    run: async (actor) => {
      ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: COMBAT_ACTIONS["Knockout"].card });
      await rollSkillByName(actor, "Athletics");
    },
  },

  "Splinter Shield": {
    card: `
<div style="border:2px solid #6a0dad;border-radius:6px;background:#110d1a;color:#e8d0f0;font-family:'Palatino Linotype',serif;padding:10px 14px;max-width:340px;">
  <div style="background:#6a0dad;color:#e8d0f0;font-size:1.1em;font-weight:bold;letter-spacing:1px;text-align:center;padding:4px 8px;margin:-10px -14px 10px -14px;border-radius:4px 4px 0 0;">🛡 SPLINTER SHIELD</div>
  <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
    <span style="background:#1d0d2e;border:1px solid #6a0dad;border-radius:4px;padding:2px 10px;font-size:0.9em;">PERILOUS STUNT</span>
    <span style="background:#1d0d2e;border:1px solid #6a0dad;border-radius:4px;padding:2px 10px;font-size:0.9em;">1 AP</span>
  </div>
  <div style="font-size:0.85em;color:#c0a0d8;margin-bottom:8px;">
    Make a <strong style="color:#e8d0f0;">Combat-based Skill Test</strong>. Foe must <strong style="color:#e8d0f0;">Resist Toughness</strong> or their shield is <strong style="color:#e8d0f0;">Ruined!</strong>
  </div>
  <div style="background:#1d0d2e;border:1px solid #6a0dad;border-radius:4px;padding:6px 10px;font-size:0.8em;color:#ff9999;">
    💥 On success, the foe's shield is <strong style="color:#ffcccc;">permanently destroyed</strong>.
  </div>
</div>`,
    run: async (actor) => {
      const weapons = actor.items.filter(i => i.type === "weapon");
      if (!weapons.length) { ui.notifications.warn("No weapons found on this character."); return; }
      const weaponOptions = weapons.map((w, idx) => `<option value="${idx}">${w.name}</option>`).join("");
      new Dialog({
        title: "🛡 Splinter Shield — Choose Weapon",
        content: `
          <style>#ss-dialog{font-family:'Palatino Linotype',serif;color:#e8d0f0;background:#110d1a;padding:8px;}
          #ss-dialog label{display:block;font-size:0.82em;color:#c0a0d8;margin-bottom:3px;margin-top:10px;}
          #ss-dialog select{width:100%;background:#1d0d2e;border:1px solid #6a0dad;color:#e8d0f0;border-radius:4px;padding:4px 8px;font-family:inherit;}</style>
          <div id="ss-dialog"><label>Select Weapon</label>
          <select id="weapon-select">${weaponOptions}</select></div>`,
        buttons: {
          cancel: { label: "Cancel", icon: '<i class="fas fa-times"></i>' },
          roll: {
            label: "🛡 Roll!", icon: '<i class="fas fa-dice"></i>',
            callback: async (html) => {
              const weapon = weapons[parseInt(html.find("#weapon-select").val())];
              ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: COMBAT_ACTIONS["Splinter Shield"].card });
              await weapon.roll();
            },
          },
        },
        default: "roll",
      }).render(true);
    },
  },

  "Stunning Blow": {
    card: `
<div style="border:2px solid #6a0dad;border-radius:6px;background:#110d1a;color:#e8d0f0;font-family:'Palatino Linotype',serif;padding:10px 14px;max-width:340px;">
  <div style="background:#6a0dad;color:#e8d0f0;font-size:1.1em;font-weight:bold;letter-spacing:1px;text-align:center;padding:4px 8px;margin:-10px -14px 10px -14px;border-radius:4px 4px 0 0;">⭐ STUNNING BLOW</div>
  <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
    <span style="background:#1d0d2e;border:1px solid #6a0dad;border-radius:4px;padding:2px 10px;font-size:0.9em;">PERILOUS STUNT</span>
    <span style="background:#1d0d2e;border:1px solid #6a0dad;border-radius:4px;padding:2px 10px;font-size:0.9em;">1 AP</span>
  </div>
  <div style="font-size:0.85em;color:#c0a0d8;margin-bottom:8px;">
    Make an <strong style="color:#e8d0f0;">Athletics Test</strong>. Foe must <strong style="color:#e8d0f0;">Resist Toughness</strong> or be <strong style="color:#e8d0f0;">Stunned</strong>.
  </div>
  <div style="background:#1d0d2e;border:1px solid #6a0dad;border-radius:4px;padding:6px 10px;font-size:0.8em;color:#c0a0d8;margin-bottom:6px;">
    ⚡ Stunned foe starts with <strong style="color:#e8d0f0;">1 less AP</strong> until Resist Toughness is successful.
  </div>
  <div style="background:#1d0d2e;border:1px solid #6a0dad;border-radius:4px;padding:6px 10px;font-size:0.8em;color:#c0a0d8;">
    ℹ Effect persists each Round until the foe successfully Resists.
  </div>
</div>`,
    run: async (actor) => {
      ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: COMBAT_ACTIONS["Stunning Blow"].card });
      await rollSkillByName(actor, "Athletics");
    },
  },

  "Takedown": {
    card: `
<div style="border:2px solid #6a0dad;border-radius:6px;background:#110d1a;color:#e8d0f0;font-family:'Palatino Linotype',serif;padding:10px 14px;max-width:340px;">
  <div style="background:#6a0dad;color:#e8d0f0;font-size:1.1em;font-weight:bold;letter-spacing:1px;text-align:center;padding:4px 8px;margin:-10px -14px 10px -14px;border-radius:4px 4px 0 0;">🤸 TAKEDOWN</div>
  <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
    <span style="background:#1d0d2e;border:1px solid #6a0dad;border-radius:4px;padding:2px 10px;font-size:0.9em;">PERILOUS STUNT</span>
    <span style="background:#1d0d2e;border:1px solid #6a0dad;border-radius:4px;padding:2px 10px;font-size:0.9em;">1 AP</span>
  </div>
  <div style="font-size:0.85em;color:#c0a0d8;margin-bottom:8px;">
    Make a <strong style="color:#e8d0f0;">Coordination or Athletics Test</strong>. Foe must <strong style="color:#e8d0f0;">Resist Coordination</strong> or be knocked <strong style="color:#e8d0f0;">Prone</strong>.
  </div>
  <div style="background:#1d0d2e;border:1px solid #6a0dad;border-radius:4px;padding:6px 10px;font-size:0.8em;color:#c0a0d8;">
    ⚡ If you used <strong style="color:#e8d0f0;">Charge</strong> this Turn, attacks gain <strong style="color:#e8d0f0;">1D6 Fury Die</strong>.
  </div>
</div>`,
    run: async (actor) => {
      const chargedFirst = await new Promise((resolve) => {
        new Dialog({
          title: "Takedown — Did you Charge this Turn?",
          content: `<p style="font-family:'Palatino Linotype',serif;color:#e8e8e8;">Did you use the <strong>Charge</strong> action this Turn? Attacks gain 1D6 Fury Die if so.</p>`,
          buttons: {
            yes: { label: "✔ Yes, I Charged", callback: () => resolve(true) },
            no:  { label: "✘ No",             callback: () => resolve(false) },
          },
          default: "no",
        }).render(true);
      });
      let furySection = "";
      if (chargedFirst) {
        const fury = await rollFuryDie();
        const breakdown = fury.rolls.length > 1
          ? fury.rolls.join(" + ") + " = " + fury.total : String(fury.total);
        furySection = `
    <div style="text-align:center;font-size:0.78em;color:#c0a0d8;margin-bottom:4px;">CHARGE FURY DIE</div>
    ${fury.exploded ? `<div style="text-align:center;font-size:0.75em;color:#ffaa00;margin-bottom:4px;">🔥 FURY DIE EXPLODED!</div>` : ""}
    <div style="text-align:center;font-size:1.8em;font-weight:bold;color:${fury.exploded ? "#ffaa00" : "#cc44ff"};background:#1d0d2e;border:2px solid ${fury.exploded ? "#ffaa00" : "#6a0dad"};border-radius:6px;padding:4px;margin-bottom:4px;">+${fury.total}</div>
    <div style="text-align:center;font-size:0.72em;color:#9060b0;margin-bottom:10px;">🎲 ${breakdown}</div>`;
      }
      const card = `
<div style="border:2px solid #6a0dad;border-radius:6px;background:#110d1a;color:#e8d0f0;font-family:'Palatino Linotype',serif;padding:10px 14px;max-width:340px;">
  <div style="background:#6a0dad;color:#e8d0f0;font-size:1.1em;font-weight:bold;letter-spacing:1px;text-align:center;padding:4px 8px;margin:-10px -14px 10px -14px;border-radius:4px 4px 0 0;">🤸 TAKEDOWN</div>
  <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
    <span style="background:#1d0d2e;border:1px solid #6a0dad;border-radius:4px;padding:2px 10px;font-size:0.9em;">PERILOUS STUNT</span>
    <span style="background:#1d0d2e;border:1px solid #6a0dad;border-radius:4px;padding:2px 10px;font-size:0.9em;">1 AP</span>
  </div>
  <div style="font-size:0.85em;color:#c0a0d8;margin-bottom:8px;">
    Make a <strong style="color:#e8d0f0;">Coordination or Athletics Test</strong>. Foe must <strong style="color:#e8d0f0;">Resist Coordination</strong> or be knocked <strong style="color:#e8d0f0;">Prone</strong>.
  </div>
  ${furySection}
  <div style="background:#1d0d2e;border:1px solid #6a0dad;border-radius:4px;padding:6px 10px;font-size:0.8em;color:#c0a0d8;">
    ⚡ If you used <strong style="color:#e8d0f0;">Charge</strong> this Turn, attacks gain <strong style="color:#e8d0f0;">1D6 Fury Die</strong>.
  </div>
</div>`;
      ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: card });
      new Dialog({
        title: "Takedown — Choose Skill",
        content: `<p style="font-family:'Palatino Linotype',serif;color:#e8e8e8;">Roll <strong>Coordination</strong> or <strong>Athletics</strong>?</p>`,
        buttons: {
          coord: { label: "Coordination", callback: async () => await rollSkillByName(actor, "Coordination") },
          athl:  { label: "Athletics",    callback: async () => await rollSkillByName(actor, "Athletics") },
        },
        default: "coord",
      }).render(true);
    },
  },

  "Channel Power": {
    card: `
<div style="border:2px solid #7a7a8a;border-radius:6px;background:#131318;color:#e0e0f0;font-family:'Palatino Linotype',serif;padding:10px 14px;max-width:340px;">
  <div style="background:#4a4a5a;color:#e0e0f0;font-size:1.1em;font-weight:bold;letter-spacing:1px;text-align:center;padding:4px 8px;margin:-10px -14px 10px -14px;border-radius:4px 4px 0 0;">✦ CHANNEL POWER</div>
  <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
    <span style="background:#1e1e28;border:1px solid #7a7a8a;border-radius:4px;padding:2px 10px;font-size:0.9em;">SPECIAL ACTION</span>
    <span style="background:#1e1e28;border:1px solid #7a7a8a;border-radius:4px;padding:2px 10px;font-size:0.9em;">1 AP</span>
  </div>
  <div style="font-size:0.85em;color:#b0b0c8;margin-bottom:8px;">
    You attempt to <strong style="color:#e0e0f0;">increase your chances of success</strong> to Cast Magick during combat.
  </div>
  <div style="background:#1e1e28;border:1px solid #7a7a8a;border-radius:4px;padding:6px 10px;font-size:0.8em;color:#9090a8;">
    ℹ See your Grimoire for specific Channeling rules and effects.
  </div>
</div>`,
    run: async (actor) => {
      ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: COMBAT_ACTIONS["Channel Power"].card });
    },
  },

  "Inspiring Words": {
    card: `
<div style="border:2px solid #7a7a8a;border-radius:6px;background:#131318;color:#e0e0f0;font-family:'Palatino Linotype',serif;padding:10px 14px;max-width:340px;">
  <div style="background:#4a4a5a;color:#e0e0f0;font-size:1.1em;font-weight:bold;letter-spacing:1px;text-align:center;padding:4px 8px;margin:-10px -14px 10px -14px;border-radius:4px 4px 0 0;">🗣 INSPIRING WORDS</div>
  <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
    <span style="background:#1e1e28;border:1px solid #7a7a8a;border-radius:4px;padding:2px 10px;font-size:0.9em;">SPECIAL ACTION</span>
    <span style="background:#1e1e28;border:1px solid #7a7a8a;border-radius:4px;padding:2px 10px;font-size:0.9em;">1 AP</span>
  </div>
  <div style="font-size:0.85em;color:#b0b0c8;margin-bottom:8px;">
    Make a <strong style="color:#e0e0f0;">Leadership Test</strong>. Number of allies equal to <strong style="color:#e0e0f0;">[FB]</strong> gain <strong style="color:#e0e0f0;">+1 Damage</strong> and <strong style="color:#e0e0f0;">Peril Threshold</strong>.
  </div>
  <div style="background:#1e1e28;border:1px solid #7a7a8a;border-radius:4px;padding:6px 10px;font-size:0.8em;color:#ff9999;">
    ⚠ <strong style="color:#ffcccc;">Once per combat</strong> only.
  </div>
</div>`,
    run: async (actor) => {
      ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: COMBAT_ACTIONS["Inspiring Words"].card });
      await rollSkillByName(actor, "Leadership");
    },
  },

  "Litnay Of Hatred": {
    card: `
<div style="border:2px solid #7a7a8a;border-radius:6px;background:#131318;color:#e0e0f0;font-family:'Palatino Linotype',serif;padding:10px 14px;max-width:340px;">
  <div style="background:#4a4a5a;color:#e0e0f0;font-size:1.1em;font-weight:bold;letter-spacing:1px;text-align:center;padding:4px 8px;margin:-10px -14px 10px -14px;border-radius:4px 4px 0 0;">😤 LITANY OF HATRED</div>
  <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
    <span style="background:#1e1e28;border:1px solid #7a7a8a;border-radius:4px;padding:2px 10px;font-size:0.9em;">SPECIAL ACTION</span>
    <span style="background:#1e1e28;border:1px solid #7a7a8a;border-radius:4px;padding:2px 10px;font-size:0.9em;">1 AP</span>
  </div>
  <div style="font-size:0.85em;color:#b0b0c8;margin-bottom:8px;">
    Make an <strong style="color:#e0e0f0;">Intimidate Test</strong>. Number of foes equal to <strong style="color:#e0e0f0;">[FB]</strong> suffer <strong style="color:#e0e0f0;">-1 Damage</strong> and <strong style="color:#e0e0f0;">Peril Threshold</strong>.
  </div>
  <div style="background:#1e1e28;border:1px solid #7a7a8a;border-radius:4px;padding:6px 10px;font-size:0.8em;color:#ff9999;">
    ⚠ <strong style="color:#ffcccc;">Once per combat</strong> only.
  </div>
</div>`,
    run: async (actor) => {
      ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: COMBAT_ACTIONS["Litnay Of Hatred"].card });
      await rollSkillByName(actor, "Intimidate");
    },
  },

  "Load": {
    card: `
<div style="border:2px solid #7a7a8a;border-radius:6px;background:#131318;color:#e0e0f0;font-family:'Palatino Linotype',serif;padding:10px 14px;max-width:340px;">
  <div style="background:#4a4a5a;color:#e0e0f0;font-size:1.1em;font-weight:bold;letter-spacing:1px;text-align:center;padding:4px 8px;margin:-10px -14px 10px -14px;border-radius:4px 4px 0 0;">🔫 LOAD</div>
  <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
    <span style="background:#1e1e28;border:1px solid #7a7a8a;border-radius:4px;padding:2px 10px;font-size:0.9em;">SPECIAL ACTION</span>
    <span style="background:#1e1e28;border:1px solid #7a7a8a;border-radius:4px;padding:2px 10px;font-size:0.9em;">VARIES</span>
  </div>
  <div style="font-size:0.85em;color:#b0b0c8;margin-bottom:8px;">
    Load a <strong style="color:#e0e0f0;">ranged weapon</strong>. AP cost depends on the weapon being loaded.
  </div>
  <div style="background:#1e1e28;border:1px solid #7a7a8a;border-radius:4px;padding:6px 10px;font-size:0.8em;color:#9090a8;">
    ℹ Check your weapon's profile for its specific Load cost.
  </div>
</div>`,
    run: async (actor) => {
      ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: COMBAT_ACTIONS["Load"].card });
    },
  },

  "Subdue": {
    card: `
<div style="border:2px solid #7a7a8a;border-radius:6px;background:#131318;color:#e0e0f0;font-family:'Palatino Linotype',serif;padding:10px 14px;max-width:340px;">
  <div style="background:#4a4a5a;color:#e0e0f0;font-size:1.1em;font-weight:bold;letter-spacing:1px;text-align:center;padding:4px 8px;margin:-10px -14px 10px -14px;border-radius:4px 4px 0 0;">✋ SUBDUE</div>
  <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
    <span style="background:#1e1e28;border:1px solid #7a7a8a;border-radius:4px;padding:2px 10px;font-size:0.9em;">SPECIAL ACTION</span>
    <span style="background:#1e1e28;border:1px solid #7a7a8a;border-radius:4px;padding:2px 10px;font-size:0.9em;">1 AP</span>
  </div>
  <div style="font-size:0.85em;color:#b0b0c8;margin-bottom:8px;">
    You intentionally avoid inflicting <strong style="color:#e0e0f0;">Injuries</strong> or dealing enough Damage to render a foe <strong style="color:#e0e0f0;">Slain</strong> by your melee weapon attack.
  </div>
  <div style="background:#1e1e28;border:1px solid #7a7a8a;border-radius:4px;padding:6px 10px;font-size:0.8em;color:#9090a8;">
    ℹ The foe is left alive and incapacitated rather than killed.
  </div>
</div>`,
    run: async (actor) => {
      ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: COMBAT_ACTIONS["Subdue"].card });
    },
  },

  "Take Aim": {
    card: `
<div style="border:2px solid #7a7a8a;border-radius:6px;background:#131318;color:#e0e0f0;font-family:'Palatino Linotype',serif;padding:10px 14px;max-width:340px;">
  <div style="background:#4a4a5a;color:#e0e0f0;font-size:1.1em;font-weight:bold;letter-spacing:1px;text-align:center;padding:4px 8px;margin:-10px -14px 10px -14px;border-radius:4px 4px 0 0;">🎯 TAKE AIM</div>
  <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
    <span style="background:#1e1e28;border:1px solid #7a7a8a;border-radius:4px;padding:2px 10px;font-size:0.9em;">SPECIAL ACTION</span>
    <span style="background:#1e1e28;border:1px solid #7a7a8a;border-radius:4px;padding:2px 10px;font-size:0.9em;">1–2 AP</span>
  </div>
  <div style="font-size:0.85em;color:#b0b0c8;margin-bottom:8px;">
    Spend 1 AP for Routine +10%, or 2 AP for Easy +20% on your next Attack or Perilous Stunt.
  </div>
  <div style="background:#1e1e28;border:1px solid #7a7a8a;border-radius:4px;padding:6px 10px;font-size:0.8em;color:#ff9999;">
    ⚠ You <strong style="color:#ffcccc;">cannot Take Aim</strong> to Cast Magick.
  </div>
</div>`,
    run: async (actor) => {
      const apChoice = await new Promise((resolve) => {
        new Dialog({
          title: "Take Aim — AP Spent",
          content: `
            <p style="font-family:'Palatino Linotype',serif;margin-bottom:8px;color:#e8e8e8;">How many AP are you spending?</p>
            <div style="display:flex;flex-direction:column;gap:6px;font-family:'Palatino Linotype',serif;">
              <label style="color:#e8e8e8;"><input type="radio" name="ap" value="1" checked> <strong>1 AP</strong> — Routine +10%</label>
              <label style="color:#e8e8e8;"><input type="radio" name="ap" value="2"> <strong>2 AP</strong> — Easy +20%</label>
            </div>`,
          buttons: {
            ok:     { label: "Next →", callback: (html) => resolve(html.find("input[name=ap]:checked").val()) },
            cancel: { label: "Cancel", callback: () => resolve(null) },
          },
          default: "ok",
        }).render(true);
      });
      if (!apChoice) return;
      const bonus    = apChoice === "1" ? "+10" : "+20";
      const bonusVal = apChoice === "1" ? 10 : 20;
      const bonusColor = apChoice === "1" ? "#a0c8a0" : "#60d860";

      const weapons = actor.items.filter(i => i.type === "weapon");
      if (!weapons.length) { ui.notifications.warn("No weapons found on this character."); return; }
      const weaponOptions = weapons.map(w => `<option value="${w.id}">${w.name}</option>`).join("");
      const weaponId = await new Promise((resolve) => {
        new Dialog({
          title: "Take Aim — Choose Weapon",
          content: `
            <div style="font-family:'Palatino Linotype',serif;padding:4px 0 8px;">
              <p style="margin-bottom:8px;">Which weapon are you aiming with?</p>
              <select name="weapon" style="width:100%;padding:4px;font-family:'Palatino Linotype',serif;background:#1e1e28;color:#e0e0f0;border:1px solid #7a7a8a;border-radius:4px;">
                ${weaponOptions}
              </select>
            </div>`,
          buttons: {
            ok:     { label: "🎯 Take Aim & Roll", callback: (html) => resolve(html.find("select[name=weapon]").val()) },
            cancel: { label: "Cancel",             callback: () => resolve(null) },
          },
          default: "ok",
        }).render(true);
      });
      if (!weaponId) return;
      const weapon = actor.items.get(weaponId);

      const card = `
<div style="border:2px solid #7a7a8a;border-radius:6px;background:#131318;color:#e0e0f0;font-family:'Palatino Linotype',serif;padding:10px 14px;max-width:340px;">
  <div style="background:#4a4a5a;color:#e0e0f0;font-size:1.1em;font-weight:bold;letter-spacing:1px;text-align:center;padding:4px 8px;margin:-10px -14px 10px -14px;border-radius:4px 4px 0 0;">🎯 TAKE AIM</div>
  <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
    <span style="background:#1e1e28;border:1px solid #7a7a8a;border-radius:4px;padding:2px 10px;font-size:0.9em;">SPECIAL ACTION</span>
    <span style="background:#1e1e28;border:1px solid #7a7a8a;border-radius:4px;padding:2px 10px;font-size:0.9em;">${apChoice} AP</span>
  </div>
  <div style="font-size:0.85em;color:#b0b0c8;margin-bottom:6px;">Weapon: <strong style="color:#e0e0f0;">${weapon.name}</strong></div>
  <div style="text-align:center;font-size:0.8em;color:#b0b0c8;margin-bottom:4px;">BASE CHANCE BONUS</div>
  <div style="text-align:center;font-size:2.2em;font-weight:bold;color:${bonusColor};background:#1e1e28;border:2px solid #7a7a8a;border-radius:6px;padding:6px;margin-bottom:10px;text-shadow:0 0 8px ${bonusColor}88;">${bonus}</div>
  <div style="font-size:0.85em;color:#b0b0c8;margin-bottom:8px;">Applies to your <strong style="color:#e0e0f0;">next Attack Action or Perilous Stunt</strong> only.</div>
  <div style="background:#1e1e28;border:1px solid #7a7a8a;border-radius:4px;padding:6px 10px;font-size:0.8em;color:#ff9999;">
    ⚠ You <strong style="color:#ffcccc;">cannot Take Aim</strong> to Cast Magick.
  </div>
</div>`;
      await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: card });
      await triggerWeaponRoll(actor, weapon, bonusVal);
    },
  },

  "Wait": {
    card: `
<div style="border:2px solid #7a7a8a;border-radius:6px;background:#131318;color:#e0e0f0;font-family:'Palatino Linotype',serif;padding:10px 14px;max-width:340px;">
  <div style="background:#4a4a5a;color:#e0e0f0;font-size:1.1em;font-weight:bold;letter-spacing:1px;text-align:center;padding:4px 8px;margin:-10px -14px 10px -14px;border-radius:4px 4px 0 0;">⏳ WAIT</div>
  <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
    <span style="background:#1e1e28;border:1px solid #7a7a8a;border-radius:4px;padding:2px 10px;font-size:0.9em;">SPECIAL ACTION</span>
    <span style="background:#1e1e28;border:1px solid #7a7a8a;border-radius:4px;padding:2px 10px;font-size:0.9em;">0 AP</span>
  </div>
  <div style="font-size:0.85em;color:#b0b0c8;margin-bottom:8px;">
    Wait until later to use your APs, but place yourself <strong style="color:#e0e0f0;">lower on the Initiative Ladder</strong>.
  </div>
  <div style="background:#1e1e28;border:1px solid #7a7a8a;border-radius:4px;padding:6px 10px;font-size:0.8em;color:#9090a8;">
    ℹ Your unused APs carry over to your new position in the Initiative order.
  </div>
</div>`,
    run: async (actor) => {
      ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: COMBAT_ACTIONS["Wait"].card });
    },
  },
};

// ── Style injection ─────────────────────────────────────────
function ensureStyles() {
  if (document.getElementById("luck-tab-styles")) return;
  const s = document.createElement("style");
  s.id = "luck-tab-styles";
  s.textContent = `
    /* ── Dialog text colour fix ────────────────────────────── */
    #app-dialog p, #app-dialog label,
    .dialog p, .dialog label,
    .window-app.dialog p, .window-app.dialog label,
    form p, form label,
    .dialog-content p, .dialog-content label,
    .dialog-content div:not([style*="background"]),
    .window-content > p, .window-content > label,
    .window-content > div > p, .window-content > div > label {
      color: #e8e8e8 !important;
    }

    .ltp-panel, .ltr-panel {
      position: fixed; z-index: 10000;
      border-radius: 8px 8px 0 0; overflow: hidden;
      transition: max-height 0.3s, opacity 0.3s;
      max-height: 0; opacity: 0; pointer-events: none; min-width: 280px;
    }
    .ltp-panel { background: #1e1b14; border: 2px solid #c8a228; }
    .ltp-panel.ltp-open { max-height: 220px; opacity: 1; pointer-events: all; }
    .ltr-panel { background: #181410; border: 2px solid #4a7c59; z-index: 10001; }
    .ltr-panel.ltr-open { max-height: 260px; opacity: 1; pointer-events: all; }

    .ltp-inner, .ltr-inner {
      padding: 14px 20px 18px; display: flex; flex-direction: column; gap: 12px;
    }
    .ltp-header, .ltr-header {
      display: flex; align-items: center; justify-content: space-between;
    }
    .ltp-title {
      font-size: 1.05em; font-weight: 700; color: #e8d48a;
      letter-spacing: .06em; text-transform: uppercase;
      display: flex; align-items: center; gap: 6px;
    }
    .ltp-title i { color: #c8a228; }
    .ltr-title {
      font-size: 1.05em; font-weight: 700; color: #8ed4a4;
      letter-spacing: .06em; text-transform: uppercase;
      display: flex; align-items: center; gap: 6px;
    }
    .ltr-title i { color: #4a7c59; }
    .ltp-close, .ltr-close {
      background: none; border: none; cursor: pointer;
      font-size: .95em; padding: 2px 6px; border-radius: 3px; line-height: 1;
    }
    .ltp-close { color: #9a8a60; }
    .ltp-close:hover { background: rgba(255,255,255,.1); color: #e8d48a; }
    .ltr-close { color: #5a8a6a; }
    .ltr-close:hover { background: rgba(255,255,255,.08); color: #8ed4a4; }

    .ltp-score-row { display: flex; align-items: center; gap: 14px; }
    .ltp-pips      { display: flex; flex-wrap: wrap; gap: 4px; flex: 1; }
    .ltp-pip {
      width: 18px; height: 18px; border-radius: 50%;
      border: 2px solid #5a4a20; background: #2a2318;
      cursor: pointer; transition: background .15s, transform .1s; padding: 0;
    }
    .ltp-pip:hover { transform: scale(1.2); border-color: #c8a228; }
    .ltp-pip.ltp-filled {
      background: radial-gradient(circle at 35% 35%, #f0c940, #b88a10);
      border-color: #9a7010;
    }
    .ltp-input-wrap { display: flex; flex-direction: column; align-items: center; gap: 2px; min-width: 52px; }
    .ltp-input {
      width: 50px; text-align: center; font-size: 1.6em; font-weight: 700;
      color: #f0c940; background: #2a2318; border: 2px solid #c8a228;
      border-radius: 6px; padding: 2px 4px; -moz-appearance: textfield;
    }
    .ltp-input::-webkit-outer-spin-button,
    .ltp-input::-webkit-inner-spin-button { -webkit-appearance: none; }
    .ltp-input:focus { outline: none; border-color: #f0c940; box-shadow: 0 0 0 3px rgba(200,162,40,.3); }
    .ltp-out-of { font-size: .7em; color: #7a6a40; white-space: nowrap; }
    .ltp-hint   { font-size: .75em; color: #7a6a40; font-style: italic; line-height: 1.3; margin: 0; }

    .ltr-info-row {
      display: flex; align-items: center; justify-content: space-between;
      font-size: .82em; color: #6aaa80; gap: 8px;
    }
    .ltr-info-label { opacity: .75; }
    .ltr-info-value { font-weight: 700; color: #8ed4a4; }

    .ltr-rest-btn {
      display: flex; align-items: center; justify-content: center; gap: 7px;
      background: linear-gradient(135deg, #3a6b4a, #254a30);
      color: #c8f0d8; border: 1px solid #4a7c59; border-radius: 6px;
      padding: 8px 14px; font-size: .9em; font-weight: 700;
      cursor: pointer; letter-spacing: .04em; white-space: nowrap;
      transition: background .15s, transform .1s;
    }
    .ltr-rest-btn:hover   { background: linear-gradient(135deg, #4a8a5a, #2e5e3a); transform: translateY(-1px); }
    .ltr-rest-btn:active  { transform: translateY(0); }
    .ltr-rest-btn:disabled{ opacity: .45; cursor: not-allowed; transform: none; }
    .ltr-result {
      font-size: .78em; color: #6aaa80; font-style: italic;
      line-height: 1.4; text-align: center; min-height: 1.2em;
    }
    .ltr-result.ltr-success { color: #8ed4a4; }
    .ltr-result.ltr-maxed   { color: #c8a228; }

    /* ── Tab buttons: collapsed circles by default, expand on hover ── */
    .ltp-btn, .ltr-btn {
      position: fixed; z-index: 10000;
      height: 28px;
      max-width: 28px;
      border-radius: 14px;
      padding: 0;
      font-size: .78em; font-weight: 700; cursor: pointer;
      display: flex; align-items: center; justify-content: flex-start;
      overflow: hidden;
      box-shadow: 0 2px 8px rgba(0,0,0,.6);
      letter-spacing: .03em; white-space: nowrap;
      transition: max-width 0.2s ease-out 0.15s,
                  padding 0.2s ease-out 0.15s,
                  box-shadow 0.15s ease,
                  background 0.15s ease;
      visibility: hidden;
    }
    .ltp-btn i, .ltr-btn i {
      flex-shrink: 0;
      width: 28px; height: 28px;
      display: flex; align-items: center; justify-content: center;
      font-size: 12px;
      order: 1;
    }
    .ltp-btn .btn-label, .ltr-btn .btn-label,
    .ltp-btn .ltp-badge {
      order: 2;
      overflow: hidden;
      opacity: 0;
      transition: opacity 0.1s ease 0.15s;
      flex-shrink: 0;
    }
    .ltp-btn:hover, .ltr-btn:hover {
      max-width: 120px;
      padding: 0 10px 0 0;
      gap: 3px;
      box-shadow: 0 3px 12px rgba(0,0,0,.7);
      transition-delay: 0s;
    }
    .ltp-btn:hover .btn-label, .ltr-btn:hover .btn-label,
    .ltp-btn:hover .ltp-badge {
      opacity: 1;
      transition-delay: 0s;
    }
    .ltp-btn.ltp-ready, .ltr-btn.ltr-ready { visibility: visible; }
    .ltp-btn {
      background: linear-gradient(135deg, #c8a228, #7a5a10);
      color: #fff8e0; border: 1px solid #9a7a20;
    }
    .ltp-btn:hover { background: linear-gradient(135deg, #e0b830, #9a7020); }
    .ltr-btn {
      background: linear-gradient(135deg, #3a6b4a, #254a30);
      color: #c8f0d8; border: 1px solid #4a7c59; z-index: 10001;
    }
    .ltr-btn:hover { background: linear-gradient(135deg, #4a8a5a, #2e5e3a); }
    .ltc-btn {
      background: linear-gradient(135deg, #8a1a1a, #5a0808);
      color: #ffd5d5; border: 1px solid #c03030; z-index: 10002;
    }
    .ltc-btn:hover { background: linear-gradient(135deg, #b02020, #780f0f); }
    .ltc-panel { background: #1a0808; border: 2px solid #c03030; z-index: 10003; overflow: hidden; }
    .ltc-panel.ltc-open { max-height: 600px !important; opacity: 1; pointer-events: all; }
    .ltc-inner { padding: 10px 14px 14px; display: flex; flex-direction: column; gap: 8px; max-height: 420px; overflow-y: auto; }
    .ltc-inner::-webkit-scrollbar { width: 6px; }
    .ltc-inner::-webkit-scrollbar-track { background: #1a0808; }
    .ltc-inner::-webkit-scrollbar-thumb { background: #8b1a1a; border-radius: 3px; }
    .ltc-header { display: flex; align-items: center; justify-content: space-between; }
    .ltc-title {
      font-size: 1.05em; font-weight: 700; color: #ffaaaa;
      letter-spacing: .06em; text-transform: uppercase;
      display: flex; align-items: center; gap: 6px;
    }
    .ltc-title i { color: #c03030; }
    .ltc-close { background: none; border: none; cursor: pointer; font-size: .95em; padding: 2px 6px; border-radius: 3px; line-height: 1; color: #9a5050; }
    .ltc-close:hover { background: rgba(255,255,255,.08); color: #ffaaaa; }
    .ltc-section-header {
      background: #3a0000; color: #ff8080;
      font-size: .7em; font-weight: bold; letter-spacing: 1.5px;
      text-transform: uppercase; padding: 3px 6px;
      border-left: 3px solid #cc2222; margin-top: 4px;
    }
    .ltc-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 3px; }
    .ltc-action-btn {
      background: #2a0808; border: 1px solid #6b1a1a; border-radius: 4px;
      padding: 4px 6px; font-size: .75em; color: #e8d5c4; cursor: pointer;
      display: flex; align-items: center; gap: 5px; width: 100%; text-align: left;
    }
    .ltc-action-btn:hover { background: #3d0f0f; border-color: #cc3333; color: #fff; }
    .ltc-dot { width: 5px; height: 5px; border-radius: 50%; background: #cc2222; flex-shrink: 0; }
    .ltc-ap-pips { display: flex; gap: 6px; align-items: center; margin: 4px 0; }
    .ltc-ap-pip {
      width: 24px; height: 24px; border-radius: 50%;
      border: 2px solid #2a3a4a; background: #0c1a2e;
      cursor: pointer; transition: transform .1s, border-color .15s;
      flex-shrink: 0;
    }
    .ltc-ap-pip:hover { transform: scale(1.2); border-color: #5ab0f0; }
    .ltc-ap-pip-filled {
      background: radial-gradient(circle at 35% 30%, #72c6ff, #1a6fc4);
      border-color: #5ab0f0;
      box-shadow: 0 0 6px #3a9fffaa, 0 0 2px #aaddff;
    }
    .ltc-ap-pip-filled:hover { border-color: #aaddff; }
    .ltc-ap {
      margin-left: auto; background: #5a0000; color: #ff9090;
      border-radius: 3px; font-size: .7em; padding: 1px 4px; white-space: nowrap; flex-shrink: 0;
    }
    #ltc-tooltip {
      display: none; position: fixed; z-index: 99999; pointer-events: none;
      flex-direction: column; filter: drop-shadow(0 4px 12px rgba(0,0,0,.8));
    }
    #ltc-tooltip::after {
      content: ''; display: block; width: 0; height: 0; margin: 0 auto;
      border: 6px solid transparent; border-top-color: #b8860b;
    }
    #ltc-tooltip.ltc-tip-flipped { flex-direction: column-reverse; }
    #ltc-tooltip.ltc-tip-flipped::after { border-top-color: transparent; border-bottom-color: #b8860b; }
    #ltc-tooltip-inner {
      width: 300px; max-height: 320px; overflow-y: auto;
      border-radius: 6px; background: #1a0a0a; border: 1px solid #b8860b;
      padding: 8px 10px; font-size: .78em; color: #e8d5c4; line-height: 1.5; box-sizing: border-box;
    }
    .ltp-badge {
      background: rgba(0,0,0,.3); border-radius: 10px; padding: 0 5px; font-weight: 800;
    }
  `;
  document.head.appendChild(s);
}

// ── DOM builders ────────────────────────────────────────────
function buildLuckPanel(luck) {
  const pips = Array.from({ length: MAX_LUCK }, (_, i) =>
    `<button class="ltp-pip${i < luck ? " ltp-filled" : ""}" data-pip="${i+1}" type="button"></button>`
  ).join("");
  const d = document.createElement("div");
  d.className = "ltp-panel";
  d.innerHTML = `
    <div class="ltp-inner">
      <div class="ltp-header">
        <span class="ltp-title"><i class="fas fa-clover"></i> Luck Score</span>
        <button class="ltp-close" type="button"><i class="fas fa-times"></i></button>
      </div>
      <div class="ltp-score-row">
        <div class="ltp-pips">${pips}</div>
        <div class="ltp-input-wrap">
          <input class="ltp-input" type="number" min="0" max="${MAX_LUCK}" value="${luck}" />
          <span class="ltp-out-of">/ ${MAX_LUCK}</span>
        </div>
      </div>
      <p class="ltp-hint">Your fortune — 0 to ${MAX_LUCK}.</p>
    </div>`;
  return d;
}

function buildLuckBtn(luck) {
  const b = document.createElement("button");
  b.className = "ltp-btn";
  b.type = "button";
  b.innerHTML = `<i class="fas fa-clover"></i><span class="btn-label">&nbsp;Luck</span><span class="ltp-badge">${luck}</span>`;
  return b;
}

function buildRestPanel(actor) {
  const peril = getPerilCurrent(actor);
  const pb    = getPerceptionBonus(actor);
  const d = document.createElement("div");
  d.className = "ltr-panel";
  d.innerHTML = `
    <div class="ltr-inner">
      <div class="ltr-header">
        <span class="ltr-title"><i class="fas fa-moon"></i> Rest</span>
        <button class="ltr-close" type="button"><i class="fas fa-times"></i></button>
      </div>
      <div class="ltr-info-row">
        <span class="ltr-info-label">Current Peril</span>
        <span class="ltr-info-value ltr-peril-val">${peril}</span>
      </div>
      <div class="ltr-info-row">
        <span class="ltr-info-label">Perception Bonus (PB)</span>
        <span class="ltr-info-value ltr-pb-val">${pb}</span>
      </div>
      <div class="ltr-info-row">
        <span class="ltr-info-label">Luck Recovery Roll</span>
        <span class="ltr-info-value">1d10 + <span class="ltr-pb-formula">${pb}</span></span>
      </div>
      <button class="ltr-rest-btn" type="button">
        <i class="fas fa-campfire"></i> Take a Rest
      </button>
      <p class="ltr-result">Recovers peril to Unhindered &amp; adds 1d10+PB Luck.</p>
    </div>`;
  return d;
}

function buildRestBtn() {
  const b = document.createElement("button");
  b.className = "ltr-btn";
  b.type = "button";
  b.innerHTML = `<i class="fas fa-moon"></i><span class="btn-label">&nbsp;Rest</span>`;
  return b;
}

// ── Combat actions data ─────────────────────────────────────
const COMBAT_SECTIONS = {
  "Movement": [
    { name: "Charge", ap: "2" }, { name: "Get Up", ap: "2" },
    { name: "Hustle", ap: "1" }, { name: "Maneuver", ap: "2" },
    { name: "Run", ap: "1" },    { name: "Take Cover", ap: "1" },
  ],
  "Attack": [
    { name: "Called Shot", ap: "2" }, { name: "Cast Magic", ap: "Varies" },
    { name: "Melee Attack", ap: "1" }, { name: "Ranged Attack", ap: "1" },
  ],
  "Perilous Stunts": [
    { name: "Chokehold", ap: "1" }, { name: "Dirty Tricks", ap: "1" },
    { name: "Disarm", ap: "1" },    { name: "Knockout", ap: "1" },
    { name: "Splinter Shield", ap: "1" }, { name: "Stunning Blow", ap: "1" },
    { name: "Takedown", ap: "1" },
  ],
  "Special": [
    { name: "Channel Power", ap: "1" }, { name: "Inspiring Words", ap: "1" },
    { name: "Litnay Of Hatred", ap: "1" }, { name: "Load", ap: "Varies" },
    { name: "Subdue", ap: "1" }, { name: "Take Aim", ap: "1-2" },
    { name: "Wait", ap: "0" },
  ],
  "Reactions": [
    { name: "Assist", ap: "Varies" }, { name: "Counterspell", ap: "1" },
    { name: "Dodge", ap: "1" },       { name: "Opportunity Attack", ap: "0" },
    { name: "Parry", ap: "1" },       { name: "Resist", ap: "0" },
  ],
};

function buildAPPips(currentAP) {
  return Array.from({ length: MAX_AP }, (_, i) => {
    const filled = i < currentAP;
    return `<div class="ltc-ap-pip${filled ? " ltc-ap-pip-filled" : ""}" data-pip="${i}"></div>`;
  }).join("");
}

function buildCombatPanel(actor) {
  const currentAP = getAP(actor);
  const d = document.createElement("div");
  d.className = "ltp-panel ltc-panel";
  d.style.minWidth = "340px";

  let sectionsHTML = "";
  for (const [section, actions] of Object.entries(COMBAT_SECTIONS)) {
    const btns = actions.map(a =>
      `<button class="ltc-action-btn" data-action="${a.name}" type="button">
        <span class="ltc-dot"></span>${a.name}<span class="ltc-ap">${a.ap} AP</span>
      </button>`
    ).join("");
    sectionsHTML += `
      <div class="ltc-section-header">${section}</div>
      <div class="ltc-grid">${btns}</div>`;
  }

  d.innerHTML = `
    <div class="ltc-inner">
      <div class="ltc-header">
        <span class="ltc-title"><i class="fas fa-sword"></i> Combat</span>
        <button class="ltc-close" type="button"><i class="fas fa-times"></i></button>
      </div>

      <!-- ── AP TRACKER ───────────────────────────────── -->
      <div class="ltc-ap-frame">
        <div class="ltc-ap-frame-label">
          <i class="fas fa-bolt"></i> Action Points
        </div>
        <div class="ltc-ap-pips" id="ltc-ap-pips">
          ${buildAPPips(currentAP)}
        </div>
        <div class="ltc-ap-refill-hint">
          Replenishes automatically at start of your turn
        </div>
      </div>
      <!-- ────────────────────────────────────────────── -->

      ${sectionsHTML}
    </div>`;
  return d;
}

function buildCombatBtn() {
  const b = document.createElement("button");
  b.className = "ltr-btn ltc-btn";
  b.type = "button";
  b.innerHTML = `<i class="fas fa-sword"></i><span class="btn-label">&nbsp;Combat</span>`;
  return b;
}

function attachCombatTooltip() {
  if (document.getElementById("ltc-tooltip")) return;
  const tip = document.createElement("div");
  tip.id = "ltc-tooltip";
  tip.innerHTML = `<div id="ltc-tooltip-inner"></div>`;
  document.body.appendChild(tip);
}

function wireCombatPanel(combatPanel, actor, inst) {
  attachCombatTooltip();
  const tipEl    = document.getElementById("ltc-tooltip");
  const tipInner = document.getElementById("ltc-tooltip-inner");

  combatPanel.querySelectorAll(".ltc-action-btn").forEach(btn => {
    const actionName = btn.dataset.action;
    const action = COMBAT_ACTIONS[actionName];

    // ── Tooltip: use embedded card HTML ─────────────────────
    btn.addEventListener("mouseenter", () => {
      if (!action?.card) return;
      tipInner.innerHTML = action.card;
      tipEl.classList.remove("ltc-tip-flipped");
      tipEl.style.display = "flex";
      const br     = btn.getBoundingClientRect();
      const tipW   = tipInner.offsetWidth  || 300;
      const tipH   = tipEl.offsetHeight    || 200;
      const margin = 8;
      let left = br.left + br.width / 2 - tipW / 2;
      left = Math.max(margin, Math.min(left, window.innerWidth - tipW - margin));
      let top;
      if (br.top - tipH - 12 >= margin) { top = br.top - tipH - 12; }
      else { top = br.bottom + 12; tipEl.classList.add("ltc-tip-flipped"); }
      tipEl.style.left = left + "px";
      tipEl.style.top  = top  + "px";
    });

    btn.addEventListener("mouseleave", () => { tipEl.style.display = "none"; });

    // ── Click: check AP, then run embedded action ─────────
    btn.addEventListener("click", async () => {
      if (!action) {
        ui.notifications.warn(`Action "${actionName}" not implemented.`);
        return;
      }

      // Resolve AP cost for this action
      const actionDef = Object.values(COMBAT_SECTIONS).flat().find(a => a.name === actionName);
      const apLabel   = actionDef?.ap ?? null;
      let   cost      = resolveAPCost(apLabel);

      // For VARIES / range costs, prompt the player
      if (cost === null && apLabel) {
        const labelUpper = String(apLabel).toUpperCase();

        if (/^\d[–\-]\d$/.test(apLabel)) {
          // e.g. "1-2" — offer a choice
          const [lo, hi] = apLabel.split(/[–\-]/).map(Number);
          cost = await new Promise(resolve => {
            const opts = Array.from({length: hi - lo + 1}, (_, i) => lo + i);
            const btnsHtml = opts.map(n =>
              `<button class="dialog-button" style="background:#1a3a5a;border:1px solid #2a6aaa;color:#a0d0ff;border-radius:4px;padding:4px 12px;cursor:pointer;font-family:'Palatino Linotype',serif;" data-cost="${n}">${n} AP</button>`
            ).join(" ");
            new Dialog({
              title: `${actionName} — AP Cost`,
              content: `<p style="font-family:'Palatino Linotype',serif;color:#e8e8e8;">How many AP are you spending?</p><div style="display:flex;gap:8px;justify-content:center;margin-top:8px;">${btnsHtml}</div>`,
              buttons: {
                cancel: { label: "Cancel", callback: () => resolve(null) },
              },
              render: html => {
                html[0].querySelectorAll("[data-cost]").forEach(b =>
                  b.addEventListener("click", () => { resolve(parseInt(b.dataset.cost)); })
                );
              },
              default: "cancel",
            }).render(true);
          });
        } else if (labelUpper === "VARIES") {
          // Free-form entry
          cost = await new Promise(resolve => {
            new Dialog({
              title: `${actionName} — AP Cost`,
              content: `
                <p style="font-family:'Palatino Linotype',serif;margin-bottom:8px;color:#e8e8e8;">Enter AP cost for this action:</p>
                <input id="ap-cost-input" type="number" min="0" max="3" value="1"
                  style="width:60px;text-align:center;font-size:1.2em;background:#0d2233;color:#d0e8f0;border:1px solid #2a6aaa;border-radius:4px;padding:2px 6px;" />`,
              buttons: {
                ok:     { label: "Spend AP", callback: html => resolve(parseInt(html.find("#ap-cost-input").val()) || 0) },
                cancel: { label: "Skip AP",  callback: () => resolve(0) },
              },
              default: "ok",
            }).render(true);
          });
        }
      }

      // Deduct AP (reactions with 0 cost pass through freely)
      if (cost !== null && cost > 0) {
        const current = getAP(actor);
        if (current < cost) {
          ui.notifications.warn(
            `Not enough Action Points! Need ${cost} AP but only have ${current} AP remaining.`
          );
          return;
        }
        await spendAP(actor, cost);
        refreshAPUI(inst, actor);
      }

      try {
        await action.run(actor);
      } catch (err) {
        console.error(`[${MODULE_ID}] Action "${actionName}" error:`, err);
        ui.notifications.error(`Combat action "${actionName}" encountered an error. See console.`);
      }
    });
  });
}

// ── Positioning ─────────────────────────────────────────────
function positionFloaters(sheetEl, luckBtn, luckPanel, restBtn, restPanel, combatBtn, combatPanel) {
  const r = sheetEl.getBoundingClientRect();
  if (r.width === 0) return;

  const GAP    = 6;
  const BTN_SZ = 28;
  const MARGIN = 8;

  const btnLeft = r.right + MARGIN;

  const lbTop = r.bottom - BTN_SZ;
  luckBtn.style.top   = lbTop + "px";
  luckBtn.style.right = "";
  luckBtn.style.left  = btnLeft + "px";
  luckBtn.classList.add("ltp-ready");

  const rbTop = lbTop - BTN_SZ - GAP;
  restBtn.style.top   = rbTop + "px";
  restBtn.style.right = "";
  restBtn.style.left  = btnLeft + "px";
  restBtn.classList.add("ltr-ready");

  const cbTop = rbTop - BTN_SZ - GAP;
  combatBtn.style.top   = cbTop + "px";
  combatBtn.style.right = "";
  combatBtn.style.left  = btnLeft + "px";
  combatBtn.classList.add("ltr-ready");

  // Panels anchor at the same left edge as the buttons and grow rightward,
  // so they never overlap the character sheet.
  luckPanel.style.top    = "auto";
  luckPanel.style.bottom = (window.innerHeight - lbTop + GAP) + "px";
  luckPanel.style.left   = btnLeft + "px";

  restPanel.style.top    = "auto";
  restPanel.style.bottom = (window.innerHeight - rbTop + GAP) + "px";
  restPanel.style.left   = btnLeft + "px";

  combatPanel.style.top    = "auto";
  combatPanel.style.bottom = (window.innerHeight - cbTop + GAP) + "px";
  combatPanel.style.left   = btnLeft + "px";
}

// ── UI refresh ───────────────────────────────────────────────
function refreshLuckUI(inst, actor) {
  const luck  = getLuck(actor);
  const badge = inst.luckBtn.querySelector(".ltp-badge");
  if (badge) badge.textContent = luck;
  const input = inst.luckPanel.querySelector(".ltp-input");
  if (input && document.activeElement !== input) input.value = luck;
  inst.luckPanel.querySelectorAll(".ltp-pip").forEach(pip => {
    pip.classList.toggle("ltp-filled", parseInt(pip.dataset.pip) <= luck);
  });
}

function refreshAPUI(inst, actor) {
  const currentAP = getAP(actor);
  const pipsContainer = inst.combatPanel.querySelector("#ltc-ap-pips");
  if (!pipsContainer) return;
  pipsContainer.innerHTML = buildAPPips(currentAP);

  // Re-attach pip click handler after every innerHTML rebuild.
  // stopPropagation prevents the click bubbling up to the combatBtn toggle.
  pipsContainer.addEventListener("click", async (e) => {
    e.stopPropagation();
    const pip = e.target.closest(".ltc-ap-pip");
    if (!pip) return;
    const pipIndex = parseInt(pip.dataset.pip); // 0-based
    const pipValue = pipIndex + 1;
    const current  = getAP(actor);
    if (pip.classList.contains("ltc-ap-pip-filled")) {
      const newAP = pipIndex === 0 && current === 1 ? 0 : pipIndex;
      await setAP(actor, newAP);
    } else {
      await setAP(actor, pipValue);
    }
    refreshAPUI(inst, actor);
  }, { once: true }); // once: true so it doesn't stack on repeated refreshes

  // Dim action buttons that cost more AP than available
  inst.combatPanel.querySelectorAll(".ltc-action-btn").forEach(btn => {
    const actionName = btn.dataset.action;
    const section = COMBAT_SECTIONS;
    let apLabel = null;
    for (const actions of Object.values(section)) {
      const found = actions.find(a => a.name === actionName);
      if (found) { apLabel = found.ap; break; }
    }
    const cost = resolveAPCost(apLabel);
    if (cost !== null && cost > currentAP) {
      btn.classList.add("ltc-action-unaffordable");
    } else {
      btn.classList.remove("ltc-action-unaffordable");
    }
  });
}

function refreshRestUI(inst, actor) {
  const peril = getPerilCurrent(actor);
  const pb    = getPerceptionBonus(actor);
  const pv = inst.restPanel.querySelector(".ltr-peril-val");
  if (pv) pv.textContent = peril;
  const pbv = inst.restPanel.querySelector(".ltr-pb-val");
  if (pbv) pbv.textContent = pb;
  const pf = inst.restPanel.querySelector(".ltr-pb-formula");
  if (pf) pf.textContent = pb;
}

// ── Rest action ─────────────────────────────────────────────
async function doRest(actor, restPanel, inst) {
  const btn    = restPanel.querySelector(".ltr-rest-btn");
  const result = restPanel.querySelector(".ltr-result");

  btn.disabled = true;
  result.className = "ltr-result";
  result.textContent = "Resting…";

  try {
    await setPeril(actor, getUnhinderedPeril());

    const pb   = getPerceptionBonus(actor);
    const roll = new Roll(`1d10 + ${pb}`);
    await roll.evaluate();
    await roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor }),
      flavor:  `<strong>${actor.name}</strong> rests and recovers Luck (1d10 + ${pb} PB)`,
    });

    const previous = getLuck(actor);
    const next     = await setLuck(actor, previous + roll.total);

    refreshRestUI(inst, actor);
    refreshLuckUI(inst, actor);

    if (next >= MAX_LUCK) {
      result.className = "ltr-result ltr-maxed";
      result.textContent = `Luck maxed! Rolled ${roll.total} (was ${previous}, now ${next}/${MAX_LUCK}). Peril cleared.`;
    } else {
      result.className = "ltr-result ltr-success";
      result.textContent = `Rolled ${roll.total} → Luck ${previous} → ${next}/${MAX_LUCK}. Peril cleared.`;
    }
  } catch (err) {
    console.error(`[${MODULE_ID}] Rest failed:`, err);
    result.className = "ltr-result";
    result.textContent = "Rest failed — check browser console for details.";
  } finally {
    btn.disabled = false;
  }
}

// ── Instance management ─────────────────────────────────────
const _instances = new Map();

function teardown(appId) {
  const inst = _instances.get(appId);
  if (!inst) return;
  cancelAnimationFrame(inst.rafId);
  inst.luckBtn.remove();
  inst.luckPanel.remove();
  inst.restBtn.remove();
  inst.restPanel.remove();
  inst.combatBtn.remove();
  inst.combatPanel.remove();
  document.getElementById("ltc-tooltip")?.remove();
  _instances.delete(appId);
  console.log(`[${MODULE_ID}] removed floaters for appId ${appId}`);
}

function getActorFromApp(app) {
  return app.actor ?? (app.document instanceof Actor ? app.document : null);
}

function getAppId(app) {
  return app.appId ?? app.id ?? app.constructor.name;
}

// ── Attach — only for actor sheets ──────────────────────────
function attach(app) {
  const actor = getActorFromApp(app);
  if (!actor) return;

  const el = (() => {
    const s = app.element;
    if (s instanceof HTMLElement) return s;
    if (s && s[0]) return s[0];
    return null;
  })();
  if (!el) return;

  const isSheet = el.classList.contains("sheet")
    || el.querySelector("form") !== null
    || el.closest(".app") !== null;
  if (!isSheet) return;

  const appId = getAppId(app);

  // If already attached, just refresh UI — don't teardown/rebuild which closes panels.
  if (_instances.has(appId)) {
    const inst = _instances.get(appId);
    refreshLuckUI(inst, actor);
    refreshRestUI(inst, actor);
    refreshAPUI(inst, actor);
    return;
  }

  ensureStyles();

  const luck        = getLuck(actor);
  const luckPanel   = buildLuckPanel(luck);
  const luckBtn     = buildLuckBtn(luck);
  const restPanel   = buildRestPanel(actor);
  const restBtn     = buildRestBtn();
  const combatPanel = buildCombatPanel(actor);
  const combatBtn   = buildCombatBtn();

  document.body.appendChild(luckPanel);
  document.body.appendChild(luckBtn);
  document.body.appendChild(restPanel);
  document.body.appendChild(restBtn);
  document.body.appendChild(combatPanel);
  document.body.appendChild(combatBtn);

  const inst = { luckBtn, luckPanel, restBtn, restPanel, combatBtn, combatPanel, rafId: null };
  _instances.set(appId, inst);

  // Z-index elevation: bring the most recently opened panel to the front
  let _panelZCounter = 10010;
  function bringToFront(panel) {
    _panelZCounter += 1;
    panel.style.zIndex = _panelZCounter;
  }

  // Luck panel wiring
  const openLuck  = () => { luckPanel.classList.add("ltp-open"); bringToFront(luckPanel); };
  const closeLuck = () => luckPanel.classList.remove("ltp-open");
  luckBtn.addEventListener("click", (e) => { e.stopPropagation(); luckPanel.classList.contains("ltp-open") ? closeLuck() : openLuck(); });
  luckPanel.addEventListener("click", (e) => e.stopPropagation());
  luckPanel.querySelector(".ltp-close").addEventListener("click", (e) => { e.stopPropagation(); closeLuck(); });
  luckPanel.querySelectorAll(".ltp-pip").forEach(pip => {
    pip.addEventListener("click", async () => {
      const t = parseInt(pip.dataset.pip);
      await setLuck(actor, getLuck(actor) === t ? t - 1 : t);
      refreshLuckUI(inst, actor);
    });
  });
  const input = luckPanel.querySelector(".ltp-input");
  const commit = async () => {
    const v = parseInt(input.value);
    if (!isNaN(v)) { await setLuck(actor, v); refreshLuckUI(inst, actor); }
  };
  input.addEventListener("change", commit);
  input.addEventListener("keydown", async e => {
    if (e.key === "Enter") { e.preventDefault(); input.blur(); await commit(); }
  });

  // Rest panel wiring
  const openRest  = () => { restPanel.classList.add("ltr-open"); bringToFront(restPanel); };
  const closeRest = () => restPanel.classList.remove("ltr-open");
  restBtn.addEventListener("click", (e) => { e.stopPropagation(); restPanel.classList.contains("ltr-open") ? closeRest() : openRest(); });
  restPanel.addEventListener("click", (e) => e.stopPropagation());
  restPanel.querySelector(".ltr-close").addEventListener("click", (e) => { e.stopPropagation(); closeRest(); });
  restPanel.querySelector(".ltr-rest-btn").addEventListener("click", () =>
    doRest(actor, restPanel, inst)
  );

  // Combat panel wiring — pass actor so embedded actions know who's acting
  const openCombat  = () => { combatPanel.classList.add("ltc-open"); bringToFront(combatPanel); };
  const closeCombat = () => combatPanel.classList.remove("ltc-open");
  combatBtn.addEventListener("click", (e) => { e.stopPropagation(); combatPanel.classList.contains("ltc-open") ? closeCombat() : openCombat(); });
  combatPanel.addEventListener("click", (e) => e.stopPropagation());
  combatPanel.querySelector(".ltc-close").addEventListener("click", (e) => { e.stopPropagation(); closeCombat(); });
  wireCombatPanel(combatPanel, actor, inst);  // <-- actor + inst passed in
  refreshAPUI(inst, actor); // initial dimming state

  // Actor update sync
  Hooks.on("updateActor", updated => {
    if (updated.id !== actor.id) return;
    if (!_instances.has(appId)) return;
    refreshLuckUI(inst, actor);
    refreshRestUI(inst, actor);
    refreshAPUI(inst, actor);
  });

  // rAF positioning loop
  const tick = () => {
    if (!el.isConnected) { teardown(appId); return; }
    positionFloaters(el, luckBtn, luckPanel, restBtn, restPanel, combatBtn, combatPanel);
    inst.rafId = requestAnimationFrame(tick);
  };
  inst.rafId = requestAnimationFrame(tick);

  console.log(`[${MODULE_ID}] attached to "${actor.name}" (appId: ${appId})`);
}

// ── Hooks — actor sheets only ────────────────────────────────
Hooks.on("renderActorSheet",    (app) => { setTimeout(() => attach(app), 0); });
Hooks.on("renderApplicationV2", (app) => {
  if (!getActorFromApp(app)) return;
  setTimeout(() => attach(app), 0);
});

Hooks.on("closeActorSheet",  (app) => teardown(getAppId(app)));
Hooks.on("closeApplicationV2", (app) => {
  if (_instances.has(getAppId(app))) teardown(getAppId(app));
});

Hooks.once("ready", () => console.log(`[${MODULE_ID}] ready — combat actions embedded (no macros needed)`));

