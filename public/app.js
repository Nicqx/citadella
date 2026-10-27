'use strict';

const BASE = '/citadella';
const STORAGE_KEY = 'citadella-session-v1';
const app = document.getElementById('app');
const helpButton = document.getElementById('help-button');
const helpDialog = document.getElementById('help-dialog');
const helpClose = document.getElementById('help-close');
const helpList = document.getElementById('help-list');
const toast = document.getElementById('toast');

let auth = loadAuth();
let state = null;
let polling = null;
let toastTimer = null;

const errors = {
  name_required: 'Adj meg egy nevet.',
  session_not_found: 'Ez a szoba már nem létezik vagy lejárt.',
  session_already_started: 'A játék már elkezdődött.',
  session_full: 'A szoba megtelt.',
  name_in_use: 'Ez a név már foglalt a szobában.',
  auth_failed: 'A helyi játékazonosító nem érvényes ehhez a szobához.',
  supported_player_count: 'Ez a verzió 4–8 játékost támogat.',
  host_only: 'Ezt csak a házigazda teheti meg.',
  active_player_only: 'Ezt most csak az aktív játékos teheti meg.',
  not_current_drafter: 'Most nem te választasz karaktert.',
  character_unavailable: 'Ez a karakter már nem választható.',
  invalid_gold_total: 'Ennyi arany nem állítható be.',
  game_not_active: 'A játék még nem fut.',
  turn_not_active: 'Nincs aktív kör.',
  resource_required: 'Előbb válassz: 2 arany vagy kerületlap-húzás.',
  resource_already_gathered: 'Ebben a körben már választottál nyersanyagot.',
  draw_choice_required: 'Előbb válaszd ki, melyik húzott kerületlapot tartod meg.',
  draw_choice_not_active: 'Most nincs folyamatban lapválasztás.',
  invalid_draw_choice: 'Ez a lap nem választható.',
  build_limit_reached: 'Ebben a körben már elérted az építési korlátot.',
  district_not_in_hand: 'Ez a kerületlap nincs a kezedben.',
  duplicate_district: 'Ilyen nevű kerület már van a városodban.',
  not_enough_gold: 'Nincs elég aranyad ehhez.',
  ability_already_used: 'Ezt a képességet ebben a körben már használtad.',
  invalid_character_target: 'Ez a karakter most nem választható célpontnak.',
  invalid_player_target: 'Ez a játékos most nem választható célpontnak.',
  invalid_ability_action: 'Ez a képességművelet nem használható.',
  cards_required: 'Válassz legalább egy kerületlapot.',
  completed_city_protected: 'Befejezett város kerülete nem pusztítható el.',
  bishop_protected: 'A Püspök kerületei ebben a körben védettek.',
  keep_protected: 'A Keep kerületet a Hadúr nem pusztíthatja el.',
  district_deck_empty: 'Elfogyott a kerületpakli.',
  district_ability_unavailable: 'Ez a kerülethatás most nem használható.',
  district_ability_already_used: 'Ezt a kerülethatást ebben a körben már használtad.',
  invalid_district_ability: 'Ismeretlen kerülethatás.',
  invalid_bot_count: 'A szimulált játékosok száma nem megfelelő.',
  too_many_players: 'A valós és szimulált játékosok együtt legfeljebb nyolcan lehetnek.',
  unique_district_selection_count: 'Pontosan 14 egyedi kerületet válassz.',
  unknown_unique_district: 'Ismeretlen egyedi kerület került a választásba.',
  district_cannot_be_built: 'Ezt a kerületet nem lehet megépíteni.',
  monument_too_late: 'Az Emlékmű már nem építhető, ha legalább öt kerületed van.',
  internal_error: 'Szerverhiba történt.'
};

function loadAuth() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); }
  catch (_err) { return null; }
}

function saveAuth(value) {
  auth = value;
  if (value) localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  else localStorage.removeItem(STORAGE_KEY);
}

function requestedCode() {
  const query = new URLSearchParams(location.search).get('code');
  if (/^\d{5}$/.test(query || '')) return query;
  const suffix = location.pathname.slice(BASE.length).replace(/^\/+|\/+$/g, '');
  return /^\d{5}$/.test(suffix) ? suffix : '';
}

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('show');
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (auth?.playerId && auth?.token) {
    headers['x-player-id'] = auth.playerId;
    headers['x-player-token'] = auth.token;
  }
  const response = await fetch(`${BASE}/api${path}`, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'internal_error');
    error.code = data.error || 'internal_error';
    throw error;
  }
  return data;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[ch]));
}

function phaseLabel(phase) {
  return ({
    lobby: 'Váróterem',
    draft: 'Karakterválasztás',
    turns: 'Játékkör',
    finished: 'Játék vége'
  })[phase] || phase;
}

function typeInfo(type) {
  return state?.districtTypes?.find((item) => item.id === type) || {
    id: type,
    label: type,
    symbol: '?'
  };
}

function characterById(characterId) {
  return state?.characters?.find((character) => character.id === characterId) || null;
}

function renderTopbar() {
  if (!state) return '';
  const canFinish = state.isHost && !['lobby', 'finished'].includes(state.phase);
  return `<div class="topbar"><div class="brand"><p class="eyebrow">${escapeHtml(phaseLabel(state.phase))} · ${state.round ? `${state.round}. kör` : 'előkészület'}</p><h1>Citadella</h1></div><div class="topbar-meta"><span class="badge">👤 ${escapeHtml(state.me?.name || '—')}</span><span class="badge">pakli: ${state.deckCount ?? '—'}</span><div class="code-badge" title="Szobakód">${escapeHtml(state.code)}</div>${canFinish ? '<button class="danger mini-action" data-action="finish-game">Játék befejezése</button>' : ''}<button class="ghost mini-action" data-action="leave-session">Kilépés / új szoba</button></div></div>`;
}

