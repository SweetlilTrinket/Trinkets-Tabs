// ============================================================
//  luck-spend.js
//  Zweihander TTRPG — Spend Luck on failing rolls in chat
//
//  When a roll appears in chat and the actor failed, a button
//  is injected into the message letting them spend luck to flip
//  the result to a success.  Each pip of luck covers 1 on the
//  d100 roll (margin of failure = luck cost).
// ============================================================

const MODULE_ID = "trinket-tabs";
const FLAG_KEY  = "luck";
const MAX_LUCK  = 20;

// ── Luck helpers (mirrors luck-tab.js) ──────────────────────
function clamp(v, min, max) { return Math.min(Math.max(Number(v), min), max); }
function getLuck(actor)      { return clamp(actor.getFlag(MODULE_ID, FLAG_KEY) ?? 0, 0, MAX_LUCK); }
async function setLuck(actor, value) {
  const v = clamp(Math.round(Number(value)), 0, MAX_LUCK);
  await actor.setFlag(MODULE_ID, FLAG_KEY, v);
  return v;
}

// ── Zweihander roll parsing ──────────────────────────────────
// Zweihander chat messages store roll data in message.rolls[].
// A skill test roll is a d100; the flavor/HTML usually contains
// the target number.  We dig for both in several places.
//
// Returns null if this message doesn't look like a skill test,
// or { rolled, target, margin } if it's a failed one we can help.

// ── Zweihander skill names ───────────────────────────────────
// Full list of skills from the active world — used to detect
// skill roll messages by finding a skill name in the HTML.
const ZWEIHANDER_SKILLS = [
  "Alchemy","Leadership","Drive","Incantation","Ride","Heal",
  "Handle Animal","Intimidate","Warfare","Navigation",
  "Simple Melee","Counterfeit","Disguise","Resolve","Athletics",
  "Pilot","Scrutinize","Folklore","Skulduggery","Education",
  "Martial Melee","Bargain","Gamble","Awareness","Tradecraft",
  "Charm","Eavesdrop","Martial Ranged","Survival","Stealth",
  "Rumor","Toughness","Guile","Coordination","Interrogation",
  "Simple Ranged",
];

function parseZweihanderRoll(message) {
  const content  = message.content ?? "";
  const flavor   = message.flavor  ?? "";
  const combined = content + " " + flavor;

  // ── 1. Must contain a known skill name ──────────────────
  let skillName = null;
  for (const skill of ZWEIHANDER_SKILLS) {
    const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp("\\b" + escaped + "\\b", "i").test(combined)) {
      skillName = skill;
      break;
    }
  }
  if (!skillName) return null;

  // ── 2. Find the d100 rolled value ───────────────────────
  let rolled = null;
  if (message.rolls?.length) {
    for (const roll of message.rolls) {
      const d100 = roll.dice?.find(d => d.faces === 100);
      if (d100) { rolled = roll.total; break; }
    }
  }
  // HTML fallback
  if (rolled === null) {
    const m = combined.match(/roll-total[^>]*>\s*(\d+)/i);
    if (m) rolled = parseInt(m[1]);
  }
  if (rolled === null) return null;

  // ── 3. Find the target number ────────────────────────────
  // Zweihander stores the effective skill rank (target) in
  // message.flags.zweihander or renders it into the HTML.
  let target = null;

  // Check system flags — most reliable source
  const zh = message.flags?.zweihander ?? message.flags?.zwh ?? {};
  for (const key of ["target","difficulty","skillTarget","totalChance","chance","threshold","rank","effectiveRank"]) {
    if (zh[key] != null) {
      const v = parseInt(zh[key]);
      if (v >= 1 && v <= 100) { target = v; break; }
    }
  }

  // Scrape HTML — Zweihander renders the skill chance as a number
  if (target === null) {
    const htmlPats = [
      /data-(?:target|chance|threshold|difficulty|rank)="(\d+)"/i,
      /\bvs\.?\s*(\d+)/i,
      /target[:\s]+(\d+)/i,
      /threshold[:\s]+(\d+)/i,
      /chance[:\s]+(\d+)/i,
      /rank[:\s]+(\d+)/i,
      /(\d{2,3})%/,
    ];
    for (const pat of htmlPats) {
      const m = combined.match(pat);
      if (m) {
        const v = parseInt(m[1]);
        if (v >= 1 && v <= 100 && v !== rolled) { target = v; break; }
      }
    }
  }

  // Last resort: first 2-3 digit number in content that isn't the roll
  if (target === null) {
    for (const m of combined.matchAll(/\b(\d{2,3})\b/g)) {
      const v = parseInt(m[1]);
      if (v >= 1 && v <= 100 && v !== rolled) { target = v; break; }
    }
  }

  if (target === null) return null;

  // ── 4. Was it a failure? ─────────────────────────────────
  if (rolled <= target) return null;                        // success
  const isFumble = rolled !== 100 && rolled % 11 === 0;    // 11,22…99
  if (isFumble) return null;

  return { rolled, target, margin: rolled - target, skillName };
}

