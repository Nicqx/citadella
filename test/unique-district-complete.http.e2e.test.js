'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openRig, seedTurn, built, card } = require('./support/http-e2e-rig');

async function playDraft(h) {
  let state = await h.get();
  for (let guard = 0; guard < 12 && state.phase === 'draft'; guard += 1) {
    const index = h.auth.findIndex((seat) => seat.playerId === state.draft.currentPlayerId);
    assert.ok(index >= 0, 'current drafter must be authenticated');
    const myState = await h.get(index);
    const options = myState.draft.options;
    const payload = { characterId: options[0].id };
    if (myState.draft.discardRequired) {
      assert.ok(options.length >= 2);
      payload.discardCharacterId = options[1].id;
    }
    await h.post('/draft/choose', payload, index);
    state = await h.get();
  }
  assert.notEqual(state.phase, 'draft', 'draft must terminate');
  return state;
}

test('SPECIAL HTTP: Armory destroys itself and a target including Keep; no gold paid', async (t) => {
  const h = await openRig(t);
  seedTurn(h, 'assassin', {
    ownBuilt: [built('armory', 'unique', 3), built('tavern', 'trade', 1)],
    opponentBuilt: [built('keep', 'unique', 3)]
  });
  const before = h.raw().districtDeck.length;
  const gold = (await h.get()).me.gold;
  await h.post('/turn/district-ability', {
    districtId: 'armory', targetCardId: 'fixture_keep'
  });
  const state = await h.get();
  assert.equal(state.me.built.some((entry) => entry.id === 'armory'), false);
  assert.equal(state.me.built.some((entry) => entry.id === 'tavern'), true);
  assert.equal(state.players.find((p) => p.id === h.auth[1].playerId).built.length, 0);
  assert.equal(state.me.gold, gold);
  assert.equal(h.raw().districtDeck.length, before + 2);
  assert.equal(state.turn.action.districtUses.armory, true);
});

test('SPECIAL HTTP: Armory cannot destroy a district in any completed city', async (t) => {
  const h = await openRig(t);
  seedTurn(h, 'assassin', {
    ownBuilt: [built('armory', 'unique', 3)],
    opponentBuilt: Array.from({ length: 8 }, (_, i) =>
      built('opponent-' + i, 'trade', 1, 'opp-' + i))
  });
  const result = await h.post('/turn/district-ability', {
    districtId: 'armory', targetCardId: 'fixture_opp-0'
  }, 0, 409);
  assert.equal(result.error, 'completed_city_protected');
  assert.equal((await h.get()).me.built.length, 1);
  assert.equal(h.raw().players[1].built.length, 8);
  h.mutate((session) => {
    session.players[1].built = [built('tavern', 'trade', 1)];
    session.players[0].built = [
      built('armory', 'unique', 3),
      ...Array.from({ length: 7 }, (_, i) => built('other-' + i, 'trade', 1, 'self-' + i))
    ];
  });
  const ownCity = await h.post('/turn/district-ability', {
    districtId: 'armory', targetCardId: 'fixture_tavern'
  }, 0, 409);
  assert.equal(ownCity.error, 'completed_city_protected');
});

test('SPECIAL HTTP: Framework sacrifice builds for zero gold and blocks Magistrate confiscation', async (t) => {
  const h = await openRig(t);
  seedTurn(h, 'assassin', {
    gold: 0,
    ownBuilt: [built('framework', 'unique', 3)],
    ownCards: [card('palace', 'noble', 5, 'framework_palace')],
    extra: (session) => {
      session.roundEffects.magistrateSignedCharacterId = 'assassin';
      session.roundEffects.magistratePlayerId = session.players[1].id;
      session.roundEffects.magistrateUsed = false;
    }
  });
  const before = h.raw().districtDeck.length;
  await h.post('/turn/build', {
    cardId: 'fixture_framework_palace', paymentMode: 'framework'
  }, 0, 201);
  const state = await h.get();
  assert.equal(state.me.gold, 0);
  assert.deepEqual(state.me.built.map((d) => d.id), ['palace']);
  assert.equal(state.players.find((p) => p.id === h.auth[1].playerId).built.length, 0);
  assert.equal(h.raw().districtDeck.length, before + 1);
  assert.equal(state.finalRound, false);
});

test('SPECIAL HTTP: Framework cannot be sacrificed if it is not built; invalid payment is atomic', async (t) => {
  const h = await openRig(t);
  seedTurn(h, 'assassin', { gold: 0, ownCards: [card('palace', 'noble', 5)] });
  const start = await h.get();
  assert.equal((await h.post('/turn/build', {
    cardId: 'fixture_palace', paymentMode: 'framework'
  }, 0, 409)).error, 'framework_required');
  const after = await h.get();
  assert.deepEqual(after.me.hand, start.me.hand);
  assert.equal(after.me.gold, start.me.gold);
});