function roleCard() {
  const role = state?.me?.character || state?.draft?.myChoice;
  if (!role) return '';
  return `<section class="panel role-card"><div class="role-title"><span class="role-rank">${role.rank}</span><div><p class="eyebrow">A karaktered</p><h2>${escapeHtml(role.name)}</h2></div></div><p>${escapeHtml(role.short)}</p><p class="muted">${escapeHtml(role.detail)}</p></section>`;
}

function renderHome() {
  helpButton.classList.add('hidden');
  const code = requestedCode();
  app.innerHTML = `<section class="hero"><div class="brand"><p class="eyebrow">Játékszoba</p><h1>Citadella</h1><p class="muted">Telefonos Citadella-asztal: titkos karakterválasztás, saját kerületkéz, arany, építés és kattintható karakterképességek.</p></div><div class="grid-2"><form id="create-form" class="panel stack"><h2>Új játék</h2><label>Név<input name="name" maxlength="32" autocomplete="name" required></label><button type="submit">Szoba létrehozása</button><p class="muted">4–8 játékos, ötjegyű szobakóddal.</p></form><form id="join-form" class="panel stack"><h2>Csatlakozás</h2><label>Név<input name="name" maxlength="32" autocomplete="name" required></label><label>Szobakód<input name="code" inputmode="numeric" pattern="[0-9]{5}" maxlength="5" value="${escapeHtml(code)}" required></label><button type="submit">Belépés</button></form></div></section>`;
}

function lobbyRow(player, index) {
  const crowned = player.isCrowned ? '<span class="badge crown">♛ korona</span>' : '';
  const host = player.isHost ? '<span class="badge">házigazda</span>' : '';
  const bot = player.isBot ? '<span class="badge bot-badge">🤖 szimulált</span>' : '';
  const controls = state.isHost
    ? `<div class="actions"><button class="ghost" data-action="move-up" data-player="${player.id}" ${index === 0 ? 'disabled' : ''}>↑</button><button class="ghost" data-action="move-down" data-player="${player.id}" ${index === state.players.length - 1 ? 'disabled' : ''}>↓</button><button class="secondary" data-action="crown" data-player="${player.id}">♛</button></div>`
    : '';
  return `<div class="player-row"><div><strong>${escapeHtml(player.name)}</strong><div class="meta">${host}${bot}${crowned}</div></div>${controls}</div>`;
}

function uniqueDistrictSelector() {
  const selected = new Set(state.selectedUniqueDistrictIds || []);
  const catalog = state.uniqueDistrictCatalog || [];
  const cards = catalog.map((district) => `
    <label class="unique-option ${selected.has(district.id) ? 'selected' : ''}">
      <input type="checkbox" name="districtId" value="${district.id}" ${selected.has(district.id) ? 'checked' : ''}>
      <span><strong>${escapeHtml(district.name)}</strong><small>${district.cost} 🪙 · ${escapeHtml(district.effect)}</small></span>
    </label>`).join('');
  return `<form id="district-config-form" class="stack"><div class="section-head"><div><p class="eyebrow">Kiegészítő kerületek</p><h3>Egyedi kerületek</h3></div><span id="unique-count" class="badge">${selected.size}/14</span></div><p class="muted">A szabály szerint 14 különböző egyedi kerület kerül az 54 alapkerület mellé. Az első játék készlete van alapból kijelölve.</p><div class="unique-config-grid">${cards}</div><div class="actions"><button type="submit">14-es készlet mentése</button><button type="button" class="secondary" data-action="default-unique">Alapkészlet</button></div></form>`;
}

function renderLobby() {
  helpButton.classList.remove('hidden');
  const countOk = state.players.length >= 4 && state.players.length <= 8;
  const maxBots = Math.max(0, 8 - Number(state.humanCount || 1));
  const botOptions = Array.from({ length: maxBots + 1 }, (_, count) =>
    `<option value="${count}" ${count === state.botCount ? 'selected' : ''}>${count}</option>`).join('');
  const selectedNames = (state.uniqueDistrictCatalog || [])
    .filter((district) => (state.selectedUniqueDistrictIds || []).includes(district.id))
    .map((district) => `<span class="badge">${escapeHtml(district.name)}</span>`).join('');

  const hostSettings = state.isHost
    ? `<section class="panel stack lobby-settings"><h2>Játékbeállítások</h2><form id="bot-form" class="inline-form"><label>Szimulált játékosok<select name="count">${botOptions}</select></label><button type="submit">Botok beállítása</button></form><p class="muted">A botok ugyanúgy karaktert választanak, nyersanyagot gyűjtenek és várost építenek. A valós + szimulált létszám együtt 4–8 lehet.</p>${uniqueDistrictSelector()}</section>`
    : `<section class="panel stack lobby-settings"><h2>Játékbeállítások</h2><p><strong>Szimulált játékosok:</strong> ${state.botCount}</p><div><p class="eyebrow">A kiválasztott 14 egyedi kerület</p><div class="face-up">${selectedNames}</div></div><p class="muted">Ezeket a házigazda módosíthatja indulás előtt.</p></section>`;

  app.innerHTML = `${renderTopbar()}<div class="grid-2"><section class="panel stack"><div><h2>Játékosok (${state.players.length}/8)</h2><p class="muted">A sorrend az asztal körüli ülésrendet jelenti. A koronát annak add, aki először választ karaktert.</p></div><div class="lobby-list">${state.players.map(lobbyRow).join('')}</div>${state.isHost ? `<button data-action="start" ${countOk ? '' : 'disabled'}>Játék indítása</button>${countOk ? '' : '<p class="notice">Az induláshoz összesen 4–8 valós vagy szimulált játékos kell.</p>'}` : '<p class="muted">A házigazda indítja a játékot.</p>'}</section><section class="panel stack"><h2>Digitális kerületlapok</h2><p>Indításkor mindenki 4 titkos kerületlapot és 2 aranyat kap. A saját lapjaid csak a te telefonodon látszanak; a többieknél csak a kézben lévő lapok száma nyilvános.</p><p>A körödben az app vezeti a nyersanyagválasztást és a kézből történő építést.</p><p class="muted">A ? gomb alatt megtalálod a játék célját, a teljes menetet, a karaktereket és az egyedi kerületek hatását.</p></section></div>${hostSettings}`;
}
function cardCost(card) {
  const hasFactory = state?.me?.built?.some((district) => district.id === 'factory');
  return Math.max(0, Number(card.cost || 0) - (hasFactory && card.type === 'unique' && card.id !== 'factory' ? 1 : 0));
}

