'use strict';

// Isolated HTTP test rig. Each test gets a fresh in-memory Redis substitute
// and a real Express listener on 127.0.0.1:0. No NUC, k3s, or live Redis.
const assert = require('node:assert/strict');
const { app, setRedisClientForTests } = require('../../server');
const { CHARACTER_MAP, DEFAULT_CHARACTER_IDS } = require('../../game');

function memoryRedis() {
  const values = new Map();
  return {
    values,
    async get(key) { return values.get(key) ?? null; },
    async setEx(key, _ttl, value) { values.set(key, value); return 'OK'; },
    async ttl(key) { return values.has(key) ? 3600 : -2; },
    async exists(key) { return values.has(key) ? 1 : 0; },
    async expire(key) { return values.has(key) ? 1 : 0; },
    async ping() { return 'PONG'; }
  };
}

function card(id, type = 'trade', cost = 1, instanceId = id) {
  return { id, cardId: 'fixture_' + instanceId, name: id, type, cost, effect: null };
}

function built(id, type = 'trade', cost = 1, instanceId = id) {
  return { ...card(id, type, cost, instanceId), beautified: false, builtAtRound: 1 };
}

async function openRig(t, { players = 2, characterNine = 'artist' } = {}) {
  const store = memoryRedis();
  setRedisClientForTests(store);

  const listener = await new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
  t.after(() => new Promise((resolve, reject) => {
    listener.close((error) => error ? reject(error) : resolve());
  }));

  const base = 'http://127.0.0.1:' + listener.address().port + '/citadella/api';

  async function request(path, { method = 'GET', body, auth, expected = 200 } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (auth) {
      headers['x-player-id'] = auth.playerId;
      headers['x-player-token'] = auth.token;
    }
    const response = await fetch(base + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body)
    });
    const payload = await response.json();
    assert.equal(
      response.status, expected,
      method + ' ' + path + ': expected ' + expected + ', got ' +
        response.status + ': ' + JSON.stringify(payload)
    );
    return payload;
  }
  const created = await request('/session', {
    method: 'POST', body: { hostName: 'E2E Host' }, expected: 201
  });
  const code = created.code;
  const route = '/session/' + code;
  const auth = [{ playerId: created.playerId, token: created.token }];

  for (let i = 1; i < players; i += 1) {
    const joined = await request(route + '/join', {
      method: 'POST', body: { name: 'E2E Player ' + i }, expected: 201
    });
    auth.push({ playerId: joined.playerId, token: joined.token });
  }

  if (players === 3) {
    const selected = [...DEFAULT_CHARACTER_IDS];
    selected[8] = characterNine;
    await request(route + '/config/characters', {
      method: 'POST', auth: auth[0], body: { characterIds: selected }
    });
  }

  const key = 'citadella:session:' + code;
  function raw() {
    const value = store.values.get(key);
    assert.ok(value, 'missing isolated session ' + key);
    return JSON.parse(value);
  }
  function overwrite(value) {
    store.values.set(key, JSON.stringify(value));
  }
  function mutate(fn) {
    const value = raw();
    fn(value);
    overwrite(value);
    return value;
  }
  const post = (path, body = {}, who = 0, expected = 200) => request(route + path, {
    method: 'POST', auth: auth[who], body, expected
  });
  const get = (who = 0) => request(route + '/state', { auth: auth[who] });

  return { request, store, code, route, auth, raw, mutate, post, get };
}

// Scenario fixture: all code paths after this point are exercised through
// real HTTP requests and the same persisted-session load/save path as prod.
function seedTurn(rig, roleId, {
  count = 2, opponentRole = 'king', otherCards = [card('market', 'trade', 2, 'market')],
  ownCards = [card('tavern', 'trade', 1, 'tavern'), card('temple', 'religious', 1, 'temple')],
  ownBuilt = [], opponentBuilt = [], gold = 10, otherGold = 9,
  extra = null
} = {}) {
  const rank = CHARACTER_MAP.get(roleId)?.rank;
  assert.ok(rank, 'unknown character ' + roleId);
  assert.equal(rig.auth.length, count);

  rig.mutate((session) => {
    session.phase = 'turns';
    session.round = 1;
    session.firstCompletedPlayerId = null;
    session.finalRound = false;
    session.winnerPlayerId = null;
    session.roundEffects = {};
    session.roundFaceUpCharacterIds = [];
    session.botActionLog = [];
    session.botActionSeq = 0;
    session.selectedCharacterIds = [...DEFAULT_CHARACTER_IDS];
    session.selectedCharacterIds[rank - 1] = roleId;
    if (count === 3) session.selectedCharacterIds[8] = roleId === 'tax-collector' || roleId === 'artist' ? roleId : 'artist';
    if (count === 8) session.selectedCharacterIds[8] = roleId;

    session.players.forEach((player, i) => {
      const owned = i === 0 ? [roleId] : i === 1 ? [opponentRole] : [];
      player.characterIds = owned;
      player.characterId = owned[0] || null;
      player.gold = i === 0 ? gold : otherGold;
      player.built = i === 0 ? structuredClone(ownBuilt) : i === 1 ? structuredClone(opponentBuilt) : [];
      player.hand = i === 0 ? structuredClone(ownCards) : i === 1 ? structuredClone(otherCards) : [];
    });

    session.turn = {
      order: [
        { playerId: session.players[0].id, characterId: roleId, rank },
        { playerId: session.players[1].id, characterId: opponentRole,
          rank: CHARACTER_MAP.get(opponentRole)?.rank ?? 4 }
      ],
      index: 0,
      revealedPlayerIds: [session.players[0].id],
      revealedCharacterIds: [roleId],
      skippedPlayerIds: [],
      action: {
        playerId: session.players[0].id, resourceGathered: true,
        builds: 0, incomeUsed: false, specialUsed: false,
        destructionUsed: false, witchContinuation: false,
        bewitchedVictim: false, blackmailPending: false,
        districtUses: {}, pendingDraw: [], specialDraw: [],
        inspectedHand: [], inspectedPlayerId: null,
        seerPendingPlayerIds: [], buildGoldSpent: 0, artistUses: 0
      }
    };

    if (typeof extra === 'function') extra(session);
  });
}

module.exports = { openRig, seedTurn, card, built };