test('SPECIAL HTTP: Necropolis sacrifices own Museum and stored cards instead of gold', async (t) => {
  const h = await openRig(t);
  const museum = built('museum', 'unique', 4);
  museum.storedCards = [card('tavern', 'trade', 1, 'museum_under')];
  seedTurn(h, 'assassin', {
    gold: 0,
    ownBuilt: [museum],
    ownCards: [card('necropolis', 'unique', 5)],
    extra: (session) => {
      session.roundEffects.magistrateSignedCharacterId = 'assassin';
      session.roundEffects.magistratePlayerId = session.players[1].id;
      session.roundEffects.magistrateUsed = false;
    }
  });
  const before = h.raw().districtDeck.length;
  await h.post('/turn/build', {
    cardId: 'fixture_necropolis', paymentMode: 'sacrifice', sacrificeCardId: 'fixture_museum'
  }, 0, 201);
  const state = await h.get();
  assert.deepEqual(state.me.built.map((d) => d.id), ['necropolis']);
  assert.equal(state.me.gold, 0);
  assert.equal(h.raw().districtDeck.length, before + 2);
  assert.equal(state.players.find((p) => p.id === h.auth[1].playerId).built.length, 0);
});

test('SPECIAL HTTP: Sacrifice mode is forbidden on a non-Necropolis card', async (t) => {
  const h = await openRig(t);
  seedTurn(h, 'assassin', {
    gold: 0, ownBuilt: [built('market', 'trade', 2)],
    ownCards: [card('palace', 'noble', 5)]
  });
  assert.equal((await h.post('/turn/build', {
    cardId: 'fixture_palace', paymentMode: 'sacrifice', sacrificeCardId: 'fixture_market'
  }, 0, 400)).error, 'invalid_payment_mode');
  assert.equal((await h.get()).me.built[0].id, 'market');
});

test('SPECIAL HTTP: Thieves Den pays part of the cost using 4 cards and remaining 2 gold', async (t) => {
  const h = await openRig(t);
  const payments = Array.from({ length: 4 }, (_, i) =>
    card('payment-' + i, 'trade', 1, 'td_payment_' + i));
  seedTurn(h, 'assassin', {
    gold: 2,
    ownCards: [card('thieves-den', 'unique', 6, 'td_build'), ...payments]
  });
  const deckStart = h.raw().districtDeck.length;
  await h.post('/turn/build', {
    cardId: 'fixture_td_build', paymentCardIds: payments.map((p) => p.cardId)
  }, 0, 201);
  const state = await h.get();
  assert.equal(state.me.gold, 0);
  assert.equal(state.me.built[0].id, 'thieves-den');
  assert.equal(state.me.hand.length, 0);
  assert.equal(h.raw().districtDeck.length, deckStart + 4);
});

test('SPECIAL HTTP: Thieves Den Magistrate refunds only gold, not spent cards', async (t) => {
  const h = await openRig(t);
  const payments = Array.from({ length: 4 }, (_, i) =>
    card('payment-' + i, 'trade', 1, 'mag_payment_' + i));
  seedTurn(h, 'assassin', {
    gold: 2,
    ownCards: [card('thieves-den', 'unique', 6, 'mag_thieves'), ...payments],
    extra: (session) => {
      session.roundEffects.magistrateSignedCharacterId = 'assassin';
      session.roundEffects.magistratePlayerId = session.players[1].id;
      session.roundEffects.magistrateUsed = false;
    }
  });
  await h.post('/turn/build', {
    cardId: 'fixture_mag_thieves', paymentCardIds: payments.map((p) => p.cardId)
  }, 0, 201);
  const state = await h.get();
  assert.equal(state.me.gold, 2, 'only spent 2 gold is refunded');
  assert.equal(state.me.hand.length, 0, 'four cards are NOT returned');
  assert.equal(state.me.built.length, 0);
  assert.ok(state.players.find((p) => p.id === h.auth[1].playerId)
    .built.some((d) => d.id === 'thieves-den'));
});

test('SPECIAL HTTP: Thieves Den rejects duplicate payment cards and preserves the hand', async (t) => {
  const h = await openRig(t);
  seedTurn(h, 'assassin', {
    gold: 0,
    ownCards: [card('thieves-den', 'unique', 6), card('tavern', 'trade', 1)]
  });
  const start = await h.get();
  const result = await h.post('/turn/build', {
    cardId: 'fixture_thieves-den',
    paymentCardIds: ['fixture_tavern', 'fixture_tavern']
  }, 0, 400);
  assert.equal(result.error, 'invalid_payment_cards');
  assert.deepEqual((await h.get()).me.hand, start.me.hand);
});