function handCard(card, options = {}) {
  const type = typeInfo(card.type);
  const effective = cardCost(card);
  const costLabel = effective === card.cost ? String(card.cost) : `${effective} <s>${card.cost}</s>`;
  const controls = [];
  if (options.selectable) {
    controls.push(`<label class="compact-check"><input type="checkbox" name="magician-card" value="${card.cardId}"> csere</label>`);
  }
  if (options.keep) {
    controls.push(`<button data-action="keep-drawn-card" data-card="${card.cardId}">Ezt tartom meg</button>`);
  }
  if (options.build) {
    controls.push(`<button data-action="build-card" data-card="${card.cardId}" ${options.disabled ? 'disabled' : ''}>Megépítem · ${effective} 🪙</button>`);
  }
  return `<div class="district-row"><span class="type-dot type-${escapeHtml(type.id)}">${escapeHtml(type.symbol)}</span><div class="district-row-main"><div class="district-row-title"><strong>${escapeHtml(card.name)}</strong><span class="badge">${escapeHtml(type.label)}</span><span class="row-cost">${costLabel} 🪙</span></div>${card.effect ? `<div class="row-effect">${escapeHtml(card.effect)}</div>` : ''}</div>${controls.length ? `<div class="row-actions">${controls.join('')}</div>` : ''}</div>`;
}

function handPanel({ build = false, selectable = false } = {}) {
  const hand = state?.me?.hand || [];
  const action = state?.turn?.action;
  const canBuildPhase = build &&
    state.turn?.activePlayerId === state.me.id &&
    action?.resourceGathered &&
    !action?.pendingDraw?.length;

  return `<section class="panel stack hand-panel"><div class="section-head"><div><p class="eyebrow">Titkos</p><h2>A kezed · ${hand.length} lap</h2></div><span class="badge">csak te látod</span></div>${hand.length ? `<div class="hand-list">${hand.map((card) => {
    const limitReached = action && action.builds >= action.buildLimit && card.id !== 'stables';
    const cannotBuild = card.id === 'secret-vault' ||
      (card.id === 'monument' && (state.me.built || []).length >= 5);
    return handCard(card, {
      build: canBuildPhase,
      selectable,
      disabled: cardCost(card) > state.me.gold || limitReached || cannotBuild
    });
  }).join('')}</div>` : '<p class="muted">Nincs kerületlap a kezedben.</p>'}</section>`;
}
function renderDraft() {
  helpButton.classList.remove('hidden');
  const current = state.players.find((player) => player.id === state.draft.currentPlayerId);
  const myTurn = state.draft.currentPlayerId === state.me.id;
  const options = state.draft.options.map((role) => `<button class="character-option" data-action="choose-character" data-character="${role.id}"><strong>${role.rank}. ${escapeHtml(role.name)}</strong><small>${escapeHtml(role.short)}</small></button>`).join('');
  const faceUp = state.draft.faceUp.length
    ? state.draft.faceUp.map((role) => `<span class="badge">${role.rank}. ${escapeHtml(role.name)}</span>`).join('')
    : '<span class="muted">Nincs képpel felfelé félretett karakter.</span>';

  app.innerHTML = `${renderTopbar()}${roleCard()}${botActionsPanel()}${handPanel()}<section class="panel stack"><div class="status-banner"><div><p class="eyebrow">Most választ</p><h2>${escapeHtml(current?.name || '—')}</h2></div><span class="badge">${state.draft.availableCount} lehetőség</span></div><div><p class="eyebrow">Nyíltan félretett karakterek</p><div class="face-up">${faceUp}</div></div>${myTurn ? `<div><p class="eyebrow">Válassz titokban egy karaktert</p><div class="draft-grid">${options}</div></div>` : `<p class="muted">Várj, amíg ${escapeHtml(current?.name || 'a következő játékos')} választ.</p>`}</section><div class="table-grid">${state.players.map(playerCard).join('')}</div>`;
}

function districtChip(district) {
  const type = typeInfo(district.type);
  const canDelete = state.isHost;
  const museumCount = district.id === 'museum' && district.storedCardCount
    ? `<span class="badge">🖼️ ${district.storedCardCount}</span>`
    : '';
  return `<span class="district" title="${escapeHtml(district.effect || type.label)}"><span class="type-dot type-${escapeHtml(type.id)}">${escapeHtml(type.symbol)}</span><span class="name">${escapeHtml(district.name)}</span><span class="cost">${district.cost}${district.beautified ? '+1' : ''}</span>${museumCount}${canDelete ? `<button data-action="delete-district" data-district="${district.cardId}" aria-label="Kerület törlése">×</button>` : ''}</span>`;
}

