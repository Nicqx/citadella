'use strict';

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('redis');
const {
  DISTRICT_TYPES,
  CHARACTERS,
  CHARACTER_MAP,
  inUseCharacters,
  createDraft,
  draftOptions,
  chooseCharacter,
  turnOrderFromChoices,
  scorePlayer
} = require('./game');
const {
  createDistrictDeck,
  districtPublic,
  drawCards,
  putOnDeckBottom,
  effectiveBuildCost,
  canBuildDuplicate
} = require('./districts');

const PORT = Number(process.env.PORT || 8106);
const BASE_PATH = normalizeBasePath(process.env.BASE_PATH || '/citadella');
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const SESSION_TTL_SECONDS = Math.max(900, Number(process.env.SESSION_TTL_SECONDS || 21600));
const MAX_GOLD = 999;
const MAX_BONUS = 999;

const app = express();
const api = express.Router();
const redis = createClient({ url: REDIS_URL });
const locks = new Map();

redis.on('error', (err) => console.error('[redis] error:', err));
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'");
  next();
});

function normalizeBasePath(value) {
  if (!value || value === '/') return '';
  let result = String(value).trim();
  if (!result.startsWith('/')) result = `/${result}`;
  if (result.endsWith('/')) result = result.slice(0, -1);
  return result;
}