for (const count of [2, 3, 4]) {
  test('THEATER HTTP: ' + count + ' humans, private blind character swap at draft completion', async (t) => {
    const h = await openRig(t, { players: count });
    await h.post('/start');
    h.mutate((session) => {
      session.players[0].built = [built('theater', 'unique', 6)];
    });
    let stage = await playDraft(h);
    assert.equal(stage.phase, 'theater');
    assert.equal(stage.theater.currentPlayerId, h.auth[0].playerId);
    assert.equal(stage.turn, null, 'no role called before Theater decision');
    const original = h.raw().draft.choices;
    const humanBefore = [...original[h.auth[0].playerId]];
    const targetBefore = [...original[h.auth[1].playerId]];
    assert.equal(humanBefore.length, count <= 3 ? 2 : 1);
    assert.equal(targetBefore.length, count <= 3 ? 2 : 1);

    const guestView = await h.get(1);
    assert.equal(guestView.theater.myChoices.length, targetBefore.length);
    assert.equal(guestView.players.find((p) => p.id === h.auth[0].playerId)
      .characters.length, 0, 'no secret character may be published');
    assert.ok(!JSON.stringify(guestView.theater).includes(humanBefore[0]),
      'theater state must not reveal the opponent private character');

    const outsider = count >= 3 ? await h.get(2) : null;
    await h.post('/theater/choose', {
      action: 'swap',
      characterId: humanBefore[0],
      targetPlayerId: h.auth[1].playerId
    });
    stage = await h.get();
    assert.equal(stage.phase, 'turns');
    assert.equal(stage.turn.total, count <= 3 ? count * 2 : count);
    const changed = h.raw().players;
    const currentHuman = changed.find((p) => p.id === h.auth[0].playerId).characterIds;
    const currentTarget = changed.find((p) => p.id === h.auth[1].playerId).characterIds;
    assert.equal(currentHuman.length, humanBefore.length);
    assert.equal(currentTarget.length, targetBefore.length);
    assert.ok(targetBefore.includes(currentHuman[0]));
    assert.ok(currentTarget.includes(humanBefore[0]));
    assert.equal(new Set(changed.flatMap((p) => p.characterIds)).size,
      changed.reduce((acc, p) => acc + p.characterIds.length, 0),
      'each character must be held by exactly one seat');
    if (outsider) {
      assert.equal(outsider.players.find((p) => p.id === h.auth[0].playerId)
        .characters.length, 0, 'outsider knew no private role before Theater action');
    }
  });
}

test('THEATER HTTP: owner may skip; wrong player and invalid role rejected', async (t) => {
  const h = await openRig(t, { players: 2 });
  await h.post('/start');
  h.mutate((session) => { session.players[0].built = [built('theater', 'unique', 6)]; });
  await playDraft(h);
  const before = structuredClone(h.raw().draft.choices);
  assert.equal((await h.post('/theater/choose', { action: 'skip' }, 1, 403)).error, 'active_player_only');
  assert.equal((await h.post('/theater/choose', {
    action: 'swap', characterId: 'unknown', targetPlayerId: h.auth[1].playerId
  }, 0, 400)).error, 'invalid_theater_exchange');
  assert.deepEqual(h.raw().draft.choices, before);
  await h.post('/theater/choose', { action: 'skip' });
  assert.equal((await h.get()).phase, 'turns');
  const after = h.raw().players.map((p) => [p.id, p.characterIds]);
  assert.deepEqual(after, h.raw().players.map((p) => [p.id, before[p.id]]));
});

test('THEATER HTTP: no Theater built uses normal draft-to-turn transition', async (t) => {
  const h = await openRig(t, { players: 2 });
  await h.post('/start');
  assert.equal((await playDraft(h)).phase, 'turns');
});

for (const theaterOwner of ['human', 'bot']) {
  test('THEATER HTTP: bot finishes 2-player draft; ' + theaterOwner + ' owns Theater', async (t) => {
    const h = await openRig(t, { players: 2 });
    h.mutate((session) => { session.players.splice(1, 1); });
    await h.post('/bots', { count: 1 });
    await h.post('/start');
    h.mutate((session) => {
      const player = theaterOwner === 'human'
        ? session.players.find((p) => !p.isBot)
        : session.players.find((p) => p.isBot);
      player.built.push(built('theater', 'unique', 6));
    });
    let state = await h.get();
    for (let step = 0; step < 3 && state.phase === 'draft'; step += 1) {
      assert.equal(state.draft.currentPlayerId, h.auth[0].playerId);
      const options = state.draft.options;
      const payload = { characterId: options[0].id };
      if (state.draft.discardRequired) payload.discardCharacterId = options[1].id;
      await h.post('/draft/choose', payload);
      state = await h.get();
    }
    if (theaterOwner === 'human') {
      assert.equal(state.phase, 'theater');
      assert.equal(state.theater.currentPlayerId, h.auth[0].playerId);
      await h.post('/theater/choose', { action: 'skip' });
      assert.equal((await h.get()).phase, 'turns');
    } else {
      assert.equal(state.phase, 'turns', 'bot should automatically skip its optional Theater swap');
      assert.equal(state.turn.total, 4);
    }
  });
}