function playerCard(player) {
  const active = state.turn?.activePlayerId === player.id;
  const role = player.character ? `<span class="badge">${player.character.rank}. ${escapeHtml(player.character.name)}</span>` : '';
  const controls = state.isHost
    ? `<div class="gold-admin"><span class="small-text muted">Admin aranykorrekció</span><div class="gold-controls"><button class="ghost" data-action="gold" data-player="${player.id}" data-delta="-1" title="Kézi admin javítás: −1 arany">−1 arany</button><button class="secondary" data-action="gold" data-player="${player.id}" data-delta="1" title="Kézi admin javítás: +1 arany">+1 arany</button></div></div>`
    : '';
  return `<section class="panel player-card ${active ? 'active' : ''} ${player.id === state.me.id ? 'me' : ''}"><div class="player-head"><div><div class="player-name">${escapeHtml(player.name)}</div><div class="meta">${player.isCrowned ? '<span class="badge crown">♛</span>' : ''}${player.isHost ? '<span class="badge">host</span>' : ''}${player.isBot ? '<span class="badge bot-badge">🤖</span>' : ''}${role}</div></div><div class="meta"><span class="badge">${player.handCount} kézlap</span><span class="badge">${player.built.length} kerület</span></div></div><div class="gold-line">🪙 ${player.gold} arany</div>${controls}<div class="districts">${player.built.map(districtChip).join('') || '<span class="muted">Még nincs megépített kerület.</span>'}</div></section>`;
}

function resourcePanel() {
  if (state.turn?.activePlayerId !== state.me.id) return '';
  const action = state.turn.action;
  if (action.pendingDraw?.length) {
    return `<section class="panel stack action-panel"><div><p class="eyebrow">Nyersanyag</p><h2>Válassz 1 kerületlapot</h2><p class="muted">A többi húzott lap a pakli aljára kerül.</p></div><div class="hand-list">${action.pendingDraw.map((card) => handCard(card, { keep: true })).join('')}</div></section>`;
  }
  if (action.resourceGathered) {
    return '<section class="panel compact-panel"><span class="badge good">✓ Nyersanyag kiválasztva</span></section>';
  }
  const goldAmount = (state.me.built || []).some((district) => district.id === 'gold-mine') ? 3 : 2;
  const drawAmount = (state.me.built || []).some((district) => district.id === 'observatory') ? 3 : 2;
  const keepAll = (state.me.built || []).some((district) => district.id === 'library');
  const cardLabel = keepAll ? `🃏 ${drawAmount} lap, mindet megtartod` : `🃏 ${drawAmount} lapból 1`;
  return `<section class="panel stack action-panel"><div><p class="eyebrow">Kötelező lépés</p><h2>Mit veszel fel?</h2></div><div class="choice-grid"><button data-action="take-resource" data-mode="gold">🪙 ${goldAmount} arany</button><button class="secondary" data-action="take-resource" data-mode="cards">${cardLabel}</button></div></section>`;
}
function faceUpCharactersPanel() {
  const cards = state.faceUpCharacters || [];
  if (!cards.length) return '';
  return `<section class="panel compact-panel face-up-panel"><span class="muted">Ebben a körben nyíltan félretéve:</span>${cards.map((role) => `<span class="badge">${role.rank}. ${escapeHtml(role.name)}</span>`).join('')}</section>`;
}

function botActionsPanel() {
  const actions = state?.botActions || [];
  if (!actions.length) return '';
  const visible = actions.slice(-5).reverse();
  return `<section class="bot-action-panel"><div class="bot-action-title"><span>🤖 Botok lépései</span><small>legfrissebb felül</small></div><div class="bot-action-list">${visible.map((entry, index) => {
    const role = entry.characterName ? ` · ${escapeHtml(entry.characterName)}` : '';
    return `<div class="bot-action-bubble ${index === 0 ? 'latest' : ''}"><div class="bot-action-head"><strong>${escapeHtml(entry.playerName)}${role}</strong><span>${entry.round}. kör</span></div><ul>${(entry.messages || []).map((message) => `<li>${escapeHtml(message)}</li>`).join('')}</ul></div>`;
  }).join('')}</div></section>`;
}

function announcementsPanel() {
  const killed = characterById(state.roundEffects?.assassinatedCharacterId);
  const robbed = characterById(state.roundEffects?.thiefTargetCharacterId);
  if (!killed && !robbed) return '';
  return `<section class="panel compact-panel announcements">${killed ? `<span class="badge danger-badge">☠ ${escapeHtml(killed.name)}</span>` : ''}${robbed ? `<span class="badge">🗝 Tolvaj célpontja: ${escapeHtml(robbed.name)}</span>` : ''}</section>`;
}

function targetCharacterButtons(mode) {
  const roleId = state.turn.character.id;
  const faceUpIds = new Set((state.faceUpCharacters || []).map((character) => character.id));
  return state.characters
    .filter((character) => {
      if (faceUpIds.has(character.id)) return false;
      if (character.id === roleId) return false;
      if (mode === 'assassin') return character.id !== 'assassin';
      if (mode === 'thief') {
        return character.id !== 'assassin' &&
          character.id !== 'thief' &&
          character.id !== state.roundEffects?.assassinatedCharacterId;
      }
      return false;
    })
    .map((character) => `<button class="character-option" data-action="ability-target-character" data-character="${character.id}"><strong>${character.rank}. ${escapeHtml(character.name)}</strong><small>${escapeHtml(character.short)}</small></button>`)
    .join('');
}

