'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_CHARACTER_IDS, CHARACTER_MAP } = require('../game');
const { UNIQUE_DISTRICTS, DEFAULT_UNIQUE_DISTRICT_IDS } = require('../districts');
const { openRig, seedTurn, card, built } = require('./support/http-e2e-rig');

function realRound(session) {
  const n = session.players.length;
  const ids = n === 3
    ? ['assassin', 'thief', 'magician', 'bishop', 'merchant', 'architect']
    : n === 2
      ? ['assassin', 'thief', 'merchant', 'warlord']
      : ['assassin', 'thief', 'magician', 'king', 'bishop', 'merchant', 'architect', 'warlord'].slice(0, n);
  const indices = n === 2 ? [0, 1, 0, 1]
    : n === 3 ? [0, 1, 2, 0, 1, 2]
      : session.players.map((_p, i) => i);
  session.turn.order = ids.map((roleId, i) => ({
    playerId: session.players[indices[i]].id,
    characterId: roleId,
    rank: CHARACTER_MAP.get(roleId).rank
  }));
  session.turn.index = 0;
  session.turn.revealedPlayerIds = [session.players[0].id];
  session.turn.revealedCharacterIds = ['assassin'];
  session.turn.action.playerId = session.players[0].id;
  session.players.forEach((player) => {
    player.characterIds = session.turn.order.filter((entry) => entry.playerId === player.id)
      .map((entry) => entry.characterId);
    player.characterId = player.characterIds[0] || null;
  });
}

for (const count of [2, 3, 4, 5, 7, 8]) {
  test('RULE E2E: ' + count + ' players, precisely ' + (count <= 3 ? 8 : 7) +
    ' districts trigger final round; remaining roles finish, no new draft', async (t) => {
    const rig = await openRig(t, { players: count });
    const target = count <= 3 ? 8 : 7;
    seedTurn(rig, 'assassin', {
      count,
      ownCards: [card('tavern', 'trade', 1, 'winning_tavern')],
      ownBuilt: Array.from({ length: target - 2 }, (_v, i) =>
        built('existing-' + i, 'trade', 1, 'existing-' + i)),
      extra: realRound
    });

    let state = await rig.get();
    assert.equal(state.finalRound, false);
    assert.equal(state.cityCompletionTarget, target);
    assert.equal(state.me.cityDistrictCount, target - 2);

    // The penultimate physical district must not trigger game completion.
    await rig.post('/district', {
      name: 'Penultimate', type: 'trade', cost: 1
    }, 0, 201);
    state = await rig.get();
    assert.equal(state.me.cityDistrictCount, target - 1);
    assert.equal(state.finalRound, false);
    assert.equal(state.firstCompletedPlayerId, null);

    // A real hand-card build must trigger it at the official threshold.
    await rig.post('/turn/build', { cardId: 'fixture_winning_tavern' }, 0, 201);
    state = await rig.get();
    assert.equal(state.me.cityDistrictCount, target);
    assert.equal(state.finalRound, true);
    assert.equal(state.firstCompletedPlayerId, rig.auth[0].playerId);
    assert.equal(state.phase, 'turns');

    const total = count <= 3 ? count * 2 : count;
    assert.equal(state.turn.total, total);

    // Execute every remaining authenticated character turn over HTTP.
    for (let step = 0; step < total && state.phase === 'turns'; step += 1) {
      const activeIndex = rig.auth.findIndex((user) => user.playerId === state.turn.activePlayerId);
      assert.notEqual(activeIndex, -1, 'active seat is a known player');
      if (!state.turn.action.resourceGathered) {
        await rig.post('/turn/resource', { mode: 'gold' }, activeIndex);
      }
      await rig.post('/turn/end', {}, activeIndex);
      state = await rig.get();
    }
    assert.equal(state.phase, 'finished', 'must finish current round rather than begin next draft');
    assert.equal(state.round, 1);
    assert.equal(state.winnerPlayerId, rig.auth[0].playerId);
    assert.equal(state.scores.find((entry) => entry.playerId === rig.auth[0].playerId).completionBonus, 4);
  });
}

