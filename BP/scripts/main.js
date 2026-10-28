import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { world, system, ItemStack, EquipmentSlot } from "@minecraft/server";
import * as mcServer from "@minecraft/server";

const MAX_HEARTS = 3;
const DEFAULT_COMBAT_SECONDS = 60;
const DEFAULT_PLAYTIME_SECONDS = 10800; // 3 Stunden

const hearts = new Map();
const recentDeaths = new Set();

const combatTaggedPlayers = new Map();
const combatKeyToName = new Map();
const combatZeroSent = new Set();
const combatLoggedPlayers = new Map();
const lastDamager = new Map();
const combatOpponentByPlayer = new Map();
const combatPenaltyKillIssued = new Set();
const teamChatEnabled = new Map();
const recentSoulAmuletSeenAt = new Map();
const recentCombatEndedAt = new Map();
let pendingBrokenSoulAmuletConversions = 0;

const playtimeRemainingMsByPlayer = new Map();
const playtimeDayByPlayer = new Map();
const playtimeLastTickAt = new Map();

const timeUpKicked = new Set();

const cameraRotatedOnce = new Set();
const firstSeenTimeByPlayer = new Map();
const lastRotationByPlayer = new Map();
const lastViewBlockByPlayer = new Map();
const knownPlayers = new Set();
const DEBUG_LOGS = true;
const activeSoulAmuletEventChest = {
  location: null,
  dimensionId: null
};

function createSoulAmuletItem() {
  try {
    const soulAmulet = new ItemStack("helden:soul_amulet", 1);
    soulAmulet.setLore([
      "§7Wenn du dieses Item beim Tod im Inventar hast,",
      "§7verlierst du kein Herz."
    ]);
    return soulAmulet;
  } catch {
    return null;
  }
}

function normalizeName(name) {
  try {
    return String(name || "").toLowerCase().trim();
  } catch {
    return "";
  }
}