function warlordTargets() {
  const cards = [];
  for (const player of state.players) {
    const citySize = player.built.length + (player.built.some((district) => district.id === 'monument') ? 1 : 0);
    const hasGreatWall = player.built.some((district) => district.id === 'great-wall');
    for (const district of player.built) {
      if (district.id === 'keep' || citySize >= 7) continue;
      const wallExtra = hasGreatWall && district.id !== 'great-wall' ? 1 : 0;
      const cost = Math.max(0, Number(district.cost || 0) - 1 + wallExtra);
      cards.push(`<button class="target-district secondary" data-action="warlord-destroy" data-card="${district.cardId}" ${cost > state.me.gold ? 'disabled' : ''}><strong>${escapeHtml(player.name)} · ${escapeHtml(district.name)}</strong><span>${cost} 🪙</span></button>`);
    }
  }
  return cards.join('') || '<p class="muted">Jelenleg nincs elpusztítható kerület.</p>';
}
function abilityPanel() {
  if (state.turn?.activePlayerId !== state.me.id) return '';
  const role = state.turn.character;
  const action = state.turn.action;

  if (role.id === 'assassin') {
    if (action.specialUsed) {
      const target = characterById(state.roundEffects?.assassinatedCharacterId);
      return `<section class="panel compact-panel"><strong>☠ Célpont: ${escapeHtml(target?.name || '—')}</strong></section>`;
    }
    return `<section class="panel stack ability-panel"><div><p class="eyebrow">Orgyilkos</p><h2>Kit ölsz meg?</h2><p class="muted">Karakterre kattints, nem játékosra. A célpont nem tudja, hogy nála van-e a kiválasztott karakter.</p></div><div class="draft-grid">${targetCharacterButtons('assassin')}</div></section>`;
  }

  if (role.id === 'thief') {
    if (action.specialUsed) {
      const target = characterById(state.roundEffects?.thiefTargetCharacterId);
      return `<section class="panel compact-panel"><strong>🗝 Célpont: ${escapeHtml(target?.name || '—')}</strong></section>`;
    }
    return `<section class="panel stack ability-panel"><div><p class="eyebrow">Tolvaj</p><h2>Kit rabolj ki?</h2><p class="muted">Az Orgyilkos és az általa megölt karakter nem választható.</p></div><div class="draft-grid">${targetCharacterButtons('thief')}</div></section>`;
  }

  if (role.id === 'magician') {
    if (action.specialUsed) return '<section class="panel compact-panel"><span class="badge good">✓ A Mágus képessége felhasználva</span></section>';
    const others = state.players.filter((player) => player.id !== state.me.id)
      .map((player) => `<button class="secondary" data-action="magician-swap" data-player="${player.id}">Kézcsere: ${escapeHtml(player.name)} (${player.handCount})</button>`).join('');
    return `<section class="panel stack ability-panel"><div><p class="eyebrow">Mágus</p><h2>Képesség</h2></div><div class="actions">${others}</div><div class="divider"></div><p class="muted">Vagy jelöld ki a saját lapjaid közül, amelyeket a pakli aljára teszel, majd húzz ugyanannyit.</p>${handPanel({ selectable: true }).replace('<section class="panel stack hand-panel">', '<div class="nested-hand stack">').replace(/<\/section>$/, '</div>')}<button class="secondary" data-action="magician-redraw">Kijelöltek újrahúzása</button></section>`;
  }

  if (['king', 'bishop', 'merchant', 'warlord'].includes(role.id)) {
    const incomeLabels = {
      king: 'Nemesi bevétel',
      bishop: 'Egyházi bevétel',
      merchant: 'Kereskedelmi bevétel',
      warlord: 'Katonai bevétel'
    };
    const income = action.incomeUsed
      ? '<span class="badge good">✓ Színbevétel beszedve</span>'
      : `<button data-action="ability-income">${incomeLabels[role.id]}</button>`;
    const destruction = role.id === 'warlord'
      ? `<div class="divider"></div><div><p class="eyebrow">Hadúr</p><h3>Kerület elpusztítása</h3><p class="muted">Egy kerületet az értékénél 1 arannyal olcsóbban pusztíthatsz el. A Püspök és a befejezett város védett.</p></div>${action.destructionUsed ? '<span class="badge good">✓ Pusztítás felhasználva</span>' : `<div class="target-list">${warlordTargets()}</div>`}`
      : '';
    return `<section class="panel stack ability-panel"><div><p class="eyebrow">${escapeHtml(role.name)}</p><h2>Karakterképesség</h2></div><div class="actions">${income}</div>${destruction}</section>`;
  }

  if (role.id === 'architect') {
    return '<section class="panel compact-panel"><strong>🃏 Az Építész 2 plusz lapját automatikusan megkaptad. Ebben a körben legfeljebb 3 kerületet építhetsz.</strong></section>';
  }

  if (role.id === 'queen') {
    return '<section class="panel compact-panel"><strong>♛ A Királynő szomszédsági bónuszát az app automatikusan kezeli.</strong></section>';
  }

  return '';
}

function districtAbilityPanel() {
  if (state.turn?.activePlayerId !== state.me.id) return '';
  const action = state.turn.action;
  if (!action?.resourceGathered || action.pendingDraw?.length) return '';

  const builtIds = new Set((state.me.built || []).map((district) => district.id));
  const uses = action.districtUses || {};
  const blocks = [];

  if (builtIds.has('laboratory')) {
    if (uses.laboratory) {
      blocks.push('<div class="district-ability-row"><strong>Laboratórium</strong><span class="badge good">✓ használva</span></div>');
    } else if ((state.me.hand || []).length) {
      const options = state.me.hand.map((card) => `<option value="${card.cardId}">${escapeHtml(card.name)} (${card.cost} 🪙)</option>`).join('');
      blocks.push(`<div class="district-ability-row"><div><strong>Laboratórium</strong><div class="muted small-text">1 kézlap eldobása → 2 arany</div></div><div class="inline-control"><select id="laboratory-card">${options}</select><button class="secondary" data-action="use-laboratory">Használom</button></div></div>`);
    }
  }

  if (builtIds.has('smithy')) {
    if (uses.smithy) {
      blocks.push('<div class="district-ability-row"><strong>Kovácsműhely</strong><span class="badge good">✓ használva</span></div>');
    } else {
      blocks.push(`<div class="district-ability-row"><div><strong>Kovácsműhely</strong><div class="muted small-text">2 arany → 3 kerületlap</div></div><button class="secondary" data-action="use-smithy" ${state.me.gold < 2 ? 'disabled' : ''}>Használom</button></div>`);
    }
  }

  if (builtIds.has('museum')) {
    const museum = (state.me.built || []).find((district) => district.id === 'museum');
    const stored = Number(museum?.storedCardCount || 0);
    if (uses.museum) {
      blocks.push(`<div class="district-ability-row"><div><strong>Múzeum</strong><div class="muted small-text">${stored} lap alatta · ${stored} pont jelenleg</div></div><span class="badge good">✓ használva</span></div>`);
    } else if ((state.me.hand || []).length) {
      const options = state.me.hand.map((card) => `<option value="${card.cardId}">${escapeHtml(card.name)} (${card.cost} 🪙)</option>`).join('');
      blocks.push(`<div class="district-ability-row"><div><strong>Múzeum</strong><div class="muted small-text">Körönként 1 kézlapot tehetsz alá · minden alátett lap +1 pont a végén · jelenleg: ${stored}</div></div><div class="inline-control"><select id="museum-card">${options}</select><button class="secondary" data-action="use-museum">Lap alá helyezése</button></div></div>`);
    } else {
      blocks.push(`<div class="district-ability-row"><div><strong>Múzeum</strong><div class="muted small-text">${stored} lap alatta · nincs kézlap, amit alátehetnél</div></div></div>`);
    }
  }

  if (!blocks.length) return '';
  return `<section class="panel stack ability-panel"><div><p class="eyebrow">Egyedi kerületek</p><h2>Használható hatások</h2></div><div class="district-ability-list">${blocks.join('')}</div></section>`;
}