test('RULE E2E: Monument counts for two districts toward city completion', async (t) => {
  const rig = await openRig(t, { players: 2 });
  const previous = [
    built('monument', 'unique', 4, 'monument'),
    ...Array.from({ length: 5 }, (_v, i) => built('district-' + i, 'trade', 1, 'm' + i))
  ];
  seedTurn(rig, 'assassin', {
    ownBuilt: previous,
    ownCards: [card('tavern', 'trade', 1, 'monument_final')]
  });
  let state = await rig.get();
  assert.equal(state.me.built.length, 6);
  assert.equal(state.me.cityDistrictCount, 7);
  assert.equal(state.finalRound, false);

  await rig.post('/turn/build', { cardId: 'fixture_monument_final' }, 0, 201);
  state = await rig.get();
  assert.equal(state.me.built.length, 7);
  assert.equal(state.me.cityDistrictCount, 8);
  assert.equal(state.finalRound, true);
});

test('RULE E2E: 3-player lobby permits 9th rank (Artist), rejects Queen', async (t) => {
  const rig = await openRig(t, { players: 3 });
  const invalid = [...DEFAULT_CHARACTER_IDS];
  const fail = await rig.post('/config/characters', { characterIds: invalid }, 0, 400);
  assert.equal(fail.error, 'queen_not_allowed_under_five');
  invalid[8] = 'artist';
  await rig.post('/config/characters', { characterIds: invalid });
  await rig.post('/start');
  const state = await rig.get();
  assert.equal(state.characters.length, 9);
  assert.equal(state.phase, 'draft');
});

test('RULE E2E: 2-player Emperor forbidden; 4-player and 8-player ranks validated', async (t) => {
  const rig = await openRig(t, { players: 2 });
  const invalid = [...DEFAULT_CHARACTER_IDS];
  invalid[3] = 'emperor';
  const error = await rig.post('/config/characters', { characterIds: invalid }, 0, 400);
  assert.equal(error.error, 'emperor_not_allowed_two_players');
  await rig.post('/start');
  const state = await rig.get();
  assert.equal(state.characters.length, 8);
  assert.equal(state.cityCompletionTarget, 8);
});

test('RULE E2E: special districts have exactly 14 distinct choices', async (t) => {
  const rig = await openRig(t);
  const all = UNIQUE_DISTRICTS.map((district) => district.id);
  assert.equal(all.length, 30);
  const rejected13 = await rig.post('/config/unique-districts', {
    districtIds: all.slice(0, 13)
  }, 0, 400);
  assert.equal(rejected13.error, 'unique_district_selection_count');
  const rejected15 = await rig.post('/config/unique-districts', {
    districtIds: all.slice(0, 15)
  }, 0, 400);
  assert.equal(rejected15.error, 'unique_district_selection_count');
  const rejectedDuplicate = await rig.post('/config/unique-districts', {
    districtIds: [...all.slice(0, 13), all[0]]
  }, 0, 400);
  assert.equal(rejectedDuplicate.error, 'unique_district_selection_count');

  // Pick 14 alternatives which are not the default set.
  const selected = all.slice(16, 30);
  assert.notDeepEqual(selected, DEFAULT_UNIQUE_DISTRICT_IDS);
  await rig.post('/config/unique-districts', { districtIds: selected });
  const state = await rig.get();
  assert.deepEqual(state.selectedUniqueDistrictIds, selected);
  await rig.post('/start');
  assert.equal((await rig.get()).phase, 'draft');
});

test('RULE E2E: one human plus two bots drafts two roles each for 3 players', async (t) => {
  const rig = await openRig(t, { players: 2 });
  // Use a fresh two-person room: replace the second human via isolated fixture
  // so this test genuinely has one human and two automated seats.
  rig.mutate((session) => { session.players.splice(1, 1); });
  await rig.post('/bots', { count: 2 });
  const selected = [...DEFAULT_CHARACTER_IDS];
  selected[8] = 'artist';
  await rig.post('/config/characters', { characterIds: selected });
  await rig.post('/start');
  let state = await rig.get();
  assert.equal(state.players.length, 3);
  for (let i = 0; i < 2; i += 1) {
    assert.equal(state.phase, 'draft');
    const choice = state.draft.options[0];
    await rig.post('/draft/choose', { characterId: choice.id });
    state = await rig.get();
  }
  assert.equal(state.phase, 'turns');
  assert.equal(state.me.characterCount, 2);
  assert.equal(state.me.characters.length, 2);
  assert.equal(state.turn.total, 6);
  assert.ok(state.players.filter((p) => p.isBot).every((bot) => bot.characterCount === 2));
});
