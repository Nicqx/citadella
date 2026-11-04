'use strict';

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('redis');
const {
  DISTRICT_TYPES,
  CHARACTERS,
  CHARACTER_MAP,
  DEFAULT_CHARACTER_IDS,
  validateCharacterSelection,
  inUseCharacters,
  createDraft,
  draftOptions,
  chooseCharacter,
  turnOrderFromChoices,
  scorePlayer
} = require('./game');
const {
  UNIQUE_DISTRICTS,
  DEFAULT_UNIQUE_DISTRICT_IDS,
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

const BOT_STRATEGIES = Object.freeze({
  adaptive: Object.freeze({
    id: 'adaptive',
    label: 'Alkalmazkodó',
    description: 'Az aktuális kézhez, városhoz és lehetőségekhez igazodik.',
    focusType: null,
    preferredCharacters: []
  }),
  noble: Object.freeze({
    id: 'noble',
    label: 'Nemesi fókusz',
    description: 'A nemesi kerületeket és a Királyt részesíti előnyben.',
    focusType: 'noble',
    preferredCharacters: ['king']
  }),
  religious: Object.freeze({
    id: 'religious',
    label: 'Egyházi fókusz',
    description: 'Az egyházi kerületeket és a Püspököt részesíti előnyben.',
    focusType: 'religious',
    preferredCharacters: ['bishop']
  }),
  trade: Object.freeze({
    id: 'trade',
    label: 'Kereskedelmi fókusz',
    description: 'A kereskedelmi kerületeket és a Kereskedőt részesíti előnyben.',
    focusType: 'trade',
    preferredCharacters: ['merchant']
  }),
  military: Object.freeze({
    id: 'military',
    label: 'Katonai fókusz',
    description: 'A katonai kerületeket és a Hadurat keresi, és agresszívan rombol.',
    focusType: 'military',
    preferredCharacters: ['warlord']
  }),
  unique: Object.freeze({
    id: 'unique',
    label: 'Egyedi kerület fókusz',
    description: 'Az egyedi kerületeket és az ezekhez jól illő építkező karaktereket keresi.',
    focusType: 'unique',
    preferredCharacters: ['architect', 'magician']
  })
});

function normalizeBotStrategy(value) {
  const idValue = String(value || 'adaptive');
  return BOT_STRATEGIES[idValue] ? idValue : 'adaptive';
}

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
  player.isBot = Boolean(player.isBot);
  player.botStrategy = player.isBot ? normalizeBotStrategy(player.botStrategy) : null;
  return player;
}

function ensureRoundEffects(session) {
  if (!session.roundEffects || typeof session.roundEffects !== 'object') session.roundEffects = {};
  const effects = session.roundEffects;
  if (!Object.hasOwn(effects, 'assassinatedCharacterId')) effects.assassinatedCharacterId = null;
  if (!Object.hasOwn(effects, 'thiefTargetCharacterId')) effects.thiefTargetCharacterId = null;
  if (!Object.hasOwn(effects, 'thiefPlayerId')) effects.thiefPlayerId = null;
  if (!Object.hasOwn(effects, 'witchTargetCharacterId')) effects.witchTargetCharacterId = null;
  if (!Object.hasOwn(effects, 'witchPlayerId')) effects.witchPlayerId = null;
  if (!Object.hasOwn(effects, 'witchBorrowedCharacterId')) effects.witchBorrowedCharacterId = null;
  if (!Array.isArray(effects.magistrateTargetCharacterIds)) effects.magistrateTargetCharacterIds = [];
  if (!Object.hasOwn(effects, 'magistrateSignedCharacterId')) effects.magistrateSignedCharacterId = null;
  if (!Object.hasOwn(effects, 'magistratePlayerId')) effects.magistratePlayerId = null;
  if (!Object.hasOwn(effects, 'magistrateUsed')) effects.magistrateUsed = false;
  if (!Array.isArray(effects.blackmailTargetCharacterIds)) effects.blackmailTargetCharacterIds = [];
  if (!Object.hasOwn(effects, 'blackmailRealCharacterId')) effects.blackmailRealCharacterId = null;
  if (!Object.hasOwn(effects, 'blackmailerPlayerId')) effects.blackmailerPlayerId = null;
  if (!effects.blackmailResolved || typeof effects.blackmailResolved !== 'object') effects.blackmailResolved = {};
  return effects;
}

function ensureSessionFields(session) {
  if (!session) return session;
  session.players.forEach(ensurePlayerFields);
  if (!Array.isArray(session.districtDeck)) session.districtDeck = [];
  if (!Array.isArray(session.roundFaceUpCharacterIds)) session.roundFaceUpCharacterIds = [];
  if (!Array.isArray(session.botActionLog)) session.botActionLog = [];
  if (!Number.isInteger(session.botActionSeq)) session.botActionSeq = 0;
  if (!Array.isArray(session.selectedUniqueDistrictIds) || session.selectedUniqueDistrictIds.length !== 14) {
    session.selectedUniqueDistrictIds = [...DEFAULT_UNIQUE_DISTRICT_IDS];
  }
  try {
    session.selectedCharacterIds = validateCharacterSelection(session.selectedCharacterIds);
  } catch (_err) {
    session.selectedCharacterIds = [...DEFAULT_CHARACTER_IDS];
  }
  if (!Number.isInteger(session.taxPool)) session.taxPool = Number(session.taxPool || 0);
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
    character: canSeeCharacter && player.characterId ? characterPublic(player.characterId) : null,
    hasCharacter: Boolean(player.characterId),
    isCrowned: player.id === session.crownPlayerId,
    isHost: player.id === session.hostPlayerId,
    isBot: Boolean(player.isBot),
    botStrategy: player.isBot ? normalizeBotStrategy(player.botStrategy) : null
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
    buildLimit: current ? characterBuildLimit(current.characterId) : 1,
    incomeUsed: Boolean(action.incomeUsed),
    specialUsed: Boolean(action.specialUsed),
    destructionUsed: Boolean(action.destructionUsed),
    witchContinuation: Boolean(action.witchContinuation),
    bewitchedVictim: Boolean(action.bewitchedVictim),
    blackmailPending: Boolean(action.blackmailPending),
    artistUses: Number(action.artistUses || 0),
    districtUses: selfActive ? { ...(action.districtUses || {}) } : {},
    pendingDraw: selfActive ? (action.pendingDraw || []).map(districtPublic) : [],
    specialDraw: selfActive ? (action.specialDraw || []).map(districtPublic) : [],
    inspectedHand: selfActive ? (action.inspectedHand || []).map(districtPublic) : [],
    inspectedPlayerId: selfActive ? (action.inspectedPlayerId || null) : null,
    seerPendingPlayerIds: selfActive ? [...(action.seerPendingPlayerIds || [])] : []
  };
}

