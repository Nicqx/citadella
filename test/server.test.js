'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { stateView } = require('../server');

test('stateView includes the authenticated player without throwing', () => {
  const actor = {
    id: 'p_host',
    name: 'Nick',
    seatIndex: 0,
    tokenHash: 'unused',
    gold: 0,
    built: [],
    characterId: null,
    manualBonus: 0
  };
  const session = {
    code: '64814',
    phase: 'lobby',
    round: 0,
    createdAt: 1,
    updatedAt: 2,
    hostPlayerId: actor.id,
    crownPlayerId: actor.id,
    players: [actor],
    draft: null,
    turn: null,
    firstCompletedPlayerId: null,
    finalRound: false,
    winnerPlayerId: null
  };

  const view = stateView(session, actor, 1234);

  assert.equal(view.code, '64814');
  assert.equal(view.me.id, actor.id);
  assert.equal(view.me.name, 'Nick');
  assert.equal(view.ttlSeconds, 1234);
});
