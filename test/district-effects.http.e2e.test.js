'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openRig, seedTurn, card, built } = require('./support/http-e2e-rig');

test('DISTRICT HTTP E2E: Laboratory exchanges one hand card for two gold, once per turn', async (t) => {
  const h = await openRig(t);
  seedTurn(h, 'architect', { ownBuilt: [built('laboratory', 'unique', 5)] });
  const start = await h.get();
  await h.post('/turn/district-ability', { districtId: 'laboratory', cardId: 'fixture_tavern' });
  const state = await h.get();
  assert.equal(state.me.gold, start.me.gold + 2);
  assert.equal(state.me.handCount, start.me.handCount - 1);
  assert.equal((await h.post('/turn/district-ability', {
    districtId: 'laboratory', cardId: 'fixture_temple'
  }, 0, 409)).error, 'district_ability_already_used');
});

test('DISTRICT HTTP E2E: Smithy costs two gold and draws three cards', async (t) => {
  const h = await openRig(t);
  seedTurn(h, 'architect', { ownBuilt: [built('smithy', 'unique', 5)] });
  const start = await h.get();
  await h.post('/turn/district-ability', { districtId: 'smithy' });
  const state = await h.get();
  assert.equal(state.me.gold, start.me.gold - 2);
  assert.equal(state.me.handCount, start.me.handCount + 3);
});

test('DISTRICT HTTP E2E: Museum stores one card privately and counts it', async (t) => {
  const h = await openRig(t);
  seedTurn(h, 'architect', { ownBuilt: [built('museum', 'unique', 4)] });
  await h.post('/turn/district-ability', { districtId: 'museum', cardId: 'fixture_tavern' });
  const owner = await h.get(0);
  const guest = await h.get(1);
  assert.equal(owner.me.built[0].storedCardCount, 1);
  assert.equal(owner.me.hand.some((entry) => entry.cardId === 'fixture_tavern'), false);
  assert.equal(JSON.stringify(guest).includes('fixture_tavern'), false, 'museum stored card must remain hidden');
});

test('DISTRICT HTTP E2E: Gold Mine adds one extra gold during resource gathering', async (t) => {
  const h = await openRig(t);
  seedTurn(h, 'assassin', { ownBuilt: [built('gold-mine', 'unique', 6)] });
  h.mutate((session) => { session.turn.action.resourceGathered = false; });
  const start = await h.get();
  await h.post('/turn/resource', { mode: 'gold' });
  assert.equal((await h.get()).me.gold, start.me.gold + 3);
});

test('DISTRICT HTTP E2E: Observatory draws three, keep one; Library keeps both', async (t) => {
  const h = await openRig(t);
  seedTurn(h, 'assassin', { ownBuilt: [built('observatory', 'unique', 5)] });
  h.mutate((session) => { session.turn.action.resourceGathered = false; });
  let state = await h.get();
  const oldHand = state.me.handCount;
  await h.post('/turn/resource', { mode: 'cards' });
  state = await h.get();
  assert.equal(state.turn.action.pendingDraw.length, 3);
  await h.post('/turn/resource/keep', { cardId: state.turn.action.pendingDraw[0].cardId });
  state = await h.get();
  assert.equal(state.turn.action.pendingDraw.length, 0);
  assert.equal(state.me.handCount, oldHand + 1);

  seedTurn(h, 'assassin', { ownBuilt: [built('library', 'unique', 6)] });
  h.mutate((session) => { session.turn.action.resourceGathered = false; });
  state = await h.get();
  const libraryHand = state.me.handCount;
  await h.post('/turn/resource', { mode: 'cards' });
  state = await h.get();
  assert.equal(state.turn.action.pendingDraw.length, 0);
  assert.equal(state.me.handCount, libraryHand + 2);
});

test('DISTRICT HTTP E2E: Quarry permits duplicate building while normal city forbids it', async (t) => {
  const h = await openRig(t);
  seedTurn(h, 'architect', {
    ownBuilt: [built('tavern', 'trade', 1, 'old_tavern')],
    ownCards: [card('tavern', 'trade', 1, 'new_tavern')]
  });
  const rejected = await h.post('/turn/build', { cardId: 'fixture_new_tavern' }, 0, 409);
  assert.equal(rejected.error, 'duplicate_district');
  h.mutate((session) => { session.players[0].built.push(built('quarry', 'unique', 5)); });
  await h.post('/turn/build', { cardId: 'fixture_new_tavern' }, 0, 201);
  assert.equal((await h.get()).me.built.filter((district) => district.id === 'tavern').length, 2);
});

test('DISTRICT HTTP E2E: Factory discounts unique card by one gold', async (t) => {
  const h = await openRig(t);
  seedTurn(h, 'architect', {
    ownBuilt: [built('factory', 'unique', 5)],
    ownCards: [card('dragon-gate', 'unique', 6, 'dragon_discount')]
  });
  const before = (await h.get()).me.gold;
  await h.post('/turn/build', { cardId: 'fixture_dragon_discount' }, 0, 201);
  assert.equal((await h.get()).me.gold, before - 5);
});