function selectorName(name) {
  return String(name || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function logDebug(message) {
  try {
    if (!DEBUG_LOGS) return;
    console.warn(`[Project H] ${message}`);
  } catch { }
}

function logError(message, error) {
  try {
    const suffix = error ? ` :: ${String(error)}` : "";
    console.warn(`[Project H][Error] ${message}${suffix}`);
  } catch { }
}

// ===== Helden Modi (Helden 1 / 2 / 3) =====
const MODE_PROP = "helden_mode";
const LINKS_PROP = "helden_links";
const BOUNTIES_PROP = "helden_bounty_pairs"; // { Spieler: Kopfgeld-Ziel }, immer in beide Richtungen
const BOUNTY_DONE_PROP = "helden_bounty_done"; // Spieler, deren Kopfgeld schon eingelöst wurde (nur einmalig)
const PENDING_HEARTS_PROP = "helden_pending_hearts";
const LINKLIST_PROP = "helden_link_list";
const ARMOR_LOCKS_PROP = "helden_armor_locks";
const HELDEN_PROPS_TO_RESET = [MODE_PROP, "helden_config", LINKS_PROP, LINKLIST_PROP, BOUNTIES_PROP, BOUNTY_DONE_PROP, "helden_bounties", PENDING_HEARTS_PROP, ARMOR_LOCKS_PROP, "helden_banned_items"];
const MODE_INFO = {
  1: "Normale Herzen",
  2: "Verlinkte Herzen",
  3: "Normale Herzen + Kopfgeld"
};

function clampHearts(value, fallback = MAX_HEARTS) {
  const n = Number(value);
  return Math.max(0, Math.min(MAX_HEARTS, Number.isFinite(n) ? n : fallback));
}

function readJsonProp(key, fallback) {
  try {
    const raw = world.getDynamicProperty?.(key);
    if (!raw) return fallback;
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    return obj && typeof obj === "object" ? obj : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonProp(key, obj) {
  try {
    world.setDynamicProperty?.(key, JSON.stringify(obj));
    return true;
  } catch (error) {
    logError(`writeJsonProp failed for ${key}`, error);
    return false;
  }
}

function getHeldenMode() {
  try {
    const n = Number(world.getDynamicProperty?.(MODE_PROP));
    return n === 1 || n === 2 || n === 3 ? n : null;
  } catch {
    return null;
  }
}

// Solange noch kein Modus gewählt wurde, verhält sich alles wie Helden 1.
function getActiveMode() {
  return getHeldenMode() ?? 1;
}

function broadcastMessage(txt) {
  try {
    if (world.sendMessage) {
      world.sendMessage(txt);
      return;
    }
  } catch { }
  try {
    if (world.say) {
      world.say(txt);
      return;
    }
  } catch { }
  for (const p of getOnlinePlayers()) {
    try {
      p.sendMessage(txt);
    } catch { }
  }
}

function resetHeldenSettings() {
  armorLocksCache = null;
  armorState.clear();
  armorInvSnapshot.clear();
  armorRemoved.clear();
  pearlCounts.clear();
  for (const key of HELDEN_PROPS_TO_RESET) {
    try {
      world.setDynamicProperty?.(key, undefined);
    } catch (error) {
      logError(`resetHeldenSettings failed for ${key}`, error);
    }
  }
}

// ----- Helden 2: verlinkte Herzen -----
function getLinkedPartner(name) {
  try {
    const partner = readJsonProp(LINKS_PROP, {})[name];
    return typeof partner === "string" && partner ? partner : null;
  } catch {
    return null;
  }
}

function linkPlayers(nameA, nameB) {
  try {
    const links = readJsonProp(LINKS_PROP, {});
    links[nameA] = nameB;
    links[nameB] = nameA;
    writeJsonProp(LINKS_PROP, links);

    const shared = Math.min(getPlayerHeartCount(nameA), getPlayerHeartCount(nameB));
    setPlayerHeartCount(nameA, shared);

    const a = getPlayer(nameA);
    const b = getPlayer(nameB);
    if (a) updateHudActionbar(a);
    if (b) updateHudActionbar(b);
    try {
      a?.sendMessage(`§dDu bist jetzt mit §f${nameB}§d verlinkt – ihr teilt euch eure Herzen!`);
    } catch { }
    try {
      b?.sendMessage(`§dDu bist jetzt mit §f${nameA}§d verlinkt – ihr teilt euch eure Herzen!`);
    } catch { }
    logDebug(`Linked ${nameA} <-> ${nameB} (hearts=${shared})`);
  } catch (error) {
    logError(`linkPlayers failed for ${nameA} / ${nameB}`, error);
  }
}

// ----- Link-Spielerliste: nur eingetragene Spieler bekommen einen Link -----
function getLinkList() {
  const raw = readJsonProp(LINKLIST_PROP, []);
  return Array.isArray(raw) ? raw.filter((n) => typeof n === "string" && n) : [];
}

function isOnLinkList(name) {
  const key = normalizeName(name);
  if (!key) return false;
  return getLinkList().some((n) => normalizeName(n) === key);
}

function findLinkKey(links, name) {
  const key = normalizeName(name);
  return Object.keys(links).find((k) => normalizeName(k) === key) || null;
}

function addToLinkList(name) {
  try {
    const clean = String(name || "").trim();
    if (!clean) return "invalid";
    if (isOnLinkList(clean)) return "exists";
    const list = getLinkList();
    list.push(clean);
    writeJsonProp(LINKLIST_PROP, list);
    const online = getOnlinePlayers().find((p) => normalizeName(p?.name) === normalizeName(clean));
    if (online) tryLinkPlayer(online.name);
    return "added";
  } catch (error) {
    logError(`addToLinkList failed for ${name}`, error);
    return "invalid";
  }
}

function unlinkPlayer(name) {
  try {
    const links = readJsonProp(LINKS_PROP, {});
    const key = findLinkKey(links, name);
    if (!key) return;
    const partner = links[key];
    delete links[key];
    if (partner) delete links[partner];
    writeJsonProp(LINKS_PROP, links);
    if (partner) {
      try {
        getPlayer(partner)?.sendMessage("§dDein Link wurde aufgelöst.");
      } catch { }
      tryLinkPlayer(partner);
    }
  } catch (error) {
    logError(`unlinkPlayer failed for ${name}`, error);
  }
}

function removeFromLinkList(name) {
  try {
    const key = normalizeName(name);
    const list = getLinkList();
    const next = list.filter((n) => normalizeName(n) !== key);
    if (next.length === list.length) return false;
    writeJsonProp(LINKLIST_PROP, next);
    unlinkPlayer(name);
    return true;
  } catch (error) {
    logError(`removeFromLinkList failed for ${name}`, error);
    return false;
  }
}

function assignRandomLinks() {
  try {
    const links = readJsonProp(LINKS_PROP, {});
    const free = getOnlinePlayers().filter((p) => p?.name && !links[p.name] && isOnLinkList(p.name));
    for (let i = free.length - 1; i > 0; i--) {
      const j = randomIntInclusive(0, i);
      [free[i], free[j]] = [free[j], free[i]];
    }
    for (let i = 0; i + 1 < free.length; i += 2) {
      linkPlayers(free[i].name, free[i + 1].name);
    }
  } catch (error) {
    logError("assignRandomLinks failed", error);
  }
}

function tryLinkPlayer(name) {
  try {
    if (!name || getActiveMode() !== 2) return false;
    if (!isOnLinkList(name)) return false;
    if (getLinkedPartner(name)) return false;
    const links = readJsonProp(LINKS_PROP, {});
    const candidates = getOnlinePlayers().filter((p) => p?.name && p.name !== name && !links[p.name] && isOnLinkList(p.name));
    if (!candidates.length) return false;
    const partner = candidates[randomIntInclusive(0, candidates.length - 1)];
    linkPlayers(name, partner.name);
    return true;
  } catch (error) {
    logError(`tryLinkPlayer failed for ${name}`, error);
    return false;
  }
}

function isLinkedPair(nameA, nameB) {
  try {
    if (getActiveMode() !== 2 || !nameA || !nameB || nameA === nameB) return false;
    return getLinkedPartner(nameA) === nameB;
  } catch {
    return false;
  }
}

const linkedWarnAt = new Map();
function warnLinkedAttack(attackerName) {
  try {
    const now = Date.now();
    if (now - (linkedWarnAt.get(attackerName) || 0) < 2000) return;
    linkedWarnAt.set(attackerName, now);
    system.run(() => {
      try {
        getPlayer(attackerName)?.sendMessage("§cDu kannst deinen verlinkten Partner nicht verletzen!");
      } catch { }
    });
  } catch { }
}

// Fallback, falls es kein beforeEvents.entityHurt gibt: Schaden nachträglich zurückgeben.
function healLinkedHit(victim, damage) {
  try {
    const hc = victim?.getComponent?.("minecraft:health");
    if (!hc) return;
    const cur = Number(hc.currentValue);
    if (!(cur > 0)) return;
    const max = Number(hc.effectiveMax) || cur + (Number(damage) || 0);
    hc.setCurrentValue(Math.min(max, cur + (Number(damage) || 0)));
  } catch { }
}

function subscribeLinkedProtection() {
  try {
    const ev = world.beforeEvents?.entityHurt;
    if (!ev) return;
    ev.subscribe((evt) => {
      try {
        if (getActiveMode() !== 2) return;
        const victim = evt.hurtEntity || evt.entity;
        const attacker = evt.damageSource?.damagingEntity;
        const victimName = victim?.name || (victim?.typeId === DUMMY_TYPE ? victim.nameTag : null);
        if (!victimName || !attacker?.name) return;
        if (!isLinkedPair(victimName, attacker.name)) return;
        evt.cancel = true;
        warnLinkedAttack(attacker.name);
      } catch { }
    });
  } catch { }
}

function propagateLinkedHearts(name, value) {
  try {
    if (getActiveMode() !== 2) return;
    const partnerName = getLinkedPartner(name);
    if (!partnerName) return;

    const previous = hearts.has(partnerName) ? clampHearts(hearts.get(partnerName)) : MAX_HEARTS;
    if (previous === value) return;

    hearts.set(partnerName, value);
    saveHeartsToWorld();

    const partner = getPlayer(partnerName);
    if (partner) {
      try {
        partner.setDynamicProperty("hearts", value);
      } catch { }
      if (value <= 0) {
        sendCommandAsPlayerOrDimension(
          partner,
          "gamemode spectator @s",
          `gamemode spectator @a[name="${selectorName(partnerName)}"]`
        );
      } else if (previous <= 0) {
        sendCommandAsPlayerOrDimension(
          partner,
          "gamemode survival @s",
          `gamemode survival @a[name="${selectorName(partnerName)}"]`
        );
      }
      updateHudActionbar(partner);
    } else {
      // Partner offline: Wert merken, wird beim nächsten Join angewendet.
      const pending = readJsonProp(PENDING_HEARTS_PROP, {});
      pending[partnerName] = value;
      writeJsonProp(PENDING_HEARTS_PROP, pending);
    }
  } catch (error) {
    logError(`propagateLinkedHearts failed for ${name}`, error);
  }
}

function notifyModeInfoOnJoin(player) {
  try {
    const name = player?.name;
    if (!name) return;
    const mode = getActiveMode();
    let msg = null;
    if (mode === 2) {
      const partner = getLinkedPartner(name);
      if (partner) msg = `§dDein verlinkter Partner: §f${partner}§d – ihr teilt euch eure Herzen.`;
    } else if (mode === 3) {
      const target = getBountyTarget(name);
      if (target) msg = `§6Dein Kopfgeld-Ziel: §c${target}§6. Tötest du ihn, bekommst du 1 Herz und er verliert keins. Er jagt auch dich!`;
    }
    if (msg) {
      runLater(() => {
        try {
          getPlayer(name)?.sendMessage(msg);
        } catch { }
      }, 40);
    }
  } catch (error) {
    logError("notifyModeInfoOnJoin failed", error);
  }
}

// ----- Helden 3: Kopfgeld-Paare -----
// Kopfgelder werden zufällig vergeben und sind immer gegenseitig: Ist X mein Ziel, ist auch ich das Ziel
// von X. Niemand sonst kann X oder mich als Ziel haben. Teamkollegen werden nie zusammen gelost.
function getBountyPairs() {
  return readJsonProp(BOUNTIES_PROP, {});
}

function getBountyTarget(name) {
  try {
    const t = getBountyPairs()[name];
    return typeof t === "string" && t ? t : null;
  } catch {
    return null;
  }
}

function sameTeam(a, b) {
  try {
    const ta = getTeam(a);
    const tb = getTeam(b);
    return !!ta && ta === tb;
  } catch {
    return false;
  }
}

function isSpectatorPlayer(player) {
  try {
    return String(player?.getGameMode?.() ?? "").toLowerCase() === "spectator";
  } catch {
    return false;
  }
}

// Nur echte Mitspieler werden gelost: keine Spectator, niemand ohne Herzen.
function getBountyDoneList() {
  const raw = readJsonProp(BOUNTY_DONE_PROP, []);
  return Array.isArray(raw) ? raw : [];
}

function isBountyDone(name) {
  try {
    return getBountyDoneList().includes(name);
  } catch {
    return false;
  }
}

function markBountyDone(...names) {
  try {
    const list = getBountyDoneList();
    for (const n of names) if (n && !list.includes(n)) list.push(n);
    writeJsonProp(BOUNTY_DONE_PROP, list);
  } catch { }
}

function isBountyEligible(player) {
  try {
    if (!player?.name || isSpectatorPlayer(player) || isBountyDone(player.name)) return false;
    return getPlayerHeartCount(player) > 0;
  } catch {
    return false;
  }
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomIntInclusive(0, i);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function pairBountyPlayers(nameA, nameB) {
  try {
    const pairs = getBountyPairs();
    pairs[nameA] = nameB;
    pairs[nameB] = nameA;
    writeJsonProp(BOUNTIES_PROP, pairs);
    for (const [me, other] of [[nameA, nameB], [nameB, nameA]]) {
      try {
        getPlayer(me)?.sendMessage(`§6Dein Kopfgeld-Ziel ist §c${other}§6. Tötest du ihn, bekommst du 1 Herz und er verliert keins. Er jagt auch dich!`);
      } catch { }
    }
    logDebug(`Kopfgeld-Paar ${nameA} <-> ${nameB}`);
  } catch (error) {
    logError(`pairBountyPlayers failed for ${nameA} / ${nameB}`, error);
  }
}

function releaseBountyPair(name) {
  try {
    const pairs = getBountyPairs();
    const other = pairs[name];
    delete pairs[name];
    if (other) delete pairs[other];
    writeJsonProp(BOUNTIES_PROP, pairs);
  } catch { }
}

// Lost alle freien, zulässigen Online-Spieler zufällig zu Paaren (ohne Teamkollegen).
// Mehrere Zufallsversuche, genommen wird die Verteilung mit den meisten Paaren.
function assignBountyPairs() {
  try {
    if (getActiveMode() !== 3) return;
    const pairs = getBountyPairs();
    const free = getOnlinePlayers().filter((p) => p?.name && !pairs[p.name] && isBountyEligible(p));
    if (free.length < 2) return;

    let best = [];
    for (let attempt = 0; attempt < 30; attempt++) {
      const order = shuffleInPlace(free.slice());
      const used = new Set();
      const result = [];
      for (const p of order) {
        if (used.has(p.name)) continue;
        const candidates = order.filter((q) => q.name !== p.name && !used.has(q.name) && !sameTeam(p, q));
        if (!candidates.length) continue;
        const q = candidates[randomIntInclusive(0, candidates.length - 1)];
        used.add(p.name);
        used.add(q.name);
        result.push([p.name, q.name]);
      }
      if (result.length > best.length) best = result;
      if (best.length * 2 >= free.length - (free.length % 2)) break;
    }
    for (const [a, b] of best) pairBountyPlayers(a, b);
  } catch (error) {
    logError("assignBountyPairs failed", error);
  }
}

function tryPairBountyPlayer(name) {
  try {
    if (!name || getActiveMode() !== 3) return;
    if (getBountyTarget(name)) return;
    assignBountyPairs();
  } catch (error) {
    logError(`tryPairBountyPlayer failed for ${name}`, error);
  }
}

// Der Killer tötet sein Kopfgeld-Ziel: +1 Herz für den Killer. Das Opfer verliert dabei kein Herz
// (der Aufrufer entscheidet das anhand des Rückgabewerts true).
function payoutBounty(victimName, killerName) {
  try {
    if (getActiveMode() !== 3) return false;
    if (!victimName || !killerName || victimName === killerName) return false;
    if (getBountyTarget(killerName) !== victimName) return false;

    const killer = getPlayer(killerName);
    if (!killer) return false;

    // Inzwischen im selben Team? Dann gilt das Kopfgeld nicht, beide bekommen neue Ziele.
    const victim = getPlayer(victimName);
    if (victim && sameTeam(killer, victim)) {
      releaseBountyPair(killerName);
      assignBountyPairs();
      return false;
    }

    const current = getPlayerHeartCount(killer);
    const next = Math.min(MAX_HEARTS, current + 1);
    if (next > current) {
      setPlayerHeartCount(killer, next);
      updateHudActionbar(killer);
      broadcastMessage(`§6Kopfgeld! §e${killerName}§f hat sein Ziel §c${victimName}§f erledigt und erhält §c1 Herz§f. Das Kopfgeld ist damit eingelöst.`);
    } else {
      broadcastMessage(`§6Kopfgeld! §e${killerName}§f hat sein Ziel §c${victimName}§f erledigt, hat aber schon alle Herzen. Das Kopfgeld ist damit eingelöst.`);
    }
    // Einmalig: nur der Killer bekommt das Herz. Das Paar wird aufgelöst und nie wieder gelost.
    releaseBountyPair(killerName);
    markBountyDone(killerName, victimName);
    return true;
  } catch (error) {
    logError(`payoutBounty failed for ${victimName}`, error);
    return false;
  }
}

// ----- Link-Liste: Menüs -----
function describeLinkList() {
  const list = getLinkList();
  if (!list.length) return "§7Noch niemand eingetragen. Nur eingetragene Spieler bekommen einen Link.";
  const links = readJsonProp(LINKS_PROP, {});
  return "§7Eingetragen:\n" + list.map((n) => {
    const key = findLinkKey(links, n);
    const partner = key ? links[key] : null;
    return partner ? `§f${n} §d↔ §f${partner}` : `§f${n} §8(wartet auf Partner)`;
  }).join("\n");
}

function openLinkListMenu(sender) {
  try {
    if (getActiveMode() !== 2) {
      sender.sendMessage("§cDie Link-Liste gibt es nur in Helden 2.");
      return;
    }
    const form = new ActionFormData();
    form.title("§dLink-Spielerliste");
    form.body(describeLinkList());
    form.button("§aMehrere Online-Spieler eintragen");
    form.button("§aEinzelnen Online-Spieler eintragen");
    form.button("§aOffline-Spieler");
    form.button("§cSpieler entfernen");
    form.button("Schließen");
    form.show(sender).then((res) => {
      if (!res || res.canceled || res.selection === undefined) return;
      if (res.selection === 0) bulkAddOnlinePlayersToLinkList(sender);
      else if (res.selection === 1) pickOnlinePlayerForLinkList(sender);
      else if (res.selection === 2) openOfflineListMenu(sender);
      else if (res.selection === 3) removeFromLinkListMenu(sender);
    }).catch((error) => logError("openLinkListMenu failed", error));
  } catch (error) {
    logError("openLinkListMenu crashed", error);
  }
}

function reportLinkListAdd(sender, name, result) {
  try {
    if (result === "added") sender.sendMessage(`§a${name} wurde in die Link-Liste eingetragen.`);
    else if (result === "exists") sender.sendMessage(`§e${name} ist bereits eingetragen.`);
    else sender.sendMessage("§cUngültiger Name.");
  } catch { }
}

function pickOnlinePlayerForLinkList(sender) {
  const candidates = getOnlinePlayers().filter((p) => p?.name && !isOnLinkList(p.name));
  if (!candidates.length) {
    try {
      sender.sendMessage("§eAlle Spieler, die online sind, stehen schon in der Liste.");
    } catch { }
    openLinkListMenu(sender);
    return;
  }
  const form = new ActionFormData();
  form.title("Spieler eintragen");
  candidates.forEach((p) => form.button(p.name));
  form.button("Zurück");
  form.show(sender).then((res) => {
    if (!res || res.canceled || res.selection === undefined) return;
    if (res.selection < candidates.length) {
      const name = candidates[res.selection].name;
      reportLinkListAdd(sender, name, addToLinkList(name));
    }
    openLinkListMenu(sender);
  }).catch((error) => logError("pickOnlinePlayerForLinkList failed", error));
}

// Mehrere Online-Spieler auf einmal eintragen. Spectator sind standardmäßig abgewählt,
// weil sie nicht als Spieler zählen sollen (Streamer, Admins, Zuschauer).
function bulkAddOnlinePlayersToLinkList(sender) {
  try {
    const candidates = getOnlinePlayers().filter((p) => p?.name && !isOnLinkList(p.name));
    if (!candidates.length) {
      try {
        sender.sendMessage("§eAlle Spieler, die online sind, stehen schon in der Liste.");
      } catch { }
      openLinkListMenu(sender);
      return;
    }

    const form = new ModalFormData();
    form.title("Spieler eintragen");
    for (const p of candidates) {
      let spectator = false;
      try {
        spectator = String(p.getGameMode?.() ?? "").toLowerCase() === "spectator";
      } catch { }
      const label = spectator ? `${p.name} §7(Spectator)` : p.name;
      try {
        form.toggle(label, { defaultValue: !spectator });
      } catch {
        form.toggle(label, !spectator);
      }
    }

    form.show(sender).then((res) => {
      if (!res || res.canceled || !Array.isArray(res.formValues)) return;
      const added = [];
      candidates.forEach((p, i) => {
        if (res.formValues[i] === true && addToLinkList(p.name) === "added") added.push(p.name);
      });
      try {
        sender.sendMessage(added.length ? `§a${added.length} Spieler eingetragen: §f${added.join(", ")}` : "§eNiemand wurde eingetragen.");
      } catch { }
      openLinkListMenu(sender);
    }).catch((error) => logError("bulkAddOnlinePlayersToLinkList failed", error));
  } catch (error) {
    logError("bulkAddOnlinePlayersToLinkList crashed", error);
  }
}

// Formular anzeigen und erneut versuchen, falls der Spieler gerade Chat/Menü offen hat (UserBusy).
function showFormRetry(form, player, attempt = 0) {
  return form.show(player).then((res) => {
    if (res?.canceled && res.cancelationReason === "UserBusy" && attempt < 15) {
      return new Promise((resolve) => {
        runLater(() => resolve(showFormRetry(form, player, attempt + 1)), 10);
      });
    }
    return res;
  });
}

// Eingabemenü: Namen eintippen, wird in der Link-Liste gespeichert.
function enterNameForLinkList(sender) {
  try {
    const form = new ModalFormData();
    form.title("Spieler hinzufügen");
    const label = "Spielername (genau wie im Spiel, mehrere mit Komma trennen)";
    try {
      form.textField(label, "Name", { defaultValue: "" });
    } catch {
      try {
        form.textField(label, "Name", "");
      } catch {
        form.textField(label, "Name");
      }
    }
    try {
      form.submitButton("Speichern");
    } catch { }

    showFormRetry(form, sender).then((res) => {
      if (!res || res.canceled) {
        openOfflineListMenu(sender);
        return;
      }
      const names = String(res.formValues?.[0] ?? "")
        .split(/[,;\n]/)
        .map((n) => n.trim())
        .filter(Boolean);
      if (!names.length) {
        try {
          sender.sendMessage("§eEs wurde kein Name eingegeben.");
        } catch { }
      }
      for (const name of names) reportLinkListAdd(sender, name, addToLinkList(name));
      openOfflineListMenu(sender);
    }).catch((error) => logError("enterNameForLinkList failed", error));
  } catch (error) {
    logError("enterNameForLinkList crashed", error);
  }
}

// Offline-Spieler-Menü: oben "Spieler hinzufügen", darunter alle eingetragenen Spieler.
function openOfflineListMenu(sender) {
  try {
    if (getActiveMode() !== 2) {
      sender.sendMessage("§cDie Link-Liste gibt es nur in Helden 2.");
      return;
    }
    const list = getLinkList();
    const links = readJsonProp(LINKS_PROP, {});
    const onlineKeys = new Set(getOnlinePlayers().map((p) => normalizeName(p?.name)));

    const form = new ActionFormData();
    form.title("§dOffline-Spieler");
    form.body(list.length
      ? `§7Eingetragene Spieler (${list.length}) – tippe einen an, um ihn zu entfernen.`
      : "§7Noch niemand eingetragen.");
    form.button("§aSpieler hinzufügen");
    for (const n of list) {
      const key = findLinkKey(links, n);
      const partner = key ? links[key] : null;
      const online = onlineKeys.has(normalizeName(n));
      form.button(`${online ? "§a" : "§8"}${n}\n§7${online ? "online" : "offline"} · ${partner ? `↔ ${partner}` : "kein Partner"}`);
    }
    form.button("Zurück");

    form.show(sender).then((res) => {
      if (!res || res.canceled || res.selection === undefined) return;
      if (res.selection === 0) {
        enterNameForLinkList(sender);
      } else if (res.selection <= list.length) {
        confirmRemoveFromLinkList(sender, list[res.selection - 1]);
      } else {
        openLinkListMenu(sender);
      }
    }).catch((error) => logError("openOfflineListMenu failed", error));
  } catch (error) {
    logError("openOfflineListMenu crashed", error);
  }
}

function confirmRemoveFromLinkList(sender, name) {
  const form = new ActionFormData();
  form.title("Spieler entfernen");
  form.body(`§f${name}§7 aus der Link-Liste entfernen? Sein Link wird aufgelöst.`);
  form.button("§cEntfernen");
  form.button("Abbrechen");
  form.show(sender).then((res) => {
    if (!res || res.canceled || res.selection === undefined) return;
    if (res.selection === 0 && removeFromLinkList(name)) {
      try {
        sender.sendMessage(`§e${name} wurde aus der Link-Liste entfernt (Link aufgelöst).`);
      } catch { }
    }
    openOfflineListMenu(sender);
  }).catch((error) => logError("confirmRemoveFromLinkList failed", error));
}

function removeFromLinkListMenu(sender) {
  const list = getLinkList();
  if (!list.length) {
    try {
      sender.sendMessage("§eDie Link-Liste ist leer.");
    } catch { }
    openLinkListMenu(sender);
    return;
  }
  const form = new ActionFormData();
  form.title("Spieler entfernen");
  list.forEach((n) => form.button(n));
  form.button("Zurück");
  form.show(sender).then((res) => {
    if (!res || res.canceled || res.selection === undefined) return;
    if (res.selection < list.length) {
      const name = list[res.selection];
      if (removeFromLinkList(name)) {
        try {
          sender.sendMessage(`§e${name} wurde aus der Link-Liste entfernt (Link aufgelöst).`);
        } catch { }
      }
    }
    openLinkListMenu(sender);
  }).catch((error) => logError("removeFromLinkListMenu failed", error));
}

// ----- Modus-Auswahl (kommt vor dem eigentlichen Config-Menü) -----
function openModeSelection(sender, onChosen) {
  try {
    const form = new ActionFormData();
    form.title("§bHelden§f Modus wählen");
    form.body("§7Wähle einen Modus. Die Auswahl bleibt fest, bis sie mit §f/helden:reset§7 gelöscht wird.");
    form.button("§aHelden 1\n§7Normale Herzen");
    form.button("§dHelden 2\n§7Verlinkte Herzen mit zufälligem Spieler");
    form.button("§6Helden 3\n§7Normale Herzen + Kopfgeld");

    form.show(sender).then((res) => {
      if (!res || res.canceled || res.selection === undefined) return;

      if (getHeldenMode() !== null) {
        try {
          sender.sendMessage(`§eEs wurde bereits Helden ${getHeldenMode()} gewählt.`);
        } catch { }
        if (typeof onChosen === "function") onChosen();
        return;
      }

      const mode = res.selection + 1;
      if (mode < 1 || mode > 3) return;

      world.setDynamicProperty(MODE_PROP, mode);
      if (mode === 2) assignRandomLinks();
      if (mode === 3) assignBountyPairs();
      broadcastMessage(`§bHelden§f: §eHelden ${mode}§f (${MODE_INFO[mode]}) wurde ausgewählt.`);
      if (mode === 2) {
        try {
          sender.sendMessage("§dTrage unter §fLink-Spielerliste§d alle Spieler ein, die einen Link bekommen sollen (Menü oder /helden:linkliste).");
        } catch { }
      }
      if (typeof onChosen === "function") onChosen();
    }).catch((error) => logError("openModeSelection failed", error));
  } catch (error) {
    logError("openModeSelection crashed", error);
  }
}

// ===== Kampf-Limits: Armor-Lock und Ender-Pearl-Limit =====
const DEFAULT_ARMOR_LOCK_MINUTES = 15;
const ARMOR_LOCK_OPTIONS = [10, 15, 30, 60];
const DEFAULT_PEARL_LIMIT = 16;
const PEARL_LIMIT_OPTIONS = [16, 32];
const ARMOR_SLOTS = ["Head", "Chest", "Legs", "Feet"];
const ARMOR_TYPE_RE = /(_helmet|_chestplate|_leggings|_boots)$|^minecraft:elytra$/;
const ARMOR_TICK_INTERVAL = 1;
const ARMOR_SNAPSHOT_TTL_MS = 60000;
const PEARL_RETRIGGER_GAP_MS = 900;
const NOTICE_COOLDOWN_MS = 3000;

let armorLocksCache = null;
const armorState = new Map();
const armorInvSnapshot = new Map();
const armorRemoved = new Map();
const ARMOR_REEQUIP_WINDOW_MS = 120000;
const pearlCounts = new Map();
const limitNoticeAt = new Map();

function readHeldenConfig() {
  try {
    const raw = world.getDynamicProperty?.("helden_config");
    if (!raw) return {};
    const cfg = typeof raw === "string" ? JSON.parse(raw) : raw;
    return cfg && typeof cfg === "object" ? cfg : {};
  } catch {
    return {};
  }
}

function saveHeldenConfigValue(key, value) {
  try {
    const cfg = readHeldenConfig();
    cfg[key] = value;
    world.setDynamicProperty("helden_config", JSON.stringify(cfg));
    return true;
  } catch (error) {
    logError(`saveHeldenConfigValue failed for ${key}`, error);
    return false;
  }
}

function getArmorLockMinutes() {
  const n = Number(readHeldenConfig().armor_lock_minutes);
  return ARMOR_LOCK_OPTIONS.includes(n) ? n : DEFAULT_ARMOR_LOCK_MINUTES;
}

function getPearlLimit() {
  const n = Number(readHeldenConfig().pearl_limit);
  return PEARL_LIMIT_OPTIONS.includes(n) ? n : DEFAULT_PEARL_LIMIT;
}

function noticeOnce(name, message) {
  try {
    const now = Date.now();
    if (now - (limitNoticeAt.get(name) || 0) < NOTICE_COOLDOWN_MS) return;
    limitNoticeAt.set(name, now);
    system.run(() => {
      try {
        getPlayer(name)?.sendMessage(message);
      } catch { }
    });
  } catch { }
}

// ----- Armor-Lock -----
function loadArmorLocks() {
  if (!armorLocksCache) {
    armorLocksCache = new Map();
    const obj = readJsonProp(ARMOR_LOCKS_PROP, {});
    for (const [name, v] of Object.entries(obj)) {
      armorLocksCache.set(name, { until: Number(v?.until) || 0, keys: new Set(Array.isArray(v?.keys) ? v.keys : []) });
    }
  }
  return armorLocksCache;
}

function saveArmorLocks() {
  const obj = {};
  const now = Date.now();
  for (const [name, lock] of loadArmorLocks()) {
    if (lock.until > now) obj[name] = { until: lock.until, keys: [...lock.keys] };
  }
  writeJsonProp(ARMOR_LOCKS_PROP, obj);
}

function getActiveArmorLock(name) {
  const locks = loadArmorLocks();
  const lock = locks.get(name);
  if (!lock) return null;
  if (lock.until <= Date.now()) {
    locks.delete(name);
    saveArmorLocks();
    return null;
  }
  return lock;
}

function clearArmorLock(name) {
  try {
    if (loadArmorLocks().delete(name)) saveArmorLocks();
  } catch { }
}

// Identität eines Rüstungsteils ohne Haltbarkeit (die sinkt beim Tragen und darf keinen Wechsel auslösen).
function armorItemKey(item) {
  try {
    if (!item || !ARMOR_TYPE_RE.test(item.typeId)) return null;
    let ench = "";
    try {
      const comp = item.getComponent?.("minecraft:enchantable") || item.getComponent?.("minecraft:enchantments");
      const list = comp?.getEnchantments?.();
      if (list) ench = [...list].map((e) => `${e.type?.id ?? e.type}${e.level}`).sort().join(",");
    } catch { }
    return `${item.typeId}|${ench}|${item.nameTag || ""}`;
  } catch {
    return null;
  }
}

function getItemDamage(item) {
  try {
    const d = item?.getComponent?.("minecraft:durability");
    return typeof d?.damage === "number" ? d.damage : null;
  } catch {
    return null;
  }
}

function setItemDamage(item, damage) {
  try {
    const d = item?.getComponent?.("minecraft:durability");
    if (d) d.damage = damage;
  } catch { }
}

// Merkt sich die Haltbarkeit aller Rüstungsteile im Inventar (Schlüssel -> { values, seen }).
// Einträge bleiben noch eine Weile erhalten, auch wenn das Teil das Inventar verlässt: Beim Ziehen mit
// der Maus liegt es mehrere Ticks lang auf dem Cursor und ist in keinem Slot.
function buildArmorInvSnapshot(player, old) {
  const now = Date.now();
  const snap = new Map();
  try {
    if (old) {
      for (const [key, entry] of old) {
        if (now - entry.seen <= ARMOR_SNAPSHOT_TTL_MS) snap.set(key, entry);
      }
    }
    const inv = player.getComponent?.("minecraft:inventory")?.container;
    if (!inv) return snap;
    const fresh = new Map();
    for (let i = 0; i < inv.size; i++) {
      const it = inv.getItem(i);
      const key = armorItemKey(it);
      if (!key) continue;
      const dmg = getItemDamage(it);
      if (dmg === null) continue;
      if (!fresh.has(key)) fresh.set(key, []);
      fresh.get(key).push(dmg);
    }
    for (const [key, values] of fresh) snap.set(key, { values, seen: now });
  } catch { }
  return snap;
}

// Das kurz getragene (blockierte) Teil bekommt seine alte Haltbarkeit zurück: Schaden, den es in der
// kurzen Zeit am Körper genommen hat, wird rückgängig gemacht. Schaden kann nur steigen, also gilt der
// größte gemerkte Wert, der nicht über dem aktuellen liegt.
function restoreArmorDamage(item, snap) {
  try {
    const key = armorItemKey(item);
    const values = key ? snap?.get(key)?.values : null;
    const current = getItemDamage(item);
    if (!values || current === null) return;
    const candidates = values.filter((v) => v <= current);
    if (candidates.length) setItemDamage(item, Math.max(...candidates));
  } catch { }
}

// Neu angezogenes Teil wieder ausziehen: altes Teil zurück in den Slot, das neue ins Inventar.
function revertArmorEquip(player, eq, slot, prevKey, snap) {
  const slotId = EquipmentSlot[slot];
  let blockedItem = null;
  try {
    blockedItem = eq.getEquipment(slotId);
  } catch { }
  try {
    eq.setEquipment(slotId, undefined);
  } catch { }

  const inv = player.getComponent?.("minecraft:inventory")?.container;
  let restoredKey = null;
  if (prevKey && inv) {
    for (let i = 0; i < inv.size; i++) {
      const it = inv.getItem(i);
      if (it && armorItemKey(it) === prevKey) {
        inv.setItem(i, undefined);
        eq.setEquipment(slotId, it);
        restoredKey = prevKey;
        break;
      }
    }
  }
  if (blockedItem) {
    restoreArmorDamage(blockedItem, snap);
    let rest = blockedItem;
    if (inv) rest = inv.addItem(blockedItem);
    if (rest) player.dimension?.spawnItem?.(rest, player.location);
  }
  return restoredKey;
}

function tickArmorLock() {
  for (const player of getOnlinePlayers()) {
    try {
      const name = player?.name;
      if (!name) continue;
      const inCombat = getCombatRemainingMs(name) > 0;

      // Ender-Pearl-Zähler gilt pro Kampf: endet der Kampf, beginnt er von vorn.
      if (!inCombat && pearlCounts.has(name)) pearlCounts.delete(name);

      const eq = player.getComponent?.("minecraft:equippable");
      if (!eq) continue;

      const cur = {};
      for (const slot of ARMOR_SLOTS) cur[slot] = armorItemKey(eq.getEquipment(EquipmentSlot[slot]));

      const prev = armorState.get(name);
      if (!prev) {
        armorState.set(name, cur);
        continue;
      }

      let lock = getActiveArmorLock(name);
      let dirty = false;
      let equippedInCombat = false;

      for (const slot of ARMOR_SLOTS) {
        if (prev[slot] === cur[slot]) continue;

        if (!cur[slot]) {
          // ausgezogen: dieses Teil darf während der Sperre wieder angezogen werden
          if (lock && prev[slot] && !lock.keys.has(prev[slot])) {
            lock.keys.add(prev[slot]);
            dirty = true;
          }
          if (prev[slot]) {
            if (!armorRemoved.has(name)) armorRemoved.set(name, {});
            armorRemoved.get(name)[slot] = { key: prev[slot], at: Date.now() };
          }
          continue;
        }

        if (lock) {
          if (!lock.keys.has(cur[slot])) {
            cur[slot] = revertArmorEquip(player, eq, slot, prev[slot], armorInvSnapshot.get(name));
            noticeOnce(name, "§cDu kannst gerade keine neue Rüstung anziehen.");
          }
        } else if (inCombat) {
          // Dasselbe Teil, das gerade ausgezogen wurde, wieder anzuziehen zählt nicht als neue Rüstung.
          const removed = armorRemoved.get(name)?.[slot];
          if (removed && removed.key === cur[slot] && Date.now() - removed.at <= ARMOR_REEQUIP_WINDOW_MS) {
            delete armorRemoved.get(name)[slot];
          } else {
            equippedInCombat = true;
          }
        }
      }

      // Der Cooldown startet nur, wenn man im Kampf eine Rüstung anzieht und danach eine volle Rüstung trägt.
      const fullArmor = ARMOR_SLOTS.every((slot) => cur[slot]);
      if (!lock && equippedInCombat && fullArmor) {
        lock = { until: Date.now() + getArmorLockMinutes() * 60000, keys: new Set(Object.values(cur).filter(Boolean)) };
        loadArmorLocks().set(name, lock);
        dirty = true;
        logDebug(`Armor-Lock gestartet für ${name} (${getArmorLockMinutes()} Min)`);
      }
      if (dirty) saveArmorLocks();
      if (inCombat || lock) armorInvSnapshot.set(name, buildArmorInvSnapshot(player, armorInvSnapshot.get(name)));
      else armorInvSnapshot.delete(name);
      armorState.set(name, cur);
    } catch (error) {
      logError("tickArmorLock failed", error);
    }
  }
}

function startArmorLockTick() {
  try {
    system.runInterval(() => {
      try {
        tickArmorLock();
      } catch (error) {
        logError("armor lock tick crashed", error);
      }
    }, ARMOR_TICK_INTERVAL);
  } catch (error) {
    logError("startArmorLockTick failed", error);
  }
}

// ----- Ender-Pearl-Limit (nur im Kampf) -----
function subscribeEnderPearlLimit() {
  try {
    const ev = world.beforeEvents?.itemUse;
    if (!ev) {
      logError("Ender-Pearl-Limit nicht verfügbar: world.beforeEvents.itemUse fehlt", null);
      return;
    }
    ev.subscribe((evt) => {
      try {
        if (evt.itemStack?.typeId !== "minecraft:ender_pearl") return;
        const name = evt.source?.name;
        if (!name) return;
        if (getCombatRemainingMs(name) <= 0) return;

        const limit = getPearlLimit();
        const entry = pearlCounts.get(name) || { count: 0, lastAt: 0 };
        if (entry.count >= limit) {
          evt.cancel = true;
          noticeOnce(name, `§cEnder-Pearl-Limit im Kampf erreicht (${limit}).`);
          return;
        }
        // Während der 1-Sekunden-Abklingzeit der Perle löst Rechtsklick kein Werfen aus, also nicht mitzählen.
        const now = Date.now();
        if (now - entry.lastAt >= PEARL_RETRIGGER_GAP_MS) {
          entry.count += 1;
          entry.lastAt = now;
        }
        pearlCounts.set(name, entry);
      } catch { }
    });
  } catch (error) {
    logError("subscribeEnderPearlLimit failed", error);
  }
}

function openCombatLimitOptions(sender, kind) {
  try {
    const isArmor = kind === "armor";
    const options = isArmor ? ARMOR_LOCK_OPTIONS : PEARL_LIMIT_OPTIONS;
    const current = isArmor ? getArmorLockMinutes() : getPearlLimit();
    const def = isArmor ? DEFAULT_ARMOR_LOCK_MINUTES : DEFAULT_PEARL_LIMIT;

    const form = new ActionFormData();
    form.title(isArmor ? "Rüstungs-Sperre einstellen" : "Ender-Pearl-Limit einstellen");
    form.body(isArmor
      ? "§7Wer im Combat eine Rüstung anzieht, kann danach so lange keine neue anziehen. Die Sperre ist für Spieler unsichtbar."
      : "§7So viele Ender Perlen kann ein Spieler pro Kampf werfen.");
    for (const o of options) {
      form.button(`${isArmor ? `${o} Minuten` : `${o} Perlen`}${o === def ? " (Standard)" : ""}${o === current ? " §a✔" : ""}`);
    }
    form.button("Abbrechen");

    form.show(sender).then((res) => {
      if (!res || res.canceled || res.selection === undefined) return;
      if (res.selection >= options.length) return;
      const value = options[res.selection];
      saveHeldenConfigValue(isArmor ? "armor_lock_minutes" : "pearl_limit", value);
      try {
        sender.sendMessage(isArmor ? `Rüstungs-Sperre gesetzt: ${value} Minuten` : `Ender-Pearl-Limit gesetzt: ${value}`);
      } catch { }
    }).catch((error) => logError("openCombatLimitOptions failed", error));
  } catch (error) {
    logError("openCombatLimitOptions crashed", error);
  }
}

// ===== Combat-Logout-Dummy =====
// Portiert aus dem Helden-Repo (function/heldenSave.js, function/dummyIds.js, events/entityHurt/timeoutDummy.js).
// Loggt jemand im Combat aus, spawnt an seiner Stelle für 15 Sekunden ein Dummy (Entity helden:dummy):
//  - überlebt der Dummy, passiert nichts (der Spieler kommt an der Dummy-Position zurück)
//  - wird der Dummy getötet, droppt er die Items des Spielers, der Spieler verliert ein Herz und hat beim
//    nächsten Join ein leeres Inventar.
// Die Entity helden:dummy muss im Behavior Pack existieren, sonst gilt wie früher die Strafe beim Wieder-Join.
const DUMMY_TYPE = "helden:dummy";
const DUMMY_LIFETIME_MS = 15000;
const DUMMY_DIMENSIONS = ["overworld", "nether", "the_end"];

// --- heldenSave.js ---
let heldenSaveCache;
let heldenSaveTimer = null;
function heldenSave(direct) {
  if (heldenSaveCache === undefined) {
    try {
      heldenSaveCache = JSON.parse(world.getDynamicProperty("heldenSave") ?? "{}");
    } catch {
      heldenSaveCache = {};
    }
  }
  if (direct) heldenSaveCache = JSON.parse(direct);
  if (!heldenSaveCache.player) heldenSaveCache.player = {};
  if (heldenSaveTimer === null) {
    heldenSaveTimer = system.runTimeout(() => {
      heldenSaveTimer = null;
      try {
        world.setDynamicProperty("heldenSave", JSON.stringify(heldenSaveCache));
      } catch (error) {
        logError("heldenSave write failed", error);
      }
    }, 5);
  }
  return heldenSaveCache;
}

function heldenPlayerSave(name) {
  const save = heldenSave();
  if (!save.player[name]) save.player[name] = {};
  return save.player[name];
}

// --- dummyIds.js ---
const dummyIds = {};
function dummyId(name, id) {
  return {
    setId() {
      dummyIds[name] = id;
    },
    removeId() {
      delete dummyIds[name];
    },
    getId() {
      return dummyIds[name];
    }
  };
}

// --- Laufzeit-Zustand ---
const dummyDesp = {};
const dummyState = new Map();
const dummyItems = new Map();
const dummyLeavePending = new Set();

function entityIsValid(entity) {
  try {
    if (!entity) return false;
    if (typeof entity.isValid === "function") return entity.isValid();
    return entity.isValid !== false;
  } catch {
    return false;
  }
}

function findDummyEntityById(id) {
  for (const dimId of DUMMY_DIMENSIONS) {
    try {
      const found = world.getDimension(dimId).getEntities({ type: DUMMY_TYPE }).find((e) => e.id === id);
      if (found) return found;
    } catch { }
  }
  return null;
}

// --- timeoutDummy.js ---
function timeoutDummy(entity) {
  if (entity?.typeId !== DUMMY_TYPE) return;
  const name = entity.nameTag;
  const entityId = entity.id;
  const combatlog = heldenSave().player[name]?.combatlog;
  // Ohne gespeicherten Ablaufzeitpunkt (z.B. Test-Dummy) den bestehenden Timer nicht anfassen.
  // Früher wurde hier mit 0 gerechnet, der Dummy verschwand dadurch einen Tick nach dem ersten Treffer.
  if (typeof combatlog !== "number") return;
  const combatTime = combatlog - Date.now();

  if (dummyDesp[entityId]) system.clearRun(dummyDesp[entityId]);

  dummyDesp[entityId] = system.runTimeout(() => {
    try {
      delete dummyDesp[entityId];
      if (!entityIsValid(entity)) return;
      const dummySave = heldenPlayerSave(name);
      const dimension = entity.dimension.id;
      const { x, y, z } = entity.location;
      delete dummySave.combatlog;
      dummySave.dummy = { location: { x, y, z }, dimension };
      dummyId(name).removeId();
      dummyState.delete(entityId);
      dummyItems.delete(name);
      entity.remove();
      heldenSave();
    } catch (error) {
      logError("timeoutDummy failed", error);
    }
  }, Math.max(1, Math.floor(combatTime / 50) - 10));
}

// --- Spawn beim Ausloggen ---
function captureLogoutSnapshot(player) {
  const items = [];
  try {
    const inv = player.getComponent?.("minecraft:inventory")?.container;
    if (inv) {
      for (let i = 0; i < inv.size; i++) {
        const it = inv.getItem(i);
        if (it) items.push(it.clone ? it.clone() : it);
      }
    }
  } catch { }
  try {
    const eq = player.getComponent?.("minecraft:equippable");
    if (eq) {
      for (const slot of ["Head", "Chest", "Legs", "Feet", "Offhand"]) {
        const it = eq.getEquipment(EquipmentSlot[slot]);
        if (it) items.push(it.clone ? it.clone() : it);
      }
    }
  } catch { }
  return {
    name: player.name,
    items,
    location: { x: player.location.x, y: player.location.y, z: player.location.z },
    dimensionId: player.dimension.id
  };
}

function spawnLogoutDummy(snapshot) {
  try {
    const dimension = world.getDimension(snapshot.dimensionId);
    const entity = dimension.spawnEntity(DUMMY_TYPE, snapshot.location);
    entity.nameTag = snapshot.name;
    try {
      entity.addTag("helden_dummy");
    } catch { }

    dummyId(snapshot.name, entity.id).setId();
    const entry = heldenPlayerSave(snapshot.name);
    entry.combatlog = Date.now() + DUMMY_LIFETIME_MS;
    delete entry.dummy;
    heldenSave();

    dummyState.set(entity.id, { name: snapshot.name, dimensionId: snapshot.dimensionId, location: snapshot.location });
    dummyItems.set(snapshot.name, snapshot.items);
    timeoutDummy(entity);
    logDebug(`Dummy gespawnt für ${snapshot.name} (${snapshot.items.length} Item-Stacks)`);
    return true;
  } catch (error) {
    logError(`spawnLogoutDummy failed for ${snapshot?.name}`, error);
    notifyOps(`§c[Dummy] Spawn für ${snapshot?.name} fehlgeschlagen: ${error?.message || error}. Existiert die Entity ${DUMMY_TYPE}? (Test: /helden:dummytest)`);
    return false;
  }
}

function notifyOps(message) {
  try {
    for (const p of getOnlinePlayers()) {
      try {
        if (p.isOp?.()) p.sendMessage(message);
      } catch { }
    }
  } catch { }
}

// Testspawn: zeigt dem Admin direkt, ob die Entity helden:dummy funktioniert. Der Test-Dummy ist nicht
// getrackt (kein Herzverlust, keine Drops) und verschwindet nach 15 Sekunden.
function testDummySpawn(sender) {
  try {
    const dimension = sender.dimension;
    const loc = { x: sender.location.x, y: sender.location.y, z: sender.location.z };
    const entity = dimension.spawnEntity(DUMMY_TYPE, loc);
    entity.nameTag = "Dummy-Test";
    system.runTimeout(() => {
      try {
        entity.remove();
      } catch { }
    }, DUMMY_LIFETIME_MS / 50);
    sender.sendMessage(`§aDummy gespawnt (${DUMMY_TYPE}). Er verschwindet nach ${DUMMY_LIFETIME_MS / 1000} Sekunden.`);
  } catch (error) {
    sender.sendMessage(`§cDummy konnte nicht gespawnt werden: ${error?.message || error}\n§7Die Entity ${DUMMY_TYPE} fehlt vermutlich im Behavior Pack.`);
  }
}

function subscribeDummyLeave() {
  try {
    const ev = world.beforeEvents?.playerLeave;
    if (!ev) return;
    ev.subscribe((evt) => {
      try {
        const player = evt.player;
        const name = player?.name;
        if (!name) return;
        if (!(combatTaggedPlayers.has(normalizeName(name)) || getCombatRemainingMs(name) > 0)) return;

        const snapshot = captureLogoutSnapshot(player);
        dummyLeavePending.add(name);
        system.run(() => {
          if (spawnLogoutDummy(snapshot)) {
            // Markierung noch kurz behalten, damit der playerLeave-Handler sie sicher sieht, egal in welcher Reihenfolge.
            runLater(() => dummyLeavePending.delete(name), 40);
          } else {
            // Dummy nicht möglich (Entity fehlt?): alte Strafe beim Wieder-Join
            combatLoggedPlayers.set(name, Date.now());
            dummyLeavePending.delete(name);
          }
        });
      } catch (error) {
        logError("dummy beforeEvents.playerLeave failed", error);
      }
    });
  } catch { }
}

// --- Dummy getötet ---
function setOfflineHeartCount(name, value) {
  setPlayerHeartCount(name, value);
  const pending = readJsonProp(PENDING_HEARTS_PROP, {});
  pending[name] = value;
  writeJsonProp(PENDING_HEARTS_PROP, pending);
}

function handleDummyKilled(name, killerName, location, dimensionId, entityId) {
  try {
    if (dummyDesp[entityId]) {
      system.clearRun(dummyDesp[entityId]);
      delete dummyDesp[entityId];
    }
    dummyState.delete(entityId);
    dummyId(name).removeId();

    // Items des Spielers droppen
    const items = dummyItems.get(name);
    dummyItems.delete(name);
    const entry = heldenPlayerSave(name);
    delete entry.combatlog;
    delete entry.dummy;
    if (items && items.length) {
      const dimension = world.getDimension(dimensionId);
      for (const item of items) {
        try {
          dimension.spawnItem(item, location);
        } catch (error) {
          logError("Dummy-Drop failed", error);
        }
      }
      entry.clearOnJoin = true;
    }
    heldenSave();

    // Herzverlust: Kopfgeld-Ziel und verlinkter Partner verlieren keins
    let heartLost = false;
    const paidBounty = killerName && payoutBounty(name, killerName);
    if (!paidBounty && !(killerName && isLinkedPair(name, killerName))) {
      const current = hearts.has(name) ? clampHearts(hearts.get(name)) : MAX_HEARTS;
      const remaining = Math.max(0, current - 1);
      setOfflineHeartCount(name, remaining);
      heartLost = true;
    }

    const by = killerName ? ` von §e${killerName}§f` : "";
    broadcastMessage(
      `§c${name}§f hat sich im Combat ausgeloggt, sein Dummy wurde${by} getötet.` + (heartLost ? " §cEr verliert ein Herz!" : "")
    );
  } catch (error) {
    logError(`handleDummyKilled failed for ${name}`, error);
  }
}

function subscribeDummyEvents() {
  try {
    const dieEv = world.afterEvents?.entityDie;
    if (dieEv) {
      dieEv.subscribe((evt) => {
        try {
          const ent = evt.deadEntity;
          if (ent?.typeId !== DUMMY_TYPE) return;
          const state = dummyState.get(ent.id);
          const name = state?.name || ent.nameTag;
          if (!name || !state) return; // nicht (mehr) getrackt, z.B. nach Ablauf entfernt
          let location = state.location;
          let dimensionId = state.dimensionId;
          try {
            location = { x: ent.location.x, y: ent.location.y, z: ent.location.z };
            dimensionId = ent.dimension.id;
          } catch { }
          const killer = evt.damageSource?.damagingEntity;
          handleDummyKilled(name, killer?.name || null, location, dimensionId, ent.id);
        } catch (error) {
          logError("dummy entityDie failed", error);
        }
      });
    }

    const hurtEv = world.afterEvents?.entityHurt;
    if (hurtEv) {
      hurtEv.subscribe((evt) => {
        try {
          const ent = evt.hurtEntity;
          if (ent?.typeId !== DUMMY_TYPE) return;
          const state = dummyState.get(ent.id);
          if (state) {
            try {
              state.location = { x: ent.location.x, y: ent.location.y, z: ent.location.z };
            } catch { }
          }
          timeoutDummy(ent);
        } catch (error) {
          logError("dummy entityHurt failed", error);
        }
      });
    }

    // Übrig gebliebene Dummys (z.B. nach Neustart) entfernen
    system.runTimeout(() => {
      for (const dimId of DUMMY_DIMENSIONS) {
        try {
          for (const e of world.getDimension(dimId).getEntities({ type: DUMMY_TYPE })) {
            if (!dummyState.has(e.id)) e.remove();
          }
        } catch { }
      }
    }, 100);
  } catch (error) {
    logError("subscribeDummyEvents failed", error);
  }
}

// --- Join: Dummy wegräumen, Position/Inventar anwenden ---
function clearPlayerItems(player) {
  try {
    const inv = player.getComponent?.("minecraft:inventory")?.container;
    if (inv) for (let i = 0; i < inv.size; i++) inv.setItem(i, undefined);
  } catch { }
  try {
    const eq = player.getComponent?.("minecraft:equippable");
    if (eq) for (const slot of ["Head", "Chest", "Legs", "Feet", "Offhand"]) eq.setEquipment(EquipmentSlot[slot], undefined);
  } catch { }
}

function teleportToSpawn(player) {
  try {
    const sp = player.getSpawnPoint?.();
    if (sp) {
      player.teleport({ x: sp.x + 0.5, y: sp.y, z: sp.z + 0.5 }, { dimension: sp.dimension });
      return;
    }
  } catch { }
  try {
    player.teleport(world.getDefaultSpawnLocation(), { dimension: world.getDimension("overworld") });
  } catch { }
}

function applyDummyJoinState(player) {
  const name = player?.name;
  if (!name) return;
  runLater(() => {
    try {
      const p = getPlayer(name);
      if (!p) return;

      // Dummy läuft noch? Spieler ist zurück, Dummy verschwindet.
      let back = null;
      const liveId = dummyId(name).getId();
      if (liveId) {
        const live = findDummyEntityById(liveId);
        if (live) {
          back = { location: { x: live.location.x, y: live.location.y, z: live.location.z }, dimension: live.dimension.id };
          if (dummyDesp[liveId]) {
            system.clearRun(dummyDesp[liveId]);
            delete dummyDesp[liveId];
          }
          live.remove();
        }
        dummyId(name).removeId();
        dummyState.delete(liveId);
        dummyItems.delete(name);
      }

      const entry = heldenSave().player?.[name];
      if (!entry && !back) return;

      if (entry?.clearOnJoin) {
        clearPlayerItems(p);
        teleportToSpawn(p);
        delete entry.clearOnJoin;
        delete entry.dummy;
        delete entry.combatlog;
        p.sendMessage("§cDein Dummy wurde getötet, während du ausgeloggt warst. Deine Items sind weg.");
      } else {
        const target = entry?.dummy || back;
        if (target) {
          try {
            p.teleport(target.location, { dimension: world.getDimension(target.dimension) });
          } catch { }
        }
        if (entry) {
          delete entry.dummy;
          delete entry.combatlog;
        }
      }
      heldenSave();
    } catch (error) {
      logError(`applyDummyJoinState failed for ${name}`, error);
    }
  }, 20);
}

// ===== Verbotene Items + End-Portal-Rahmen entfernen =====
const BANNED_ITEMS_PROP = "helden_banned_items";
const DEFAULT_BANNED_ITEMS = ["minecraft:end_portal_frame"];
const BANNED_SWEEP_TICKS = 10;
const END_FRAME_TYPE = "minecraft:end_portal_frame";
const END_FRAME_SWEEP_TICKS = 60; // alle 3 Sekunden
const END_FRAME_RADIUS_XZ = 12;
const END_FRAME_RADIUS_Y = 12;

function getBannedItems() {
  try {
    const raw = world.getDynamicProperty?.(BANNED_ITEMS_PROP);
    if (raw === undefined || raw === null) return [...DEFAULT_BANNED_ITEMS];
    const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [...DEFAULT_BANNED_ITEMS];
  } catch {
    return [...DEFAULT_BANNED_ITEMS];
  }
}

function saveBannedItems(list) {
  try {
    world.setDynamicProperty(BANNED_ITEMS_PROP, JSON.stringify([...new Set(list)]));
    return true;
  } catch (error) {
    logError("saveBannedItems failed", error);
    return false;
  }
}

function normalizeItemId(input) {
  let id = String(input || "").trim().toLowerCase();
  if (!id) return null;
  if (!id.includes(":")) id = `minecraft:${id}`;
  return /^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(id) ? id : null;
}

function addBannedItem(input) {
  const id = normalizeItemId(input);
  if (!id) return { status: "invalid", id: String(input || "") };
  try {
    const types = mcServer.ItemTypes;
    if (types?.get && !types.get(id)) return { status: "unknown", id };
  } catch { }
  const list = getBannedItems();
  if (list.includes(id)) return { status: "exists", id };
  list.push(id);
  saveBannedItems(list);
  return { status: "added", id };
}

function removeBannedItem(id) {
  const list = getBannedItems();
  if (!list.includes(id)) return false;
  return saveBannedItems(list.filter((x) => x !== id));
}

// Entfernt verbotene Items aus Inventar, Rüstungs-Slots und Offhand. Gibt die Menge je Item zurück.
function clearBannedItemsFor(player, bannedSet) {
  const removed = new Map();
  try {
    const inv = player.getComponent?.("minecraft:inventory")?.container;
    if (inv) {
      for (let i = 0; i < inv.size; i++) {
        const it = inv.getItem(i);
        if (it && bannedSet.has(it.typeId)) {
          removed.set(it.typeId, (removed.get(it.typeId) || 0) + (it.amount || 1));
          inv.setItem(i, undefined);
        }
      }
    }
  } catch { }
  try {
    const eq = player.getComponent?.("minecraft:equippable");
    if (eq) {
      for (const slot of ["Head", "Chest", "Legs", "Feet", "Offhand"]) {
        const it = eq.getEquipment(EquipmentSlot[slot]);
        if (it && bannedSet.has(it.typeId)) {
          removed.set(it.typeId, (removed.get(it.typeId) || 0) + (it.amount || 1));
          eq.setEquipment(EquipmentSlot[slot], undefined);
        }
      }
    }
  } catch { }
  return removed;
}

function sweepBannedItems() {
  const banned = new Set(getBannedItems());
  if (!banned.size) return;
  for (const player of getOnlinePlayers()) {
    try {
      const removed = clearBannedItemsFor(player, banned);
      if (removed.size) {
        const text = [...removed].map(([id, n]) => `${id.replace("minecraft:", "")} x${n}`).join(", ");
        noticeOnce(player.name, `§cVerbotene Items wurden entfernt: §f${text}`);
      }
    } catch (error) {
      logError(`sweepBannedItems failed for ${player?.name || "unknown"}`, error);
    }
  }
}

function startBannedItemSweep() {
  try {
    system.runInterval(() => {
      try {
        sweepBannedItems();
      } catch (error) {
        logError("banned item sweep crashed", error);
      }
    }, BANNED_SWEEP_TICKS);
  } catch (error) {
    logError("startBannedItemSweep failed", error);
  }
}

// ----- End-Portal-Rahmen in der Nähe von Spielern durch Luft ersetzen -----
function findEndFrameLocations(player) {
  const dimension = player.dimension;
  const c = player.location;
  const minY = dimension.heightRange?.min ?? -64;
  const maxY = (dimension.heightRange?.max ?? 320) - 1;
  const cx = Math.floor(c.x);
  const cy = Math.floor(c.y);
  const cz = Math.floor(c.z);
  const found = [];
  try {
    const volume = new mcServer.BlockVolume(
      { x: cx - END_FRAME_RADIUS_XZ, y: Math.max(minY, cy - END_FRAME_RADIUS_Y), z: cz - END_FRAME_RADIUS_XZ },
      { x: cx + END_FRAME_RADIUS_XZ, y: Math.min(maxY, cy + END_FRAME_RADIUS_Y), z: cz + END_FRAME_RADIUS_XZ }
    );
    const result = dimension.getBlocks(volume, { includeTypes: [END_FRAME_TYPE] }, true);
    for (const loc of result.getBlockLocationIterator()) found.push({ x: loc.x, y: loc.y, z: loc.z });
    return found;
  } catch {
    // Fallback ohne getBlocks: kleinerer Bereich, Block für Block
    const r = 6;
    for (let x = cx - r; x <= cx + r; x++) {
      for (let y = Math.max(minY, cy - r); y <= Math.min(maxY, cy + r); y++) {
        for (let z = cz - r; z <= cz + r; z++) {
          try {
            if (dimension.getBlock({ x, y, z })?.typeId === END_FRAME_TYPE) found.push({ x, y, z });
          } catch { }
        }
      }
    }
    return found;
  }
}

function replaceEndFramesNear(player) {
  const dimension = player.dimension;
  const locations = findEndFrameLocations(player);
  let replaced = 0;
  for (const loc of locations) {
    try {
      try {
        dimension.setBlockType(loc, "minecraft:air");
      } catch {
        dimension.getBlock(loc)?.setType("minecraft:air");
      }
      replaced += 1;
    } catch (error) {
      logError(`End-Portal-Rahmen konnte nicht ersetzt werden bei ${loc.x} ${loc.y} ${loc.z}`, error);
    }
  }
  if (replaced) logDebug(`${replaced} End-Portal-Rahmen bei ${player.name} durch Luft ersetzt`);
  return replaced;
}

function startEndPortalFrameSweep() {
  try {
    system.runInterval(() => {
      for (const player of getOnlinePlayers()) {
        try {
          replaceEndFramesNear(player);
        } catch (error) {
          logError(`end frame sweep failed for ${player?.name || "unknown"}`, error);
        }
      }
    }, END_FRAME_SWEEP_TICKS);
  } catch (error) {
    logError("startEndPortalFrameSweep failed", error);
  }
}

// ----- Menü: Verbotene Items -----
function openBannedItemsMenu(sender) {
  try {
    const list = getBannedItems();
    const form = new ActionFormData();
    form.title("§cVerbotene Items");
    form.body(list.length
      ? `§7Diese Items werden automatisch aus dem Inventar entfernt (${list.length}):\n§f${list.map((i) => i.replace("minecraft:", "")).join("\n")}`
      : "§7Die Liste ist leer.");
    form.button("§aItem in der Hand hinzufügen");
    form.button("§aItem-ID eintippen");
    form.button("§cItem entfernen");
    form.button("Schließen");
    form.show(sender).then((res) => {
      if (!res || res.canceled || res.selection === undefined) return;
      if (res.selection === 0) addHeldItemToBanned(sender);
      else if (res.selection === 1) enterBannedItemId(sender);
      else if (res.selection === 2) removeBannedItemMenu(sender);
    }).catch((error) => logError("openBannedItemsMenu failed", error));
  } catch (error) {
    logError("openBannedItemsMenu crashed", error);
  }
}

function reportBannedAdd(sender, result) {
  const text = {
    added: `§a${result.id} steht jetzt auf der Liste der verbotenen Items.`,
    exists: `§e${result.id} steht schon auf der Liste.`,
    unknown: `§cUnbekanntes Item: ${result.id}`,
    invalid: `§cUngültige Item-ID: ${result.id}`
  }[result.status];
  try {
    sender.sendMessage(text);
  } catch { }
}

function addHeldItemToBanned(sender) {
  try {
    const held = sender.getComponent?.("minecraft:equippable")?.getEquipment(EquipmentSlot.Mainhand);
    if (!held) {
      sender.sendMessage("§eDu hältst kein Item in der Hand.");
    } else {
      reportBannedAdd(sender, addBannedItem(held.typeId));
    }
  } catch (error) {
    logError("addHeldItemToBanned failed", error);
  }
  openBannedItemsMenu(sender);
}

function enterBannedItemId(sender) {
  try {
    const form = new ModalFormData();
    form.title("Verbotenes Item hinzufügen");
    const label = "Item-ID, z.B. minecraft:ender_eye (mehrere mit Komma trennen)";
    try {
      form.textField(label, "minecraft:...", { defaultValue: "" });
    } catch {
      try {
        form.textField(label, "minecraft:...", "");
      } catch {
        form.textField(label, "minecraft:...");
      }
    }
    try {
      form.submitButton("Hinzufügen");
    } catch { }

    showFormRetry(form, sender).then((res) => {
      if (!res || res.canceled) {
        openBannedItemsMenu(sender);
        return;
      }
      const ids = String(res.formValues?.[0] ?? "").split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
      if (!ids.length) {
        try {
          sender.sendMessage("§eEs wurde keine Item-ID eingegeben.");
        } catch { }
      }
      for (const id of ids) reportBannedAdd(sender, addBannedItem(id));
      openBannedItemsMenu(sender);
    }).catch((error) => logError("enterBannedItemId failed", error));
  } catch (error) {
    logError("enterBannedItemId crashed", error);
  }
}

function removeBannedItemMenu(sender) {
  try {
    const list = getBannedItems();
    if (!list.length) {
      sender.sendMessage("§eDie Liste ist leer.");
      openBannedItemsMenu(sender);
      return;
    }
    const form = new ActionFormData();
    form.title("Item entfernen");
    form.body("§7Tippe ein Item an, um es von der Liste zu nehmen.");
    for (const id of list) form.button(`§c${id.replace("minecraft:", "")}`);
    form.button("Zurück");
    form.show(sender).then((res) => {
      if (!res || res.canceled || res.selection === undefined) return;
      if (res.selection < list.length) {
        const id = list[res.selection];
        if (removeBannedItem(id)) {
          try {
            sender.sendMessage(`§e${id} wurde von der Liste genommen.`);
          } catch { }
        }
      }
      openBannedItemsMenu(sender);
    }).catch((error) => logError("removeBannedItemMenu failed", error));
  } catch (error) {
    logError("removeBannedItemMenu crashed", error);
  }
}

// ===== Nether-Portal-Blöcke sofort durch Luft ersetzen =====
// (Verbotene Items und End-Portal-Rahmen: siehe Block "Verbotene Items + End-Portal-Rahmen entfernen".)
const NETHER_PORTAL_ID = "minecraft:portal";
const PORTAL_SWEEP_TICKS = 10;
const PORTAL_RADIUS = 12;
const PORTAL_IGNITE_RADIUS = 24;

// Sucht Blöcke der angegebenen Typen im Umkreis. Nutzt dimension.getBlocks (schnell, nativ), sonst Block für Block mit kleinerem Radius.
function findBlocksNear(dimension, center, typeIds, radius, fallbackRadius) {
  const found = [];
  const x0 = Math.floor(center.x);
  const y0 = Math.floor(center.y);
  const z0 = Math.floor(center.z);
  const minY = dimension.heightRange?.min ?? -64;
  const maxY = (dimension.heightRange?.max ?? 320) - 1;
  try {
    const BV = mcServer.BlockVolume;
    if (BV && typeof dimension.getBlocks === "function") {
      const volume = new BV(
        { x: x0 - radius, y: Math.max(minY, y0 - radius), z: z0 - radius },
        { x: x0 + radius, y: Math.min(maxY, y0 + radius), z: z0 + radius }
      );
      const result = dimension.getBlocks(volume, { includeTypes: typeIds }, true);
      const iter = result?.getBlockLocationIterator ? result.getBlockLocationIterator() : result;
      for (const loc of iter) found.push({ x: loc.x, y: loc.y, z: loc.z });
      return found;
    }
  } catch { }
  const wanted = new Set(typeIds);
  const r = fallbackRadius;
  for (let x = x0 - r; x <= x0 + r; x++) {
    for (let y = Math.max(minY, y0 - r); y <= Math.min(maxY, y0 + r); y++) {
      for (let z = z0 - r; z <= z0 + r; z++) {
        try {
          const block = dimension.getBlock({ x, y, z });
          if (block && wanted.has(block.typeId)) found.push({ x, y, z });
        } catch { }
      }
    }
  }
  return found;
}

function clearBlocksNear(dimension, center, typeIds, radius, fallbackRadius) {
  const found = findBlocksNear(dimension, center, typeIds, radius, fallbackRadius);
  let count = 0;
  for (const loc of found) {
    try {
      dimension.setBlockType(loc, "minecraft:air");
      count++;
      continue;
    } catch { }
    try {
      dimension.getBlock(loc)?.setType("minecraft:air");
      count++;
    } catch { }
  }
  return count;
}

function startNetherPortalGuard() {
  try {
    // Absicherung für Portale, die nicht per Feuerzeug entstehen (Dispenser, Blitz, Feuerausbreitung ...)
    system.runInterval(() => {
      for (const player of getOnlinePlayers()) {
        try {
          clearBlocksNear(player.dimension, player.location, [NETHER_PORTAL_ID], PORTAL_RADIUS, 6);
        } catch (error) {
          logError("nether portal sweep failed", error);
        }
      }
    }, PORTAL_SWEEP_TICKS);
  } catch (error) {
    logError("startNetherPortalGuard interval failed", error);
  }
  try {
    // Wird ein Portal angezündet, entstehen die Portalblöcke im selben Tick: schon im nächsten Tick sind sie weg.
    const ev = world.afterEvents?.itemUseOn;
    if (!ev) return;
    ev.subscribe((evt) => {
      try {
        const id = evt.itemStack?.typeId;
        if (id !== "minecraft:flint_and_steel" && id !== "minecraft:fire_charge") return;
        const dimension = evt.block?.dimension || evt.source?.dimension;
        const loc = evt.block?.location;
        if (!dimension || !loc) return;
        for (const delay of [1, 2, 4]) {
          system.runTimeout(() => {
            try {
              clearBlocksNear(dimension, loc, [NETHER_PORTAL_ID], PORTAL_IGNITE_RADIUS, 10);
            } catch (error) {
              logError("portal ignite sweep failed", error);
            }
          }, delay);
        }
      } catch (error) {
        logError("portal itemUseOn failed", error);
      }
    });
  } catch (error) {
    logError("startNetherPortalGuard event failed", error);
  }
}

function applySoulAmuletLore(itemStack, isBroken = false) {
  try {
    if (!itemStack?.setLore) return itemStack;
    const lore = isBroken
      ? [
        "§8Dieses Amulett ist zerbrochen.",
        "§7Es kann dich nicht mehr vor dem Herztod retten."
      ]
      : [
        "§7Wenn du dieses Item beim Tod im Inventar hast,",
        "§7verlierst du kein Herz."
      ];
    itemStack.setLore(lore);
  } catch (error) {
    logError(`applySoulAmuletLore failed for ${itemStack?.typeId || "unknown"}`, error);
  }
  return itemStack;
}

function createBrokenSoulAmuletItem() {
  try {
    const brokenSoulAmulet = new ItemStack("helden:broken_soul_amulet", 1);
    return applySoulAmuletLore(brokenSoulAmulet, true);
  } catch (error) {
    logError("createBrokenSoulAmuletItem failed", error);
    return null;
  }
}

function refreshSoulAmuletLoreInInventory(player) {
  try {
    if (!player?.getComponent) return false;
    const inv = player.getComponent("minecraft:inventory")?.container;
    if (!inv) return false;

    let changed = false;
    for (let i = 0; i < inv.size; i++) {
      try {
        const currentItem = inv.getItem(i);
        if (!currentItem) continue;
        if (currentItem.typeId === "helden:soul_amulet") {
          applySoulAmuletLore(currentItem, false);
          inv.setItem(i, currentItem);
          changed = true;
        } else if (currentItem.typeId === "helden:broken_soul_amulet") {
          applySoulAmuletLore(currentItem, true);
          inv.setItem(i, currentItem);
          changed = true;
        }
      } catch { }
    }
    return changed;
  } catch (error) {
    logError(`refreshSoulAmuletLoreInInventory failed for ${player?.name || "unknown"}`, error);
    return false;
  }
}

function queueBrokenSoulAmuletConversion(count = 1) {
  try {
    pendingBrokenSoulAmuletConversions += Math.max(0, Number(count) || 0);
    logDebug(`Queued broken soul amulet conversions=${pendingBrokenSoulAmuletConversions}`);
  } catch { }
}

function replaceFirstSoulAmuletWithBroken(player) {
  try {
    if (!player?.getComponent) return false;
    const inv = player.getComponent("minecraft:inventory")?.container;
    if (!inv) return false;

    for (let i = 0; i < inv.size; i++) {
      try {
        const currentItem = inv.getItem(i);
        if (!currentItem || currentItem.typeId !== "helden:soul_amulet") continue;

        const brokenSoulAmulet = createBrokenSoulAmuletItem();
        if (!brokenSoulAmulet) return false;

        if ((currentItem.amount || 1) > 1) {
          const nextItem = currentItem.clone ? currentItem.clone() : currentItem;
          nextItem.amount = (currentItem.amount || 1) - 1;
          inv.setItem(i, nextItem);

          let inserted = false;
          for (let j = 0; j < inv.size; j++) {
            try {
              const slotItem = inv.getItem(j);
              if (slotItem) continue;
              inv.setItem(j, brokenSoulAmulet);
              inserted = true;
              break;
            } catch { }
          }

          if (!inserted) {
            try {
              player.dimension?.spawnItem?.(brokenSoulAmulet, player.location);
              inserted = true;
            } catch (error) {
              logError(`Failed to spawn broken soul amulet during pickup conversion for ${player.name}`, error);
            }
          }

          if (!inserted) return false;
        } else {
          inv.setItem(i, brokenSoulAmulet);
        }

        refreshSoulAmuletLoreInInventory(player);
        logDebug(`Converted picked-up soul amulet to broken variant for ${player.name}`);
        return true;
      } catch { }
    }
  } catch (error) {
    logError(`replaceFirstSoulAmuletWithBroken failed for ${player?.name || "unknown"}`, error);
  }
  return false;
}

function processPendingBrokenSoulAmuletConversions() {
  try {
    if (pendingBrokenSoulAmuletConversions <= 0) return false;
    for (const player of getOnlinePlayers()) {
      if (pendingBrokenSoulAmuletConversions <= 0) break;
      if (replaceFirstSoulAmuletWithBroken(player)) {
        pendingBrokenSoulAmuletConversions = Math.max(0, pendingBrokenSoulAmuletConversions - 1);
        logDebug(`Pending broken soul amulet conversions remaining=${pendingBrokenSoulAmuletConversions}`);
      }
    }
  } catch (error) {
    logError("processPendingBrokenSoulAmuletConversions failed", error);
  }
  return pendingBrokenSoulAmuletConversions <= 0;
}

function randomIntInclusive(min, max) {
  const low = Math.ceil(Math.min(min, max));
  const high = Math.floor(Math.max(min, max));
  return Math.floor(Math.random() * (high - low + 1)) + low;
}

function isAirBlock(block) {
  try {
    if (!block?.typeId) return true;
    const typeId = String(block.typeId).toLowerCase();
    return typeId === "minecraft:air" || typeId === "minecraft:cave_air" || typeId === "minecraft:void_air";
  } catch {
    return true;
  }
}

function isLiquidBlock(block) {
  try {
    if (!block?.typeId) return false;
    const typeId = String(block.typeId).toLowerCase();
    return typeId.includes("water") || typeId.includes("lava");
  } catch {
    return false;
  }
}

async function runExecutorCommand(executor, command) {
  try {
    if (!executor || !command) return false;
    if (executor.runCommandAsync) {
      try {
        await executor.runCommandAsync(command);
        return true;
      } catch (error) {
        logError(`runCommandAsync failed: ${command}`, error);
      }
    }
    if (executor.runCommand) {
      try {
        executor.runCommand(command);
        return true;
      } catch (error) {
        logError(`runCommand failed: ${command}`, error);
      }
    }
  } catch (error) {
    logError(`runExecutorCommand crashed: ${command}`, error);
  }
  return false;
}

async function withTemporaryTickingArea(executor, x, z, callback) {
  const areaName = `helden_amuletevent_${Math.abs(x)}_${Math.abs(z)}_${Date.now()}`;
  try {
    if (executor) {
      const added = await runExecutorCommand(executor, `tickingarea add circle ${x} 64 ${z} 1 ${areaName} true`);
      if (added) logDebug(`Temporary tickingarea added: ${areaName}`);
      else logDebug(`Temporary tickingarea could not be added: ${areaName}`);
    }
    return await callback();
  } finally {
    if (executor) {
      const removed = await runExecutorCommand(executor, `tickingarea remove ${areaName}`);
      if (removed) logDebug(`Temporary tickingarea removed: ${areaName}`);
      else logDebug(`Temporary tickingarea could not be removed: ${areaName}`);
    }
  }
}

async function findEventChestLocation(dimension, executor, x, z) {
  try {
    if (!dimension?.getBlock) return null;
    return await withTemporaryTickingArea(executor, x, z, async () => {
      try {
        const chunkLoaded = typeof dimension.isChunkLoaded === "function"
          ? dimension.isChunkLoaded({ x, y: 64, z })
          : true;
        if (!chunkLoaded) return null;
      } catch { }

      try {
        if (typeof dimension.getTopmostBlock === "function") {
          const topBlock = dimension.getTopmostBlock({ x, z }, -60);
          const topY = topBlock?.location?.y;
          if (typeof topY === "number" && topY >= -60 && topY <= 128) {
            const ground = dimension.getBlock({ x, y: topY, z });
            const target = dimension.getBlock({ x, y: topY + 1, z });
            const above = dimension.getBlock({ x, y: topY + 2, z });
            if (ground && target && above && !isAirBlock(ground) && !isLiquidBlock(ground) && isAirBlock(target) && isAirBlock(above)) {
              return { x, y: topY + 1, z };
            }
          }
        }
      } catch (error) {
        logError(`getTopmostBlock failed at ${x},${z}`, error);
      }

      for (let y = 128; y >= -60; y--) {
        try {
          const ground = dimension.getBlock({ x, y, z });
          const target = dimension.getBlock({ x, y: y + 1, z });
          const above = dimension.getBlock({ x, y: y + 2, z });
          if (!ground || !target || !above) continue;
          if (isAirBlock(ground) || isLiquidBlock(ground)) continue;
          if (!isAirBlock(target) || !isAirBlock(above)) continue;
          return { x, y: y + 1, z };
        } catch { }
      }
      return null;
    });
  } catch (error) {
    logError(`findEventChestLocation failed at ${x},${z}`, error);
  }
  return null;
}

async function collectLoadedEventChestCandidates(dimension, executor) {
  const candidates = [];
  try {
    for (let x = -250; x <= 250; x += 16) {
      for (let z = -250; z <= 250; z += 16) {
        try {
          const location = await findEventChestLocation(dimension, executor, x, z);
          if (location) candidates.push(location);
        } catch { }
      }
    }
  } catch (error) {
    logError("collectLoadedEventChestCandidates failed", error);
  }
  return candidates;
}

function isChestBlock(block) {
  try {
    if (!block?.typeId) return false;
    return String(block.typeId).toLowerCase().includes("chest");
  } catch {
    return false;
  }
}

function clearActiveSoulAmuletEventChest() {
  try {
    activeSoulAmuletEventChest.location = null;
    activeSoulAmuletEventChest.dimensionId = null;
  } catch { }
}

function setActiveSoulAmuletEventChest(location, dimensionId) {
  try {
    activeSoulAmuletEventChest.location = location
      ? { x: location.x, y: location.y, z: location.z }
      : null;
    activeSoulAmuletEventChest.dimensionId = dimensionId || null;
  } catch (error) {
    logError("setActiveSoulAmuletEventChest failed", error);
  }
}

function getActiveSoulAmuletEventChestDimension() {
  try {
    const dimensionId = activeSoulAmuletEventChest.dimensionId;
    if (!dimensionId) return null;
    return world.getDimension?.(dimensionId) || null;
  } catch {
    return null;
  }
}

function containerHasAnyItems(container) {
  try {
    if (!container) return false;
    for (let i = 0; i < container.size; i++) {
      try {
        if (container.getItem(i)) return true;
      } catch { }
    }
  } catch { }
  return false;
}

async function removeLootedSoulAmuletEventChest() {
  try {
    const location = activeSoulAmuletEventChest.location;
    if (!location) return false;

    const dimension = getActiveSoulAmuletEventChestDimension();
    if (!dimension) {
      clearActiveSoulAmuletEventChest();
      return false;
    }

    return await withTemporaryTickingArea(dimension, location.x, location.z, async () => {
      const block = dimension.getBlock?.(location);
      if (!isChestBlock(block)) {
        clearActiveSoulAmuletEventChest();
        return false;
      }

      const container = block.getComponent?.("minecraft:inventory")?.container;
      if (!container) return false;

      let trackedSlotItem = null;
      try {
        trackedSlotItem = container.getItem(13);
      } catch { }

      if (trackedSlotItem?.typeId === "helden:soul_amulet") return false;
      if (containerHasAnyItems(container)) return false;

      const removed = await runExecutorCommand(
        dimension,
        `setblock ${location.x} ${location.y} ${location.z} air`
      );

      const verifyBlock = dimension.getBlock?.(location);
      if (removed || isAirBlock(verifyBlock)) {
        clearActiveSoulAmuletEventChest();
        logDebug(`Removed looted event chest at ${location.x} ${location.y} ${location.z}`);
        return true;
      }

      return false;
    });
  } catch (error) {
    logError("removeLootedSoulAmuletEventChest failed", error);
  }
  return false;
}

async function placeEventChestAt(location, dimension, executor) {
  try {
    if (!location || !dimension) return false;
    return await withTemporaryTickingArea(executor, location.x, location.z, async () => {
      const setblockCommands = [
        `setblock ${location.x} ${location.y} ${location.z} minecraft:chest`,
        `setblock ${location.x} ${location.y} ${location.z} chest`,
        `setblock ${location.x} ${location.y} ${location.z} minecraft:chest [] replace`
      ];

      let placed = false;
      for (const cmd of setblockCommands) {
        const ok = await runExecutorCommand(executor, cmd);
        if (!ok) continue;

        const verifyBlock = dimension.getBlock?.(location);
        if (isChestBlock(verifyBlock)) {
          placed = true;
          break;
        }
      }

      const chestBlock = dimension.getBlock?.(location);
      if (!placed || !isChestBlock(chestBlock)) {
        logDebug(`Event chest placement verification failed at ${location.x} ${location.y} ${location.z}`);
        return false;
      }

      try {
        if ("nameTag" in chestBlock) chestBlock.nameTag = "event chest";
      } catch { }

      const container = chestBlock.getComponent?.("minecraft:inventory")?.container;
      if (container) {
        const soulAmulet = createSoulAmuletItem();
        if (soulAmulet) {
          container.setItem(13, soulAmulet);
          logDebug(`Event chest filled via inventory component at ${location.x} ${location.y} ${location.z}`);
        }
      } else {
        await runExecutorCommand(executor, `replaceitem block ${location.x} ${location.y} ${location.z} slot.container 13 helden:soul_amulet 1`);
      }

      return true;
    });
  } catch (error) {
    logError(`placeEventChestAt failed at ${location?.x} ${location?.y} ${location?.z}`, error);
    return false;
  }
}

async function spawnSoulAmuletEventChest(executor) {
  try {
    const dimension = world.getDimension?.("overworld") || world.getDimension?.("minecraft:overworld");
    if (!dimension) return null;

    const candidates = await collectLoadedEventChestCandidates(dimension, executor);
    if (candidates.length > 0) {
      logDebug(`amuletevent loaded candidates found=${candidates.length}`);
      for (let attempt = 0; attempt < Math.min(25, candidates.length); attempt++) {
        const index = randomIntInclusive(0, candidates.length - 1);
        const [location] = candidates.splice(index, 1);
        logDebug(`amuletevent loaded-candidate attempt=${attempt + 1} trying ${location.x} ${location.y} ${location.z}`);
        if (await placeEventChestAt(location, dimension, executor)) {
          setActiveSoulAmuletEventChest(location, "overworld");
          return location;
        }
      }
    }

    for (let attempt = 0; attempt < 25; attempt++) {
      const x = randomIntInclusive(-250, 250);
      const z = randomIntInclusive(-250, 250);
      const location = await findEventChestLocation(dimension, executor, x, z);
      if (!location) {
        logDebug(`amuletevent attempt=${attempt + 1} no valid surface at x=${x} z=${z}`);
        continue;
      }
      logDebug(`amuletevent attempt=${attempt + 1} trying ${location.x} ${location.y} ${location.z}`);
      if (await placeEventChestAt(location, dimension, executor)) {
        setActiveSoulAmuletEventChest(location, "overworld");
        return location;
      }
    }
  } catch (error) {
    logError("spawnSoulAmuletEventChest failed", error);
  }
  return null;
}

function announceSoulAmuletEvent(location) {
  try {
    if (!location) return false;
    const msg = `§6Event Chest§f wurde in einem 500x500 Radius um §eX:0 Z:0§f gespawnt! §7Position: §b${location.x} ${location.y} ${location.z}`;
    if (world.say) {
      world.say(msg);
      return true;
    }
    for (const player of getOnlinePlayers()) {
      try {
        player.sendMessage(msg);
      } catch { }
    }
    return true;
  } catch (error) {
    logError("announceSoulAmuletEvent failed", error);
    return false;
  }
}

function playerHasSoulAmulet(player) {
  try {
    if (!player?.getComponent) return false;
    const inv = player.getComponent("minecraft:inventory")?.container;
    if (!inv) return false;

    for (let i = 0; i < inv.size; i++) {
      try {
        const currentItem = inv.getItem(i);
        if (!currentItem) continue;
        if (currentItem.typeId === "helden:soul_amulet") return true;
      } catch { }
    }
  } catch { }
  return false;
}

function consumeSoulAmulet(player) {
  try {
    if (!player?.getComponent) return false;
    const inv = player.getComponent("minecraft:inventory")?.container;
    if (!inv) return false;

    for (let i = 0; i < inv.size; i++) {
      try {
        const currentItem = inv.getItem(i);
        if (!currentItem || currentItem.typeId !== "helden:soul_amulet") continue;

        const brokenSoulAmulet = createBrokenSoulAmuletItem();
        if (!brokenSoulAmulet) return false;

        if ((currentItem.amount || 1) > 1) {
          const nextItem = currentItem.clone ? currentItem.clone() : currentItem;
          nextItem.amount = (currentItem.amount || 1) - 1;
          inv.setItem(i, nextItem);

          let inserted = false;
          for (let j = 0; j < inv.size; j++) {
            try {
              const slotItem = inv.getItem(j);
              if (slotItem) continue;
              inv.setItem(j, brokenSoulAmulet);
              inserted = true;
              break;
            } catch { }
          }

          if (!inserted) {
            try {
              player.dimension?.spawnItem?.(brokenSoulAmulet, player.location);
              inserted = true;
            } catch (error) {
              logError(`Failed to drop broken soul amulet for ${player.name}`, error);
            }
          }

          if (!inserted) return false;
        } else {
          inv.setItem(i, brokenSoulAmulet);
        }
        logDebug(`Soul amulet consumed for ${player.name}, replaced with broken variant`);
        return true;
      } catch { }
    }
  } catch { }
  return false;
}

function markSoulAmuletSeen(playerOrName) {
  try {
    const name = typeof playerOrName === "string" ? playerOrName : playerOrName?.name;
    if (!name) return;
    recentSoulAmuletSeenAt.set(normalizeName(name), Date.now());
  } catch { }
}

function hadRecentSoulAmulet(playerOrName, maxAgeMs = 5000) {
  try {
    const name = typeof playerOrName === "string" ? playerOrName : playerOrName?.name;
    if (!name) return false;
    const ts = recentSoulAmuletSeenAt.get(normalizeName(name));
    return typeof ts === "number" && Date.now() - ts <= maxAgeMs;
  } catch {
    return false;
  }
}

function clearRecentSoulAmulet(playerOrName) {
  try {
    const name = typeof playerOrName === "string" ? playerOrName : playerOrName?.name;
    if (!name) return;
    recentSoulAmuletSeenAt.delete(normalizeName(name));
  } catch { }
}

function markCombatEnded(playerOrName) {
  try {
    const name = typeof playerOrName === "string" ? playerOrName : playerOrName?.name;
    if (!name) return;
    recentCombatEndedAt.set(normalizeName(name), Date.now());
  } catch { }
}

function endedCombatRecently(playerOrName, maxAgeMs = 1500) {
  try {
    const name = typeof playerOrName === "string" ? playerOrName : playerOrName?.name;
    if (!name) return false;
    const ts = recentCombatEndedAt.get(normalizeName(name));
    return typeof ts === "number" && Date.now() - ts <= maxAgeMs;
  } catch {
    return false;
  }
}

function clearRecentCombatEnded(playerOrName) {
  try {
    const name = typeof playerOrName === "string" ? playerOrName : playerOrName?.name;
    if (!name) return;
    recentCombatEndedAt.delete(normalizeName(name));
  } catch { }
}

function runLater(cb, ticks) {
  try {
    if (system?.runTimeout) return system.runTimeout(cb, ticks);
    if (system?.run) return system.run(cb);
  } catch { }
}

function getOnlinePlayers() {
  try {
    if (world.getAllPlayers) return world.getAllPlayers();
  } catch { }
  try {
    if (world.getPlayers) return world.getPlayers();
  } catch { }
  return [];
}

function getPlayer(nameOrPlayer) {
  try {
    if (!nameOrPlayer) return null;
    if (typeof nameOrPlayer === "object" && nameOrPlayer.name) return nameOrPlayer;
    const name = String(nameOrPlayer);
    if (world.getAllPlayers) {
      for (const p of world.getAllPlayers()) {
        try {
          if (p?.name === name) return p;
        } catch { }
      }
    }
    if (world.getPlayer) {
      try {
        return world.getPlayer(name) || null;
      } catch { }
    }
  } catch { }
  return null;
}

function sendCommandAsPlayerOrDimension(player, selfCmd, dimCmd) {
  try {
    if (player?.runCommandAsync) {
      try {
        player.runCommandAsync(selfCmd).catch(() => { });
        return true;
      } catch { }
    }
    if (player?.runCommand) {
      try {
        player.runCommand(selfCmd);
        return true;
      } catch { }
    }
    if (player?.dimension?.runCommand) {
      try {
        player.dimension.runCommand(dimCmd);
        return true;
      } catch { }
    }
    const ow = world.getDimension?.("overworld") || world.getDimension?.("minecraft:overworld");
    if (ow?.runCommand) {
      try {
        ow.runCommand(dimCmd);
        return true;
      } catch { }
    }
  } catch { }
  return false;
}

function loadHeartsFromPlayers() {
  try {
    for (const player of world.getAllPlayers ? world.getAllPlayers() : []) {
      try {
        const dp = player.getDynamicProperty?.("hearts");
        if (typeof dp === "number") hearts.set(player.name, Math.max(0, Math.min(MAX_HEARTS, dp)));
        else if (typeof dp === "string" && !isNaN(Number(dp))) hearts.set(player.name, Math.max(0, Math.min(MAX_HEARTS, Number(dp))));
      } catch { }
    }
  } catch { }
}

function saveHeartsToWorld() {
  try {
    const obj = {};
    hearts.forEach((v, k) => {
      try {
        obj[k] = Math.max(0, Math.min(MAX_HEARTS, Number(v) || 0));
      } catch { }
    });
    world.setDynamicProperty?.("helden_hearts", JSON.stringify(obj));
  } catch { }
}

function loadHeartsFromWorld() {
  try {
    const raw = world.getDynamicProperty?.("helden_hearts");
    if (!raw) return;
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!obj || typeof obj !== "object") return;
    Object.keys(obj).forEach((k) => {
      const v = Number(obj[k]);
      if (!isNaN(v)) hearts.set(k, Math.max(0, Math.min(MAX_HEARTS, v)));
    });
  } catch { }
}

function ensureHearts(name) {
  try {
    if (!hearts.has(name)) hearts.set(name, MAX_HEARTS);
  } catch { }
}

function getPlayerHeartCount(playerOrName) {
  try {
    const name = typeof playerOrName === "string" ? playerOrName : playerOrName?.name;
    if (!name) return MAX_HEARTS;
    const refreshed = refreshHeartsForPlayer(name);
    return clampHearts(refreshed);
  } catch {
    return MAX_HEARTS;
  }
}

function setPlayerHeartCount(playerOrName, value) {
  try {
    const name = typeof playerOrName === "string" ? playerOrName : playerOrName?.name;
    if (!name) return MAX_HEARTS;
    const safe = clampHearts(value);
    hearts.set(name, safe);
    try {
      saveHeartsToWorld();
    } catch { }
    const player = typeof playerOrName === "string" ? getPlayer(name) : playerOrName;
    try {
      player?.setDynamicProperty?.("hearts", safe);
    } catch { }
    propagateLinkedHearts(name, safe);
    return safe;
  } catch {
    return MAX_HEARTS;
  }
}

function getHeldItemId(player) {
  try {
    if (!player?.getComponent) return null;

    const equippable = player.getComponent("minecraft:equippable");
    if (equippable?.getEquipment) {
      try {
        const mainhandItem = equippable.getEquipment(EquipmentSlot.Mainhand);
        if (mainhandItem?.typeId) return mainhandItem.typeId;
      } catch { }
      try {
        const offhandItem = equippable.getEquipment(EquipmentSlot.Offhand);
        if (offhandItem?.typeId) return offhandItem.typeId;
      } catch { }
    }

    const inv = player.getComponent("minecraft:inventory")?.container;
    if (!inv) return null;

    const slot = typeof player.selectedSlot === "number"
      ? player.selectedSlot
      : (typeof player.selectedSlotIndex === "number" ? player.selectedSlotIndex : 0);
    const selectedItem = inv.getItem?.(slot);
    if (selectedItem?.typeId) return selectedItem.typeId;

    const hotbarLimit = Math.min(inv.size, 8);
    for (let i = 0; i < hotbarLimit; i++) {
      try {
        const item = inv.getItem?.(i);
        if (item?.typeId) return item.typeId;
      } catch { }
    }
    return null;
  } catch {
    return null;
  }
}

function refreshHeartsForPlayer(playerOrName) {
  try {
    loadHeartsFromWorld();
    loadHeartsFromPlayers();
    const player = getPlayer(playerOrName);
    const name = player?.name ? player.name : String(playerOrName || "");
    if (!name) return MAX_HEARTS;
    let value = null;
    if (player) {
      try {
        const dp = player.getDynamicProperty?.("hearts");
        if (typeof dp === "number") value = dp;
        else if (typeof dp === "string" && !isNaN(Number(dp))) value = Number(dp);
      } catch { }
    }
    if (player) {
      try {
        const pending = readJsonProp(PENDING_HEARTS_PROP, {});
        if (Object.prototype.hasOwnProperty.call(pending, name)) {
          value = clampHearts(pending[name]);
          delete pending[name];
          writeJsonProp(PENDING_HEARTS_PROP, pending);
          if (value <= 0) {
            runLater(() => {
              try {
                const target = getPlayer(name);
                if (target) {
                  sendCommandAsPlayerOrDimension(
                    target,
                    "gamemode spectator @s",
                    `gamemode spectator @a[name="${selectorName(name)}"]`
                  );
                }
              } catch { }
            }, 40);
          }
        }
      } catch { }
    }
    if (value === null && hearts.has(name)) value = hearts.get(name);
    if (value === null) value = MAX_HEARTS;
    const safe = clampHearts(value);
    hearts.set(name, safe);
    try {
      player?.setDynamicProperty?.("hearts", safe);
    } catch { }
    try {
      saveHeartsToWorld();
    } catch { }
    return safe;
  } catch {
    return MAX_HEARTS;
  }
}

function getCombatTagTicks() {
  try {
    const raw = world.getDynamicProperty?.("helden_config");
    const cfg = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : {};
    const secs = cfg && (typeof cfg.combat_tag_seconds === "number" || typeof cfg.combat_tag_seconds === "string")
      ? Number(cfg.combat_tag_seconds)
      : DEFAULT_COMBAT_SECONDS;
    return Math.max(1, Math.floor(secs)) * 20;
  } catch {
    return DEFAULT_COMBAT_SECONDS * 20;
  }
}

function getCombatRemainingMs(name) {
  try {
    const expiry = combatTaggedPlayers.get(normalizeName(name));
    if (!expiry || typeof expiry !== "number") return 0;
    return Math.max(0, expiry - Date.now());
  } catch {
    return 0;
  }
}

function getCombatRemainingSeconds(name) {
  try {
    const ms = getCombatRemainingMs(name);
    return ms > 0 ? Math.ceil(ms / 1000) : 0;
  } catch {
    return 0;
  }
}

function getDefaultPlaytimeMs() {
  try {
    const raw = world.getDynamicProperty?.("helden_config");
    const cfg = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : {};
    const secs = cfg && (typeof cfg.playtime_seconds === "number" || typeof cfg.playtime_seconds === "string")
      ? Number(cfg.playtime_seconds)
      : DEFAULT_PLAYTIME_SECONDS;
    return Math.max(1, Math.floor(secs)) * 1000;
  } catch {
    return DEFAULT_PLAYTIME_SECONDS * 1000;
  }
}

// ===== Playtime: Tagesbudget mit Übertrag =====
// Jeder Spieler bekommt pro Tag die eingestellte Playtime (Standard 3 Stunden). Wer an einem Tag nicht oder
// nur kurz spielt, bekommt die ungenutzte Zeit mit dem neuen Tag dazu, höchstens aber PLAYTIME_MAX_DAYS Tage
// (Standard: 3 x 3 Stunden = 9 Stunden). Ein neuer Tag beginnt um Mitternacht deutscher Zeit (Europa/Berlin).
const PLAYTIME_MAX_DAYS = 3;
const PLAYTIME_STORE_PROP = "helden_playtime";
const PLAYTIME_SAVE_EVERY_SECONDS = 30;
const PLAYTIME_MAX_STEP_MS = 5000;
let playtimeStore = null;
let playtimeSaveCounter = 0;

// EU-Sommerzeit: vom letzten Sonntag im März bis zum letzten Sonntag im Oktober, jeweils 01:00 UTC.
function berlinOffsetMs(utcMs) {
  const year = new Date(utcMs).getUTCFullYear();
  const lastSunday = (month) => {
    const d = new Date(Date.UTC(year, month + 1, 0, 1));
    d.setUTCDate(d.getUTCDate() - d.getUTCDay());
    return d.getTime();
  };
  const summer = utcMs >= lastSunday(2) && utcMs < lastSunday(9);
  return (summer ? 2 : 1) * 3600000;
}

function playtimeDayKey(utcMs = Date.now()) {
  const t = new Date(utcMs + berlinOffsetMs(utcMs));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

function playtimeDayNumber(key) {
  const [y, m, d] = String(key).split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

function getPlaytimeCapMs() {
  return getDefaultPlaytimeMs() * PLAYTIME_MAX_DAYS;
}

function loadPlaytimeStore() {
  if (!playtimeStore) playtimeStore = readJsonProp(PLAYTIME_STORE_PROP, {});
  return playtimeStore;
}

function savePlaytimeStore() {
  try {
    const store = loadPlaytimeStore();
    for (const [key, ms] of playtimeRemainingMsByPlayer) {
      const day = playtimeDayByPlayer.get(key);
      if (day) store[key] = { ms: Math.max(0, Math.floor(ms)), day };
    }
    writeJsonProp(PLAYTIME_STORE_PROP, store);
  } catch (error) {
    logError("savePlaytimeStore failed", error);
  }
}

// Neuer Tag: pro vergangenem Tag kommt die Tages-Playtime dazu, gedeckelt auf das Maximum.
function rolloverPlaytime(key, today) {
  const day = playtimeDayByPlayer.get(key);
  if (!day || day === today) return;
  const passed = playtimeDayNumber(today) - playtimeDayNumber(day);
  if (passed > 0) {
    const daily = getDefaultPlaytimeMs();
    const cur = playtimeRemainingMsByPlayer.get(key) || 0;
    playtimeRemainingMsByPlayer.set(key, Math.min(getPlaytimeCapMs(), cur + passed * daily));
    timeUpKicked.delete(key);
    timeUpKickTry.delete(key);
  }
  playtimeDayByPlayer.set(key, today);
  savePlaytimeStore();
}

function ensurePlaytimeFor(name) {
  const key = normalizeName(name);
  if (playtimeRemainingMsByPlayer.has(key)) return;
  const today = playtimeDayKey();
  const entry = loadPlaytimeStore()[key];
  if (entry && typeof entry.ms === "number" && typeof entry.day === "string") {
    playtimeRemainingMsByPlayer.set(key, entry.ms);
    playtimeDayByPlayer.set(key, entry.day);
    rolloverPlaytime(key, today);
  } else {
    playtimeRemainingMsByPlayer.set(key, getDefaultPlaytimeMs());
    playtimeDayByPlayer.set(key, today);
  }
}

// Spieler hat den Server verlassen: Stand sichern und aus dem Laufzeit-Speicher nehmen.
function releasePlaytime(name) {
  const key = normalizeName(name);
  savePlaytimeStore();
  playtimeRemainingMsByPlayer.delete(key);
  playtimeDayByPlayer.delete(key);
  playtimeLastTickAt.delete(key);
}

// Beim Verlassen sofort sichern, damit ein direkter Rejoin den exakten Stand findet.
function subscribePlaytimeLeave() {
  try {
    const ev = world.afterEvents?.playerLeave || world.events?.playerLeave;
    if (!ev) return;
    ev.subscribe((evt) => {
      try {
        if (evt?.playerName) releasePlaytime(evt.playerName);
      } catch (error) {
        logError("playtime leave failed", error);
      }
    });
  } catch { }
}

function getPlaytimeRemainingSeconds(name) {
  const key = normalizeName(name);
  const ms = playtimeRemainingMsByPlayer.get(key);
  if (typeof ms !== "number") return 0;
  return Math.max(0, Math.ceil(ms / 1000));
}

function tickPlaytimeSecond() {
  const today = playtimeDayKey();
  for (const p of getOnlinePlayers()) {
    const key = normalizeName(p.name);
    ensurePlaytimeFor(p.name);
    rolloverPlaytime(key, today);
    // Abgezogen wird die tatsächlich vergangene Zeit (nicht pauschal 1 s pro Tick). Bei Server-Lags oder
    // kurzen Hängern beim Join/Leave läuft die Playtime so nicht zu langsam. Pro Schritt maximal 5 s.
    const nowMs = Date.now();
    const lastMs = playtimeLastTickAt.get(key);
    const elapsed = lastMs === undefined ? 1000 : Math.max(0, Math.min(PLAYTIME_MAX_STEP_MS, nowMs - lastMs));
    playtimeLastTickAt.set(key, nowMs);
    const cur = playtimeRemainingMsByPlayer.get(key) || 0;
    playtimeRemainingMsByPlayer.set(key, Math.max(0, cur - elapsed));
  }
  playtimeSaveCounter += 1;
  if (playtimeSaveCounter >= PLAYTIME_SAVE_EVERY_SECONDS) {
    playtimeSaveCounter = 0;
    savePlaytimeStore();
  }
}

// Spielzeit abgelaufen: Spieler kicken. Schlägt der Kick fehl oder bleibt der Spieler online, wird alle
// 5 Sekunden erneut versucht, bis er weg ist.
const timeUpKickTry = new Map();
const TIME_UP_KICK_RETRY_MS = 5000;

function kickIfPlaytimeExpired(p, remaining) {
  try {
    if (!p?.name || remaining > 0) return;
    const key = normalizeName(p.name);
    const now = Date.now();
    if (now - (timeUpKickTry.get(key) || 0) < TIME_UP_KICK_RETRY_MS) return;
    timeUpKickTry.set(key, now);

    if (!timeUpKicked.has(key)) {
      timeUpKicked.add(key);
      try {
        p.sendMessage?.(`§cDeine Spielzeit für heute ist aufgebraucht. Du wirst gekickt. Mit jedem neuen Tag kommen ${formatHMS(getDefaultPlaytimeMs() / 1000)} dazu (maximal ${formatHMS(getPlaytimeCapMs() / 1000)}).`);
      } catch { }
    }

    const name = p.name;
    runLater(() => {
      try {
        const target = getPlayer(name);
        if (!target) return;
        const reason = "Deine Spielzeit fuer heute ist aufgebraucht";
        sendCommandAsPlayerOrDimension(target, `kick @s ${reason}`, `kick @a[name="${selectorName(name)}"] ${reason}`);
      } catch (error) {
        logError(`Failed to kick time-expired player ${name}`, error);
      }
    }, 4);
  } catch (error) {
    logError(`time-expiry check failed for ${p?.name || "unknown"}`, error);
  }
}

function sendTitlePlain(player, message) {
  try {
    const selfCmd = `title @s title ${message}`;
    const dimCmd = `title @a[name="${selectorName(player.name)}"] title ${message}`;
    return sendCommandAsPlayerOrDimension(player, selfCmd, dimCmd);
  } catch {
    return false;
  }
}

function clearCombatTitle(player) {
  try {
    if (!player) return false;
    const selfCmd = "title @s title 0:0";
    const dimCmd = `title @a[name="${selectorName(player.name)}"] title 0:0`;
    return sendCommandAsPlayerOrDimension(player, selfCmd, dimCmd);
  } catch {
    return false;
  }
}

function clearTopTimeTitle(player) {
  try {
    if (!player) return false;
    const selfCmd = "title @s title update_time";
    const dimCmd = `title @a[name="${selectorName(player.name)}"] title update_time`;
    return sendCommandAsPlayerOrDimension(player, selfCmd, dimCmd);
  } catch {
    return false;
  }
}

function hardClearCombatVisualState(player) {
  try {
    if (!player) return false;
    try {
      player.removeTag?.("in_combat");
    } catch { }
    clearCombatTitle(player);
    return true;
  } catch {
    return false;
  }
}

function updateCombatTitle(player, seconds) {
  try {
    if (!player) return false;
    if (!seconds || Number(seconds) <= 0) return clearCombatTitle(player);
    const secNum = Number(seconds) || 0;
    const msg = `§cIm Kampf§7(${secNum}s übrig) update_combat`;
    return sendTitlePlain(player, msg);
  } catch {
    return false;
  }
}

// Die Playtime wird nicht mehr als Title angezeigt, sondern per /helden:time abgefragt.
// Die Funktion bleibt als Platzhalter, damit die bestehenden Aufrufe weiter funktionieren.
function updateTopTimeTitle() {
  return false;
}

function formatHMS(totalSeconds) {
  const total = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function setCombatOpponents(a, b) {
  try {
    if (!a || !b) return;
    combatOpponentByPlayer.set(normalizeName(a), b);
    combatOpponentByPlayer.set(normalizeName(b), a);
  } catch { }
}

function getCombatOpponent(name) {
  try {
    return combatOpponentByPlayer.get(normalizeName(name)) || null;
  } catch {
    return null;
  }
}

function removeCombatState(name) {
  try {
    if (!name) return;
    const key = normalizeName(name);
    logDebug(`removeCombatState start player=${name} key=${key}`);
    combatTaggedPlayers.delete(key);
    combatKeyToName.delete(key);
    combatZeroSent.delete(key);
    combatOpponentByPlayer.delete(key);
    for (const [k, v] of Array.from(combatOpponentByPlayer.entries())) {
      try {
        if (normalizeName(v) === key) combatOpponentByPlayer.delete(k);
      } catch { }
    }
    const player = getPlayer(name);
    if (player) {
      hardClearCombatVisualState(player);
      logDebug(`removeCombatState player object cleared for ${name}`);
    } else {
      logDebug(`removeCombatState no live player object for ${name}, cleared map state only`);
    }
  } catch (error) {
    logError(`removeCombatState failed for ${name}`, error);
  }
}

function tagInCombat(name) {
  try {
    if (!name) return;
    const key = normalizeName(name);
    clearRecentCombatEnded(name);
    const expiry = Date.now() + (getCombatTagTicks() * 50);
    combatTaggedPlayers.set(key, expiry);
    combatKeyToName.set(key, name);
    combatZeroSent.delete(key);
    const pl = getPlayer(name);
    if (pl?.addTag) {
      try {
        pl.addTag("in_combat");
      } catch { }
    }
    if (pl) updateCombatTitle(pl, getCombatRemainingSeconds(name));
    logDebug(`tagInCombat player=${name} expiresInMs=${Math.max(0, expiry - Date.now())}`);
  } catch (error) {
    logError(`tagInCombat failed for ${name}`, error);
  }
}

function forceActionbar(player, token) {
  return new Promise((resolve) => {
    try {
      if (!player) return resolve(false);
      const payload = String(token || "").replace(/"/g, "");
      const selfCmd = `title @s actionbar ${payload}`;
      const dimCmd = `title @a[name="${selectorName(player.name)}"] actionbar ${payload}`;
      const ok = sendCommandAsPlayerOrDimension(player, selfCmd, dimCmd);
      resolve(!!ok);
      return;
    } catch { }
    resolve(false);
  });
}

function updateHudActionbar(player) {
  try {
    if (!player) return false;

    const h = Math.max(0, Math.min(MAX_HEARTS, Number(refreshHeartsForPlayer(player)) || MAX_HEARTS));
    forceActionbar(player, `heart${h}`).catch(() => { });
    return true;
  } catch {
    return false;
  }
}

function showHearts(player) {
  try {
    return updateHudActionbar(player);
  } catch {
    return false;
  }
}

function tryPlayerKill(player) {
  try {
    if (!player) return false;
    if (player.runCommandAsync) {
      try {
        player.runCommandAsync("kill @s").catch(() => { });
        return true;
      } catch { }
    }
    if (player.runCommand) {
      try {
        player.runCommand("kill @s");
        return true;
      } catch { }
    }
    const dim = player.dimension || world.getDimension?.("overworld") || world.getDimension?.("minecraft:overworld");
    if (dim?.runCommand) {
      try {
        dim.runCommand(`kill @a[name="${selectorName(player.name)}"]`);
        return true;
      } catch { }
    }
  } catch { }
  return false;
}

function broadcastDeathMessage(playerName, killerName) {
  try {
    const txt = killerName
      ? `${playerName} wurde von ${killerName} getötet (-1 Herz)`
      : `${playerName} ist gestorben (-1 Herz)`;
    if (world.say) {
      try {
        world.say(txt);
        return;
      } catch { }
    }
    for (const p of getOnlinePlayers()) {
      try {
        p.sendMessage(txt);
      } catch { }
    }
  } catch { }
}

async function handlePlayerDeath(playerName, killerName, cause) {
  if (!playerName) return;
  if (recentDeaths.has(playerName)) return;
  try {
    recentDeaths.add(playerName);
    runLater(() => recentDeaths.delete(playerName), 20);
  } catch { }

  let wasInCombat = false;
  const p = getPlayer(playerName);
  const norm = normalizeName(playerName);

  // Mit dem Tod endet der Kampf: Armor-Lock und Pearl-Zähler zurücksetzen.
  clearArmorLock(playerName);
  pearlCounts.delete(playerName);
  armorState.delete(playerName);
  armorInvSnapshot.delete(playerName);
  armorRemoved.delete(playerName);

  try {
    wasInCombat = getCombatRemainingMs(playerName) > 0;
    if (!wasInCombat && p?.hasTag) {
      try {
        if (p.hasTag("in_combat")) wasInCombat = true;
      } catch { }
    }
    if (!wasInCombat && killerName) wasInCombat = true;
    if (!wasInCombat) {
      const rec = lastDamager.get(norm) || lastDamager.get(playerName);
      if (rec?.ts && Date.now() - rec.ts <= 15000) wasInCombat = true;
    }
    if (cause === "Combat-Logout") wasInCombat = true;
  } catch { }

  logDebug(`handlePlayerDeath player=${playerName} killer=${killerName || "none"} cause=${cause || "unknown"} wasInCombat=${wasInCombat}`);

  if (!wasInCombat) {
    removeCombatState(playerName);
    return;
  }

  if (killerName && isLinkedPair(playerName, killerName)) {
    removeCombatState(playerName);
    removeCombatState(killerName);
    broadcastMessage(`§d${killerName}§7 hat seinen verlinkten Partner §d${playerName}§7 getötet – es wird kein Herz abgezogen.`);
    if (p) updateHudActionbar(p);
    return;
  }

  if (getActiveMode() === 3) {
    let bountyKiller = killerName || null;
    if (!bountyKiller && cause === "Combat-Logout") {
      const rec = lastDamager.get(norm) || lastDamager.get(playerName);
      const maxAgeMs = Math.max(60000, (getCombatTagTicks() / 20) * 1000 + 10000);
      if (rec?.name && rec.ts && Date.now() - rec.ts <= maxAgeMs) bountyKiller = rec.name;
      if (!bountyKiller) bountyKiller = getCombatOpponent(playerName);
    }
    if (bountyKiller && payoutBounty(playerName, bountyKiller)) {
      // Spieler mit Kopfgeld stirbt (Kill oder Combat-Logout): kein Herzverlust.
      removeCombatState(playerName);
      removeCombatState(bountyKiller);
      clearRecentSoulAmulet(playerName);
      if (p) updateHudActionbar(p);
      return;
    }
  }

  const consumedSoulAmuletDirectly = !!(p && playerHasSoulAmulet(p) && consumeSoulAmulet(p));
  const savedBySoulAmuletViaRecentPickup = !consumedSoulAmuletDirectly && hadRecentSoulAmulet(playerName);
  const savedBySoulAmulet = !!(consumedSoulAmuletDirectly || savedBySoulAmuletViaRecentPickup);

  if (savedBySoulAmulet) {
    if (savedBySoulAmuletViaRecentPickup) {
      queueBrokenSoulAmuletConversion(1);
      logDebug(`Queued post-pickup broken conversion for used soul amulet from ${playerName}`);
    }
    logDebug(`Soul Amulet saved ${playerName}`);
    clearRecentSoulAmulet(playerName);
    removeCombatState(playerName);
    if (killerName) removeCombatState(killerName);
    try {
      const txt = `§b${playerName} §7wurde durch ein Soul Amulet gerettet und hat kein Herz verloren!`;
      if (world.say) world.say(txt);
      else {
        for (const online of getOnlinePlayers()) online.sendMessage(txt);
      }
    } catch { }
    if (p) updateHudActionbar(p);
    return;
  }

  ensureHearts(playerName);
  const cur = Number(hearts.get(playerName) ?? refreshHeartsForPlayer(playerName));
  const remaining = Math.max(0, cur - 1);
  logDebug(`Applying heart loss to ${playerName}: ${cur} -> ${remaining}`);
  setPlayerHeartCount(p || playerName, remaining);

  if (p) updateHudActionbar(p);

  removeCombatState(playerName);
  if (killerName) removeCombatState(killerName);
  clearRecentSoulAmulet(playerName);
  if (p) {
    runLater(() => {
      try {
        hardClearCombatVisualState(p);
        logDebug(`Post-death hard combat clear for ${playerName}`);
      } catch (error) {
        logError(`Post-death hard combat clear failed for ${playerName}`, error);
      }
    }, 1);
  }

  broadcastDeathMessage(playerName, killerName);
  try {
    if (getActiveMode() === 2) {
      const partnerName = getLinkedPartner(playerName);
      if (partnerName) {
        broadcastMessage(`§d${partnerName}§7 verliert durch die Verlinkung mit §d${playerName}§7 ebenfalls ein Herz. (§f${remaining}§7 übrig)`);
      }
    }
  } catch { }

  if (remaining <= 0) {
    try {
      const target = p || getPlayer(playerName);
      if (target) {
        sendCommandAsPlayerOrDimension(
          target,
          "gamemode spectator @s",
          `gamemode spectator @a[name="${selectorName(playerName)}"]`
        );
      }
    } catch { }
  }
}

function applyCombatLogoutPenalty(player) {
  try {
    if (!player?.name) return;
    if (combatPenaltyKillIssued.has(player.name)) return;
    combatPenaltyKillIssued.add(player.name);
    combatLoggedPlayers.set(player.name, -1);
    refreshHeartsForPlayer(player);
    handlePlayerDeath(player.name, null, "Combat-Logout").catch(() => { });
    tryPlayerKill(player);
    removeCombatState(player.name);
    runLater(() => {
      try {
        if (combatLoggedPlayers.get(player.name) === -1) combatLoggedPlayers.delete(player.name);
      } catch { }
    }, 40);
    runLater(() => {
      try {
        combatPenaltyKillIssued.delete(player.name);
      } catch { }
    }, 100);
  } catch { }
}

function attemptCombatLogoutPenalty(playerName, attemptsLeft) {
  try {
    if (!playerName) return;
    const marker = combatLoggedPlayers.get(playerName);
    if (!combatLoggedPlayers.has(playerName) || marker === -1) return;

    const player = getPlayer(playerName);
    if (!player) {
      if (attemptsLeft > 0) runLater(() => {
        try {
          attemptCombatLogoutPenalty(playerName, attemptsLeft - 1);
        } catch { }
      }, 10);
      return;
    }
    if (attemptsLeft > 0) {
      runLater(() => {
        try {
          if (combatLoggedPlayers.has(playerName) && combatLoggedPlayers.get(playerName) !== -1) applyCombatLogoutPenalty(player);
        } catch { }
      }, 4);
      return;
    }
    applyCombatLogoutPenalty(player);
  } catch { }
}

function updateHudOnCameraRotation(player) {
  if (!player?.name) return;
  if (cameraRotatedOnce.has(player.name)) return;
  try {
    refreshHeartsForPlayer(player);
    updateHudActionbar(player);
    ensurePlaytimeFor(player.name);
    updateTopTimeTitle(player, getPlaytimeRemainingSeconds(player.name));

    if (getCombatRemainingMs(player.name) > 0) updateCombatTitle(player, getCombatRemainingSeconds(player.name));
    else clearCombatTitle(player);

    cameraRotatedOnce.add(player.name);

    if (combatLoggedPlayers.has(player.name) && combatLoggedPlayers.get(player.name) !== -1) {
      attemptCombatLogoutPenalty(player.name, 40);
    }
  } catch { }
}

function updateHudOnJoin(player) {
  if (!player?.name) return;
  try {
    clearRecentSoulAmulet(player.name);
    clearRecentCombatEnded(player.name);
    hardClearCombatVisualState(player);
    removeCombatState(player.name);
    refreshSoulAmuletLoreInInventory(player);
    refreshHeartsForPlayer(player);
    updateHudActionbar(player);
    notifyModeInfoOnJoin(player);
    tryLinkPlayer(player.name);
    tryPairBountyPlayer(player.name);
    applyDummyJoinState(player);
    ensurePlaytimeFor(player.name);
    updateTopTimeTitle(player, getPlaytimeRemainingSeconds(player.name));

    if (getCombatRemainingMs(player.name) > 0) updateCombatTitle(player, getCombatRemainingSeconds(player.name));
    else clearCombatTitle(player);

    cameraRotatedOnce.delete(player.name);
    firstSeenTimeByPlayer.set(player.name, Date.now());
    timeUpKicked.delete(normalizeName(player.name));
    timeUpKickTry.delete(normalizeName(player.name));
    logDebug(`updateHudOnJoin completed for ${player.name}`);
  } catch (error) {
    logError(`updateHudOnJoin failed for ${player?.name || "unknown"}`, error);
  }
}

try {
  system.runInterval(() => {
    try {
      const players = getOnlinePlayers();
      const currentNames = new Set(players.map((p) => p?.name).filter(Boolean));

      currentNames.forEach((n) => {
        if (!knownPlayers.has(n)) {
          const pl = players.find((x) => x.name === n);
          if (pl) {
            knownPlayers.add(n);
            updateHudOnJoin(pl);
          }
        }
      });

      players.forEach((p) => {
        try {
          if (!p?.name) return;
          const rot = p.rotation;
          const key = p.name;
          const now = Date.now();

          if (!lastRotationByPlayer.has(key)) {
            lastRotationByPlayer.set(key, { x: rot?.x || 0, y: rot?.y || 0 });
            if (!firstSeenTimeByPlayer.has(key)) firstSeenTimeByPlayer.set(key, now);
            return;
          }
          if (cameraRotatedOnce.has(key)) {
            lastRotationByPlayer.set(key, { x: rot?.x || 0, y: rot?.y || 0 });
            return;
          }

          const last = lastRotationByPlayer.get(key);
          const dx = typeof rot?.x === "number" ? Math.abs(rot.x - last.x) : 0;
          const dy = typeof rot?.y === "number" ? Math.abs(rot.y - last.y) : 0;
          let rotationDetected = dx > 0.05 || dy > 0.05;

          try {
            if (!rotationDetected && typeof p.getBlockFromViewDirection === "function") {
              const looked = p.getBlockFromViewDirection();
              const blk = looked?.block
                ? `${looked.block.location.x},${looked.block.location.y},${looked.block.location.z}`
                : null;
              const lastBlk = lastViewBlockByPlayer.get(key) || null;
              if (blk !== lastBlk && lastBlk !== null) rotationDetected = true;
              lastViewBlockByPlayer.set(key, blk);
            }
          } catch { }

          const firstSeen = firstSeenTimeByPlayer.get(key) || now;
          if (rotationDetected && now - firstSeen > 250) updateHudOnCameraRotation(p);
          lastRotationByPlayer.set(key, { x: rot?.x || 0, y: rot?.y || 0 });
        } catch { }
      });

      Array.from(knownPlayers).forEach((n) => {
        if (!currentNames.has(n)) {
          knownPlayers.delete(n);
          cameraRotatedOnce.delete(n);
          firstSeenTimeByPlayer.delete(n);
          lastRotationByPlayer.delete(n);
          lastViewBlockByPlayer.delete(n);
          releasePlaytime(n);
        }
      });
    } catch { }
  }, 10);
} catch { }

// ===== Events =====
function subscribeDamage() {
  try {
    const ev = world.afterEvents?.entityHurt || world.events?.entityHurt;
    if (!ev) return;
    ev.subscribe((evt) => {
      try {
        const victim = evt.hurtEntity || evt.entity || evt.player || evt.affectedEntity;
        const src = evt.damageSource?.damagingEntity || evt.source?.damagingEntity || evt.attacker;
        const vName = victim?.name;
        const sName = src?.name;
        if (!vName || !sName || vName === sName) return;
        const pv = getPlayer(vName);
        const ps = getPlayer(sName);
        if (!pv || !ps) return;

        if (isLinkedPair(vName, sName)) {
          healLinkedHit(pv, evt.damage);
          warnLinkedAttack(sName);
          return;
        }

        if (playerHasSoulAmulet(pv)) markSoulAmuletSeen(vName);
        logDebug(`entityHurt victim=${vName} attacker=${sName} victimHasAmulet=${playerHasSoulAmulet(pv)}`);

        ensureHearts(vName);
        ensureHearts(sName);

        const heldItemId = getHeldItemId(ps);
        const attackerHeartCount = getPlayerHeartCount(ps);
        const victimHeartCount = getPlayerHeartCount(pv);
        if (heldItemId === "helden:soul_stealer" && attackerHeartCount < MAX_HEARTS && victimHeartCount > 0) {
          const nextAttackerHearts = Math.min(MAX_HEARTS, attackerHeartCount + 1);
          const nextVictimHearts = Math.max(0, victimHeartCount - 1);
          setPlayerHeartCount(ps, nextAttackerHearts);
          setPlayerHeartCount(pv, nextVictimHearts);
          try {
            updateHudActionbar(ps);
            updateHudActionbar(pv);
          } catch { }
          logDebug(`Soul stealer triggered: attacker=${sName} hearts ${attackerHeartCount}->${nextAttackerHearts} victim=${vName} hearts ${victimHeartCount}->${nextVictimHearts}`);
        }

        lastDamager.set(normalizeName(vName), { name: sName, ts: Date.now() });
        setCombatOpponents(vName, sName);
        tagInCombat(vName);
        tagInCombat(sName);

        updateCombatTitle(pv, getCombatRemainingSeconds(vName));
        updateCombatTitle(ps, getCombatRemainingSeconds(sName));
      } catch { }
    });
  } catch { }
}

function subscribeJoin() {
  try {
    const ev = world.afterEvents?.playerJoin || world.beforeEvents?.playerJoin || world.events?.playerJoin;
    if (!ev) return;
    ev.subscribe((evt) => {
      try {
        const player = evt.player || evt.playerEntity;
        if (!player) return;
        clearRecentSoulAmulet(player.name);
        clearRecentCombatEnded(player.name);
        hardClearCombatVisualState(player);
        refreshSoulAmuletLoreInInventory(player);
        refreshHeartsForPlayer(player);
        updateHudActionbar(player);
        ensurePlaytimeFor(player.name);
        updateTopTimeTitle(player, getPlaytimeRemainingSeconds(player.name));

        if (getCombatRemainingMs(player.name) > 0) updateCombatTitle(player, getCombatRemainingSeconds(player.name));
        else clearCombatTitle(player);

        if (combatLoggedPlayers.has(player.name) && combatLoggedPlayers.get(player.name) !== -1) {
          attemptCombatLogoutPenalty(player.name, 40);
        }
        logDebug(`playerJoin ${player.name}`);
      } catch (error) {
        logError("playerJoin handler failed", error);
      }
    });
  } catch { }
}

// ===== Todes-Effekt: Blitz (nur visuell) + Dreizack-Donner + Crit-Sound =====
// Der echte Blitz (lightning_bolt) verletzt und entzündet alles in der Nähe und lässt sich per Script
// nicht entschärfen. Deshalb wird der Blitz aus Partikeln gezeichnet. Auf true setzen, falls ein echter
// Blitz gewünscht ist (Achtung: Schaden/Feuer für Killer und Umgebung).
const DEATH_EFFECT_USE_REAL_LIGHTNING = false;
const DEATH_EFFECT_SOUNDS = ["item.trident.thunder", "game.player.attack.crit"];
const DEATH_EFFECT_VOLUME = 3;
const DEATH_EFFECT_BOLT_HEIGHT = 24;
const deathEffectAt = new Map();

function playSoundAt(dimension, soundId, loc, volume, pitch) {
  try {
    dimension.playSound(soundId, loc, { volume, pitch });
    return true;
  } catch { }
  try {
    dimension.runCommand(`playsound ${soundId} @a ${loc.x.toFixed(2)} ${loc.y.toFixed(2)} ${loc.z.toFixed(2)} ${volume} ${pitch}`);
    return true;
  } catch (error) {
    logError(`playSoundAt failed for ${soundId}`, error);
    return false;
  }
}

function spawnParticleSafe(dimension, id, loc) {
  try {
    dimension.spawnParticle(id, loc);
  } catch { }
}

function drawVisualBolt(dimension, loc) {
  const top = loc.y + DEATH_EFFECT_BOLT_HEIGHT;
  for (let y = top; y >= loc.y; y -= 0.6) {
    // Je näher am Boden, desto weniger Zickzack, damit der Blitz genau am Todesort einschlägt.
    const spread = 1.2 * Math.min(1, (y - loc.y) / 6);
    const pos = {
      x: loc.x + (Math.random() - 0.5) * spread,
      y,
      z: loc.z + (Math.random() - 0.5) * spread
    };
    spawnParticleSafe(dimension, "minecraft:end_rod", pos);
    spawnParticleSafe(dimension, "minecraft:electric_spark_particle", pos);
  }
  for (let i = 0; i < 8; i++) {
    spawnParticleSafe(dimension, "minecraft:electric_spark_particle", {
      x: loc.x + (Math.random() - 0.5) * 1.6,
      y: loc.y + Math.random() * 1.2,
      z: loc.z + (Math.random() - 0.5) * 1.6
    });
  }
}

// Beide Sounds und der Blitz laufen im selben Tick, also gleichzeitig.
function playDeathLightningEffect(entity) {
  try {
    const name = entity?.name || "unknown";
    const now = Date.now();
    if (now - (deathEffectAt.get(name) || 0) < 1000) return;
    deathEffectAt.set(name, now);

    const dimension = entity?.dimension;
    const loc = entity?.location;
    if (!dimension || !loc) return;

    for (const soundId of DEATH_EFFECT_SOUNDS) playSoundAt(dimension, soundId, loc, DEATH_EFFECT_VOLUME, 1);

    if (DEATH_EFFECT_USE_REAL_LIGHTNING) {
      try {
        dimension.spawnEntity("minecraft:lightning_bolt", loc);
      } catch (error) {
        logError("spawn lightning_bolt failed", error);
      }
    } else {
      drawVisualBolt(dimension, loc);
    }
  } catch (error) {
    logError("playDeathLightningEffect failed", error);
  }
}

function subscribeDeath() {
  try {
    const ev = world.afterEvents?.entityDie || world.events?.entityDie || world.afterEvents?.entityDeath;
    if (!ev) return;
    ev.subscribe((evt) => {
      try {
        const ent = evt.deadEntity || evt.hurtEntity || evt.entity || evt.player || evt.playerEntity;
        if (!ent?.name) return;
        const name = ent.name;
        const killer = evt.damageSource?.damagingEntity || evt.source?.damagingEntity || evt.attacker;
        const kname = killer?.name;
        const playerObj = getPlayer(name);
        if (playerObj || (ent?.__identifier && String(ent.__identifier).toLowerCase().includes("player"))) {
          logDebug(`entityDie player=${name} killer=${kname || "none"}`);
          playDeathLightningEffect(ent);
          handlePlayerDeath(name, kname, "death").catch(() => { });
        }
      } catch (error) {
        logError("entityDie handler failed", error);
      }
    });
  } catch { }
}

function subscribeCombatLogout() {
  try {
    const ev = world.afterEvents?.playerLeave || world.events?.playerLeave;
    if (!ev) return;
    ev.subscribe((evt) => {
      try {
        const name = evt.playerName || evt.player?.name || null;
        if (!name) return;
        const leaveKey = normalizeName(name);
        if (combatTaggedPlayers.has(leaveKey) || getCombatRemainingMs(name) > 0) {
          const opponentName = getCombatOpponent(name);
          const dummyTakesOver = dummyLeavePending.has(name);
          if (!dummyTakesOver) combatLoggedPlayers.set(name, Date.now());
          removeCombatState(name);
          if (opponentName) removeCombatState(opponentName);
          logDebug(`combatLogout player=${name} opponent=${opponentName || "none"} dummy=${dummyTakesOver}`);
          const txt = dummyTakesOver
            ? `§c${name} §fhat das Spiel während des Combats verlassen. Sein Dummy bleibt ${DUMMY_LIFETIME_MS / 1000} Sekunden – wird er getötet, verliert er ein Herz!`
            : `§c${name} §fhat das Spiel während des Combats verlassen, dadurch verliert dieser Spieler nun ein Herz!`;
          try {
            world.say?.(txt);
          } catch { }
        }
      } catch (error) {
        logError("playerLeave handler failed", error);
      }
    });
  } catch { }
}

function subscribeRespawn() {
  try {
    const ev = world.afterEvents?.playerRespawn || world.events?.playerRespawn || world.afterEvents?.playerSpawn || world.events?.playerSpawn;
    if (!ev) return;
    ev.subscribe((evt) => {
      try {
        const player = evt.player || evt.playerEntity || evt.entity || (evt.playerName && getPlayer(evt.playerName));
        if (!player) return;
        runLater(() => {
          try {
            clearRecentSoulAmulet(player.name);
            clearRecentCombatEnded(player.name);
            cameraRotatedOnce.delete(player.name);
            firstSeenTimeByPlayer.set(player.name, Date.now());
            hardClearCombatVisualState(player);
            removeCombatState(player.name);
            refreshSoulAmuletLoreInInventory(player);
            refreshHeartsForPlayer(player);
            updateHudActionbar(player);

            ensurePlaytimeFor(player.name);
            updateTopTimeTitle(player, getPlaytimeRemainingSeconds(player.name));

            if (getCombatRemainingMs(player.name) > 0) updateCombatTitle(player, getCombatRemainingSeconds(player.name));
            else clearCombatTitle(player);
            logDebug(`playerRespawn ${player.name}`);
          } catch (error) {
            logError("playerRespawn handler failed", error);
          }
        }, 2);
      } catch (error) {
        logError("playerRespawn subscription failed", error);
      }
    });
  } catch { }
}

try {
  system.runInterval(() => {
    try {
      const now = Date.now();
      Array.from(combatTaggedPlayers.keys()).forEach((key) => {
        try {
          const expiry = combatTaggedPlayers.get(key);
          const original = combatKeyToName.get(key) || key;
          if (!expiry || expiry <= now) {
            const expiredPlayer = getPlayer(original);
            if (expiredPlayer) clearCombatTitle(expiredPlayer);
            markCombatEnded(original);
            logDebug(`combatExpired player=${original}`);
            removeCombatState(original);
            return;
          }

          const pl = getPlayer(original);
          if (!pl) return;

          const combatSecs = getCombatRemainingSeconds(original);
          const playtimeSecs = getPlaytimeRemainingSeconds(original);

          if (combatSecs <= 0) {
            if (!combatZeroSent.has(key)) {
              markCombatEnded(original);
              clearCombatTitle(pl);
              combatZeroSent.add(key);
              logDebug(`combatReachedZero player=${original} playtime=${playtimeSecs}`);
            }
            return;
          }

          combatZeroSent.delete(key);

          updateCombatTitle(pl, combatSecs);
          runLater(() => {
            try {
              updateTopTimeTitle(pl, getPlaytimeRemainingSeconds(original));
            } catch { }
          }, 1);
        } catch { }
      });
    } catch { }
  }, 20);
} catch { }

try {
  system.runInterval(() => {
    try {
      processPendingBrokenSoulAmuletConversions();
      removeLootedSoulAmuletEventChest().catch(() => { });
      tickPlaytimeSecond();
      for (const p of getOnlinePlayers()) {
        try {
          const remaining = getPlaytimeRemainingSeconds(p.name);

          updateHudActionbar(p);

          if (getCombatRemainingMs(p.name) > 0) {
            updateCombatTitle(p, getCombatRemainingSeconds(p.name));
          } else if (endedCombatRecently(p.name)) {
            clearCombatTitle(p);
          } else {
            updateTopTimeTitle(p, remaining);
          }

          kickIfPlaytimeExpired(p, remaining);
        } catch { }
      }
    } catch { }
  }, 20);
} catch { }

function subscribeAntiCombatLog() { }

function getTeam(player) {
  try {
    if (!player || typeof player.hasTag !== "function") return null;
    for (let i = 1; i <= 20; i++) {
      const tag = `Team${i}`;
      if (player.hasTag(tag)) return tag;
    }
  } catch { }
  return null;
}

function clearTeamTags(player) {
  try {
    if (!player || typeof player.removeTag !== "function") return;
    for (let i = 1; i <= 20; i++) {
      try {
        player.removeTag(`Team${i}`);
      } catch { }
    }
  } catch { }
}

function subscribeTeamChat() {
  try {
    const ev = world.beforeEvents?.chatSend;
    if (!ev) return;
    ev.subscribe((chatEv) => {
      try {
        const player = chatEv.sender;
        const message = chatEv.message;
        if (!player || !player.id) return;

        const senderId = player.id;
        const team = getTeam(player);
        const isTeamOwner = !!(player.hasTag && player.hasTag("TeamOwner"));
        const chatEnabled = (teamChatEnabled.get(senderId) ?? false) || isTeamOwner;
        if (!chatEnabled) return;

        chatEv.cancel = true;

        if (!team && !isTeamOwner) {
          try {
            player.sendMessage("§cYou are not in a Team!");
          } catch { }
          teamChatEnabled.set(senderId, false);
          return;
        }

        system.run(() => {
          try {
            for (const target of getOnlinePlayers()) {
              try {
                const targetEnabled = target?.id ? (teamChatEnabled.get(target.id) ?? false) : false;
                const targetIsTeamOwner = !!(target?.hasTag && target.hasTag("TeamOwner"));
                const sameTeam = !!(team && target?.hasTag && target.hasTag(team));
                if ((sameTeam || targetIsTeamOwner) && (targetEnabled || targetIsTeamOwner)) {
                  target.sendMessage(`§b[${team}] §f${player.name}: ${message}`);
                }
              } catch { }
            }
          } catch { }
        });
      } catch { }
    });
  } catch { }
}

function openConfigMenu(sender) {
  let cfg = {};
  try {
    const raw = world.getDynamicProperty("helden_config");
    cfg = raw ? JSON.parse(raw) : {};
  } catch { }

  const disableVanilla = cfg.disableVanillaDeaths === true;
  const combatSeconds = cfg?.combat_tag_seconds ? Number(cfg.combat_tag_seconds) : DEFAULT_COMBAT_SECONDS;
  const playtimeSeconds = cfg?.playtime_seconds ? Number(cfg.playtime_seconds) : DEFAULT_PLAYTIME_SECONDS;

  const form = new ActionFormData();
  form.title(`§bHelden§f Einstellungen §7(Helden ${getActiveMode()})`);
  form.button(`§aCombat-Zeit: ${combatSeconds}s`, "textures/helden/ui/clock_icon");
  form.button(`§aPlaytime pro Tag: ${formatHMS(playtimeSeconds)}`, "textures/helden/ui/clock_icon");
  form.button(`§eVanilla Todesnachrichten: ${disableVanilla ? "AUS" : "AN"}`, "textures/helden/ui/notification_icon");
  form.button("§cSpieler Herzen bearbeiten", "textures/helden/ui/heart_icon");
  // In Helden 2 gibt es keine Teams: statt "Teams einstellen" steht dort die Link-Spielerliste (Index 4).
  if (getActiveMode() === 2) form.button("§dLink-Spielerliste", "textures/helden/ui/heart_icon");
  else form.button("§9Teams einstellen", "textures/ui/FriendsIcon");
  form.button(`§6Rüstungs-Sperre: ${getArmorLockMinutes()} Min`, "textures/helden/ui/clock_icon");
  form.button(`§bEnder-Pearl-Limit: ${getPearlLimit()}`, "textures/helden/ui/clock_icon");
  form.button(`§cVerbotene Items (${getBannedItems().length})`, "textures/helden/ui/x_icon");
  form.button("§cSchließen", "textures/helden/ui/x_icon");

  form.show(sender).then((res) => {
    if (!res || res.canceled || res.selection === undefined) return;
    const sel = res.selection;

    if (getActiveMode() === 2 && sel === 4) {
      openLinkListMenu(sender);
      return;
    }

    if (sel === 5 || sel === 6) {
      openCombatLimitOptions(sender, sel === 5 ? "armor" : "pearl");
      return;
    }

    if (sel === 7) {
      openBannedItemsMenu(sender);
      return;
    }

    if (sel === 0 || sel === 1) {
      const options = sel === 0
        ? [5, 10, 20, 30, 60, 90, 120]
        : [300, 600, 900, 1800, 2700, 3600, 5400, 7200, 10800, 14400];

      const optForm = new ActionFormData();
      optForm.title(sel === 0 ? "Combat-Zeit einstellen" : "Playtime pro Tag einstellen");
      options.forEach((o) => {
        if (sel === 0) {
          optForm.button(`${o} Sekunden`);
        } else {
          optForm.button(`${formatHMS(o)} h${o === DEFAULT_PLAYTIME_SECONDS ? " (Standard)" : ""}`);
        }
      });
      optForm.button("Abbrechen");

      optForm.show(sender).then((optRes) => {
        if (!optRes || optRes.canceled || optRes.selection === undefined) return;
        const idx = optRes.selection;
        if (idx >= options.length) return;

        if (sel === 0) cfg.combat_tag_seconds = options[idx];
        else cfg.playtime_seconds = options[idx];

        try {
          world.setDynamicProperty("helden_config", JSON.stringify(cfg));
        } catch { }

        try {
          if (sel === 0) sender.sendMessage(`Combat-Zeit gesetzt: ${options[idx]} Sekunden`);
          else sender.sendMessage(`Playtime pro Tag gesetzt: ${formatHMS(options[idx])} (maximal ${formatHMS(options[idx] * PLAYTIME_MAX_DAYS)} Übertrag)`);
        } catch { }
      });
      return;
    }

    if (sel === 2) {
      cfg.disableVanillaDeaths = !disableVanilla;
      try {
        world.setDynamicProperty("helden_config", JSON.stringify(cfg));
      } catch { }
      try {
        sender.sendMessage(`Vanilla Todesnachrichten ${cfg.disableVanillaDeaths ? "deaktiviert" : "aktiviert"}`);
      } catch { }
      return;
    }

    if (sel === 3) {
      const players = getOnlinePlayers();
      if (!players.length) return;

      const pform = new ActionFormData();
      pform.title("Spieler wählen");
      players.forEach((p) => pform.button(p.name));
      pform.button("Abbrechen");

      pform.show(sender).then((pres) => {
        if (!pres || pres.canceled || pres.selection === undefined) return;
        const idx = pres.selection;
        if (idx >= players.length) return;
        const target = players[idx];

        const cform = new ActionFormData();
        cform.title(`Herzen für ${target.name}`);
        for (let i = 0; i <= MAX_HEARTS; i++) cform.button(`${i} Herzen`);
        cform.button("Abbrechen");

        cform.show(sender).then((cres) => {
          if (!cres || cres.canceled || cres.selection === undefined) return;
          const sel2 = cres.selection;
          if (sel2 === MAX_HEARTS + 1) return;

          const newVal = Math.max(0, Math.min(MAX_HEARTS, sel2));
          setPlayerHeartCount(target, newVal);
          showHearts(target);

          if (newVal <= 0) {
            sendCommandAsPlayerOrDimension(
              target,
              "gamemode spectator @s",
              `gamemode spectator @a[name="${selectorName(target.name)}"]`
            );
          } else {
            sendCommandAsPlayerOrDimension(
              target,
              "gamemode survival @s",
              `gamemode survival @a[name="${selectorName(target.name)}"]`
            );
          }
        });
      });
      return;
    }

    if (sel === 4) {
      const players = getOnlinePlayers();
      if (!players.length) return;

      const pform = new ActionFormData();
      pform.title("Team: Spieler wählen");
      players.forEach((p) => pform.button(p.name));
      pform.button("Abbrechen");

      pform.show(sender).then((pres) => {
        if (!pres || pres.canceled || pres.selection === undefined) return;
        const idx = pres.selection;
        if (idx >= players.length) return;
        const target = players[idx];

        const tform = new ActionFormData();
        tform.title(`Team für ${target.name}`);
        for (let i = 1; i <= 20; i++) tform.button(`Team ${i}`);
        tform.button("Team entfernen");
        tform.button("Abbrechen");

        tform.show(sender).then((tres) => {
          if (!tres || tres.canceled || tres.selection === undefined) return;
          const teamSel = tres.selection;

          if (teamSel <= 19) {
            const teamNumber = teamSel + 1;
            clearTeamTags(target);
            const teamTag = `Team${teamNumber}`;
            try {
              target.addTag(teamTag);
            } catch { }
            teamChatEnabled.set(target.id, true);
            try {
              sender.sendMessage(`§a${target.name} ist jetzt in ${teamTag}.`);
            } catch { }
            try {
              target.sendMessage(`§aYou are now in ${teamTag}!`);
            } catch { }
            return;
          }

          if (teamSel === 20) {
            clearTeamTags(target);
            teamChatEnabled.set(target.id, false);
            try {
              sender.sendMessage(`§eTeam von ${target.name} entfernt.`);
            } catch { }
            try {
              target.sendMessage("§eDein Team wurde entfernt.");
            } catch { }
          }
        });
      });
    }
  });
}

function registerCommands() {
  system.beforeEvents.startup.subscribe(({ customCommandRegistry }) => {
    customCommandRegistry.registerCommand({
      name: "helden:teamchat",
      description: "Toggle Team Chat",
      aliases: ["heldenteamchat", "teamchat"],
      permissionLevel: 0
    }, (origin, args) => {
      const player = origin.sourceEntity || origin.sender;
      if (!player) return { statusMessage: "Nur Spieler können dies verwenden.", status: 0 };

      if (args && args.length > 0) {
        const teamNumber = parseInt(args[0], 10);
        if (teamNumber >= 1 && teamNumber <= 20) {
          clearTeamTags(player);
          const teamTag = `Team${teamNumber}`;
          try {
            player.addTag(teamTag);
          } catch { }
          teamChatEnabled.set(player.id, true);
          try {
            player.sendMessage(`§aYou are now in ${teamTag}!`);
          } catch { }
          return { statusMessage: `Team gesetzt: ${teamTag}`, status: 1 };
        }
        try {
          player.sendMessage("§cInvalid team! (1-20)");
        } catch { }
        return { statusMessage: "Ungültiges Team", status: 0 };
      }

      const current = teamChatEnabled.get(player.id) ?? false;
      const next = !current;
      teamChatEnabled.set(player.id, next);
      try {
        player.sendMessage(next ? "§aTeamchat activated!" : "§cTeamchat deactivated!");
      } catch { }
      return { statusMessage: `Teamchat ${next ? "AN" : "AUS"}`, status: 1 };
    });

    customCommandRegistry.registerCommand({
      name: "helden:config",
      description: "Öffnet das Helden Einstellungen-Menü",
      aliases: ["heldenconfig", "phconfig"],
      permissionLevel: 2
    }, (origin) => {
      const sender = origin.sourceEntity || origin.sender;
      if (!sender) return { statusMessage: "Nur Spieler können dies verwenden.", status: 0 };

      system.run(() => {
        try {
          if (getHeldenMode() === null) {
            openModeSelection(sender, () => openConfigMenu(sender));
          } else {
            openConfigMenu(sender);
          }
        } catch (error) {
          logError("helden:config failed", error);
        }
      });

      return { statusMessage: "Config-Menü geöffnet.", status: 1 };
    });

    customCommandRegistry.registerCommand({
      name: "helden:fixhud",
      description: "Refresh HUD/title for a player (or self)",
      permissionLevel: 0
    }, (origin, args) => {
      try {
        const sender = origin.sourceEntity || origin.sender || null;
        let target = null;
        if (args && args.length) {
          const p = getPlayer(args[0]);
          if (p) target = p;
        }
        if (!target && sender?.name) target = sender;
        if (!target) return { statusMessage: "Spieler nicht gefunden", status: 0 };

        updateHudActionbar(target);

        ensurePlaytimeFor(target.name);
        updateTopTimeTitle(target, getPlaytimeRemainingSeconds(target.name));

        const csecs = getCombatRemainingSeconds(target.name) || 0;
        if (csecs > 0) updateCombatTitle(target, csecs);
        else clearCombatTitle(target);

        return { statusMessage: "HUD aktualisiert", status: 1 };
      } catch {
        return { statusMessage: "Fehler beim Aktualisieren des HUD", status: 0 };
      }
    });

    customCommandRegistry.registerCommand({
      name: "helden:debughearts",
      description: "Debug: zeigt gespeicherte Herzen und DynamicProperty",
      permissionLevel: 3
    }, (origin) => {
      const sender = origin.sourceEntity || origin.sender;
      try {
        const raw = world.getDynamicProperty?.("helden_hearts");
        try {
          sender?.sendMessage?.("[Helden] world.helden_hearts: " + String(raw));
        } catch { }
        try {
          const parsed = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;
          sender?.sendMessage?.("[Helden] parsed: " + JSON.stringify(parsed));
        } catch {
          sender?.sendMessage?.("[Helden] parsed: <parse error>");
        }
      } catch { }
      return { statusMessage: "Debug ausgegeben", status: 1 };
    });

    customCommandRegistry.registerCommand({
      name: "helden:amuletevent",
      description: "Spawnt eine Event Chest mit Soul Amulet",
      aliases: ["amuletevent"],
      permissionLevel: 2
    }, (origin) => {
      try {
        const executor = origin?.sourceEntity || origin?.sender || getOnlinePlayers()[0] || null;
        if (!executor) {
          return { statusMessage: "Kein Executor fuer das Event verfuegbar.", status: 0 };
        }

        system.run(() => {
          spawnSoulAmuletEventChest(executor).then((location) => {
            if (!location) {
              try {
                executor.sendMessage?.("§cKonnte keine gültige Event-Chest Position finden. Lade den Bereich um X:0 Z:0 oder bewege dich näher dorthin.");
              } catch { }
              return;
            }
            announceSoulAmuletEvent(location);
            try {
              executor.sendMessage?.(`§aEvent Chest gespawnt bei ${location.x} ${location.y} ${location.z}`);
            } catch { }
          }).catch((error) => {
            logError("helden:amuletevent async execution failed", error);
          });
        });

        return { statusMessage: "Amuletevent wird vorbereitet.", status: 1 };
      } catch (error) {
        logError("helden:amuletevent command failed", error);
        return { statusMessage: "Fehler beim Spawnen der Event Chest.", status: 0 };
      }
    });

    const OK = mcServer.CustomCommandStatus?.Success ?? 0;
    const FAIL = mcServer.CustomCommandStatus?.Failure ?? 1;

    customCommandRegistry.registerCommand({
      name: "helden:reset",
      description: "Löscht alle Helden-Voreinstellungen (Modus, Config, Verlinkungen, Kopfgelder)",
      permissionLevel: 2
    }, (origin) => {
      const sender = origin.sourceEntity || origin.sender || null;
      system.run(() => {
        try {
          resetHeldenSettings();
          const msg = "§aAlle Helden-Voreinstellungen wurden gelöscht. Mit /helden:config kannst du den Modus neu wählen.";
          if (sender?.sendMessage) sender.sendMessage(msg);
          else broadcastMessage(msg);
        } catch (error) {
          logError("helden:reset failed", error);
        }
      });
      return { status: OK, message: "Helden-Reset wird ausgeführt." };
    });

    try {
      customCommandRegistry.registerCommand({
        name: "helden:kopfgeld",
        description: "Zeigt dein Kopfgeld-Ziel (Helden 3). Tötest du es, bekommst du 1 Herz",
        aliases: ["kopfgeld"],
        permissionLevel: 0
      }, (origin) => {
        if (getActiveMode() !== 3) {
          return { status: FAIL, message: "§cKopfgeld gibt es nur in Helden 3." };
        }
        const sender = origin.sourceEntity || origin.sender || null;
        if (!sender?.name) return { status: FAIL, message: "§cNur Spieler haben ein Kopfgeld-Ziel." };
        if (isBountyDone(sender.name)) {
          return { status: OK, message: "§7Dein Kopfgeld ist bereits eingelöst. Es gibt es nur einmal." };
        }
        const target = getBountyTarget(sender.name);
        if (!target) {
          return { status: OK, message: "§7Du hast noch kein Kopfgeld-Ziel. Sobald ein weiterer Spieler online ist, wirst du gelost." };
        }
        return { status: OK, message: `§6Dein Kopfgeld-Ziel: §c${target}§6. Tötest du ihn, bekommst du 1 Herz und er verliert keins. Er jagt auch dich!` };
      });
    } catch (error) {
      logError("helden:kopfgeld registration failed", error);
    }

    customCommandRegistry.registerCommand({
      name: "helden:linkliste",
      description: "Öffnet die Link-Spielerliste (Helden 2)",
      aliases: ["linkliste"],
      permissionLevel: 2
    }, (origin) => {
      if (getActiveMode() !== 2) return { status: FAIL, message: "§cDie Link-Liste gibt es nur in Helden 2." };
      const sender = origin.sourceEntity || origin.sender || null;
      if (!sender) return { status: FAIL, message: "§cNur Spieler können dies verwenden." };
      system.run(() => openLinkListMenu(sender));
      return { status: OK, message: "§7Link-Liste wird geöffnet." };
    });

    customCommandRegistry.registerCommand({
      name: "helden:dummytest",
      description: "Spawnt zum Test kurz einen Combat-Logout-Dummy an deiner Position",
      permissionLevel: 2
    }, (origin) => {
      const sender = origin.sourceEntity || origin.sender || null;
      if (!sender?.name) return { status: FAIL, message: "§cNur Spieler können dies verwenden." };
      system.run(() => testDummySpawn(sender));
      return { status: OK, message: "§7Dummy-Test läuft..." };
    });

    // Hinweis: /time ist ein Vanilla-Befehl und lässt sich nicht überschreiben. Deshalb heißt der Befehl helden:time
    // (mit den Kurzformen /playtime und /spielzeit).
    customCommandRegistry.registerCommand({
      name: "helden:playtime",
      description: "Zeigt deine verbleibende Spielzeit (Playtime)",
      aliases: ["playtime", "spielzeit"],
      permissionLevel: 0
    }, (origin) => {
      const sender = origin.sourceEntity || origin.sender || null;
      if (!sender?.name) return { status: FAIL, message: "§cNur Spieler haben eine Spielzeit." };
      ensurePlaytimeFor(sender.name);
      return {
        status: OK,
        message: `§6Verbleibende Spielzeit: §f${formatHMS(getPlaytimeRemainingSeconds(sender.name))} §7(pro Tag +${formatHMS(getDefaultPlaytimeMs() / 1000)} ab Mitternacht, maximal ${formatHMS(getPlaytimeCapMs() / 1000)})`
      };
    });

    customCommandRegistry.registerCommand({
      name: "helden:verboten",
      description: "Öffnet die Liste der verbotenen Items",
      permissionLevel: 2
    }, (origin) => {
      const sender = origin.sourceEntity || origin.sender || null;
      if (!sender?.name) return { status: FAIL, message: "§cNur Spieler können dies verwenden." };
      system.run(() => openBannedItemsMenu(sender));
      return { status: OK, message: "§7Liste der verbotenen Items wird geöffnet..." };
    });

    customCommandRegistry.registerCommand({
      name: "helden:partner",
      description: "Zeigt deinen verlinkten Partner und die gemeinsamen Herzen (Helden 2)",
      aliases: ["partner"],
      permissionLevel: 0
    }, (origin) => {
      if (getActiveMode() !== 2) return { status: FAIL, message: "§cVerlinkte Herzen gibt es nur in Helden 2." };
      const sender = origin.sourceEntity || origin.sender || null;
      if (!sender?.name) return { status: FAIL, message: "§cNur Spieler können dies verwenden." };
      const partner = getLinkedPartner(sender.name);
      if (!partner) {
        if (!isOnLinkList(sender.name)) return { status: OK, message: "§7Du stehst nicht auf der Link-Liste." };
        return { status: OK, message: "§7Du hast noch keinen Partner. Sobald ein weiterer freier Spieler von der Link-Liste online ist, wirst du verlinkt." };
      }
      const h = hearts.has(sender.name) ? clampHearts(hearts.get(sender.name)) : MAX_HEARTS;
      const online = getOnlinePlayers().some((p) => p?.name === partner);
      return { status: OK, message: `§dPartner: §f${partner} §7(${online ? "online" : "offline"}) §d– gemeinsame Herzen: §f${h}` };
    });
  });
}

try {
  loadHeartsFromWorld();
} catch { }
try {
  runLater(() => {
    try {
      loadHeartsFromWorld();
      loadHeartsFromPlayers();
    } catch { }
  }, 2);
} catch { }

subscribeDamage();
subscribeDeath();
subscribeJoin();
subscribeCombatLogout();
subscribeRespawn();
subscribeAntiCombatLog();
subscribeLinkedProtection();
startBannedItemSweep();
startEndPortalFrameSweep();
subscribePlaytimeLeave();
subscribeDummyLeave();
subscribeDummyEvents();
subscribeEnderPearlLimit();
startArmorLockTick();
startNetherPortalGuard();
subscribeTeamChat();
registerCommands();