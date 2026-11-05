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
