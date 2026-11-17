'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { UNIQUE_DISTRICTS } = require('../districts');
const { openRig, seedTurn, card, built } = require('./support/http-e2e-rig');

// Do not conflate a listed card with an implemented card effect.
// These five are present in the selectable card catalog, but no corresponding
// game-action implementation exists. Keep visible TODOs until covered by a
// positive HTTP test that performs the actual card effect.
const PENDING_EFFECTS = [
  ['armory', 'Fegyvertár – sacrifice to destroy a district'],
  ['framework', 'Állványzat – sacrifice instead of paying the build cost'],
  ['necropolis', 'Temető – build by destroying a district instead of paying'],
  ['theater', 'Színház – secret role swap at the end of draft'],
  ['thieves-den', 'Tolvajtanya – pay build cost with hand cards']
];

test('RULE AUDIT: every declared yet unimplemented district is tracked', () => {
  const catalogIds = new Set(UNIQUE_DISTRICTS.map((card) => card.id));
  assert.equal(catalogIds.size, 30);
  for (const [id] of PENDING_EFFECTS) assert.ok(catalogIds.has(id));
});

for (const [id, description] of PENDING_EFFECTS) {
  test.todo('UNIMPLEMENTED: ' + description + ' (' + id + ')');
}

test('SCORING HTTP E2E: Basilica scores one bonus for each odd-cost district', async (t) => {
  const h = await openRig(t);
  seedTurn(h, 'assassin', {
    ownBuilt: [
      built('basilica', 'unique', 4),
      built('tavern', 'trade', 1),
      built('manor', 'noble', 3),
      built('palace', 'noble', 5)
    ]
  });
  await h.post('/finish');
  const state = await h.get();
  assert.equal(state.phase, 'finished');
  assert.equal(state.scores.find((score) => score.playerId === h.auth[0].playerId).uniqueBonus, 3);
});

test('SCORING HTTP E2E: School of Magic counts toward any colour-role income', async (t) => {
  const h = await openRig(t);
  seedTurn(h, 'king', { ownBuilt: [built('school-of-magic', 'unique', 6)] });
  const before = (await h.get()).me.gold;
  await h.post('/turn/ability', { action: 'income' });
  assert.equal((await h.get()).me.gold, before + 1);
});

test('SCORING HTTP E2E: Secret Vault cannot be built', async (t) => {
  const h = await openRig(t);
  seedTurn(h, 'architect', {
    ownCards: [card('secret-vault', 'unique', 0)]
  });
  const result = await h.post('/turn/build', { cardId: 'fixture_secret-vault' }, 0, 409);
  assert.equal(result.error, 'district_cannot_be_built');
});

test('TAX HTTP E2E: Tax Collector pool increases when another character builds', async (t) => {
  const h = await openRig(t, { players: 3 });
  seedTurn(h, 'architect', { count: 3 });
  h.mutate((session) => {
    session.selectedCharacterIds[8] = 'tax-collector';
  });
  const before = (await h.get()).me.gold;
  await h.post('/turn/build', { cardId: 'fixture_tavern' }, 0, 201);
  const state = await h.get();
  assert.equal(state.me.gold, before - 2, '1 construction + 1 tax');
  assert.equal(state.taxPool, 1);
});
