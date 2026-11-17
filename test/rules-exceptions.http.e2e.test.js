'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openRig, seedTurn, card, built } = require('./support/http-e2e-rig');

test('OFFICIAL RULE: Poor House triggers before Alchemist building-cost refund', async (t) => {
  const h = await openRig(t);
  seedTurn(h, 'alchemist', {
    gold: 1,
    ownBuilt: [built('poor-house', 'unique', 4)],
    ownCards: [card('tavern', 'trade', 1, 'alchemist_zero')]
  });

  await h.post('/turn/build', { cardId: 'fixture_alchemist_zero' }, 0, 201);
  assert.equal((await h.get()).me.gold, 0);

  await h.post('/turn/end');
  // Source: Hungarian Citadella official rules, special-district clarifications:
  // Poor House pays 1 gold first, *then* Alchemist returns the building costs.
  assert.equal((await h.get()).me.gold, 2);
});

for (const role of ['diplomat', 'marshal']) {
  test('OFFICIAL RULE: Keep cannot be targeted by ' + role, async (t) => {
    const h = await openRig(t);
    seedTurn(h, role, {
      ownBuilt: [built('temple', 'religious', 1)],
      opponentBuilt: [built('keep', 'unique', 3)]
    });
    const action = role === 'diplomat'
      ? { action: 'swap-districts', ownCardId: 'fixture_temple', targetCardId: 'fixture_keep' }
      : { action: 'seize-district', cardId: 'fixture_keep' };
    const result = await h.post('/turn/ability', action, 0, 409);
    assert.equal(result.error, 'keep_protected');
    assert.ok((await h.get()).players.find((p) => p.id === h.auth[1].playerId)
      .built.some((district) => district.id === 'keep'));
  });
}

for (const role of ['diplomat', 'marshal']) {
  test('OFFICIAL RULE: Great Wall increases rank-eight ' + role + ' payment by one gold', async (t) => {
    const h = await openRig(t);
    const target = role === 'diplomat'
      ? built('market', 'trade', 2, 'wall_market')
      : built('watchtower', 'military', 1, 'wall_watchtower');

    seedTurn(h, role, {
      ownBuilt: [built('temple', 'religious', 1, 'wall_own')],
      opponentBuilt: [built('great-wall', 'unique', 6), target],
      gold: 10, otherGold: 8
    });
    const action = role === 'diplomat'
      ? { action: 'swap-districts', ownCardId: 'fixture_wall_own', targetCardId: target.cardId }
      : { action: 'seize-district', cardId: target.cardId };
    await h.post('/turn/ability', action);
    const state = await h.get();
    assert.equal(state.me.gold, 8, 'base payment 1 + Great Wall surcharge 1');
    if (role === 'marshal') {
      assert.equal(state.players.find((p) => p.id === h.auth[1].playerId).gold, 10);
    }
  });
}
