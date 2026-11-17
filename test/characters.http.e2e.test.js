'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CHARACTERS } = require('../game');
const { openRig, seedTurn, card, built } = require('./support/http-e2e-rig');

const cases = Object.create(null);
const v = (h) => h.get();
const invoke = (h, action, extra = {}, who = 0, expected = 200) =>
  h.post('/turn/ability', { action, ...extra }, who, expected);
const other = (h) => h.auth[1].playerId;

cases.assassin = async (h) => {
  await invoke(h, 'target-character', { targetCharacterId: 'king' });
  assert.equal((await v(h)).roundEffects.assassinatedCharacterId, 'king');
  assert.equal((await invoke(h, 'target-character', { targetCharacterId: 'king' }, 0, 409)).error, 'ability_already_used');
};

cases.witch = async (h) => {
  await invoke(h, 'target-character', { targetCharacterId: 'king' });
  let state = await v(h);
  assert.equal(state.turn.activePlayerId, other(h));
  assert.equal(state.turn.action.bewitchedVictim, true);
  await h.post('/turn/resource', { mode: 'gold' }, 1);
  state = await v(h);
  assert.equal(state.turn.activePlayerId, h.auth[0].playerId);
  assert.equal(state.turn.character.id, 'king');
  assert.equal(state.turn.action.witchContinuation, true);
};

cases.magistrate = async (h) => {
  await invoke(h, 'set-orders', {
    targetCharacterIds: ['thief', 'magician', 'king'],
    signedCharacterId: 'king'
  });
  assert.deepEqual((await v(h)).roundEffects.magistrateTargetCharacterIds, ['thief', 'magician', 'king']);
  await h.post('/turn/end');
  await h.post('/turn/resource', { mode: 'gold' }, 1);
  await h.post('/turn/build', { cardId: 'fixture_market' }, 1, 201);
  const state = await v(h);
  assert.equal(state.me.built.some((entry) => entry.cardId === 'fixture_market'), true);
  assert.equal(state.players.find((entry) => entry.id === other(h)).built.length, 0);
};

cases.thief = async (h) => {
  await invoke(h, 'target-character', { targetCharacterId: 'king' });
  await h.post('/turn/end');
  const state = await v(h);
  assert.equal(state.turn.activePlayerId, other(h));
  assert.equal(state.me.gold, 19);
  assert.equal(state.players.find((entry) => entry.id === other(h)).gold, 0);
};

cases.spy = async (h) => {
  h.mutate((session) => {
    session.players[1].hand.push(card('tavern', 'trade', 1, 'spy_extra'));
  });
  const before = await v(h);
  await invoke(h, 'spy', { targetPlayerId: other(h), districtType: 'trade' });
  const after = await v(h);
  assert.equal(after.me.gold, before.me.gold + 2);
  assert.equal(after.me.handCount, before.me.handCount + 2);
};

cases.blackmailer = async (h) => {
  await invoke(h, 'set-threats', {
    targetCharacterIds: ['king', 'bishop'],
    realCharacterId: 'king'
  });
  await h.post('/turn/end');
  await h.post('/turn/resource', { mode: 'gold' }, 1);
  let state = await v(h);
  assert.equal(state.turn.action.blackmailPending, true);
  const targetBefore = state.players.find((entry) => entry.id === other(h)).gold;
  const collectorBefore = state.me.gold;
  await h.post('/turn/blackmail', { response: 'pay' }, 1);
  state = await v(h);
  assert.equal(state.turn.action.blackmailPending, false);
  assert.equal(state.me.gold, collectorBefore + Math.floor(targetBefore / 2));
};

cases.magician = async (h) => {
  const before = await v(h);
  await invoke(h, 'swap-hands', { targetPlayerId: other(h) });
  const after = await v(h);
  assert.equal(after.me.handCount, before.players.find((p) => p.id === other(h)).handCount);
  assert.equal(after.players.find((p) => p.id === other(h)).handCount, before.me.handCount);
};

cases.wizard = async (h) => {
  await invoke(h, 'inspect', { targetPlayerId: other(h) });
  let state = await v(h);
  assert.equal(state.turn.action.inspectedPlayerId, other(h));
  assert.equal(state.turn.action.inspectedHand.length, 1);
  await invoke(h, 'take-card', { mode: 'keep', cardId: 'fixture_market' });
  state = await v(h);
  assert.equal(state.me.hand.some((entry) => entry.cardId === 'fixture_market'), true);
  assert.equal(state.turn.action.specialUsed, true);
};

cases.seer = async (h) => {
  await invoke(h, 'seer-draw');
  let state = await v(h);
  assert.deepEqual(state.turn.action.seerPendingPlayerIds, [other(h)]);
  assert.equal(state.me.handCount, 3);
  await invoke(h, 'seer-return', { targetPlayerId: other(h), cardId: 'fixture_tavern' });
  state = await v(h);
  assert.deepEqual(state.turn.action.seerPendingPlayerIds, []);
  assert.equal(state.me.handCount, 2);
};