function sessionKey(code) { return `citadella:session:${code}`; }
function now() { return Date.now(); }
function id(prefix) { return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`; }
function makeToken() { return crypto.randomBytes(32).toString('hex'); }
function hashToken(token) { return crypto.createHash('sha256').update(String(token || '')).digest('hex'); }
function randomCode() { return String(crypto.randomInt(10000, 100000)); }

function httpError(status, code, details) {
  const err = new Error(code);
  err.status = status;
  err.code = code;
  if (details) err.details = details;
  return err;
}

function sanitizeName(value) {
  const name = String(value || '').trim().replace(/\s+/g, ' ').slice(0, 32);
  if (!name) throw httpError(400, 'name_required');
  return name;
}

function sanitizeDistrictName(value) {
  const name = String(value || '').trim().replace(/\s+/g, ' ').slice(0, 48);
  return name || 'Kerület';
}

function sanitizeType(value) {
  const type = String(value || '');
  if (!DISTRICT_TYPES.some((item) => item.id === type)) throw httpError(400, 'invalid_district_type');
  return type;
}

function sanitizeCost(value) {
  const cost = Number(value);
  if (!Number.isInteger(cost) || cost < 0 || cost > 9) throw httpError(400, 'invalid_district_cost');
  return cost;
}

function clampInt(value, min, max, errorCode) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw httpError(400, errorCode);
  return number;
}

function timingSafeTokenEqual(actualHash, token) {
  const incomingHash = hashToken(token);
  const a = Buffer.from(String(actualHash || ''), 'hex');
  const b = Buffer.from(incomingHash, 'hex');
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function ensurePlayerFields(player) {
  if (!Array.isArray(player.built)) player.built = [];
  if (!Array.isArray(player.hand)) player.hand = [];
  if (!Number.isInteger(player.gold)) player.gold = Number(player.gold || 0);
  if (!Number.isInteger(player.manualBonus)) player.manualBonus = Number(player.manualBonus || 0);
  return player;
}

function ensureRoundEffects(session) {
  if (!session.roundEffects || typeof session.roundEffects !== 'object') {
    session.roundEffects = {
      assassinatedCharacterId: null,
      thiefTargetCharacterId: null,
      thiefPlayerId: null
    };
  }
  return session.roundEffects;
}

function ensureSessionFields(session) {
  if (!session) return session;
  session.players.forEach(ensurePlayerFields);
  if (!Array.isArray(session.districtDeck)) session.districtDeck = [];
  if (!Array.isArray(session.roundFaceUpCharacterIds)) session.roundFaceUpCharacterIds = [];
  ensureRoundEffects(session);
  return session;
}

async function loadSession(code) {
  const raw = await redis.get(sessionKey(code));
  return raw ? ensureSessionFields(JSON.parse(raw)) : null;
}

async function saveSession(session) {
  ensureSessionFields(session);
  session.updatedAt = now();
  await redis.setEx(sessionKey(session.code), SESSION_TTL_SECONDS, JSON.stringify(session));
}

async function ttl(code) {
  const value = await redis.ttl(sessionKey(code));
  return value > 0 ? value : null;
}

async function withLock(code, fn) {
  const previous = (locks.get(code) || Promise.resolve()).catch(() => undefined);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  locks.set(code, tail);
  await previous;
  try { return await fn(); }
  finally {
    release();
    if (locks.get(code) === tail) locks.delete(code);
  }
}

async function generateUniqueCode() {
  for (let i = 0; i < 50; i += 1) {
    const code = randomCode();
    if (!(await redis.exists(sessionKey(code)))) return code;
  }
  throw httpError(503, 'code_generation_failed');
}

function requireSession(session) {
  if (!session) throw httpError(404, 'session_not_found');
  return session;
}

function getPlayer(session, playerId) { return session.players.find((p) => p.id === playerId); }

function authPlayer(session, req) {
  const playerId = String(req.get('x-player-id') || '');
  const token = String(req.get('x-player-token') || '');
  const player = getPlayer(session, playerId);
  if (!player || !timingSafeTokenEqual(player.tokenHash, token)) throw httpError(401, 'auth_failed');
  return player;
}

function requireHost(session, actor) {
  if (actor.id !== session.hostPlayerId) throw httpError(403, 'host_only');
}

function sortedPlayers(session) { return [...session.players].sort((a, b) => a.seatIndex - b.seatIndex); }

function activeTurn(session) {
  if (session.phase !== 'turns' || !session.turn) return null;
  return session.turn.order[session.turn.index] || null;
}

function activeAction(session) {
  if (!session.turn || !session.turn.action) return null;
  return session.turn.action;
}

function requireActiveActor(session, actor) {
  if (session.phase !== 'turns') throw httpError(409, 'turn_not_active');
  const current = activeTurn(session);
  if (!current || current.playerId !== actor.id) throw httpError(403, 'active_player_only');
  return current;
}

function canAdminPublicState(session, actor) {
  const turn = activeTurn(session);
  return actor.id === session.hostPlayerId || (turn && turn.playerId === actor.id);
}

function characterPublic(idValue) {
  const character = CHARACTER_MAP.get(idValue);
  if (!character) return null;
  return {
    id: character.id,
    rank: character.rank,
    name: character.name,
    short: character.short,
    detail: character.detail
  };
}

function playerView(session, player, actor) {
  ensurePlayerFields(player);
  const self = player.id === actor.id;
  const revealed = session.turn?.revealedPlayerIds?.includes(player.id) || session.phase === 'finished';
  const canSeeCharacter = self || revealed;
  return {
    id: player.id,
    name: player.name,
    seatIndex: player.seatIndex,
    gold: player.gold,
    built: player.built.map(districtPublic),
    handCount: player.hand.length,
    ...(self ? { hand: player.hand.map(districtPublic) } : {}),
    manualBonus: session.phase === 'finished' ? player.manualBonus : undefined,
    character: canSeeCharacter && player.characterId ? characterPublic(player.characterId) : null,
    hasCharacter: Boolean(player.characterId),
    isCrowned: player.id === session.crownPlayerId,
    isHost: player.id === session.hostPlayerId
  };
}

function turnActionView(session, actor) {
  const action = activeAction(session);
  if (!action) return null;
  const current = activeTurn(session);
  const selfActive = current?.playerId === actor.id;
  return {
    resourceGathered: Boolean(action.resourceGathered),
    builds: Number(action.builds || 0),
    buildLimit: current?.characterId === 'architect' ? 3 : 1,
    incomeUsed: Boolean(action.incomeUsed),
    specialUsed: Boolean(action.specialUsed),
    destructionUsed: Boolean(action.destructionUsed),
    districtUses: selfActive ? { ...(action.districtUses || {}) } : {},
    pendingDraw: selfActive ? (action.pendingDraw || []).map(districtPublic) : []
  };
}

function stateView(session, actor, ttlSeconds) {
  ensureSessionFields(session);
  const draft = session.draft;
  const currentDraftPlayerId = session.phase === 'draft' && draft ? draft.order[draft.index] : null;
  const meIsDrafter = currentDraftPlayerId === actor.id;
  const turn = activeTurn(session);
  const characters = (session.players.length >= 4 ? inUseCharacters(session.players.length) : CHARACTERS.filter((c) => c.rank <= 8))
    .map((c) => characterPublic(c.id));
  const scores = session.phase === 'finished'
    ? sortedPlayers(session).map((p) => ({
      playerId: p.id,
      ...scorePlayer(p, session),
      lastCharacterRank: CHARACTER_MAP.get(p.characterId)?.rank || 0
    }))
    : [];
  const effects = ensureRoundEffects(session);

  return {
    code: session.code,
    phase: session.phase,
    round: session.round,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ttlSeconds,
    hostPlayerId: session.hostPlayerId,
    crownPlayerId: session.crownPlayerId,
    firstCompletedPlayerId: session.firstCompletedPlayerId,
    finalRound: Boolean(session.finalRound),
    deckCount: session.districtDeck.length,
    faceUpCharacters: (draft ? draft.faceUpIds : session.roundFaceUpCharacterIds).map(characterPublic).filter(Boolean),
    me: playerView(session, actor, actor),
    isHost: actor.id === session.hostPlayerId,
    canAdminPublicState: canAdminPublicState(session, actor),
    players: sortedPlayers(session).map((p) => playerView(session, p, actor)),
    characters,
    districtTypes: DISTRICT_TYPES,
    roundEffects: {
      assassinatedCharacterId: effects.assassinatedCharacterId || null,
      thiefTargetCharacterId: effects.thiefTargetCharacterId || null
    },
    draft: draft ? {
      currentPlayerId: currentDraftPlayerId,
      faceUp: draft.faceUpIds.map(characterPublic),
      hiddenDiscardCount: 1 + (draft.finalDiscardId ? 1 : 0),
      availableCount: draftOptions(draft).length,
      options: meIsDrafter ? draftOptions(draft).map(characterPublic) : [],
      myChoice: draft.choices[actor.id] ? characterPublic(draft.choices[actor.id]) : null
    } : null,
    turn: turn ? {
      activePlayerId: turn.playerId,
      character: characterPublic(turn.characterId),
      index: session.turn.index,
      total: session.turn.order.length,
      action: turnActionView(session, actor)
    } : null,
    scores,
    winnerPlayerId: session.winnerPlayerId || null
  };
}

function initializePlayerForGame(player) {
  player.gold = 2;
  player.built = [];
  player.hand = [];
  player.characterId = null;
  player.manualBonus = 0;
}

function setupDistrictDeck(session) {
  session.districtDeck = createDistrictDeck();
  for (const player of sortedPlayers(session)) {
    player.hand.push(...drawCards(session, 4));
  }
}

function prepareDraft(session) {
  session.players.forEach((p) => { p.characterId = null; });
  session.roundFaceUpCharacterIds = [];
  session.draft = createDraft(sortedPlayers(session), session.crownPlayerId);
  session.turn = null;
  session.phase = 'draft';
  session.roundEffects = {
    assassinatedCharacterId: null,
    thiefTargetCharacterId: null,
    thiefPlayerId: null
  };
}

function beginTurns(session) {
  session.roundFaceUpCharacterIds = [...session.draft.faceUpIds];
  for (const [playerId, characterId] of Object.entries(session.draft.choices)) {
    const player = getPlayer(session, playerId);
    if (player) player.characterId = characterId;
  }
  const order = turnOrderFromChoices(session.draft.choices);
  session.turn = {
    order,
    index: 0,
    revealedPlayerIds: [],
    skippedPlayerIds: [],
    action: null
  };
  session.phase = 'turns';
  session.draft = null;
  activateCurrentTurn(session);
}

function areAdjacent(session, playerAId, playerBId) {
  const players = sortedPlayers(session);
  const a = players.findIndex((p) => p.id === playerAId);
  const b = players.findIndex((p) => p.id === playerBId);
  if (a < 0 || b < 0 || players.length < 2) return false;
  return ((a + 1) % players.length === b) || ((b + 1) % players.length === a);
}

function applyTurnStartEffects(session, current) {
  const actor = getPlayer(session, current.playerId);
  const effects = ensureRoundEffects(session);

  if (effects.thiefTargetCharacterId === current.characterId && effects.thiefPlayerId) {
    const thief = getPlayer(session, effects.thiefPlayerId);
    if (thief && thief.id !== actor.id) {
      thief.gold += actor.gold;
      actor.gold = 0;
    }
  }

  if (current.characterId === 'king') {
    session.crownPlayerId = current.playerId;
  } else if (current.characterId === 'merchant') {
    actor.gold = Math.min(MAX_GOLD, actor.gold + 1);
  } else if (current.characterId === 'architect') {
    actor.hand.push(...drawCards(session, 2));
  } else if (current.characterId === 'queen') {
    const kingEntry = session.turn.order.find((entry) => entry.characterId === 'king');
    if (kingEntry && effects.assassinatedCharacterId !== 'king' && areAdjacent(session, current.playerId, kingEntry.playerId)) {
      actor.gold = Math.min(MAX_GOLD, actor.gold + 3);
    }
  }
}

function activateCurrentTurn(session) {
  while (session.turn && session.turn.index < session.turn.order.length) {
    const current = activeTurn(session);
    if (!current) break;
    const effects = ensureRoundEffects(session);

    if (effects.assassinatedCharacterId === current.characterId) {
      if (!session.turn.skippedPlayerIds.includes(current.playerId)) {
        session.turn.skippedPlayerIds.push(current.playerId);
      }
      session.turn.index += 1;
      continue;
    }

    if (!session.turn.revealedPlayerIds.includes(current.playerId)) {
      session.turn.revealedPlayerIds.push(current.playerId);
    }
    session.turn.action = {
      playerId: current.playerId,
      resourceGathered: false,
      builds: 0,
      incomeUsed: false,
      specialUsed: false,
      destructionUsed: false,
      districtUses: {},
      pendingDraw: []
    };
    applyTurnStartEffects(session, current);
    return;
  }

  if (session.turn) completeRound(session);
}

function calculateWinner(session) {
  const ranked = sortedPlayers(session).map((p) => {
    const score = scorePlayer(p, session);
    return {
      playerId: p.id,
      total: score.total,
      rank: CHARACTER_MAP.get(p.characterId)?.rank || 0
    };
  }).sort((a, b) => b.total - a.total || b.rank - a.rank);
  return ranked[0]?.playerId || null;
}

function finishGame(session) {
  session.phase = 'finished';
  session.draft = null;
  session.turn = null;
  session.winnerPlayerId = calculateWinner(session);
}

function completeRound(session) {
  const effects = ensureRoundEffects(session);
  if (effects.assassinatedCharacterId === 'king') {
    const killedKing = session.players.find((p) => p.characterId === 'king');
    if (killedKing) session.crownPlayerId = killedKing.id;
  }

  if (session.finalRound) {
    finishGame(session);
  } else {
    session.round += 1;
    prepareDraft(session);
  }
}

function endCurrentTurn(session) {
  if (!session.turn) throw httpError(409, 'turn_not_active');
  const action = activeAction(session);
  if (!action?.resourceGathered) throw httpError(409, 'resource_required');
  if (action.pendingDraw?.length) throw httpError(409, 'draw_choice_required');

  session.turn.index += 1;
  if (session.turn.index >= session.turn.order.length) completeRound(session);
  else activateCurrentTurn(session);
}

function hasDistrict(player, districtId) {
  return player.built.some((district) => district.id === districtId);
}

function characterIncome(actor, characterId) {
  const typeByCharacter = {
    king: 'noble',
    bishop: 'religious',
    merchant: 'trade',
    warlord: 'military'
  };
  const type = typeByCharacter[characterId];
  if (!type) return 0;
  let amount = actor.built.filter((district) => district.type === type).length;
  if (hasDistrict(actor, 'school-of-magic')) amount += 1;
  return amount;
}

function findBuiltDistrict(session, districtCardId) {
  for (const owner of session.players) {
    const index = owner.built.findIndex((district) => district.cardId === districtCardId);
    if (index >= 0) return { owner, index, district: owner.built[index] };
  }
  return null;
}

function inUseCharacterIds(session) {
  return new Set(inUseCharacters(session.players.length).map((character) => character.id));
}

function targetableCharacterIds(session, actingCharacterId) {
  const ids = inUseCharacterIds(session);
  for (const characterId of session.roundFaceUpCharacterIds || []) ids.delete(characterId);

  if (actingCharacterId === 'assassin') {
    ids.delete('assassin');
  } else if (actingCharacterId === 'thief') {
    ids.delete('assassin');
    ids.delete('thief');
    ids.delete(ensureRoundEffects(session).assassinatedCharacterId);
  }
  return ids;
}

api.post('/session', async (req, res, next) => {
  try {
    const code = await generateUniqueCode();
    const name = sanitizeName(req.body.hostName);
    const token = makeToken();
    const playerId = id('p');
    const createdAt = now();
    const host = {
      id: playerId,
      name,
      seatIndex: 0,
      tokenHash: hashToken(token),
      gold: 0,
      built: [],
      hand: [],
      characterId: null,
      manualBonus: 0
    };
    const session = {
      code,
      createdAt,
      updatedAt: createdAt,
      phase: 'lobby',
      round: 0,
      hostPlayerId: playerId,
      crownPlayerId: playerId,
      players: [host],
      districtDeck: [],
      draft: null,
      turn: null,
      roundEffects: {
        assassinatedCharacterId: null,
        thiefTargetCharacterId: null,
        thiefPlayerId: null
      },
      roundFaceUpCharacterIds: [],
      firstCompletedPlayerId: null,
      finalRound: false,
      winnerPlayerId: null
    };
    await saveSession(session);
    res.status(201).json({ code, playerId, token, ttlSeconds: SESSION_TTL_SECONDS });
  } catch (err) { next(err); }
});

api.post('/session/:code/join', async (req, res, next) => {
  try {
    const result = await withLock(req.params.code, async () => {
      const session = requireSession(await loadSession(req.params.code));
      if (session.phase !== 'lobby') throw httpError(409, 'session_already_started');
      if (session.players.length >= 8) throw httpError(409, 'session_full');
      const name = sanitizeName(req.body.name);
      if (session.players.some((p) => p.name.localeCompare(name, 'hu', { sensitivity: 'base' }) === 0)) {
        throw httpError(409, 'name_in_use');
      }
      const playerId = id('p');
      const token = makeToken();
      session.players.push({
        id: playerId,
        name,
        seatIndex: session.players.length,
        tokenHash: hashToken(token),
        gold: 0,
        built: [],
        hand: [],
        characterId: null,
        manualBonus: 0
      });
      await saveSession(session);
      return { code: session.code, playerId, token };
    });
    res.status(201).json(result);
  } catch (err) { next(err); }
});

api.get('/session/:code/state', async (req, res, next) => {
  try {
    const session = requireSession(await loadSession(req.params.code));
    const actor = authPlayer(session, req);
    await redis.expire(sessionKey(session.code), SESSION_TTL_SECONDS);
    res.json(stateView(session, actor, await ttl(session.code)));
  } catch (err) { next(err); }
});

api.post('/session/:code/crown', async (req, res, next) => {
  try {
    await withLock(req.params.code, async () => {
      const session = requireSession(await loadSession(req.params.code));
      const actor = authPlayer(session, req);
      requireHost(session, actor);
      if (session.phase !== 'lobby') throw httpError(409, 'lobby_only');
      const target = getPlayer(session, String(req.body.playerId || ''));
      if (!target) throw httpError(404, 'player_not_found');
      session.crownPlayerId = target.id;
      await saveSession(session);
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

api.post('/session/:code/reorder', async (req, res, next) => {
  try {
    await withLock(req.params.code, async () => {
      const session = requireSession(await loadSession(req.params.code));
      const actor = authPlayer(session, req);
      requireHost(session, actor);
      if (session.phase !== 'lobby') throw httpError(409, 'lobby_only');
      const order = Array.isArray(req.body.playerIds) ? req.body.playerIds.map(String) : [];
      if (
        order.length !== session.players.length ||
        new Set(order).size !== order.length ||
        order.some((playerId) => !getPlayer(session, playerId))
      ) {
        throw httpError(400, 'invalid_player_order');
      }
      order.forEach((playerId, index) => { getPlayer(session, playerId).seatIndex = index; });
      await saveSession(session);
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

api.post('/session/:code/start', async (req, res, next) => {
  try {
    await withLock(req.params.code, async () => {
      const session = requireSession(await loadSession(req.params.code));
      const actor = authPlayer(session, req);
      requireHost(session, actor);
      if (!['lobby', 'finished'].includes(session.phase)) throw httpError(409, 'cannot_start_now');
      if (session.players.length < 4 || session.players.length > 8) throw httpError(400, 'supported_player_count');

      session.round = 1;
      session.firstCompletedPlayerId = null;
      session.finalRound = false;
      session.winnerPlayerId = null;
      session.players.forEach(initializePlayerForGame);
      setupDistrictDeck(session);
      prepareDraft(session);
      await saveSession(session);
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

api.post('/session/:code/draft/choose', async (req, res, next) => {
  try {
    await withLock(req.params.code, async () => {
      const session = requireSession(await loadSession(req.params.code));
      const actor = authPlayer(session, req);
      if (session.phase !== 'draft' || !session.draft) throw httpError(409, 'draft_not_active');
      let completed;
      try {
        completed = chooseCharacter(session.draft, actor.id, String(req.body.characterId || ''));
      } catch (error) {
        throw httpError(409, error.message);
      }
      if (completed) beginTurns(session);
      await saveSession(session);
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

api.post('/session/:code/turn/resource', async (req, res, next) => {
  try {
    await withLock(req.params.code, async () => {
      const session = requireSession(await loadSession(req.params.code));
      const actor = authPlayer(session, req);
      requireActiveActor(session, actor);
      const action = activeAction(session);
      if (action.resourceGathered) throw httpError(409, 'resource_already_gathered');

      const mode = String(req.body.mode || '');
      if (mode === 'gold') {
        actor.gold = Math.min(MAX_GOLD, actor.gold + 2);
        action.resourceGathered = true;
      } else if (mode === 'cards') {
        const drawn = drawCards(session, 2);
        action.resourceGathered = true;
        if (hasDistrict(actor, 'library')) actor.hand.push(...drawn);
        else action.pendingDraw = drawn;
      } else {
        throw httpError(400, 'invalid_resource_mode');
      }
      await saveSession(session);
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

api.post('/session/:code/turn/resource/keep', async (req, res, next) => {
  try {
    await withLock(req.params.code, async () => {
      const session = requireSession(await loadSession(req.params.code));
      const actor = authPlayer(session, req);
      requireActiveActor(session, actor);
      const action = activeAction(session);
      const pending = action.pendingDraw || [];
      if (pending.length < 2) throw httpError(409, 'draw_choice_not_active');
      const cardId = String(req.body.cardId || '');
      const chosen = pending.find((card) => card.cardId === cardId);
      if (!chosen) throw httpError(400, 'invalid_draw_choice');
      actor.hand.push(chosen);
      putOnDeckBottom(session, pending.filter((card) => card.cardId !== cardId));
      action.pendingDraw = [];
      await saveSession(session);
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

api.post('/session/:code/turn/build', async (req, res, next) => {
  try {
    await withLock(req.params.code, async () => {
      const session = requireSession(await loadSession(req.params.code));
      const actor = authPlayer(session, req);
      const current = requireActiveActor(session, actor);
      const action = activeAction(session);
      if (!action.resourceGathered) throw httpError(409, 'resource_required');
      if (action.pendingDraw?.length) throw httpError(409, 'draw_choice_required');

      const buildLimit = current.characterId === 'architect' ? 3 : 1;
      if (action.builds >= buildLimit) throw httpError(409, 'build_limit_reached');

      const cardId = String(req.body.cardId || '');
      const cardIndex = actor.hand.findIndex((card) => card.cardId === cardId);
      if (cardIndex < 0) throw httpError(404, 'district_not_in_hand');
      const card = actor.hand[cardIndex];
      if (!canBuildDuplicate(actor, card)) throw httpError(409, 'duplicate_district');

      const cost = effectiveBuildCost(actor, card);
      if (actor.gold < cost) throw httpError(409, 'not_enough_gold');

      actor.gold -= cost;
      actor.hand.splice(cardIndex, 1);
      actor.built.push({ ...card, beautified: false, builtAtRound: session.round });
      action.builds += 1;

      if (!session.firstCompletedPlayerId && actor.built.length >= 7) {
        session.firstCompletedPlayerId = actor.id;
        session.finalRound = true;
      }

      await saveSession(session);
    });
    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});

api.post('/session/:code/turn/ability', async (req, res, next) => {
  try {
    await withLock(req.params.code, async () => {
      const session = requireSession(await loadSession(req.params.code));
      const actor = authPlayer(session, req);
      const current = requireActiveActor(session, actor);
      const action = activeAction(session);
      const effects = ensureRoundEffects(session);
      const abilityAction = String(req.body.action || '');

      if (current.characterId === 'assassin') {
        if (action.specialUsed) throw httpError(409, 'ability_already_used');
        if (abilityAction !== 'target-character') throw httpError(400, 'invalid_ability_action');
        const target = String(req.body.targetCharacterId || '');
        if (!targetableCharacterIds(session, 'assassin').has(target)) {
          throw httpError(400, 'invalid_character_target');
        }
        effects.assassinatedCharacterId = target;
        action.specialUsed = true;
      } else if (current.characterId === 'thief') {
        if (action.specialUsed) throw httpError(409, 'ability_already_used');
        if (abilityAction !== 'target-character') throw httpError(400, 'invalid_ability_action');
        const target = String(req.body.targetCharacterId || '');
        if (!targetableCharacterIds(session, 'thief').has(target)) {
          throw httpError(400, 'invalid_character_target');
        }
        effects.thiefTargetCharacterId = target;
        effects.thiefPlayerId = actor.id;
        action.specialUsed = true;
      } else if (current.characterId === 'magician') {
        if (action.specialUsed) throw httpError(409, 'ability_already_used');
        if (abilityAction === 'swap-hands') {
          const target = getPlayer(session, String(req.body.targetPlayerId || ''));
          if (!target || target.id === actor.id) throw httpError(400, 'invalid_player_target');
          const hand = actor.hand;
          actor.hand = target.hand;
          target.hand = hand;
          action.specialUsed = true;
        } else if (abilityAction === 'redraw') {
          const cardIds = Array.isArray(req.body.cardIds) ? [...new Set(req.body.cardIds.map(String))] : [];
          if (!cardIds.length) throw httpError(400, 'cards_required');
          const selected = cardIds.map((cardId) => actor.hand.find((card) => card.cardId === cardId));
          if (selected.some((card) => !card)) throw httpError(400, 'district_not_in_hand');
          actor.hand = actor.hand.filter((card) => !cardIds.includes(card.cardId));
          putOnDeckBottom(session, selected);
          actor.hand.push(...drawCards(session, selected.length));
          action.specialUsed = true;
        } else {
          throw httpError(400, 'invalid_ability_action');
        }
      } else if (['king', 'bishop', 'merchant', 'warlord'].includes(current.characterId) && abilityAction === 'income') {
        if (action.incomeUsed) throw httpError(409, 'ability_already_used');
        const amount = characterIncome(actor, current.characterId);
        actor.gold = Math.min(MAX_GOLD, actor.gold + amount);
        action.incomeUsed = true;
      } else if (current.characterId === 'warlord' && abilityAction === 'destroy-district') {
        if (action.destructionUsed) throw httpError(409, 'ability_already_used');
        const found = findBuiltDistrict(session, String(req.body.cardId || ''));
        if (!found) throw httpError(404, 'district_not_found');
        if (found.owner.built.length >= 7) throw httpError(409, 'completed_city_protected');
        if (
          found.owner.characterId === 'bishop' &&
          effects.assassinatedCharacterId !== 'bishop'
        ) {
          throw httpError(409, 'bishop_protected');
        }
        if (found.district.id === 'keep') throw httpError(409, 'keep_protected');

        const destroyCost = Math.max(0, Number(found.district.cost || 0) - 1);
        if (actor.gold < destroyCost) throw httpError(409, 'not_enough_gold');
        actor.gold -= destroyCost;
        const [destroyed] = found.owner.built.splice(found.index, 1);
        putOnDeckBottom(session, [destroyed]);
        action.destructionUsed = true;
      } else {
        throw httpError(400, 'invalid_ability_action');
      }

      await saveSession(session);
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

api.post('/session/:code/turn/district-ability', async (req, res, next) => {
  try {
    await withLock(req.params.code, async () => {
      const session = requireSession(await loadSession(req.params.code));
      const actor = authPlayer(session, req);
      requireActiveActor(session, actor);
      const action = activeAction(session);
      if (!action.resourceGathered) throw httpError(409, 'resource_required');
      if (action.pendingDraw?.length) throw httpError(409, 'draw_choice_required');
      if (!action.districtUses || typeof action.districtUses !== 'object') action.districtUses = {};

      const districtId = String(req.body.districtId || '');

      if (districtId === 'laboratory') {
        if (!hasDistrict(actor, 'laboratory')) throw httpError(409, 'district_ability_unavailable');
        if (action.districtUses.laboratory) throw httpError(409, 'district_ability_already_used');

        const cardId = String(req.body.cardId || '');
        const cardIndex = actor.hand.findIndex((card) => card.cardId === cardId);
        if (cardIndex < 0) throw httpError(404, 'district_not_in_hand');

        const [discarded] = actor.hand.splice(cardIndex, 1);
        putOnDeckBottom(session, [discarded]);
        actor.gold = Math.min(MAX_GOLD, actor.gold + 2);
        action.districtUses.laboratory = true;
      } else if (districtId === 'smithy') {
        if (!hasDistrict(actor, 'smithy')) throw httpError(409, 'district_ability_unavailable');
        if (action.districtUses.smithy) throw httpError(409, 'district_ability_already_used');
        if (actor.gold < 2) throw httpError(409, 'not_enough_gold');

        actor.gold -= 2;
        actor.hand.push(...drawCards(session, 3));
        action.districtUses.smithy = true;
      } else {
        throw httpError(400, 'invalid_district_ability');
      }

      await saveSession(session);
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

api.post('/session/:code/gold', async (req, res, next) => {
  try {
    await withLock(req.params.code, async () => {
      const session = requireSession(await loadSession(req.params.code));
      const actor = authPlayer(session, req);
      if (!['turns', 'finished'].includes(session.phase)) throw httpError(409, 'game_not_active');
      const targetId = String(req.body.playerId || actor.id);
      const target = getPlayer(session, targetId);
      if (!target) throw httpError(404, 'player_not_found');
      if (target.id !== actor.id && !canAdminPublicState(session, actor)) throw httpError(403, 'not_allowed');
      const delta = clampInt(req.body.delta, -50, 50, 'invalid_gold_delta');
      const nextGold = target.gold + delta;
      if (nextGold < 0 || nextGold > MAX_GOLD) throw httpError(409, 'invalid_gold_total');
      target.gold = nextGold;
      await saveSession(session);
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

api.post('/session/:code/district', async (req, res, next) => {
  try {
    await withLock(req.params.code, async () => {
      const session = requireSession(await loadSession(req.params.code));
      const actor = authPlayer(session, req);
      if (session.phase !== 'turns') throw httpError(409, 'game_not_active');
      const current = activeTurn(session);
      if (!current || (current.playerId !== actor.id && actor.id !== session.hostPlayerId)) {
        throw httpError(403, 'active_player_only');
      }
      const targetId = actor.id === session.hostPlayerId && req.body.playerId ? String(req.body.playerId) : actor.id;
      const target = getPlayer(session, targetId);
      if (!target) throw httpError(404, 'player_not_found');
      const district = {
        cardId: id('manual'),
        id: id('manual-district'),
        name: sanitizeDistrictName(req.body.name),
        type: sanitizeType(req.body.type),
        cost: sanitizeCost(req.body.cost),
        effect: null,
        beautified: Boolean(req.body.beautified),
        builtAtRound: session.round
      };
      target.built.push(district);
      if (!session.firstCompletedPlayerId && target.built.length >= 7) {
        session.firstCompletedPlayerId = target.id;
        session.finalRound = true;
      }
      await saveSession(session);
    });
    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});

api.delete('/session/:code/district/:districtId', async (req, res, next) => {
  try {
    await withLock(req.params.code, async () => {
      const session = requireSession(await loadSession(req.params.code));
      const actor = authPlayer(session, req);
      const owner = session.players.find((p) => p.built.some((d) => d.cardId === req.params.districtId));
      if (!owner) throw httpError(404, 'district_not_found');
      if (owner.id !== actor.id && actor.id !== session.hostPlayerId) throw httpError(403, 'not_allowed');
      owner.built = owner.built.filter((d) => d.cardId !== req.params.districtId);
      await saveSession(session);
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

api.post('/session/:code/turn/end', async (req, res, next) => {
  try {
    await withLock(req.params.code, async () => {
      const session = requireSession(await loadSession(req.params.code));
      const actor = authPlayer(session, req);
      requireActiveActor(session, actor);
      endCurrentTurn(session);
      await saveSession(session);
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

api.post('/session/:code/score/bonus', async (req, res, next) => {
  try {
    await withLock(req.params.code, async () => {
      const session = requireSession(await loadSession(req.params.code));
      const actor = authPlayer(session, req);
      if (session.phase !== 'finished') throw httpError(409, 'finished_only');
      const targetId = String(req.body.playerId || actor.id);
      const target = getPlayer(session, targetId);
      if (!target) throw httpError(404, 'player_not_found');
      if (target.id !== actor.id && actor.id !== session.hostPlayerId) throw httpError(403, 'not_allowed');
      target.manualBonus = clampInt(req.body.points, -MAX_BONUS, MAX_BONUS, 'invalid_bonus');
      session.winnerPlayerId = calculateWinner(session);
      await saveSession(session);
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

api.post('/session/:code/finish', async (req, res, next) => {
  try {
    await withLock(req.params.code, async () => {
      const session = requireSession(await loadSession(req.params.code));
      const actor = authPlayer(session, req);
      requireHost(session, actor);
      if (session.phase === 'lobby') throw httpError(409, 'game_not_started');
      finishGame(session);
      await saveSession(session);
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

api.get('/healthz', async (_req, res) => {
  try {
    await redis.ping();
    res.json({ ok: true });
  } catch (_err) {
    res.status(503).json({ ok: false });
  }
});

app.use(`${BASE_PATH}/api`, api);
app.get('/livez', (_req, res) => res.json({ ok: true }));
app.use(BASE_PATH || '/', express.static(path.join(__dirname, 'public'), {
  index: false,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
    else res.setHeader('Cache-Control', 'public, max-age=3600');
  }
}));

const indexFile = path.join(__dirname, 'public', 'index.html');
app.get([BASE_PATH || '/', `${BASE_PATH}/`, `${BASE_PATH}/*`], (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(indexFile);
});

app.use((err, _req, res, _next) => {
  const status = Number(err.status || 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.code || 'internal_error', details: err.details || undefined });
});

async function main() {
  await redis.connect();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Citadella listening on ${PORT} at ${BASE_PATH || '/'}`);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  stateView,
  initializePlayerForGame,
  setupDistrictDeck,
  targetableCharacterIds
};