function renderTurns() {
  helpButton.classList.remove('hidden');
  const active = state.players.find((player) => player.id === state.turn.activePlayerId);
  const selfActive = state.turn.activePlayerId === state.me.id;
  const canEnd = selfActive && state.turn.action.resourceGathered && !state.turn.action.pendingDraw?.length;

  app.innerHTML = `${renderTopbar()}${roleCard()}${botActionsPanel()}${faceUpCharactersPanel()}${announcementsPanel()}<section class="panel status-banner"><div><p class="eyebrow">${state.finalRound ? 'Utolsó kör · ' : ''}${state.turn.index + 1}/${state.turn.total}</p><h2>${escapeHtml(active?.name || '—')} · ${state.turn.character.rank}. ${escapeHtml(state.turn.character.name)}</h2><p class="muted">${escapeHtml(state.turn.character.short)}</p></div>${selfActive ? `<button data-action="end-turn" ${canEnd ? '' : 'disabled'}>Kör vége</button>` : ''}</section>${resourcePanel()}${abilityPanel()}${districtAbilityPanel()}${handPanel({ build: true })}<div class="table-grid">${state.players.map(playerCard).join('')}</div>`;
}

function renderFinished() {
  helpButton.classList.remove('hidden');
  const byId = new Map(state.scores.map((score) => [score.playerId, score]));
  const typeLabels = new Map((state.districtTypes || []).map((type) => [type.id, type.label]));
  const rows = [...state.players]
    .sort((a, b) => (byId.get(b.id)?.total || 0) - (byId.get(a.id)?.total || 0))
    .map((player) => {
      const score = byId.get(player.id);
      const winner = player.id === state.winnerPlayerId;
      const haunted = score.hauntedQuarterType && score.hauntedQuarterType !== 'unique'
        ? `<small class="score-note">Kísértetváros: ${escapeHtml(typeLabels.get(score.hauntedQuarterType) || score.hauntedQuarterType)}</small>`
        : '';
      return `<div class="player-row score-line ${winner ? 'winner' : ''}"><div><strong>${winner ? '♛ ' : ''}${escapeHtml(player.name)}</strong>${haunted}</div><span class="score-number optional" title="Megépített kerületek pontjai">${score.districtPoints}</span><span class="score-number optional" title="Mind az öt kerülettípus bónusza">+${score.diversityBonus}</span><span class="score-number optional" title="Befejezett város bónusza">+${score.completionBonus}</span><span class="score-number optional" title="Egyedi kerületek automatikus bónuszpontjai">+${score.uniqueBonus || 0}</span><strong class="score-number" title="Összes pont">${score.total}</strong></div>`;
    }).join('');
  app.innerHTML = `${renderTopbar()}${handPanel()}<section class="panel stack"><h2>Eredmény</h2><p class="muted">A pontozás teljesen automatikus: az app számolja a kerületek értékét, az ötféle típust, a város befejezési bónuszát és a kiválasztott egyedi kerületek játékvégi pontjait. A Kísértetvárosnál automatikusan a legtöbb pontot adó szabályos típust használja.</p><div class="score-list">${rows}</div>${state.isHost ? '<div class="actions"><button data-action="start">Új játék ugyanebben a szobában</button><button class="secondary" data-action="leave-session">Új szoba létrehozása</button></div>' : '<div class="actions"><button class="secondary" data-action="leave-session">Kilépés / új szoba</button></div>'}</section>`;
}

function render() {
  if (!state) return renderHome();
  renderHelp();
  if (state.phase === 'lobby') renderLobby();
  else if (state.phase === 'draft') renderDraft();
  else if (state.phase === 'turns') renderTurns();
  else if (state.phase === 'finished') renderFinished();
}