// ── Style injection ─────────────────────────────────────────
function ensureLuckSpendStyles() {
  if (document.getElementById("luck-spend-styles")) return;
  const s = document.createElement("style");
  s.id = "luck-spend-styles";
  s.textContent = `
    .lks-banner {
      margin: 8px 4px 0;
      padding: 8px 12px;
      background: linear-gradient(135deg, #1e1b14, #2a2318);
      border: 1.5px solid #c8a228;
      border-radius: 6px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .lks-banner-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .lks-label {
      font-size: .8em;
      color: #e8d48a;
      line-height: 1.35;
      flex: 1;
    }
    .lks-label strong { color: #f0c940; }
    .lks-label .lks-cost { color: #ff9a3c; font-weight: 700; }
    .lks-label .lks-have { color: #8ed4a4; }
    .lks-spend-btn {
      background: linear-gradient(135deg, #c8a228, #7a5a10);
      color: #fff8e0;
      border: 1px solid #9a7a20;
      border-radius: 5px;
      padding: 5px 11px;
      font-size: .78em;
      font-weight: 700;
      cursor: pointer;
      white-space: nowrap;
      letter-spacing: .03em;
      display: flex;
      align-items: center;
      gap: 5px;
      transition: background .15s, transform .1s;
    }
    .lks-spend-btn:hover:not(:disabled) {
      background: linear-gradient(135deg, #e0b830, #9a7020);
      transform: translateY(-1px);
    }
    .lks-spend-btn:disabled {
      opacity: .45;
      cursor: not-allowed;
      transform: none;
    }
    .lks-spend-btn.lks-spent {
      background: linear-gradient(135deg, #3a6b4a, #254a30);
      border-color: #4a7c59;
      color: #c8f0d8;
    }
    .lks-no-luck {
      font-size: .75em;
      color: #9a6040;
      font-style: italic;
    }
    .lks-success-banner {
      margin: 8px 4px 0;
      padding: 8px 12px;
      background: linear-gradient(135deg, #1a2e1a, #0f1f0f);
      border: 1.5px solid #4a7c59;
      border-radius: 6px;
      font-size: .8em;
      color: #8ed4a4;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .lks-success-banner i { color: #4a7c59; font-size: 1.1em; }
  `;
  document.head.appendChild(s);
}

// ── Inject button into an existing chat message element ─────
function injectLuckSpendUI(messageEl, message) {
  // Don't double-inject
  if (messageEl.querySelector(".lks-banner")) return;

  const rollData = parseZweihanderRoll(message);
  if (!rollData) return;

  const { rolled, target, margin, skillName } = rollData;

  // Find the actor who made the roll
  const speakerData = message.speaker ?? {};
  const actor =
    game.actors.get(speakerData.actor) ??
    canvas.tokens.get(speakerData.token)?.actor ??
    null;

  if (!actor) return;

  // Only show for the actor's owner or the GM
  if (!actor.isOwner && !game.user.isGM) return;

  const currentLuck = getLuck(actor);
  const canAfford   = currentLuck >= margin;

  ensureLuckSpendStyles();

  const banner = document.createElement("div");
  banner.className = "lks-banner";

  if (canAfford) {
    banner.innerHTML = `
      <div class="lks-banner-row">
        <span class="lks-label">
          <strong><i class="fas fa-clover"></i> Spend Luck? (${skillName})</strong><br>
          Rolled <strong>${rolled}</strong> vs target <strong>${target}</strong> —
          spend <span class="lks-cost">${margin} Luck</span>
          (have <span class="lks-have">${currentLuck}</span>) to succeed.
        </span>
        <button class="lks-spend-btn" type="button" data-message-id="${message.id}"
                data-actor-id="${actor.id}" data-cost="${margin}"
                data-rolled="${rolled}" data-target="${target}">
          <i class="fas fa-clover"></i> Spend ${margin}
        </button>
      </div>`;
  } else {
    banner.innerHTML = `
      <div class="lks-banner-row">
        <span class="lks-label">
          <strong><i class="fas fa-clover"></i> Luck Needed (${skillName})</strong><br>
          Rolled <strong>${rolled}</strong> vs target <strong>${target}</strong> —
          need <span class="lks-cost">${margin} Luck</span>
          but only have <span class="lks-have">${currentLuck}</span>.
        </span>
        <span class="lks-no-luck"><i class="fas fa-times-circle"></i> Not enough Luck</span>
      </div>`;
  }

  // Append after the roll section in the message
  const msgContent = messageEl.querySelector(".message-content");
  if (msgContent) msgContent.appendChild(banner);
  else messageEl.appendChild(banner);
}

