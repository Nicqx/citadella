'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { app, setRedisClientForTests } = require('../server');

function memoryRedis() {
  const values = new Map();
  return {
    async get(key) { return values.has(key) ? values.get(key) : null; },
    async setEx(key, _ttlSeconds, value) { values.set(key, value); return 'OK'; },
    async ttl(key) { return values.has(key) ? 3600 : -2; },
    async exists(key) { return values.has(key) ? 1 : 0; },
    async expire(key, _ttlSeconds) { return values.has(key) ? 1 : 0; },
    async ping() { return 'PONG'; }
  };
}

async function startServer() {
  setRedisClientForTests(memoryRedis());
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const address = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}/citadella/api`
  };
}

async function jsonRequest(baseUrl, path, { method = 'GET', body, auth } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (auth) {
    headers['x-player-id'] = auth.playerId;
    headers['x-player-token'] = auth.token;
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json();
  assert.ok(
    response.ok,
    `${method} ${path} failed with ${response.status}: ${JSON.stringify(payload)}`
  );
  return payload;
}

test('HTTP E2E: one human + one bot receives two characters and four total character turns', async (t) => {
  const { server, baseUrl } = await startServer();
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const created = await jsonRequest(baseUrl, '/session', {
    method: 'POST',
    body: { hostName: 'Nick' }
  });
  const auth = {
    playerId: created.playerId,
    token: created.token
  };

  await jsonRequest(baseUrl, `/session/${created.code}/bots`, {
    method: 'POST',
    auth,
    body: { count: 1 }
  });

  const lobby = await jsonRequest(baseUrl, `/session/${created.code}/state`, { auth });
  assert.equal(lobby.players.length, 2);
  assert.equal(lobby.botCount, 1);

  await jsonRequest(baseUrl, `/session/${created.code}/start`, {
    method: 'POST',
    auth
  });

  const firstDraft = await jsonRequest(baseUrl, `/session/${created.code}/state`, { auth });
  assert.equal(firstDraft.phase, 'draft');
  assert.equal(firstDraft.draft.currentPlayerId, auth.playerId);
  assert.equal(firstDraft.draft.myChoices.length, 0);
  assert.ok(firstDraft.draft.options.length >= 1);

  await jsonRequest(baseUrl, `/session/${created.code}/draft/choose`, {
    method: 'POST',
    auth,
    body: { characterId: firstDraft.draft.options[0].id }
  });

  const secondDraft = await jsonRequest(baseUrl, `/session/${created.code}/state`, { auth });
  assert.equal(secondDraft.phase, 'draft');
  assert.equal(secondDraft.draft.currentPlayerId, auth.playerId);
  assert.equal(secondDraft.draft.myChoices.length, 1);
  assert.equal(secondDraft.draft.discardRequired, true);
  assert.ok(secondDraft.draft.options.length >= 2);

  await jsonRequest(baseUrl, `/session/${created.code}/draft/choose`, {
    method: 'POST',
    auth,
    body: {
      characterId: secondDraft.draft.options[0].id,
      discardCharacterId: secondDraft.draft.options[1].id
    }
  });

  const turns = await jsonRequest(baseUrl, `/session/${created.code}/state`, { auth });
  assert.equal(turns.phase, 'turns');
  assert.equal(turns.me.characterCount, 2);
  assert.equal(turns.me.characters.length, 2);
  assert.equal(new Set(turns.me.characters.map((character) => character.id)).size, 2);
  assert.equal(turns.turn.total, 4);

  const ownTurnEntries = turns.players.find((player) => player.id === auth.playerId);
  assert.equal(ownTurnEntries.characterCount, 2);
});


test('HTTP E2E: the eighth district starts the final round and the last character turn finishes the game', async (t) => {
  const { server, baseUrl } = await startServer();
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const created = await jsonRequest(baseUrl, '/session', {
    method: 'POST', body: { hostName: 'Two-player endgame test' }
  });
  const auth = { playerId: created.playerId, token: created.token };
  const route = `/session/${created.code}`;

  await jsonRequest(baseUrl, `${route}/bots`, {
    method: 'POST', auth, body: { count: 1 }
  });
  await jsonRequest(baseUrl, `${route}/start`, { method: 'POST', auth });

  let draft = await jsonRequest(baseUrl, `${route}/state`, { auth });
  await jsonRequest(baseUrl, `${route}/draft/choose`, {
    method: 'POST', auth, body: { characterId: draft.draft.options[0].id }
  });
  draft = await jsonRequest(baseUrl, `${route}/state`, { auth });
  await jsonRequest(baseUrl, `${route}/draft/choose`, {
    method: 'POST', auth,
    body: {
      characterId: draft.draft.options[0].id,
      discardCharacterId: draft.draft.options[1].id
    }
  });

  let state = await jsonRequest(baseUrl, `${route}/state`, { auth });
  assert.equal(state.phase, 'turns');
  assert.equal(state.players.length, 2);
  assert.equal(state.finalRound, false);
  assert.equal(state.turn.total, 4);

  // The manual-district HTTP action uses updateCityCompletion, just as real
  // hand-card builds, so this isolates the 7->8 threshold and round finish.
  for (let districtNumber = 1; districtNumber <= 7; districtNumber += 1) {
    await jsonRequest(baseUrl, `${route}/district`, {
      method: 'POST', auth,
      body: {
        name: `Regression district ${districtNumber}`,
        type: 'trade', cost: 1, playerId: auth.playerId
      }
    });
  }

  state = await jsonRequest(baseUrl, `${route}/state`, { auth });
  assert.equal(state.me.built.length, 7);
  assert.equal(state.finalRound, false);
  assert.equal(state.firstCompletedPlayerId, null);

  await jsonRequest(baseUrl, `${route}/district`, {
    method: 'POST', auth,
    body: {
      name: 'Eighth regression district',
      type: 'trade', cost: 1, playerId: auth.playerId
    }
  });

  state = await jsonRequest(baseUrl, `${route}/state`, { auth });
  assert.equal(state.me.built.length, 8);
  assert.equal(state.finalRound, true);
  assert.equal(state.firstCompletedPlayerId, auth.playerId);
  assert.equal(state.phase, 'turns', 'remaining character turns must still be played');

  // All bot character turns are played automatically. End each human
  // character turn, then assert that NO subsequent draft is started.
  for (let guard = 0; guard < 5 && state.phase === 'turns'; guard += 1) {
    assert.equal(state.turn.activePlayerId, auth.playerId);
    if (!state.turn.action.resourceGathered) {
      await jsonRequest(baseUrl, `${route}/turn/resource`, {
        method: 'POST', auth, body: { mode: 'gold' }
      });
    }
    await jsonRequest(baseUrl, `${route}/turn/end`, {
      method: 'POST', auth
    });
    state = await jsonRequest(baseUrl, `${route}/state`, { auth });
  }

  assert.equal(state.phase, 'finished', 'the game must end at the end of the current round');
  assert.equal(state.round, 1, 'the game must not start another round after eighth district');
  assert.equal(state.winnerPlayerId, auth.playerId);
  assert.equal(state.scores.find((score) => score.playerId === auth.playerId).completionBonus, 4);
});