function stateView(session, actor, ttlSeconds) {
  ensureSessionFields(session);
  const draft = session.draft;
  const currentDraftPlayerId = session.phase === 'draft' && draft ? draft.order[draft.index] : null;
  const meIsDrafter = currentDraftPlayerId === actor.id;
  const turn = activeTurn(session);
  const characters = (session.players.length >= 4
    ? inUseCharacters(session.players.length, session.selectedCharacterIds)
    : session.selectedCharacterIds.slice(0, 8).map((idValue) => CHARACTER_MAP.get(idValue)))
    .filter(Boolean)
    .map((character) => characterPublic(character.id));
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
    selectedUniqueDistrictIds: [...session.selectedUniqueDistrictIds],
    defaultUniqueDistrictIds: [...DEFAULT_UNIQUE_DISTRICT_IDS],
    selectedCharacterIds: [...session.selectedCharacterIds],
    defaultCharacterIds: [...DEFAULT_CHARACTER_IDS],
    characterCatalog: CHARACTERS.map((character) => characterPublic(character.id)),
    uniqueDistrictCatalog: UNIQUE_DISTRICTS.map((district) => ({
      id: district.id,
      name: district.name,
      cost: district.cost,
      effect: district.effect
    })),
    botCount: session.players.filter((player) => player.isBot).length,
    humanCount: session.players.filter((player) => !player.isBot).length,
    botStrategies: Object.values(BOT_STRATEGIES).map(({ id, label, description }) => ({ id, label, description })),
    botActions: session.botActionLog.slice(-8),
    taxPool: Number(session.taxPool || 0),
    faceUpCharacters: (draft ? draft.faceUpIds : session.roundFaceUpCharacterIds).map(characterPublic).filter(Boolean),
    me: playerView(session, actor, actor),
    isHost: actor.id === session.hostPlayerId,
    players: sortedPlayers(session).map((p) => playerView(session, p, actor)),
    characters,
    districtTypes: DISTRICT_TYPES,
    roundEffects: {
      assassinatedCharacterId: effects.assassinatedCharacterId || null,
      thiefTargetCharacterId: effects.thiefTargetCharacterId || null,
      witchTargetCharacterId: effects.witchTargetCharacterId || null,
      magistrateTargetCharacterIds: [...effects.magistrateTargetCharacterIds],
      blackmailTargetCharacterIds: [...effects.blackmailTargetCharacterIds]
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
}

function setupDistrictDeck(session) {
  session.districtDeck = createDistrictDeck(session.selectedUniqueDistrictIds);
  for (const player of sortedPlayers(session)) {
    player.hand.push(...drawCards(session, 4));
  }
}

function prepareDraft(session) {
  session.players.forEach((p) => { p.characterId = null; });
  session.roundFaceUpCharacterIds = [];
  session.draft = createDraft(sortedPlayers(session), session.crownPlayerId, session.selectedCharacterIds);
  session.turn = null;
  session.phase = 'draft';
  session.roundEffects = {};
  ensureRoundEffects(session);
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

function applyTurnStartEffects(session, current, options = {}) {
  const actor = getPlayer(session, current.playerId);
  const effects = ensureRoundEffects(session);
  const witchContinuation = Boolean(options.witchContinuation);
  const bewitchedVictim = Boolean(options.bewitchedVictim);

  if (!witchContinuation && effects.thiefTargetCharacterId === current.characterId && effects.thiefPlayerId) {
    const thief = getPlayer(session, effects.thiefPlayerId);
    if (thief && thief.id !== actor.id) {
      thief.gold = Math.min(MAX_GOLD, thief.gold + actor.gold);
      actor.gold = 0;
    }
  }

  // A megbabonázott Király/Patrícius a szabály szerint a koronát akkor is megkapja.
  if (!witchContinuation && ['king', 'patrician'].includes(current.characterId)) {
    session.crownPlayerId = current.playerId;
  }

  if (bewitchedVictim) return;

  if (current.characterId === 'merchant') {
    actor.gold = Math.min(MAX_GOLD, actor.gold + 1);
  } else if (current.characterId === 'architect') {
    actor.hand.push(...drawCards(session, Math.min(2, session.districtDeck.length)));
  } else if (current.characterId === 'queen') {
    const rankFourEntry = session.turn.order.find((entry) => CHARACTER_MAP.get(entry.characterId)?.rank === 4 && !entry.witchContinuation);
    if (
      rankFourEntry &&
      effects.assassinatedCharacterId !== rankFourEntry.characterId &&
      areAdjacent(session, current.playerId, rankFourEntry.playerId)
    ) {
      actor.gold = Math.min(MAX_GOLD, actor.gold + 3);
    }
  }
}

function finishBewitchedVictim(session) {
  const action = activeAction(session);
  const current = activeTurn(session);
  if (!action?.bewitchedVictim || !current || !action.resourceGathered || action.pendingDraw?.length) return false;

  const effects = ensureRoundEffects(session);
  const witch = getPlayer(session, effects.witchPlayerId);
  const borrowedCharacterId = current.characterId;

  session.turn.index += 1;
  if (witch && effects.assassinatedCharacterId !== borrowedCharacterId) {
    session.turn.order.splice(session.turn.index, 0, {
      playerId: witch.id,
      characterId: borrowedCharacterId,
      rank: CHARACTER_MAP.get(borrowedCharacterId)?.rank || 99,
      witchContinuation: true,
      originalTargetPlayerId: current.playerId
    });
  }
  activateCurrentTurn(session);
  return true;
}

function activateCurrentTurn(session) {
  while (session.turn && session.turn.index < session.turn.order.length) {
    const current = activeTurn(session);
    if (!current) break;
    const effects = ensureRoundEffects(session);

    if (!current.witchContinuation && effects.assassinatedCharacterId === current.characterId) {
      if (!session.turn.skippedPlayerIds.includes(current.playerId)) {
        session.turn.skippedPlayerIds.push(current.playerId);
      }
      session.turn.index += 1;
      continue;
    }

    if (!session.turn.revealedPlayerIds.includes(current.playerId)) {
      session.turn.revealedPlayerIds.push(current.playerId);
    }

    const isBewitchedVictim = !current.witchContinuation &&
      effects.witchTargetCharacterId === current.characterId &&
      effects.witchPlayerId &&
      effects.witchPlayerId !== current.playerId;

    session.turn.action = {
      playerId: current.playerId,
      resourceGathered: Boolean(current.witchContinuation),
      builds: 0,
      incomeUsed: false,
      specialUsed: false,
      destructionUsed: false,
      districtUses: {},
      pendingDraw: [],
      specialDraw: [],
      inspectedHand: [],
      inspectedPlayerId: null,
      seerPendingPlayerIds: [],
      buildGoldSpent: 0,
      artistUses: 0,
      blackmailPending: false,
      witchContinuation: Boolean(current.witchContinuation),
      bewitchedVictim: Boolean(isBewitchedVictim)
    };

    if (current.witchContinuation) {
      effects.witchBorrowedCharacterId = current.characterId;
      applyTurnStartEffects(session, current, { witchContinuation: true });
    } else if (isBewitchedVictim) {
      applyTurnStartEffects(session, current, { bewitchedVictim: true });
    } else {
      applyTurnStartEffects(session, current);
    }
    return;
  }

  if (session.turn) completeRound(session);
}

function afterResourceChoice(session) {
  const current = activeTurn(session);
  const action = activeAction(session);
  if (!current || !action || !action.resourceGathered || action.pendingDraw?.length) return;

  if (action.bewitchedVictim) {
    finishBewitchedVictim(session);
    return;
  }

  const effects = ensureRoundEffects(session);
  if (
    effects.blackmailTargetCharacterIds.includes(current.characterId) &&
    !effects.blackmailResolved[current.characterId]
  ) {
    action.blackmailPending = true;
  }
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
  const killedCharacterId = effects.assassinatedCharacterId;

  if (isRankFourCharacter(killedCharacterId)) {
    const killedRankFour = session.players.find((player) => player.characterId === killedCharacterId);
    if (killedRankFour) {
      if (killedCharacterId === 'emperor') {
        const players = sortedPlayers(session);
        const index = players.findIndex((player) => player.id === killedRankFour.id);
        const recipient = players[(index + 1) % players.length];
        if (recipient && recipient.id !== killedRankFour.id) session.crownPlayerId = recipient.id;
      } else {
        session.crownPlayerId = killedRankFour.id;
      }

      const queen = session.players.find((player) => player.characterId === 'queen');
      if (
        queen &&
        killedCharacterId !== 'queen' &&
        effects.assassinatedCharacterId !== 'queen' &&
        areAdjacent(session, queen.id, killedRankFour.id)
      ) {
        queen.gold = Math.min(MAX_GOLD, queen.gold + 3);
      }
    }
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
  if (action.pendingDraw?.length || action.specialDraw?.length) throw httpError(409, 'draw_choice_required');
  if (action.seerPendingPlayerIds?.length) throw httpError(409, 'seer_return_required');
  if (action.blackmailPending) throw httpError(409, 'blackmail_response_required');

  const current = activeTurn(session);
  const actor = current ? getPlayer(session, current.playerId) : null;
  if (current?.characterId === 'emperor' && !action.specialUsed) {
    throw httpError(409, 'emperor_crown_required');
  }

  if (actor) {
    if (current.characterId === 'alchemist' && action.buildGoldSpent > 0) {
      actor.gold = Math.min(MAX_GOLD, actor.gold + action.buildGoldSpent);
      action.buildGoldSpent = 0;
    }
    if (hasDistrict(actor, 'park') && actor.hand.length === 0 && session.districtDeck.length >= 2) {
      actor.hand.push(...drawCards(session, 2));
    }
    if (hasDistrict(actor, 'poor-house') && actor.gold === 0) {
      actor.gold = 1;
    }
  }

  session.turn.index += 1;
  if (session.turn.index >= session.turn.order.length) completeRound(session);
  else activateCurrentTurn(session);
}

function hasDistrict(player, districtId) {
  return player.built.some((district) => district.id === districtId);
}

function characterIncomeType(characterId) {
  return {
    king: 'noble',
    emperor: 'noble',
    patrician: 'noble',
    bishop: 'religious',
    abbot: 'religious',
    cardinal: 'religious',
    merchant: 'trade',
    trader: 'trade',
    warlord: 'military',
    diplomat: 'military',
    marshal: 'military'
  }[characterId] || null;
}

function characterIncome(actor, characterId) {
  const type = characterIncomeType(characterId);
  if (!type) return 0;
  let amount = actor.built.filter((district) => district.type === type).length;
  if (hasDistrict(actor, 'school-of-magic')) amount += 1;
  return amount;
}

function characterBuildLimit(characterId) {
  if (characterId === 'navigator') return 0;
  if (characterId === 'architect') return 3;
  if (characterId === 'seer' || characterId === 'scholar') return 2;
  return 1;
}

function buildConsumesLimit(characterId, card) {
  if (card.id === 'stables') return false;
  if (characterId === 'trader' && card.type === 'trade') return false;
  return true;
}

function isRankFourCharacter(characterId) {
  return CHARACTER_MAP.get(characterId)?.rank === 4;
}

function isRankEightProtected(session, owner) {
  const effects = ensureRoundEffects(session);
  if (owner.characterId === 'bishop' && effects.assassinatedCharacterId !== 'bishop') return true;
  return owner.id === effects.witchPlayerId &&
    effects.witchBorrowedCharacterId === 'bishop' &&
    effects.assassinatedCharacterId !== 'bishop';
}

function taxCollectorActive(session) {
  if (session.players.length !== 8) return false;
  return session.selectedCharacterIds?.[8] === 'tax-collector';
}

function applyBuildTax(session, payer) {
  if (!taxCollectorActive(session) || !payer || payer.characterId === 'tax-collector' || payer.gold <= 0) return 0;
  payer.gold -= 1;
  session.taxPool = Number(session.taxPool || 0) + 1;
  return 1;
}

function updateCityCompletion(session, player) {
  if (!session.firstCompletedPlayerId && cityCompletionCount(player) >= 7) {
    session.firstCompletedPlayerId = player.id;
    session.finalRound = true;
  }
}

function findBuiltDistrict(session, districtCardId) {
  for (const owner of session.players) {
    const index = owner.built.findIndex((district) => district.cardId === districtCardId);
    if (index >= 0) return { owner, index, district: owner.built[index] };
  }
  return null;
}

function cityCompletionCount(player) {
  return player.built.length + (hasDistrict(player, 'monument') ? 1 : 0);
}

function validateUniqueDistrictSelection(value) {
  const ids = Array.isArray(value) ? value.map(String) : [];
  if (ids.length !== 14 || new Set(ids).size !== 14) {
    throw httpError(400, 'unique_district_selection_count');
  }
  const known = new Set(UNIQUE_DISTRICTS.map((district) => district.id));
  if (ids.some((districtId) => !known.has(districtId))) {
    throw httpError(400, 'unknown_unique_district');
  }
  return ids;
}

function setBotCount(session, requestedCount) {
  const count = clampInt(requestedCount, 0, 7, 'invalid_bot_count');
  const humans = sortedPlayers(session).filter((player) => !player.isBot);
  if (humans.length + count > 8) throw httpError(400, 'too_many_players');

  const existingBots = sortedPlayers(session).filter((player) => player.isBot);
  const keptBots = existingBots.slice(0, count);
  const bots = [...keptBots];

  for (let i = bots.length; i < count; i += 1) {
    bots.push({
      id: id('bot'),
      name: `Bot ${i + 1}`,
      seatIndex: 0,
      tokenHash: null,
      isBot: true,
      gold: 0,
      built: [],
      hand: [],
      characterId: null,
      botStrategy: 'adaptive'
    });
  }

  session.players = [...humans, ...bots];
  session.players.forEach((player, index) => { player.seatIndex = index; });
  if (!getPlayer(session, session.crownPlayerId)) session.crownPlayerId = session.hostPlayerId;
}

function setBotStrategy(session, playerId, strategyId) {
  const player = getPlayer(session, String(playerId || ''));
  if (!player || !player.isBot) throw httpError(404, 'bot_not_found');
  const requested = String(strategyId || '');
  if (!BOT_STRATEGIES[requested]) throw httpError(400, 'invalid_bot_strategy');
  player.botStrategy = requested;
  return player.botStrategy;
}

function botPick(array) {
  if (!array.length) return null;
  return array[crypto.randomInt(0, array.length)];
}

function botStrategyDefinition(actor) {
  return BOT_STRATEGIES[normalizeBotStrategy(actor.botStrategy)] || BOT_STRATEGIES.adaptive;
}

function botTypeCount(actor, type, source = 'built') {
  const cards = Array.isArray(actor[source]) ? actor[source] : [];
  return cards.filter((card) => card.type === type).length;
}

function botCardScore(actor, card) {
  const strategy = botStrategyDefinition(actor);
  let score = Number(card.cost || 0) * 3;

  if (strategy.focusType && card.type === strategy.focusType) score += 35;
  if (!actor.built.some((district) => district.type === card.type)) score += 8;

  if (strategy.id === 'adaptive') {
    const momentum = botTypeCount(actor, card.type, 'built') + botTypeCount(actor, card.type, 'hand');
    score += momentum * 3;
  }

  const endGameValue = {
    'dragon-gate': 10,
    'imperial-treasury': 8,
    'map-room': 7,
    statue: 8,
    basilica: 7,
    capitol: 8,
    'ivory-tower': 8,
    'wishing-well': 8,
    'secret-vault': 12,
    monument: 7,
    museum: 6
  };
  score += endGameValue[card.id] || 0;
  return score;
}

function botCharacterScore(session, actor, characterId) {
  const strategy = botStrategyDefinition(actor);
  const incomeType = {
    king: 'noble',
    bishop: 'religious',
    merchant: 'trade',
    warlord: 'military'
  }[characterId];

  let score = 0;
  if (incomeType) {
    score += botTypeCount(actor, incomeType, 'built') * 9;
    score += botTypeCount(actor, incomeType, 'hand') * 2;
  }

  if (characterId === 'architect') {
    const affordable = actor.hand.filter((card) =>
      card.id !== 'secret-vault' && effectiveBuildCost(actor, card) <= actor.gold).length;
    score += actor.hand.length * 2 + affordable * 6;
  } else if (characterId === 'magician') {
    score += Math.max(0, 5 - actor.hand.length) * 5;
  } else if (characterId === 'thief') {
    score += Math.min(12, Math.max(0, ...session.players
      .filter((player) => player.id !== actor.id)
      .map((player) => Number(player.gold || 0))));
  } else if (characterId === 'assassin') {
    score += 6;
  } else if (characterId === 'warlord') {
    const vulnerable = session.players
      .filter((player) => player.id !== actor.id && cityCompletionCount(player) < 7)
      .reduce((sum, player) => sum + player.built.length, 0);
    score += Math.min(18, vulnerable * 2);
  }

  const preferredIndex = strategy.preferredCharacters.indexOf(characterId);
  if (preferredIndex >= 0) score += 100 - preferredIndex * 10;

  return score;
}

function botChooseCharacter(session, actor, options) {
  const ranked = options.map((characterId) => ({
    characterId,
    score: botCharacterScore(session, actor, characterId)
  }));
  const bestScore = ranked.length ? Math.max(...ranked.map((item) => item.score)) : -Infinity;
  return botPick(ranked.filter((item) => item.score === bestScore).map((item) => item.characterId));
}

function addBotAction(session, actor, characterId, messages, phase = 'turn') {
  const cleanMessages = (Array.isArray(messages) ? messages : [messages]).filter(Boolean);
  if (!cleanMessages.length) return;
  session.botActionSeq = Number(session.botActionSeq || 0) + 1;
  const character = CHARACTER_MAP.get(characterId);
  session.botActionLog.push({
    id: session.botActionSeq,
    round: session.round,
    phase,
    playerId: actor.id,
    playerName: actor.name,
    characterId: characterId || null,
    characterName: character?.name || null,
    messages: cleanMessages
  });
  if (session.botActionLog.length > 12) session.botActionLog = session.botActionLog.slice(-12);
}

function botGatherResource(session, actor, action, notes) {
  const strategy = botStrategyDefinition(actor);
  const bestHandCard = [...actor.hand]
    .filter((card) => card.id !== 'secret-vault')
    .sort((a, b) => botCardScore(actor, b) - botCardScore(actor, a))[0];
  const focusMissing = Boolean(strategy.focusType) &&
    !actor.hand.some((card) => card.type === strategy.focusType);
  const needsGoldForBest = bestHandCard &&
    effectiveBuildCost(actor, bestHandCard) > actor.gold;
  const takeCards = session.districtDeck.length >= 2 &&
    !needsGoldForBest &&
    (actor.hand.length < 3 || (focusMissing && actor.hand.length < 6));

  if (!takeCards) {
    const amount = 2 + (hasDistrict(actor, 'gold-mine') ? 1 : 0);
    actor.gold = Math.min(MAX_GOLD, actor.gold + amount);
    action.resourceGathered = true;
    notes.push(`${amount} aranyat vett fel.`);
    return;
  }

  const drawCount = hasDistrict(actor, 'observatory') ? 3 : 2;
  const safeCount = Math.min(drawCount, session.districtDeck.length);
  if (safeCount <= 0) {
    const amount = 2 + (hasDistrict(actor, 'gold-mine') ? 1 : 0);
    actor.gold = Math.min(MAX_GOLD, actor.gold + amount);
    action.resourceGathered = true;
    notes.push(`${amount} aranyat vett fel.`);
    return;
  }

  const drawn = drawCards(session, safeCount);
  action.resourceGathered = true;
  if (hasDistrict(actor, 'library')) {
    actor.hand.push(...drawn);
    notes.push(`${safeCount} kerületlapot húzott, és a Könyvtár miatt mindet megtartotta.`);
  } else {
    const chosen = [...drawn].sort((a, b) => botCardScore(actor, b) - botCardScore(actor, a))[0];
    actor.hand.push(chosen);
    putOnDeckBottom(session, drawn.filter((card) => card.cardId !== chosen.cardId));
    notes.push(`${safeCount} kerületlapból 1-et megtartott a stratégiájához.`);
  }
}

function botUseCharacterAbility(session, actor, current, action, notes) {
  const effects = ensureRoundEffects(session);
  const strategy = botStrategyDefinition(actor);

  if (current.characterId === 'assassin' && !action.specialUsed) {
    const targets = [...targetableCharacterIds(session, 'assassin')];
    let target = null;
    if (strategy.id === 'military' && targets.includes('bishop')) target = 'bishop';
    else if (strategy.id === 'religious' && targets.includes('warlord')) target = 'warlord';
    else target = botPick(targets);
    if (target) {
      effects.assassinatedCharacterId = target;
      action.specialUsed = true;
      notes.push(`Orgyilkosként ezt a karaktert jelölte ki: ${CHARACTER_MAP.get(target)?.name || target}.`);
    }
  } else if (current.characterId === 'thief' && !action.specialUsed) {
    const targets = [...targetableCharacterIds(session, 'thief')];
    const target = ['merchant', 'king', 'architect'].find((idValue) => targets.includes(idValue)) || botPick(targets);
    if (target) {
      effects.thiefTargetCharacterId = target;
      effects.thiefPlayerId = actor.id;
      action.specialUsed = true;
      notes.push(`Tolvajként ezt a karaktert jelölte ki: ${CHARACTER_MAP.get(target)?.name || target}.`);
    }
  } else if (current.characterId === 'magician' && !action.specialUsed) {
    const candidates = session.players
      .filter((player) => player.id !== actor.id && player.hand.length > actor.hand.length)
      .sort((a, b) => b.hand.length - a.hand.length);
    const target = candidates[0];
    if (target) {
      [actor.hand, target.hand] = [target.hand, actor.hand];
      action.specialUsed = true;
      notes.push(`Mágusként kézlapot cserélt vele: ${target.name}.`);
    }
  }

  if (['king', 'bishop', 'merchant', 'warlord'].includes(current.characterId) && !action.incomeUsed) {
    const amount = characterIncome(actor, current.characterId);
    actor.gold = Math.min(MAX_GOLD, actor.gold + amount);
    action.incomeUsed = true;
    if (amount > 0) notes.push(`Karakterbevételként +${amount} aranyat kapott.`);
  }
}

function districtDestructionCost(owner, district) {
  const greatWallExtra = hasDistrict(owner, 'great-wall') && district.id !== 'great-wall' ? 1 : 0;
  const beautifiedExtra = district.beautified ? 1 : 0;
  return Math.max(0, Number(district.cost || 0) - 1 + greatWallExtra + beautifiedExtra);
}

function botUseWarlordDestruction(session, actor, action, notes) {
  if (action.destructionUsed) return;
  const effects = ensureRoundEffects(session);
  const candidates = [];

  for (const owner of session.players) {
    if (owner.id === actor.id || cityCompletionCount(owner) >= 7) continue;
    if (owner.characterId === 'bishop' && effects.assassinatedCharacterId !== 'bishop') continue;

    owner.built.forEach((district, index) => {
      if (district.id === 'keep') return;
      const cost = districtDestructionCost(owner, district);
      if (cost > actor.gold) return;
      const threat = owner.built.length * 4;
      const value = (Number(district.cost || 0) + (district.beautified ? 1 : 0)) * 5;
      candidates.push({ owner, district, index, cost, score: threat + value });
    });
  }

  candidates.sort((a, b) => b.score - a.score || a.cost - b.cost);
  const target = candidates[0];
  if (!target) return;

  actor.gold -= target.cost;
  const [destroyed] = target.owner.built.splice(target.index, 1);
  if (destroyed.id === 'museum' && Array.isArray(destroyed.storedCards)) {
    putOnDeckBottom(session, destroyed.storedCards);
  }
  putOnDeckBottom(session, [destroyed]);
  action.destructionUsed = true;
  notes.push(`Hadúrként elpusztította ${target.owner.name} ${destroyed.name} kerületét (${target.cost} arany).`);
}

function botBuild(session, actor, current, action, notes) {
  const limit = current.characterId === 'architect' ? 3 : 1;
  let safety = 0;

  while (safety < 5) {
    safety += 1;
    const candidates = actor.hand
      .map((card, index) => ({
        card,
        index,
        cost: effectiveBuildCost(actor, card),
        score: botCardScore(actor, card)
      }))
      .filter(({ card, cost }) => {
        if (card.id === 'secret-vault') return false;
        if (card.id === 'monument' && actor.built.length >= 5) return false;
        if (card.id !== 'stables' && action.builds >= limit) return false;
        return cost <= actor.gold && canBuildDuplicate(actor, card);
      })
      .sort((a, b) => b.score - a.score || b.card.cost - a.card.cost || a.cost - b.cost);

    const choice = candidates[0];
    if (!choice) break;

    actor.gold -= choice.cost;
    const [card] = actor.hand.splice(choice.index, 1);
    actor.built.push({ ...card, beautified: false, builtAtRound: session.round });
    notes.push(`Megépítette: ${card.name} (${choice.cost} arany).`);
    if (card.id !== 'stables') action.builds += 1;

    if (!session.firstCompletedPlayerId && cityCompletionCount(actor) >= 7) {
      session.firstCompletedPlayerId = actor.id;
      session.finalRound = true;
    }
  }
}

function botUseMuseum(actor, action, notes) {
  const museum = actor.built.find((district) => district.id === 'museum');
  if (!museum || action.districtUses?.museum) return;

  const candidates = actor.hand
    .map((card, index) => ({ card, index, score: botCardScore(actor, card) }))
    .filter(({ card }) => card.id !== 'secret-vault')
    .sort((a, b) => a.score - b.score);
  const choice = candidates[0];
  if (!choice) return;

  const [stored] = actor.hand.splice(choice.index, 1);
  if (!Array.isArray(museum.storedCards)) museum.storedCards = [];
  museum.storedCards.push(stored);
  action.districtUses = action.districtUses || {};
  action.districtUses.museum = true;
  notes.push('A Múzeum alá tett 1, a stratégiájához kevésbé fontos kerületlapot (+1 játékvégi pont).');
}

function playBotTurn(session, actor) {
  const current = activeTurn(session);
  const action = activeAction(session);
  if (!current || !action || current.playerId !== actor.id) return;

  const notes = [];
  if (current.characterId === 'king') notes.push('Királyként megkapta a koronát.');
  if (current.characterId === 'merchant') notes.push('Kereskedőként automatikusan +1 aranyat kapott.');
  if (current.characterId === 'architect') notes.push('Építészként automatikusan 2 kerületlapot húzott.');

  botGatherResource(session, actor, action, notes);
  botUseCharacterAbility(session, actor, current, action, notes);

  if (current.characterId === 'warlord' && botStrategyDefinition(actor).id === 'military') {
    botUseWarlordDestruction(session, actor, action, notes);
  }

  botBuild(session, actor, current, action, notes);

  if (current.characterId === 'warlord' && !action.destructionUsed) {
    botUseWarlordDestruction(session, actor, action, notes);
  }

  botUseMuseum(actor, action, notes);
  addBotAction(session, actor, current.characterId, notes);
  endCurrentTurn(session);
}

function runBots(session) {
  let guard = 0;
  while (guard < 200) {
    guard += 1;

    if (session.phase === 'draft' && session.draft) {
      const playerId = session.draft.order[session.draft.index];
      const player = getPlayer(session, playerId);
      if (!player?.isBot) break;
      const choice = botChooseCharacter(session, player, draftOptions(session.draft));
      if (!choice) break;
      const completed = chooseCharacter(session.draft, player.id, choice);
      addBotAction(session, player, null, ['Titokban, a beállított stratégiája alapján karaktert választott.'], 'draft');
      if (completed) beginTurns(session);
      continue;
    }

    if (session.phase === 'turns' && session.turn) {
      const current = activeTurn(session);
      const player = current ? getPlayer(session, current.playerId) : null;
      if (!player?.isBot) break;
      playBotTurn(session, player);
      continue;
    }

    break;
  }

  if (guard >= 200) throw new Error('bot_guard_exhausted');
}

function inUseCharacterIds(session) {
  return new Set(inUseCharacters(session.players.length, session.selectedCharacterIds).map((character) => character.id));
}

function targetableCharacterIds(session, actingCharacterId) {
  const ids = inUseCharacterIds(session);
  for (const characterId of session.roundFaceUpCharacterIds || []) ids.delete(characterId);
  ids.delete(actingCharacterId);

  const effects = ensureRoundEffects(session);
  if (actingCharacterId === 'thief' || actingCharacterId === 'blackmailer') {
    for (const characterId of [...ids]) {
      if (CHARACTER_MAP.get(characterId)?.rank === 1) ids.delete(characterId);
    }
    ids.delete(effects.assassinatedCharacterId);
    ids.delete(effects.witchTargetCharacterId);
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
      isBot: false
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
      selectedUniqueDistrictIds: [...DEFAULT_UNIQUE_DISTRICT_IDS],
      selectedCharacterIds: [...DEFAULT_CHARACTER_IDS],
      taxPool: 0,
      districtDeck: [],
      draft: null,
      turn: null,
      roundEffects: {},
      roundFaceUpCharacterIds: [],
      botActionLog: [],
      botActionSeq: 0,
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
        isBot: false
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

api.post('/session/:code/bots', async (req, res, next) => {
  try {
    await withLock(req.params.code, async () => {
      const session = requireSession(await loadSession(req.params.code));
      const actor = authPlayer(session, req);
      requireHost(session, actor);
      if (session.phase !== 'lobby') throw httpError(409, 'lobby_only');
      setBotCount(session, req.body.count);
      await saveSession(session);
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

api.post('/session/:code/bots/strategy', async (req, res, next) => {
  try {
    await withLock(req.params.code, async () => {
      const session = requireSession(await loadSession(req.params.code));
      const actor = authPlayer(session, req);
      requireHost(session, actor);
      if (session.phase !== 'lobby') throw httpError(409, 'lobby_only');
      setBotStrategy(session, req.body.playerId, req.body.strategy);
      await saveSession(session);
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

api.post('/session/:code/config/characters', async (req, res, next) => {
  try {
    await withLock(req.params.code, async () => {
      const session = requireSession(await loadSession(req.params.code));
      const actor = authPlayer(session, req);
      requireHost(session, actor);
      if (session.phase !== 'lobby') throw httpError(409, 'lobby_only');
      try {
        session.selectedCharacterIds = validateCharacterSelection(req.body.characterIds);
      } catch (error) {
        throw httpError(400, error.message);
      }
      await saveSession(session);
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

api.post('/session/:code/config/unique-districts', async (req, res, next) => {
  try {
    await withLock(req.params.code, async () => {
      const session = requireSession(await loadSession(req.params.code));
      const actor = authPlayer(session, req);
      requireHost(session, actor);
      if (session.phase !== 'lobby') throw httpError(409, 'lobby_only');
      session.selectedUniqueDistrictIds = validateUniqueDistrictSelection(req.body.districtIds);
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
      session.selectedUniqueDistrictIds = validateUniqueDistrictSelection(session.selectedUniqueDistrictIds);
      try {
        session.selectedCharacterIds = validateCharacterSelection(session.selectedCharacterIds);
      } catch (error) {
        throw httpError(400, error.message);
      }
      session.taxPool = 0;

      session.round = 1;
      session.botActionLog = [];
      session.botActionSeq = 0;
      session.firstCompletedPlayerId = null;
      session.finalRound = false;
      session.winnerPlayerId = null;
      session.players.forEach(initializePlayerForGame);
      setupDistrictDeck(session);
      prepareDraft(session);
      runBots(session);
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
      runBots(session);
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
        actor.gold = Math.min(MAX_GOLD, actor.gold + 2 + (hasDistrict(actor, 'gold-mine') ? 1 : 0));
        action.resourceGathered = true;
      } else if (mode === 'cards') {
        const drawCount = hasDistrict(actor, 'observatory') ? 3 : 2;
        const drawn = drawCards(session, drawCount);
        action.resourceGathered = true;
        if (hasDistrict(actor, 'library')) actor.hand.push(...drawn);
        else action.pendingDraw = drawn;
      } else {
        throw httpError(400, 'invalid_resource_mode');
      }
      afterResourceChoice(session);
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
      afterResourceChoice(session);
      await saveSession(session);
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

api.post('/session/:code/turn/blackmail', async (req, res, next) => {
  try {
    await withLock(req.params.code, async () => {
      const session = requireSession(await loadSession(req.params.code));
      const actor = authPlayer(session, req);
      const current = requireActiveActor(session, actor);
      const action = activeAction(session);
      const effects = ensureRoundEffects(session);
      if (!action.blackmailPending) throw httpError(409, 'blackmail_not_pending');

      const blackmailer = getPlayer(session, effects.blackmailerPlayerId);
      const response = String(req.body.response || '');
      if (response === 'pay') {
        const amount = Math.floor(actor.gold / 2);
        actor.gold -= amount;
        if (blackmailer) blackmailer.gold = Math.min(MAX_GOLD, blackmailer.gold + amount);
      } else if (response === 'risk') {
        if (effects.blackmailRealCharacterId === current.characterId && blackmailer) {
          blackmailer.gold = Math.min(MAX_GOLD, blackmailer.gold + actor.gold);
          actor.gold = 0;
        }
      } else {
        throw httpError(400, 'invalid_blackmail_response');
      }

      effects.blackmailResolved[current.characterId] = true;
      action.blackmailPending = false;
      await saveSession(session);
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

function finalizeDistrictBuild(session, builder, currentCharacterId, card, paidCost, action) {
  const effects = ensureRoundEffects(session);
  let finalOwner = builder;
  let confiscated = false;

  if (
    paidCost > 0 &&
    effects.magistrateSignedCharacterId === currentCharacterId &&
    !effects.magistrateUsed
  ) {
    const magistrate = getPlayer(session, effects.magistratePlayerId);
    if (magistrate && magistrate.id !== builder.id && canBuildDuplicate(magistrate, card)) {
      const builtIndex = builder.built.findIndex((district) => district.cardId === card.cardId);
      if (builtIndex >= 0) {
        const [taken] = builder.built.splice(builtIndex, 1);
        builder.gold = Math.min(MAX_GOLD, builder.gold + paidCost);
        magistrate.built.push(taken);
        effects.magistrateUsed = true;
        finalOwner = magistrate;
        confiscated = true;
      }
    }
  }

  if (!confiscated && currentCharacterId === 'alchemist' && paidCost > 0) {
    action.buildGoldSpent = Number(action.buildGoldSpent || 0) + paidCost;
  }

  applyBuildTax(session, finalOwner);
  updateCityCompletion(session, finalOwner);
  return { finalOwner, confiscated };
}

api.post('/session/:code/turn/build', async (req, res, next) => {
  try {
    await withLock(req.params.code, async () => {
      const session = requireSession(await loadSession(req.params.code));
      const actor = authPlayer(session, req);
      const current = requireActiveActor(session, actor);
      const action = activeAction(session);
      if (!action.resourceGathered) throw httpError(409, 'resource_required');
      if (action.pendingDraw?.length || action.specialDraw?.length) throw httpError(409, 'draw_choice_required');
      if (action.seerPendingPlayerIds?.length) throw httpError(409, 'seer_return_required');
      if (action.blackmailPending) throw httpError(409, 'blackmail_response_required');

      const buildLimit = characterBuildLimit(current.characterId);
      if (buildLimit === 0) throw httpError(409, 'character_cannot_build');

      const cardId = String(req.body.cardId || '');
      const cardIndex = actor.hand.findIndex((card) => card.cardId === cardId);
      if (cardIndex < 0) throw httpError(404, 'district_not_in_hand');
      const card = actor.hand[cardIndex];
      if (buildConsumesLimit(current.characterId, card) && action.builds >= buildLimit) {
        throw httpError(409, 'build_limit_reached');
      }
      if (card.id === 'secret-vault') throw httpError(409, 'district_cannot_be_built');
      if (card.id === 'monument' && actor.built.length >= 5) throw httpError(409, 'monument_too_late');
      if (current.characterId !== 'wizard' && !canBuildDuplicate(actor, card)) {
        throw httpError(409, 'duplicate_district');
      }

      const cost = effectiveBuildCost(actor, card);
      if (actor.gold < cost) throw httpError(409, 'not_enough_gold');

      actor.gold -= cost;
      actor.hand.splice(cardIndex, 1);
      actor.built.push({ ...card, beautified: false, builtAtRound: session.round });
      if (buildConsumesLimit(current.characterId, card)) action.builds += 1;
      finalizeDistrictBuild(session, actor, current.characterId, actor.built[actor.built.length - 1], cost, action);

      await saveSession(session);
    });
    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});

function drawUpTo(session, count) {
  const safeCount = Math.min(Math.max(0, Number(count || 0)), session.districtDeck.length);
  return safeCount ? drawCards(session, safeCount) : [];
}

function takeRandomHandCard(player) {
  if (!player?.hand?.length) return null;
  const index = crypto.randomInt(0, player.hand.length);
  const [card] = player.hand.splice(index, 1);
  return card || null;
}

function returnCardsAndShuffle(session, cards) {
  session.districtDeck.push(...cards);
  for (let i = session.districtDeck.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    [session.districtDeck[i], session.districtDeck[j]] = [session.districtDeck[j], session.districtDeck[i]];
  }
}

function districtValue(district) {
  return Number(district.cost || 0) + (district.beautified ? 1 : 0);
}

function requireNoPendingTurnChoice(action) {
  if (action.blackmailPending) throw httpError(409, 'blackmail_response_required');
  if (action.pendingDraw?.length || action.specialDraw?.length) throw httpError(409, 'draw_choice_required');
  if (action.seerPendingPlayerIds?.length) throw httpError(409, 'seer_return_required');
}

api.post('/session/:code/turn/ability', async (req, res, next) => {
  try {
    await withLock(req.params.code, async () => {
      const session = requireSession(await loadSession(req.params.code));
      const actor = authPlayer(session, req);
      const current = requireActiveActor(session, actor);
      const action = activeAction(session);
      const effects = ensureRoundEffects(session);
      const abilityAction = String(req.body.action || '');
      const roleId = current.characterId;

      if (action.bewitchedVictim) throw httpError(409, 'bewitched_action_forbidden');
      if (!['seer-return', 'scholar-keep'].includes(abilityAction)) requireNoPendingTurnChoice(action);

      if (roleId === 'assassin') {
        if (action.specialUsed) throw httpError(409, 'ability_already_used');
        if (abilityAction !== 'target-character') throw httpError(400, 'invalid_ability_action');
        const target = String(req.body.targetCharacterId || '');
        if (!targetableCharacterIds(session, roleId).has(target)) throw httpError(400, 'invalid_character_target');
        effects.assassinatedCharacterId = target;
        action.specialUsed = true;

      } else if (roleId === 'witch') {
        if (action.specialUsed) throw httpError(409, 'ability_already_used');
        if (!action.resourceGathered) throw httpError(409, 'resource_required');
        if (abilityAction !== 'target-character') throw httpError(400, 'invalid_ability_action');
        const target = String(req.body.targetCharacterId || '');
        if (!targetableCharacterIds(session, roleId).has(target)) throw httpError(400, 'invalid_character_target');
        effects.witchTargetCharacterId = target;
        effects.witchPlayerId = actor.id;
        action.specialUsed = true;

        const futureTarget = session.turn.order
          .slice(session.turn.index + 1)
          .some((entry) => !entry.witchContinuation && entry.characterId === target);
        if (futureTarget && effects.assassinatedCharacterId !== target) {
          session.turn.index += 1;
          activateCurrentTurn(session);
        } else {
          endCurrentTurn(session);
        }

      } else if (roleId === 'magistrate') {
        if (action.specialUsed) throw httpError(409, 'ability_already_used');
        if (abilityAction !== 'set-orders') throw httpError(400, 'invalid_ability_action');
        const targets = Array.isArray(req.body.targetCharacterIds)
          ? [...new Set(req.body.targetCharacterIds.map(String))]
          : [];
        const signed = String(req.body.signedCharacterId || '');
        const allowed = targetableCharacterIds(session, roleId);
        if (targets.length !== 3 || targets.some((idValue) => !allowed.has(idValue)) || !targets.includes(signed)) {
          throw httpError(400, 'invalid_character_target');
        }
        effects.magistrateTargetCharacterIds = targets;
        effects.magistrateSignedCharacterId = signed;
        effects.magistratePlayerId = actor.id;
        effects.magistrateUsed = false;
        action.specialUsed = true;

      } else if (roleId === 'thief') {
        if (action.specialUsed) throw httpError(409, 'ability_already_used');
        if (abilityAction !== 'target-character') throw httpError(400, 'invalid_ability_action');
        const target = String(req.body.targetCharacterId || '');
        if (!targetableCharacterIds(session, roleId).has(target)) throw httpError(400, 'invalid_character_target');
        effects.thiefTargetCharacterId = target;
        effects.thiefPlayerId = actor.id;
        action.specialUsed = true;

      } else if (roleId === 'spy') {
        if (action.specialUsed) throw httpError(409, 'ability_already_used');
        if (abilityAction !== 'spy') throw httpError(400, 'invalid_ability_action');
        const target = getPlayer(session, String(req.body.targetPlayerId || ''));
        const type = String(req.body.districtType || '');
        if (!target || target.id === actor.id) throw httpError(400, 'invalid_player_target');
        if (!DISTRICT_TYPES.some((item) => item.id === type)) throw httpError(400, 'invalid_district_type');
        const matches = target.hand.filter((card) => card.type === type).length;
        const stolenGold = Math.min(matches, target.gold);
        target.gold -= stolenGold;
        actor.gold = Math.min(MAX_GOLD, actor.gold + stolenGold);
        actor.hand.push(...drawUpTo(session, matches));
        action.specialUsed = true;

      } else if (roleId === 'blackmailer') {
        if (action.specialUsed) throw httpError(409, 'ability_already_used');
        if (abilityAction !== 'set-threats') throw httpError(400, 'invalid_ability_action');
        const targets = Array.isArray(req.body.targetCharacterIds)
          ? [...new Set(req.body.targetCharacterIds.map(String))]
          : [];
        const real = String(req.body.realCharacterId || '');
        const allowed = targetableCharacterIds(session, roleId);
        if (targets.length !== 2 || targets.some((idValue) => !allowed.has(idValue)) || !targets.includes(real)) {
          throw httpError(400, 'invalid_character_target');
        }
        effects.blackmailTargetCharacterIds = targets;
        effects.blackmailRealCharacterId = real;
        effects.blackmailerPlayerId = actor.id;
        effects.blackmailResolved = {};
        action.specialUsed = true;

      } else if (roleId === 'magician') {
        if (action.specialUsed) throw httpError(409, 'ability_already_used');
        if (abilityAction === 'swap-hands') {
          const target = getPlayer(session, String(req.body.targetPlayerId || ''));
          if (!target || target.id === actor.id) throw httpError(400, 'invalid_player_target');
          [actor.hand, target.hand] = [target.hand, actor.hand];
          action.specialUsed = true;
        } else if (abilityAction === 'redraw') {
          const cardIds = Array.isArray(req.body.cardIds) ? [...new Set(req.body.cardIds.map(String))] : [];
          if (!cardIds.length) throw httpError(400, 'cards_required');
          const selected = cardIds.map((cardId) => actor.hand.find((card) => card.cardId === cardId));
          if (selected.some((card) => !card)) throw httpError(400, 'district_not_in_hand');
          actor.hand = actor.hand.filter((card) => !cardIds.includes(card.cardId));
          putOnDeckBottom(session, selected);
          actor.hand.push(...drawUpTo(session, selected.length));
          action.specialUsed = true;
        } else {
          throw httpError(400, 'invalid_ability_action');
        }

      } else if (roleId === 'wizard') {
        if (action.specialUsed) throw httpError(409, 'ability_already_used');
        if (abilityAction === 'inspect') {
          const target = getPlayer(session, String(req.body.targetPlayerId || ''));
          if (!target || target.id === actor.id) throw httpError(400, 'invalid_player_target');
          action.inspectedPlayerId = target.id;
          action.inspectedHand = target.hand.map((card) => ({ ...card }));
        } else if (abilityAction === 'take-card') {
          const target = getPlayer(session, action.inspectedPlayerId);
          if (!target || target.id === actor.id) throw httpError(400, 'invalid_player_target');
          const cardId = String(req.body.cardId || '');
          const index = target.hand.findIndex((card) => card.cardId === cardId);
          if (index < 0) throw httpError(404, 'district_not_in_hand');
          const card = target.hand[index];
          const mode = String(req.body.mode || 'keep');

          if (mode === 'build') {
            if (card.id === 'secret-vault') throw httpError(409, 'district_cannot_be_built');
            if (card.id === 'monument' && actor.built.length >= 5) throw httpError(409, 'monument_too_late');
            const cost = effectiveBuildCost(actor, card);
            if (actor.gold < cost) throw httpError(409, 'not_enough_gold');

            target.hand.splice(index, 1);
            actor.gold -= cost;
            actor.built.push({ ...card, beautified: false, builtAtRound: session.round });
            finalizeDistrictBuild(session, actor, roleId, actor.built[actor.built.length - 1], cost, action);
          } else if (mode === 'keep') {
            target.hand.splice(index, 1);
            actor.hand.push(card);
          } else {
            throw httpError(400, 'invalid_ability_action');
          }
          action.inspectedHand = [];
          action.inspectedPlayerId = null;
          action.specialUsed = true;
        } else {
          throw httpError(400, 'invalid_ability_action');
        }

      } else if (roleId === 'seer') {
        if (abilityAction === 'seer-draw') {
          if (action.specialUsed) throw httpError(409, 'ability_already_used');
          const pending = [];
          for (const player of session.players) {
            if (player.id === actor.id || !player.hand.length) continue;
            const card = takeRandomHandCard(player);
            if (card) {
              actor.hand.push(card);
              pending.push(player.id);
            }
          }
          action.seerPendingPlayerIds = pending;
          action.specialUsed = true;
        } else if (abilityAction === 'seer-return') {
          const targetId = String(req.body.targetPlayerId || '');
          if (!action.seerPendingPlayerIds?.includes(targetId)) throw httpError(400, 'invalid_player_target');
          const target = getPlayer(session, targetId);
          const cardId = String(req.body.cardId || '');
          const index = actor.hand.findIndex((card) => card.cardId === cardId);
          if (!target || index < 0) throw httpError(404, 'district_not_in_hand');
          const [card] = actor.hand.splice(index, 1);
          target.hand.push(card);
          action.seerPendingPlayerIds = action.seerPendingPlayerIds.filter((idValue) => idValue !== targetId);
        } else {
          throw httpError(400, 'invalid_ability_action');
        }

      } else if (['king', 'emperor', 'bishop', 'merchant', 'trader', 'warlord', 'diplomat', 'marshal'].includes(roleId) && abilityAction === 'income') {
        if (action.incomeUsed) throw httpError(409, 'ability_already_used');
        const amount = characterIncome(actor, roleId);
        actor.gold = Math.min(MAX_GOLD, actor.gold + amount);
        action.incomeUsed = true;

      } else if (['patrician', 'cardinal'].includes(roleId) && abilityAction === 'income') {
        if (action.incomeUsed) throw httpError(409, 'ability_already_used');
        const amount = characterIncome(actor, roleId);
        actor.hand.push(...drawUpTo(session, amount));
        action.incomeUsed = true;

      } else if (roleId === 'abbot' && abilityAction === 'abbot-income') {
        if (action.incomeUsed) throw httpError(409, 'ability_already_used');
        const amount = characterIncome(actor, roleId);
        const goldCount = clampInt(req.body.goldCount, 0, amount, 'invalid_resource_count');
        const cardCount = amount - goldCount;
        actor.gold = Math.min(MAX_GOLD, actor.gold + goldCount);
        actor.hand.push(...drawUpTo(session, cardCount));
        action.incomeUsed = true;

        const richestGold = Math.max(0, ...session.players.filter((player) => player.id !== actor.id).map((player) => player.gold));
        if (richestGold > actor.gold) {
          const richest = session.players.filter((player) => player.id !== actor.id && player.gold === richestGold);
          const requested = getPlayer(session, String(req.body.richestPlayerId || ''));
          const payer = requested && richest.some((player) => player.id === requested.id) ? requested : richest[0];
          if (payer?.gold > 0) {
            payer.gold -= 1;
            actor.gold = Math.min(MAX_GOLD, actor.gold + 1);
          }
        }

      } else if (roleId === 'cardinal' && abilityAction === 'cardinal-build') {
        if (action.specialUsed) throw httpError(409, 'ability_already_used');
        if (!action.resourceGathered) throw httpError(409, 'resource_required');
        const buildLimit = characterBuildLimit(roleId);
        const cardId = String(req.body.cardId || '');
        const cardIndex = actor.hand.findIndex((card) => card.cardId === cardId);
        if (cardIndex < 0) throw httpError(404, 'district_not_in_hand');
        const card = actor.hand[cardIndex];
        if (buildConsumesLimit(roleId, card) && action.builds >= buildLimit) throw httpError(409, 'build_limit_reached');
        if (card.id === 'secret-vault') throw httpError(409, 'district_cannot_be_built');
        if (card.id === 'monument' && actor.built.length >= 5) throw httpError(409, 'monument_too_late');
        if (!canBuildDuplicate(actor, card)) throw httpError(409, 'duplicate_district');
        const cost = effectiveBuildCost(actor, card);
        const shortage = Math.max(0, cost - actor.gold);
        if (shortage <= 0) throw httpError(409, 'cardinal_funding_not_needed');

        const target = getPlayer(session, String(req.body.targetPlayerId || ''));
        if (!target || target.id === actor.id || target.gold < shortage) throw httpError(400, 'invalid_player_target');
        const paymentIds = Array.isArray(req.body.paymentCardIds)
          ? [...new Set(req.body.paymentCardIds.map(String))]
          : [];
        if (paymentIds.length !== shortage || paymentIds.includes(cardId)) throw httpError(400, 'cards_required');
        const paymentCards = paymentIds.map((idValue) => actor.hand.find((item) => item.cardId === idValue));
        if (paymentCards.some((item) => !item)) throw httpError(404, 'district_not_in_hand');

        actor.hand = actor.hand.filter((item) => !paymentIds.includes(item.cardId));
        target.hand.push(...paymentCards);
        target.gold -= shortage;
        actor.gold += shortage;

        const newIndex = actor.hand.findIndex((item) => item.cardId === cardId);
        const [builtCard] = actor.hand.splice(newIndex, 1);
        actor.gold -= cost;
        actor.built.push({ ...builtCard, beautified: false, builtAtRound: session.round });
        if (buildConsumesLimit(roleId, builtCard)) action.builds += 1;
        finalizeDistrictBuild(session, actor, roleId, actor.built[actor.built.length - 1], cost, action);
        action.specialUsed = true;

      } else if (roleId === 'emperor' && abilityAction === 'crown') {
        if (action.specialUsed) throw httpError(409, 'ability_already_used');
        const target = getPlayer(session, String(req.body.targetPlayerId || ''));
        if (!target || target.id === actor.id || target.id === session.crownPlayerId) throw httpError(400, 'invalid_player_target');
        const payment = String(req.body.payment || 'gold');
        session.crownPlayerId = target.id;
        if (payment === 'gold' && target.gold > 0) {
          target.gold -= 1;
          actor.gold = Math.min(MAX_GOLD, actor.gold + 1);
        } else if (payment === 'card' && target.hand.length > 0) {
          const card = takeRandomHandCard(target);
          if (card) actor.hand.push(card);
        } else if (!(target.gold === 0 && target.hand.length === 0)) {
          throw httpError(409, 'emperor_payment_unavailable');
        }
        action.specialUsed = true;

      } else if (roleId === 'navigator' && abilityAction === 'navigator-resource') {
        if (action.specialUsed) throw httpError(409, 'ability_already_used');
        const mode = String(req.body.mode || '');
        if (mode === 'gold') actor.gold = Math.min(MAX_GOLD, actor.gold + 4);
        else if (mode === 'cards') actor.hand.push(...drawUpTo(session, 4));
        else throw httpError(400, 'invalid_resource_mode');
        action.specialUsed = true;

      } else if (roleId === 'scholar') {
        if (abilityAction === 'scholar-draw') {
          if (action.specialUsed) throw httpError(409, 'ability_already_used');
          action.specialDraw = drawUpTo(session, 7);
          action.specialUsed = true;
        } else if (abilityAction === 'scholar-keep') {
          const cardId = String(req.body.cardId || '');
          const chosen = action.specialDraw?.find((card) => card.cardId === cardId);
          if (!chosen) throw httpError(400, 'invalid_draw_choice');
          actor.hand.push(chosen);
          returnCardsAndShuffle(session, action.specialDraw.filter((card) => card.cardId !== cardId));
          action.specialDraw = [];
        } else {
          throw httpError(400, 'invalid_ability_action');
        }

      } else if (roleId === 'warlord' && abilityAction === 'destroy-district') {
        if (action.destructionUsed) throw httpError(409, 'ability_already_used');
        const found = findBuiltDistrict(session, String(req.body.cardId || ''));
        if (!found) throw httpError(404, 'district_not_found');
        if (cityCompletionCount(found.owner) >= 7) throw httpError(409, 'completed_city_protected');
        if (isRankEightProtected(session, found.owner)) throw httpError(409, 'bishop_protected');
        if (found.district.id === 'keep') throw httpError(409, 'keep_protected');
        const destroyCost = districtDestructionCost(found.owner, found.district);
        if (actor.gold < destroyCost) throw httpError(409, 'not_enough_gold');
        actor.gold -= destroyCost;
        const [destroyed] = found.owner.built.splice(found.index, 1);
        if (destroyed.id === 'museum' && Array.isArray(destroyed.storedCards)) putOnDeckBottom(session, destroyed.storedCards);
        putOnDeckBottom(session, [destroyed]);
        action.destructionUsed = true;

      } else if (roleId === 'diplomat' && abilityAction === 'swap-districts') {
        if (action.specialUsed) throw httpError(409, 'ability_already_used');
        const ownFound = findBuiltDistrict(session, String(req.body.ownCardId || ''));
        const targetFound = findBuiltDistrict(session, String(req.body.targetCardId || ''));
        if (!ownFound || ownFound.owner.id !== actor.id || !targetFound || targetFound.owner.id === actor.id) {
          throw httpError(400, 'invalid_district_target');
        }
        if (cityCompletionCount(targetFound.owner) >= 7) throw httpError(409, 'completed_city_protected');
        if (isRankEightProtected(session, targetFound.owner)) throw httpError(409, 'bishop_protected');

        const actorOther = actor.built.filter((district) => district.cardId !== ownFound.district.cardId);
        const targetOther = targetFound.owner.built.filter((district) => district.cardId !== targetFound.district.cardId);
        const actorProbe = { ...actor, built: actorOther };
        const targetProbe = { ...targetFound.owner, built: targetOther };
        if (!canBuildDuplicate(actorProbe, targetFound.district) || !canBuildDuplicate(targetProbe, ownFound.district)) {
          throw httpError(409, 'duplicate_district');
        }

        const difference = Math.max(0, districtValue(targetFound.district) - districtValue(ownFound.district));
        if (actor.gold < difference) throw httpError(409, 'not_enough_gold');
        actor.gold -= difference;

        actor.built[ownFound.index] = targetFound.district;
        targetFound.owner.built[targetFound.index] = ownFound.district;
        action.specialUsed = true;

      } else if (roleId === 'marshal' && abilityAction === 'seize-district') {
        if (action.specialUsed) throw httpError(409, 'ability_already_used');
        const found = findBuiltDistrict(session, String(req.body.cardId || ''));
        if (!found || found.owner.id === actor.id) throw httpError(400, 'invalid_district_target');
        if (cityCompletionCount(found.owner) >= 7) throw httpError(409, 'completed_city_protected');
        if (isRankEightProtected(session, found.owner)) throw httpError(409, 'bishop_protected');
        const cost = districtValue(found.district);
        if (cost > 3) throw httpError(409, 'marshal_cost_limit');
        if (!canBuildDuplicate(actor, found.district)) throw httpError(409, 'duplicate_district');
        if (actor.gold < cost) throw httpError(409, 'not_enough_gold');

        actor.gold -= cost;
        found.owner.gold = Math.min(MAX_GOLD, found.owner.gold + cost);
        const [taken] = found.owner.built.splice(found.index, 1);
        actor.built.push(taken);
        updateCityCompletion(session, actor);
        action.specialUsed = true;

      } else if (roleId === 'artist' && abilityAction === 'beautify') {
        if (action.artistUses >= 2) throw httpError(409, 'ability_already_used');
        const found = findBuiltDistrict(session, String(req.body.cardId || ''));
        if (!found || found.owner.id !== actor.id) throw httpError(400, 'invalid_district_target');
        if (found.district.beautified) throw httpError(409, 'district_already_beautified');
        if (actor.gold < 1) throw httpError(409, 'not_enough_gold');
        actor.gold -= 1;
        found.district.beautified = true;
        action.artistUses += 1;
        if (action.artistUses >= 2) action.specialUsed = true;

      } else if (roleId === 'tax-collector' && abilityAction === 'collect-tax') {
        if (action.specialUsed) throw httpError(409, 'ability_already_used');
        actor.gold = Math.min(MAX_GOLD, actor.gold + Number(session.taxPool || 0));
        session.taxPool = 0;
        action.specialUsed = true;

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
      } else if (districtId === 'museum') {
        const museum = actor.built.find((district) => district.id === 'museum');
        if (!museum) throw httpError(409, 'district_ability_unavailable');
        if (action.districtUses.museum) throw httpError(409, 'district_ability_already_used');

        const cardId = String(req.body.cardId || '');
        const cardIndex = actor.hand.findIndex((card) => card.cardId === cardId);
        if (cardIndex < 0) throw httpError(404, 'district_not_in_hand');

        const [stored] = actor.hand.splice(cardIndex, 1);
        if (!Array.isArray(museum.storedCards)) museum.storedCards = [];
        museum.storedCards.push(stored);
        action.districtUses.museum = true;
      } else {
        throw httpError(400, 'invalid_district_ability');
      }

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
      const index = owner.built.findIndex((district) => district.cardId === req.params.districtId);
      const [removed] = owner.built.splice(index, 1);
      if (removed?.id === 'museum' && Array.isArray(removed.storedCards)) {
        putOnDeckBottom(session, removed.storedCards);
      }
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
      runBots(session);
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
  targetableCharacterIds,
  cityCompletionCount,
  validateUniqueDistrictSelection,
  setBotCount,
  setBotStrategy,
  BOT_STRATEGIES,
  botChooseCharacter,
  botCardScore,
  districtDestructionCost,
  runBots
};