const goldIncome = {
  king: 'noble', emperor: 'noble',
  bishop: 'religious', merchant: 'trade', trader: 'trade',
  warlord: 'military', diplomat: 'military', marshal: 'military'
};
for (const [roleId, type] of Object.entries(goldIncome)) {
  cases[roleId] = async (h) => {
    h.mutate((session) => {
      session.players[0].built.push(built('income-' + roleId, type, 2, roleId));
    });
    const before = (await v(h)).me.gold;
    await invoke(h, 'income');
    const after = await v(h);
    assert.equal(after.me.gold, before + 1, roleId + ' colour income');
    assert.equal(after.turn.action.incomeUsed, true);
    assert.equal((await invoke(h, 'income', {}, 0, 409)).error, 'ability_already_used');
  };
}

for (const roleId of ['patrician', 'cardinal']) {
  cases[roleId] = async (h) => {
    h.mutate((session) => {
      session.players[0].built.push(built('income-' + roleId, roleId === 'patrician' ? 'noble' : 'religious', 2, roleId));
    });
    const count = (await v(h)).me.handCount;
    await invoke(h, 'income');
    const after = await v(h);
    assert.equal(after.me.handCount, count + 1);
    assert.equal(after.turn.action.incomeUsed, true);
  };
}

cases.abbot = async (h) => {
  h.mutate((session) => {
    session.players[0].built = [built('church', 'religious', 2)];
    session.players[0].gold = 3;
    session.players[1].gold = 9;
  });
  const before = await v(h);
  await invoke(h, 'abbot-income', { goldCount: 0 });
  const after = await v(h);
  assert.equal(after.me.handCount, before.me.handCount + 1);
  assert.equal(after.me.gold, before.me.gold + 1, 'Abbot receives 1 gold from richest player');
  assert.equal(after.turn.action.incomeUsed, true);
};

cases.alchemist = async (h) => {
  const before = await v(h);
  await h.post('/turn/build', { cardId: 'fixture_tavern' }, 0, 201);
  let state = await v(h);
  assert.equal(state.me.gold, before.me.gold - 1);
  await h.post('/turn/end');
  state = await v(h);
  assert.equal(state.me.gold, before.me.gold, 'building costs must be refunded on turn end');
};

cases.architect = async (h) => {
  h.mutate((session) => {
    session.players[0].hand = [
      card('tavern', 'trade', 1, 'a1'),
      card('temple', 'religious', 1, 'a2'),
      card('watchtower', 'military', 1, 'a3'),
      card('manor', 'noble', 3, 'a4')
    ];
  });
  for (const id of ['a1', 'a2', 'a3']) await h.post('/turn/build', { cardId: 'fixture_' + id }, 0, 201);
  assert.equal((await v(h)).turn.action.builds, 3);
  assert.equal((await h.post('/turn/build', { cardId: 'fixture_a4' }, 0, 409)).error, 'build_limit_reached');
};

cases.navigator = async (h) => {
  const before = await v(h);
  await invoke(h, 'navigator-resource', { mode: 'gold' });
  const after = await v(h);
  assert.equal(after.me.gold, before.me.gold + 4);
  assert.equal((await h.post('/turn/build', { cardId: 'fixture_tavern' }, 0, 409)).error, 'character_cannot_build');
};

cases.scholar = async (h) => {
  const before = await v(h);
  await invoke(h, 'scholar-draw');
  let state = await v(h);
  assert.equal(state.turn.action.specialDraw.length, 7);
  const chosen = state.turn.action.specialDraw[0].cardId;
  await invoke(h, 'scholar-keep', { cardId: chosen });
  state = await v(h);
  assert.equal(state.turn.action.specialDraw.length, 0);
  assert.equal(state.me.handCount, before.me.handCount + 1);
};

cases.artist = async (h) => {
  h.mutate((session) => {
    session.players[0].built = [built('tavern', 'trade', 1), built('temple', 'religious', 1)];
  });
  await invoke(h, 'beautify', { cardId: 'fixture_tavern' });
  await invoke(h, 'beautify', { cardId: 'fixture_temple' });
  const state = await v(h);
  assert.equal(state.me.built.filter((entry) => entry.beautified).length, 2);
  assert.equal(state.turn.action.artistUses, 2);
  assert.equal((await invoke(h, 'beautify', { cardId: 'fixture_tavern' }, 0, 409)).error, 'ability_already_used');
};

cases['tax-collector'] = async (h) => {
  h.mutate((session) => { session.taxPool = 6; });
  const before = (await v(h)).me.gold;
  await invoke(h, 'collect-tax');
  const after = await v(h);
  assert.equal(after.me.gold, before + 6);
  assert.equal(after.taxPool, 0);
};

// Add the second, movement-based abilities to the corresponding colour-role cases.
function chain(existing, extra) {
  return async (h) => { await existing(h); await extra(h); };
}

cases.emperor = chain(cases.emperor, async (h) => {
  const target = other(h);
  const previous = (await v(h)).me.gold;
  await invoke(h, 'crown', { targetPlayerId: target, payment: 'gold' });
  const state = await v(h);
  assert.equal(state.crownPlayerId, target);
  assert.equal(state.me.gold, previous + 1);
});