function renderHelp() {
  if (!state?.characters) return;
  const characters = state.characters.map((role) => `<article class="help-item"><strong><span class="rank">${role.rank}</span>${escapeHtml(role.name)}</strong><p>${escapeHtml(role.detail)}</p></article>`).join('');
  const selected = new Set(state.selectedUniqueDistrictIds || []);
  const districts = (state.uniqueDistrictCatalog || []).map((district) => `<article class="help-item ${selected.has(district.id) ? 'selected-help' : ''}"><strong>${escapeHtml(district.name)} · ${district.cost} 🪙 ${selected.has(district.id) ? '<span class="badge good">ebben a játékban</span>' : ''}</strong><p>${escapeHtml(district.effect)}</p></article>`).join('');

  helpList.innerHTML = `
    <details class="rules-section" open>
      <summary>🎯 A játék célja és vége</summary>
      <div class="rules-body">
        <p>A cél a legértékesebb középkori város felépítése. A játék abban a körben ér véget, amelyben egy város először eléri a 7 kerületet; a teljes aktuális kör még lefut.</p>
        <p><strong>Pontozás:</strong> a felépített kerületek nyomtatott értéke, +3 pont ha mind az öt kerülettípusból van legalább egy, +4 pont az elsőként befejezett városnak, +2 pont minden más befejezett városnak, valamint az egyedi kerületek bónuszai. Az Emlékmű a város befejezésénél két kerületnek számít.</p>
      </div>
    </details>
    <details class="rules-section">
      <summary>🏗️ Előkészítés</summary>
      <div class="rules-body">
        <p>Az alkalmazás 4–8 résztvevővel játszik; a hiányzó helyeket szimulált játékosok tölthetik ki. Minden játékos 4 titkos kerületlapot és 2 aranyat kap. Az 54 alapkerület mellé pontosan 14 egyedi kerület kerül a pakliba.</p>
        <p>A koronás játékos kezdi a karakterválasztást. A sorrend az asztal körüli ülésrend, amit a lobbyban lehet beállítani.</p>
      </div>
    </details>
    <details class="rules-section">
      <summary>🎭 Karakterválasztási fázis</summary>
      <div class="rules-body">
        <p>A karakterpakliból a játékosszámtól függően bizonyos lapok nyíltan, egy lap pedig titkosan félrekerül. A 4-es rangú karakter nem kerülhet nyíltan félretett lapként az asztalra. A nyíltan félretett karakterek az egész körben láthatók.</p>
        <p>A koronás játékos választ először titokban, majd az ülésrend szerint következnek a többiek. Hét- és nyolcfős játékban az utolsó választó a megmaradt nyílt lehetőség és a kezdeti titkos félretett lap közül választhat.</p>
      </div>
    </details>
    <details class="rules-section">
      <summary>🔄 A köröd menete</summary>
      <div class="rules-body">
        <p>A karaktereket rang szerint, 1-től felfelé szólítják. Amikor a karaktered sorra kerül, felfeded és végrehajtod a körödet.</p>
        <ol>
          <li><strong>Nyersanyag:</strong> kötelezően választasz 2 aranyat, vagy húzol 2 kerületlapot és egyet megtartasz. Egyedi kerületek ezt módosíthatják, például az Aranybánya, Csillagvizsgáló vagy Könyvtár.</li>
          <li><strong>Karakterképesség:</strong> a karaktered képességét a megengedett időpontban, általában körönként egyszer használhatod.</li>
          <li><strong>Építés:</strong> normál esetben legfeljebb 1 kerületet építhetsz a kezedből az ár kifizetésével. Azonos nevű kerületből nem építhetsz még egyet, kivéve ha a Kőfejtő engedi. Az Építész legfeljebb 3 kerületet építhet.</li>
        </ol>
      </div>
    </details>
    <details class="rules-section">
      <summary>🏘️ Kerülettípusok és egyedi kerületek</summary>
      <div class="rules-body">
        <p>Öt típus van: <strong>nemesi, egyházi, kereskedelmi, katonai és egyedi</strong>. A színes kerülettípusokra több karakter bevételi képessége hivatkozik. Az egyedi kerületek külön szabályt adnak; hatásuk általában opcionális, kivéve ha a szöveg kötelezően fogalmaz.</p>
        <p class="muted">Az alábbi 30 egyedi kerületből a lobbyban 14 választható. A zöld jelölés mutatja az aktuális játék készletét.</p>
        <div class="help-card-grid">${districts}</div>
      </div>
    </details>
    <details class="rules-section">
      <summary>👑 Karakterek</summary>
      <div class="rules-body"><div class="help-card-grid">${characters}</div></div>
    </details>
    <details class="rules-section">
      <summary>🤖 Szimulált játékosok</summary>
      <div class="rules-body">
        <p>A botok teljes játékoshelyet foglalnak: titokban karaktert választanak, nyersanyagot vesznek fel és automatikusan építenek. A céljuk egyszerű, szabályos játék, nem tökéletes stratégia. A botok ugyanúgy lehetnek Orgyilkos, Tolvaj, Király stb., és a korona is kerülhet hozzájuk.</p>
      </div>
    </details>`;
}
function shouldRenderState(previousState, nextState) {
  if (!previousState) return true;
  return previousState.code !== nextState.code ||
    previousState.updatedAt !== nextState.updatedAt ||
    previousState.phase !== nextState.phase;
}

async function refresh() {
  if (!auth?.code) return;
  try {
    const nextState = await api(`/session/${encodeURIComponent(auth.code)}/state`);
    const shouldRender = shouldRenderState(state, nextState);
    state = nextState;
    if (shouldRender) render();
  } catch (err) {
    if (['session_not_found', 'auth_failed'].includes(err.code)) {
      stopPolling();
      saveAuth(null);
      state = null;
      renderHome();
      showToast(errors[err.code] || err.code);
    }
  }
}

function startPolling() {
  stopPolling();
  polling = setInterval(refresh, 1500);
}

function stopPolling() {
  if (polling) clearInterval(polling);
  polling = null;
}

async function createSession(form) {
  const data = new FormData(form);
  const result = await api('/session', {
    method: 'POST',
    body: JSON.stringify({ hostName: data.get('name') })
  });
  saveAuth({ code: result.code, playerId: result.playerId, token: result.token });
  history.replaceState(null, '', `${BASE}/${result.code}`);
  await refresh();
  startPolling();
}

async function joinSession(form) {
  const data = new FormData(form);
  const code = String(data.get('code') || '').trim();
  if (!/^\d{5}$/.test(code)) throw new Error('invalid_code');
  const result = await api(`/session/${code}/join`, {
    method: 'POST',
    body: JSON.stringify({ name: data.get('name') })
  });
  saveAuth({ code, playerId: result.playerId, token: result.token });
  history.replaceState(null, '', `${BASE}/${code}`);
  await refresh();
  startPolling();
}