test('DISTRICT HTTP E2E: Stables can be built after normal build limit', async (t) => {
  const h = await openRig(t);
  seedTurn(h, 'thief', {
    ownCards: [card('stables', 'unique', 2, 'stables_limit'), card('temple', 'religious', 1, 'non_stables')]
  });
  h.mutate((session) => { session.turn.action.builds = 1; });
  await h.post('/turn/build', { cardId: 'fixture_stables_limit' }, 0, 201);
  assert.equal((await h.get()).turn.action.builds, 1);
  assert.equal((await h.post('/turn/build', { cardId: 'fixture_non_stables' }, 0, 409)).error, 'build_limit_reached');
});

test('DISTRICT HTTP E2E: Great Wall increases destruction cost; Keep cannot be destroyed', async (t) => {
  const h = await openRig(t);
  seedTurn(h, 'warlord', {
    ownCards: [],
    opponentBuilt: [
      built('great-wall', 'unique', 6),
      built('watchtower', 'military', 1, 'wall_target'),
      built('keep', 'unique', 3)
    ],
    gold: 0
  });
  assert.equal((await h.post('/turn/ability', {
    action: 'destroy-district', cardId: 'fixture_wall_target'
  }, 0, 409)).error, 'not_enough_gold');
  h.mutate((session) => { session.players[0].gold = 1; });
  await h.post('/turn/ability', { action: 'destroy-district', cardId: 'fixture_wall_target' });
  const state = await h.get();
  assert.equal(state.me.gold, 0);
  assert.ok(!state.players.find((p) => p.id === h.auth[1].playerId).built.some((c) => c.id === 'watchtower'));

  seedTurn(h, 'warlord', { opponentBuilt: [built('keep', 'unique', 3)] });
  assert.equal((await h.post('/turn/ability', {
    action: 'destroy-district', cardId: 'fixture_keep'
  }, 0, 409)).error, 'keep_protected');
});

test('DISTRICT HTTP E2E: Bishop grants rank-eight destruction protection while alive', async (t) => {
  const h = await openRig(t);
  seedTurn(h, 'warlord', {
    opponentRole: 'bishop',
    opponentBuilt: [built('temple', 'religious', 1)]
  });
  assert.equal((await h.post('/turn/ability', {
    action: 'destroy-district', cardId: 'fixture_temple'
  }, 0, 409)).error, 'bishop_protected');
  h.mutate((session) => { session.roundEffects.assassinatedCharacterId = 'bishop'; });
  await h.post('/turn/ability', { action: 'destroy-district', cardId: 'fixture_temple' });
  assert.equal((await h.get()).players.find((p) => p.id === h.auth[1].playerId).built.length, 0);
});

test('DISTRICT HTTP E2E: Park and Poor House apply at the end of an eligible turn', async (t) => {
  const h = await openRig(t);
  seedTurn(h, 'assassin', {
    ownBuilt: [built('park', 'unique', 6), built('poor-house', 'unique', 3)],
    ownCards: [], gold: 0
  });
  await h.post('/turn/end');
  const after = await h.get();
  assert.equal(after.me.gold, 1);
  assert.equal(after.me.handCount, 2);
});

test('SECURITY HTTP E2E: cannot use abilities as wrong player or leak secret hand', async (t) => {
  const h = await openRig(t);
  seedTurn(h, 'assassin', { ownCards: [card('dragon-gate', 'unique', 6, 'private_card')] });
  const guest = await h.get(1);
  const player = guest.players.find((p) => p.id === h.auth[0].playerId);
  assert.equal(player.handCount, 1);
  assert.equal(Object.hasOwn(player, 'hand'), false);
  assert.equal(JSON.stringify(guest).includes('fixture_private_card'), false);
  assert.equal((await h.post('/turn/ability', {
    action: 'target-character', targetCharacterId: 'king'
  }, 1, 403)).error, 'active_player_only');
  const invalid = await h.request(h.route + '/turn/ability', {
    method: 'POST', body: { action: 'target-character', targetCharacterId: 'king' },
    expected: 401
  });
  assert.equal(invalid.error, 'auth_failed');
});

test('SECURITY HTTP E2E: lobby-only configuration is locked after start', async (t) => {
  const h = await openRig(t);
  const current = await h.get();
  assert.equal((await h.post('/config/characters', {
    characterIds: current.selectedCharacterIds
  }, 1, 403)).error, 'host_only');
  await h.post('/start');
  assert.equal((await h.post('/config/characters', {
    characterIds: current.selectedCharacterIds
  }, 0, 409)).error, 'lobby_only');
  assert.equal((await h.post('/config/unique-districts', {
    districtIds: current.selectedUniqueDistrictIds
  }, 0, 409)).error, 'lobby_only');
});