// ── Handle Spend Luck button click ─────────────────────────
async function handleLuckSpend(btn) {
  btn.disabled = true;

  const messageId = btn.dataset.messageId;
  const actorId   = btn.dataset.actorId;
  const cost      = parseInt(btn.dataset.cost);
  const rolled    = parseInt(btn.dataset.rolled);
  const target    = parseInt(btn.dataset.target);

  const actor = game.actors.get(actorId);
  if (!actor) {
    ui.notifications.warn("Could not find actor to deduct Luck from.");
    btn.disabled = false;
    return;
  }

  const currentLuck = getLuck(actor);
  if (currentLuck < cost) {
    ui.notifications.warn(`Not enough Luck! Need ${cost}, have ${currentLuck}.`);
    btn.disabled = false;
    return;
  }

  try {
    const newLuck = await setLuck(actor, currentLuck - cost);

    // Post a follow-up success message in chat
    const successContent = `
      <div class="lks-success-banner">
        <i class="fas fa-clover"></i>
        <span>
          <strong>${actor.name}</strong> spends
          <strong>${cost} Luck</strong> (${currentLuck} → ${newLuck})
          to convert their roll of <strong>${rolled}</strong>
          into a <strong>success</strong> against a target of <strong>${target}</strong>!
        </span>
      </div>`;

    await ChatMessage.create({
      content: successContent,
      speaker: ChatMessage.getSpeaker({ actor }),
      flags: { [MODULE_ID]: { luckSpend: true } },
    });

    // Update the original message button to "spent" state
    btn.classList.add("lks-spent");
    btn.innerHTML = `<i class="fas fa-check"></i> Luck Spent`;
    btn.disabled = true;

    // Update the label
    const label = btn.closest(".lks-banner")?.querySelector(".lks-label");
    if (label) {
      label.innerHTML = `<strong><i class="fas fa-clover"></i> Luck Spent</strong><br>
        Converted roll of <strong>${rolled}</strong> to a success. Luck now <strong>${newLuck}</strong>.`;
    }

    // Sync any open luck panels on this actor's sheets
    // (luck-tab.js listens to updateActor hooks so floaters refresh automatically)

  } catch (err) {
    console.error(`[${MODULE_ID}] Luck spend failed:`, err);
    ui.notifications.error("Luck spend failed — check browser console.");
    btn.disabled = false;
  }
}

// ── Hook: new messages ──────────────────────────────────────
Hooks.on("renderChatMessage", (message, html) => {
  // html may be a jQuery object or HTMLElement depending on Foundry version
  const el = html instanceof HTMLElement ? html : html[0];
  if (!el) return;

  // Skip our own luck-spend output messages
  if (message.flags?.[MODULE_ID]?.luckSpend) return;

  // Small delay so the roll animation settles and the DOM is fully rendered
  setTimeout(() => injectLuckSpendUI(el, message), 150);
});

// ── Hook: existing messages on page load ────────────────────
// When Foundry reloads it re-renders chat history; renderChatMessage
// fires for each one so we don't need separate init logic.

// ── Click delegation on the chat log ───────────────────────
document.addEventListener("click", async (e) => {
  const btn = e.target.closest(".lks-spend-btn");
  if (!btn || btn.disabled) return;
  e.preventDefault();
  e.stopPropagation();
  await handleLuckSpend(btn);
}, true);

Hooks.once("ready", () => console.log(`[${MODULE_ID}] luck-spend ready`));