function leaveSession() {
  stopPolling();
  saveAuth(null);
  state = null;
  history.replaceState(null, '', `${BASE}/`);
  renderHome();
}

async function post(path, body = {}) {
  await api(path, { method: 'POST', body: JSON.stringify(body) });
  await refresh();
}

app.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  try {
    if (form.id === 'create-form') await createSession(form);
    else if (form.id === 'join-form') await joinSession(form);
    else if (form.id === 'bot-form') {
      const data = new FormData(form);
      await post(`/session/${state.code}/bots`, { count: Number(data.get('count')) });
    } else if (form.id === 'district-config-form') {
      const data = new FormData(form);
      const districtIds = data.getAll('districtId').map(String);
      if (districtIds.length !== 14) {
        throw Object.assign(
          new Error('unique_district_selection_count'),
          { code: 'unique_district_selection_count' }
        );
      }
      await post(`/session/${state.code}/config/unique-districts`, { districtIds });
    }
  } catch (err) {
    showToast(errors[err.code] || (err.message === 'invalid_code'
      ? 'A szobakód öt számjegyből áll.'
      : err.code || err.message));
  }
});

app.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button || !state) return;
  const action = button.dataset.action;

  try {
    if (action === 'leave-session') {
      if (!confirm('Kilépsz ebből a szobából? A böngésző nem fog automatikusan visszalépni ide.')) return;
      leaveSession();
    } else if (action === 'finish-game') {
      if (!confirm('Biztosan befejezed a játékot? Mindenki a végeredmény képernyőre kerül.')) return;
      await post(`/session/${state.code}/finish`);
    } else if (action === 'default-unique') {
      await post(`/session/${state.code}/config/unique-districts`, {
        districtIds: state.defaultUniqueDistrictIds
      });
    } else if (action === 'start') {
      await post(`/session/${state.code}/start`);
    } else if (action === 'crown') {
      await post(`/session/${state.code}/crown`, { playerId: button.dataset.player });
    } else if (action === 'move-up' || action === 'move-down') {
      const ids = state.players.map((player) => player.id);
      const index = ids.indexOf(button.dataset.player);
      const swap = action === 'move-up' ? index - 1 : index + 1;
      [ids[index], ids[swap]] = [ids[swap], ids[index]];
      await post(`/session/${state.code}/reorder`, { playerIds: ids });
    } else if (action === 'choose-character') {
      await post(`/session/${state.code}/draft/choose`, {
        characterId: button.dataset.character
      });
    } else if (action === 'take-resource') {
      await post(`/session/${state.code}/turn/resource`, { mode: button.dataset.mode });
    } else if (action === 'keep-drawn-card') {
      await post(`/session/${state.code}/turn/resource/keep`, { cardId: button.dataset.card });
    } else if (action === 'build-card') {
      await post(`/session/${state.code}/turn/build`, { cardId: button.dataset.card });
    } else if (action === 'ability-target-character') {
      await post(`/session/${state.code}/turn/ability`, {
        action: 'target-character',
        targetCharacterId: button.dataset.character
      });
    } else if (action === 'magician-swap') {
      await post(`/session/${state.code}/turn/ability`, {
        action: 'swap-hands',
        targetPlayerId: button.dataset.player
      });
    } else if (action === 'magician-redraw') {
      const cardIds = [...document.querySelectorAll('input[name="magician-card"]:checked')]
        .map((input) => input.value);
      await post(`/session/${state.code}/turn/ability`, {
        action: 'redraw',
        cardIds
      });
    } else if (action === 'ability-income') {
      await post(`/session/${state.code}/turn/ability`, { action: 'income' });
    } else if (action === 'use-laboratory') {
      const select = document.getElementById('laboratory-card');
      if (!select?.value) throw new Error('cards_required');
      await post(`/session/${state.code}/turn/district-ability`, {
        districtId: 'laboratory',
        cardId: select.value
      });
    } else if (action === 'use-smithy') {
      await post(`/session/${state.code}/turn/district-ability`, {
        districtId: 'smithy'
      });
    } else if (action === 'use-museum') {
      const select = document.getElementById('museum-card');
      if (!select?.value) throw new Error('cards_required');
      await post(`/session/${state.code}/turn/district-ability`, {
        districtId: 'museum',
        cardId: select.value
      });
    } else if (action === 'warlord-destroy') {
      if (!confirm('Biztosan elpusztítod ezt a kerületet?')) return;
      await post(`/session/${state.code}/turn/ability`, {
        action: 'destroy-district',
        cardId: button.dataset.card
      });
    } else if (action === 'gold') {
      await post(`/session/${state.code}/gold`, {
        playerId: button.dataset.player,
        delta: Number(button.dataset.delta)
      });
    } else if (action === 'end-turn') {
      await post(`/session/${state.code}/turn/end`);
    } else if (action === 'delete-district') {
      if (!confirm('Admin javításként törlöd ezt a kerületet az asztalról?')) return;
      await api(`/session/${state.code}/district/${encodeURIComponent(button.dataset.district)}`, {
        method: 'DELETE'
      });
      await refresh();
    }
  } catch (err) {
    showToast(errors[err.code] || err.code || err.message);
  }
});

app.addEventListener('change', (event) => {
  if (!event.target.matches('#district-config-form input[name="districtId"]')) return;
  const form = document.getElementById('district-config-form');
  const count = form ? form.querySelectorAll('input[name="districtId"]:checked').length : 0;
  const badge = document.getElementById('unique-count');
  if (badge) badge.textContent = `${count}/14`;
});

helpButton.addEventListener('click', () => helpDialog.showModal());
helpClose.addEventListener('click', () => helpDialog.close());
helpDialog.addEventListener('click', (event) => {
  if (event.target === helpDialog) helpDialog.close();
});

(async function bootstrap() {
  if (auth?.code) {
    await refresh();
    if (state) startPolling();
  } else {
    renderHome();
  }
})();
