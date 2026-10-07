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
  active_player_only: 'Ezt most csak az aktív játékos vagy a házigazda teheti meg.',
  not_current_drafter: 'Most nem te választasz karaktert.',
  character_unavailable: 'Ez a karakter már nem választható.',
  invalid_gold_total: 'Ennyi arany nem állítható be.',
  game_not_active: 'A játék még nem fut.',
  turn_not_active: 'Nincs aktív kör.',
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
  return String(value ?? '').replace(/[&<>'"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}

function phaseLabel(phase) {
  return ({ lobby: 'Váróterem', draft: 'Karakterválasztás', turns: 'Játékkör', finished: 'Játék vége' })[phase] || phase;
}

function typeInfo(type) {
  return state?.districtTypes?.find((item) => item.id === type) || { id: type, label: type, symbol: '?' };
}

function renderTopbar() {
  if (!state) return '';
  return `<div class="topbar"><div class="brand"><p class="eyebrow">${escapeHtml(phaseLabel(state.phase))} · ${state.round ? `${state.round}. kör` : 'előkészület'}</p><h1>Citadella</h1></div><div class="code-badge" title="Szobakód">${escapeHtml(state.code)}</div></div>`;
}

function roleCard() {
  const role = state?.me?.character || state?.draft?.myChoice;
  if (!role) return '';
  return `<section class="panel role-card"><div class="role-title"><span class="role-rank">${role.rank}</span><div><p class="eyebrow">A karaktered</p><h2>${escapeHtml(role.name)}</h2></div></div><p>${escapeHtml(role.short)}</p><p class="muted">${escapeHtml(role.detail)}</p></section>`;
}

function renderHome() {
  helpButton.classList.add('hidden');
  const code = requestedCode();
  app.innerHTML = `<section class="hero"><div class="brand"><p class="eyebrow">Játékszoba</p><h1>Citadella</h1><p class="muted">Telefonos asztal és karaktersegédlet. A kerületlapok maradhatnak fizikailag az asztalon; az app a nyílt állapotot, a karakterválasztást és a köröket kezeli.</p></div><div class="grid-2"><form id="create-form" class="panel stack"><h2>Új játék</h2><label>Név<input name="name" maxlength="32" autocomplete="name" required></label><button type="submit">Szoba létrehozása</button><p class="muted">4–8 játékos, ötjegyű szobakóddal.</p></form><form id="join-form" class="panel stack"><h2>Csatlakozás</h2><label>Név<input name="name" maxlength="32" autocomplete="name" required></label><label>Szobakód<input name="code" inputmode="numeric" pattern="[0-9]{5}" maxlength="5" value="${escapeHtml(code)}" required></label><button type="submit">Belépés</button></form></div></section>`;
}

function lobbyRow(player, index) {
  const crowned = player.isCrowned ? '<span class="badge crown">♛ korona</span>' : '';
  const host = player.isHost ? '<span class="badge">házigazda</span>' : '';
  const controls = state.isHost ? `<div class="actions"><button class="ghost" data-action="move-up" data-player="${player.id}" ${index === 0 ? 'disabled' : ''}>↑</button><button class="ghost" data-action="move-down" data-player="${player.id}" ${index === state.players.length - 1 ? 'disabled' : ''}>↓</button><button class="secondary" data-action="crown" data-player="${player.id}">♛</button></div>` : '';
  return `<div class="player-row"><div><strong>${escapeHtml(player.name)}</strong><div class="meta">${host}${crowned}</div></div>${controls}</div>`;
}

function renderLobby() {
  helpButton.classList.remove('hidden');
  const countOk = state.players.length >= 4 && state.players.length <= 8;
  app.innerHTML = `${renderTopbar()}<div class="grid-2"><section class="panel stack"><div><h2>Játékosok (${state.players.length}/8)</h2><p class="muted">A sorrend az asztal körüli ülésrendet jelenti. A koronát annak add, aki az első karaktert választja.</p></div><div class="lobby-list">${state.players.map(lobbyRow).join('')}</div>${state.isHost ? `<button data-action="start" ${countOk ? '' : 'disabled'}>Játék indítása</button>${countOk ? '' : '<p class="notice">Az induláshoz 4–8 játékos kell.</p>'}` : '<p class="muted">A házigazda indítja a játékot.</p>'}</section><section class="panel stack"><h2>Hogyan használjátok?</h2><p>A karaktereket az app titokban osztja és a rangjuk szerint vezeti a köröket. Az arany és a megépített kerületek mindenkinél látszanak.</p><p>A kerületlapokat nem kell digitalizálni: építéskor add meg a nevét, típusát és költségét. Így a különleges lapok szövegét továbbra is a fizikai kártyáról használjátok.</p><p class="muted">A ? gombon mindig eléred a játékban lévő karakterek képességeit.</p></section></div>`;
}

function renderDraft() {
  helpButton.classList.remove('hidden');
  const current = state.players.find((p) => p.id === state.draft.currentPlayerId);
  const myTurn = state.draft.currentPlayerId === state.me.id;
  const options = state.draft.options.map((role) => `<button class="character-option" data-action="choose-character" data-character="${role.id}"><strong>${role.rank}. ${escapeHtml(role.name)}</strong><small>${escapeHtml(role.short)}</small></button>`).join('');
  const faceUp = state.draft.faceUp.length ? state.draft.faceUp.map((role) => `<span class="badge">${role.rank}. ${escapeHtml(role.name)}</span>`).join('') : '<span class="muted">Nincs képpel felfelé félretett karakter.</span>';
  app.innerHTML = `${renderTopbar()}${roleCard()}<section class="panel stack"><div class="status-banner"><div><p class="eyebrow">Most választ</p><h2>${escapeHtml(current?.name || '—')}</h2></div><span class="badge">${state.draft.availableCount} lehetőség</span></div><div><p class="eyebrow">Nyíltan félretett karakterek</p><div class="face-up">${faceUp}</div></div>${myTurn ? `<div><p class="eyebrow">Válassz titokban egy karaktert</p><div class="draft-grid">${options}</div></div>` : `<p class="muted">Várj, amíg ${escapeHtml(current?.name || 'a következő játékos')} választ.</p>`}</section>`;
}

function districtChip(district, player) {
  const type = typeInfo(district.type);
  const canDelete = state.isHost || player.id === state.me.id;
  return `<span class="district" title="${escapeHtml(type.label)}"><span class="type-dot type-${escapeHtml(type.id)}">${escapeHtml(type.symbol)}</span><span class="name">${escapeHtml(district.name)}</span><span class="cost">${district.cost}${district.beautified ? '+1' : ''}</span>${canDelete ? `<button data-action="delete-district" data-district="${district.id}" aria-label="Kerület törlése">×</button>` : ''}</span>`;
}

function playerCard(player) {
  const active = state.turn?.activePlayerId === player.id;
  const role = player.character ? `<span class="badge">${player.character.rank}. ${escapeHtml(player.character.name)}</span>` : '';
  const controls = state.canAdminPublicState ? `<div class="gold-controls"><button class="ghost" data-action="gold" data-player="${player.id}" data-delta="-2">−2</button><button class="ghost" data-action="gold" data-player="${player.id}" data-delta="-1">−1</button><button class="secondary" data-action="gold" data-player="${player.id}" data-delta="1">+1</button><button class="secondary" data-action="gold" data-player="${player.id}" data-delta="2">+2</button></div>` : '';
  return `<section class="panel player-card ${active ? 'active' : ''} ${player.id === state.me.id ? 'me' : ''}"><div class="player-head"><div><div class="player-name">${escapeHtml(player.name)}</div><div class="meta">${player.isCrowned ? '<span class="badge crown">♛</span>' : ''}${player.isHost ? '<span class="badge">host</span>' : ''}${role}</div></div><span class="badge">${player.built.length} kerület</span></div><div class="gold-line">🪙 ${player.gold} arany</div>${controls}<div class="districts">${player.built.map((d) => districtChip(d, player)).join('') || '<span class="muted">Még nincs megépített kerület.</span>'}</div></section>`;
}

function buildForm() {
  const activeSelf = state.turn?.activePlayerId === state.me.id;
  if (!activeSelf && !state.isHost) return '';
  const options = state.districtTypes.map((t) => `<option value="${t.id}">${escapeHtml(t.label)}</option>`).join('');
  return `<form id="build-form" class="panel build-form"><label>Kerület neve<input name="name" maxlength="48" placeholder="pl. Piac" required></label><label>Típus<select name="type">${options}</select></label><label>Költség<input name="cost" type="number" min="0" max="9" value="1" required></label><button type="submit">Megépítve</button></form>`;
}

function renderTurns() {
  helpButton.classList.remove('hidden');
  const active = state.players.find((p) => p.id === state.turn.activePlayerId);
  const selfActive = state.turn.activePlayerId === state.me.id;
  app.innerHTML = `${renderTopbar()}${roleCard()}<section class="panel status-banner"><div><p class="eyebrow">${state.finalRound ? 'Utolsó kör · ' : ''}${state.turn.index + 1}/${state.turn.total}</p><h2>${escapeHtml(active?.name || '—')} · ${state.turn.character.rank}. ${escapeHtml(state.turn.character.name)}</h2><p class="muted">${escapeHtml(state.turn.character.short)}</p></div>${selfActive || state.isHost ? '<button data-action="end-turn">Kör vége</button>' : ''}</section>${buildForm()}<div class="table-grid">${state.players.map(playerCard).join('')}</div>`;
}

function renderFinished() {
  helpButton.classList.remove('hidden');
  const byId = new Map(state.scores.map((score) => [score.playerId, score]));
  const rows = [...state.players].sort((a, b) => (byId.get(b.id)?.total || 0) - (byId.get(a.id)?.total || 0)).map((player) => {
    const score = byId.get(player.id);
    const winner = player.id === state.winnerPlayerId;
    return `<div class="player-row score-line ${winner ? 'winner' : ''}"><strong>${winner ? '♛ ' : ''}${escapeHtml(player.name)}</strong><span class="score-number optional" title="Kerületek">${score.districtPoints}</span><span class="score-number optional" title="Típusbónusz">+${score.diversityBonus}</span><span class="score-number optional" title="Befejezés">+${score.completionBonus}</span><span class="score-number" title="Egyedi kerületek kézzel megadott bónusza">${score.manualBonus >= 0 ? '+' : ''}${score.manualBonus}</span><strong class="score-number">${score.total}</strong></div>`;
  }).join('');
  const myScore = byId.get(state.me.id);
  app.innerHTML = `${renderTopbar()}<section class="panel stack"><h2>Eredmény</h2><p class="muted">A kerületköltség, az öt típusért járó +3, valamint a város befejezésének bónusza automatikus. Az egyedi kerületek további pontjait add meg kézzel.</p><div class="score-list">${rows}</div><form id="bonus-form" class="actions"><label>Egyedi kerületek bónuszpontja<input name="points" type="number" min="-999" max="999" value="${myScore?.manualBonus || 0}"></label><button type="submit">Saját bónusz mentése</button></form>${state.isHost ? '<div class="actions"><button data-action="start">Új játék ugyanebben a szobában</button></div>' : ''}</section>`;
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
  helpList.innerHTML = state.characters.map((role) => `<article class="help-item"><strong><span class="rank">${role.rank}</span>${escapeHtml(role.name)}</strong><p>${escapeHtml(role.detail)}</p></article>`).join('');
}

async function refresh() {
  if (!auth?.code) return;
  try {
    state = await api(`/session/${encodeURIComponent(auth.code)}/state`);
    render();
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
  const result = await api('/session', { method: 'POST', body: JSON.stringify({ hostName: data.get('name') }) });
  saveAuth({ code: result.code, playerId: result.playerId, token: result.token });
  history.replaceState(null, '', `${BASE}/${result.code}`);
  await refresh(); startPolling();
}

async function joinSession(form) {
  const data = new FormData(form);
  const code = String(data.get('code') || '').trim();
  if (!/^\d{5}$/.test(code)) throw new Error('invalid_code');
  const result = await api(`/session/${code}/join`, { method: 'POST', body: JSON.stringify({ name: data.get('name') }) });
  saveAuth({ code, playerId: result.playerId, token: result.token });
  history.replaceState(null, '', `${BASE}/${code}`);
  await refresh(); startPolling();
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
    else if (form.id === 'build-form') {
      const data = new FormData(form);
      await post(`/session/${state.code}/district`, { name: data.get('name'), type: data.get('type'), cost: Number(data.get('cost')) });
      form.reset();
    } else if (form.id === 'bonus-form') {
      const data = new FormData(form);
      await post(`/session/${state.code}/score/bonus`, { points: Number(data.get('points')) });
    }
  } catch (err) { showToast(errors[err.code] || (err.message === 'invalid_code' ? 'A szobakód öt számjegyből áll.' : err.code || err.message)); }
});

app.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button || !state) return;
  const action = button.dataset.action;
  try {
    if (action === 'start') await post(`/session/${state.code}/start`);
    else if (action === 'crown') await post(`/session/${state.code}/crown`, { playerId: button.dataset.player });
    else if (action === 'move-up' || action === 'move-down') {
      const ids = state.players.map((p) => p.id);
      const index = ids.indexOf(button.dataset.player);
      const swap = action === 'move-up' ? index - 1 : index + 1;
      [ids[index], ids[swap]] = [ids[swap], ids[index]];
      await post(`/session/${state.code}/reorder`, { playerIds: ids });
    } else if (action === 'choose-character') await post(`/session/${state.code}/draft/choose`, { characterId: button.dataset.character });
    else if (action === 'gold') await post(`/session/${state.code}/gold`, { playerId: button.dataset.player, delta: Number(button.dataset.delta) });
    else if (action === 'end-turn') await post(`/session/${state.code}/turn/end`);
    else if (action === 'delete-district') {
      if (!confirm('Törlöd ezt a kerületet az asztalról?')) return;
      await api(`/session/${state.code}/district/${encodeURIComponent(button.dataset.district)}`, { method: 'DELETE' });
      await refresh();
    }
  } catch (err) { showToast(errors[err.code] || err.code || err.message); }
});

helpButton.addEventListener('click', () => helpDialog.showModal());
helpClose.addEventListener('click', () => helpDialog.close());
helpDialog.addEventListener('click', (event) => { if (event.target === helpDialog) helpDialog.close(); });

(async function bootstrap() {
  if (auth?.code) {
    await refresh();
    if (state) startPolling();
  } else renderHome();
})();
