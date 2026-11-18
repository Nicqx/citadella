'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_CHARACTER_IDS } = require('../game');
const { openRig } = require('./support/http-e2e-rig');

for (const playerCount of [4, 5, 6, 7]) {
  for (const useNinthCharacter of [false, true]) {
    test('NINTH ROLE HTTP: ' + playerCount + ' players, ' +
      (useNinthCharacter ? 9 : 8) + ' characters, complete private draft', async (t) => {
      const h = await openRig(t, { players: playerCount });
      const selected = [...DEFAULT_CHARACTER_IDS];
      if (playerCount === 4) selected[8] = 'artist';

      const before = await h.get();
      assert.equal(before.useNinthCharacter, false, 'legacy default remains eight');
      await h.post('/config/characters', { characterIds: selected, useNinthCharacter });
      const lobby = await h.get();
      assert.equal(lobby.useNinthCharacter, useNinthCharacter);
      assert.equal(lobby.activeCharacterCount, useNinthCharacter ? 9 : 8);
      assert.equal(lobby.characters.length, useNinthCharacter ? 9 : 8);

      await h.post('/start');
      let state = await h.get();
      assert.equal(state.phase, 'draft');
      const rawDraft = h.raw().draft;
      const faceUp = useNinthCharacter
        ? [0, 0, 0, 0, 3, 2, 1, 0][playerCount]
        : [0, 0, 0, 0, 2, 1, 0, 0][playerCount];
      assert.equal(rawDraft.faceUpIds.length, faceUp);
      assert.ok(!rawDraft.faceUpIds.includes(selected[3]),
        'rank four must never be discarded face-up');
      assert.ok(rawDraft.faceDownId);
      const secret = rawDraft.faceDownId;
      const seen = new Set(rawDraft.faceUpIds);

      for (let step = 0; step < playerCount; step++) {
        state = await h.get();
        assert.equal(state.phase, 'draft');
        const seat = h.auth.findIndex((auth) => auth.playerId === state.draft.currentPlayerId);
        assert.ok(seat >= 0, 'drafter must have an authenticated seat');
        const current = await h.get(seat);
        const options = current.draft.options.map((role) => role.id);
        if (step !== playerCount - 1 || !(playerCount === 7 && !useNinthCharacter)) {
          assert.equal(options.includes(secret), false, 'face-down role must remain private');
        }
        assert.equal(options.length, 2 + (playerCount - step - 1));
        const picked = options[0];
        assert.equal(seen.has(picked), false);
        seen.add(picked);
        await h.post('/draft/choose', { characterId: picked }, seat);
      }
      state = await h.get();
      assert.equal(state.phase, 'turns');
      assert.equal(state.turn.total, playerCount);
      assert.equal(h.raw().draft, null);
      const assigned = h.raw().players.flatMap((player) => player.characterIds);
      assert.equal(assigned.length, playerCount);
      assert.equal(new Set(assigned).size, playerCount);
    });
  }
}

test('NINTH ROLE HTTP: four-player Queen is blocked in 9-role mode, without mutating settings', async (t) => {
  const h = await openRig(t, { players: 4 });
  const before = await h.get();
  const invalid = await h.post('/config/characters', {
    characterIds: [...DEFAULT_CHARACTER_IDS], useNinthCharacter: true
  }, 0, 400);
  assert.equal(invalid.error, 'queen_not_allowed_under_five');
  assert.equal((await h.get()).useNinthCharacter, before.useNinthCharacter);
  assert.equal((await h.get()).selectedCharacterIds[8], 'queen');

  const invalidType = await h.post('/config/characters', {
    characterIds: [...DEFAULT_CHARACTER_IDS], useNinthCharacter: 'true'
  }, 0, 400);
  assert.equal(invalidType.error, 'invalid_character_count');

  const notHost = await h.post('/config/characters', {
    characterIds: [...DEFAULT_CHARACTER_IDS], useNinthCharacter: true
  }, 1, 403);
  assert.equal(notHost.error, 'host_only');

  const valid = [...DEFAULT_CHARACTER_IDS];
  valid[8] = 'tax-collector';
  await h.post('/config/characters', { characterIds: valid, useNinthCharacter: true });
  assert.equal((await h.get()).activeCharacterCount, 9);
  await h.post('/start');
  assert.equal((await h.post('/config/characters', {
    characterIds: valid, useNinthCharacter: false
  }, 0, 409)).error, 'lobby_only');
});

test('NINTH ROLE HTTP: Queen legal at 5 players with optional ninth; defaults unchanged at 8', async (t) => {
  const five = await openRig(t, { players: 5 });
  await five.post('/config/characters', {
    characterIds: [...DEFAULT_CHARACTER_IDS], useNinthCharacter: true
  });
  assert.ok((await five.get()).characters.some((role) => role.id === 'queen'));
});

test('NINTH ROLE HTTP: bot drafting uses optional nine-character deck with four participants', async (t) => {
  const h = await openRig(t, { players: 2 });
  h.mutate((session) => { session.players.splice(1, 1); });
  await h.post('/bots', { count: 3 });
  const selected = [...DEFAULT_CHARACTER_IDS];
  selected[8] = 'artist';
  await h.post('/config/characters', { characterIds: selected, useNinthCharacter: true });
  await h.post('/start');
  let state = await h.get();
  assert.equal(state.players.length, 4);
  assert.equal(state.activeCharacterCount, 9);
  assert.equal(state.draft.faceUp.length, 3);
  assert.equal(state.draft.currentPlayerId, h.auth[0].playerId);
  await h.post('/draft/choose', { characterId: state.draft.options[0].id });
  state = await h.get();
  assert.equal(state.phase, 'turns', 'three bots finish draft after host selects');
  assert.equal(state.turn.total, 4);
  assert.equal(h.raw().players.reduce((sum, p) => sum + p.characterIds.length, 0), 4);
});