cases.cardinal = chain(cases.cardinal, async (h) => {
  h.mutate((session) => {
    session.players[0].gold = 1;
    session.players[0].hand = [
      card('cathedral', 'religious', 5, 'cathedral'),
      card('tavern', 'trade', 1, 'pay1'),
      card('market', 'trade', 2, 'pay2'),
      card('temple', 'religious', 1, 'pay3'),
      card('watchtower', 'military', 1, 'pay4')
    ];
    session.players[1].gold = 9;
  });
  await invoke(h, 'cardinal-build', {
    cardId: 'fixture_cathedral', targetPlayerId: other(h),
    paymentCardIds: ['fixture_pay1', 'fixture_pay2', 'fixture_pay3', 'fixture_pay4']
  });
  const state = await v(h);
  assert.ok(state.me.built.some((entry) => entry.cardId === 'fixture_cathedral'));
  assert.equal(state.me.gold, 0);
  assert.equal(state.turn.action.builds, 1);
});

cases.trader = chain(cases.trader, async (h) => {
  h.mutate((session) => {
    session.turn.action.builds = 1;
    session.players[0].hand = [card('tavern', 'trade', 1, 'trader_t'), card('temple', 'religious', 1, 'trader_r')];
  });
  await h.post('/turn/build', { cardId: 'fixture_trader_t' }, 0, 201);
  assert.equal((await v(h)).turn.action.builds, 1, 'trading districts should bypass limit');
  assert.equal((await h.post('/turn/build', { cardId: 'fixture_trader_r' }, 0, 409)).error, 'build_limit_reached');
});

cases.warlord = chain(cases.warlord, async (h) => {
  h.mutate((session) => {
    session.players[1].built = [built('watchtower', 'military', 1, 'war_target')];
  });
  await invoke(h, 'destroy-district', { cardId: 'fixture_war_target' });
  const state = await v(h);
  assert.equal(state.players.find((p) => p.id === other(h)).built.length, 0);
  assert.equal(state.turn.action.destructionUsed, true);
});

cases.diplomat = chain(cases.diplomat, async (h) => {
  h.mutate((session) => {
    session.players[0].built = [built('temple', 'religious', 1, 'd_own')];
    session.players[1].built = [built('market', 'trade', 2, 'd_other')];
  });
  const previousGold = (await v(h)).me.gold;
  await invoke(h, 'swap-districts', {
    ownCardId: 'fixture_d_own', targetCardId: 'fixture_d_other'
  });
  const state = await v(h);
  assert.equal(state.me.built[0].id, 'market');
  assert.equal(state.players.find((p) => p.id === other(h)).built[0].id, 'temple');
  assert.equal(state.me.gold, previousGold - 1);
});

cases.marshal = chain(cases.marshal, async (h) => {
  h.mutate((session) => {
    session.players[1].built = [built('watchtower', 'military', 1, 'm_target')];
  });
  await invoke(h, 'seize-district', { cardId: 'fixture_m_target' });
  const state = await v(h);
  assert.ok(state.me.built.some((entry) => entry.cardId === 'fixture_m_target'));
  assert.equal(state.players.find((p) => p.id === other(h)).built.length, 0);
});

cases.queen = async (h) => {
  const before = (await v(h)).me.gold;
  h.mutate((session) => {
    session.players[0].characterIds = ['queen'];
    session.players[0].characterId = 'queen';
    session.players[1].characterIds = ['king'];
    session.players[1].characterId = 'king';
    session.turn.order = [
      { playerId: session.players[1].id, characterId: 'king', rank: 4 },
      { playerId: session.players[0].id, characterId: 'queen', rank: 9 }
    ];
    session.turn.index = 0;
    session.turn.action.playerId = session.players[1].id;
    session.turn.action.resourceGathered = true;
    session.turn.revealedCharacterIds = ['king'];
  });
  await h.post('/turn/end', {}, 1);
  const state = await v(h);
  assert.equal(state.turn.character.id, 'queen');
  assert.equal(state.turn.activePlayerId, h.auth[0].playerId);
  assert.equal(state.me.gold, before + 3, 'Queen gets 3 gold for sitting next to rank 4');
};

// This is deliberately strict: if any one of the 27 official roles is not
// covered, CI fails rather than giving the impression of complete coverage.
const implemented = CHARACTERS.map((role) => role.id).sort();
assert.deepEqual(Object.keys(cases).sort(), implemented, 'every official character must have an HTTP scenario');

for (const role of CHARACTERS) {
  test('CHARACTER HTTP E2E: rank ' + role.rank + ' ' + role.name + ' (' + role.id + ')', async (t) => {
    const count = role.id === 'queen' ? 8
      : role.rank === 9 || role.id === 'emperor' ? 3 : 2;
    const rig = await openRig(t, { players: count });
    seedTurn(rig, role.id, { count });
    await cases[role.id](rig);
  });
}
