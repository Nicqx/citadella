'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { stateView, targetableCharacterIds } = require('../server');

function makePlayer(id, name, seatIndex) {
  return {
    id,
    name,
    seatIndex,
    tokenHash: 'unused',
    gold: 2,
    built: [],
    hand: [],
    characterId: null,
    manualBonus: 0
  };
}

function makeSession(players) {
  return {
    code: '64814',
    phase: 'lobby',
    round: 0,
    createdAt: 1,
    updatedAt: 2,
    hostPlayerId: players[0].id,
    crownPlayerId: players[0].id,
    players,
    districtDeck: [],
    draft: null,
    turn: null,
    roundEffects: {
      assassinatedCharacterId: null,
      thiefTargetCharacterId: null,
      thiefPlayerId: null
    },
    roundFaceUpCharacterIds: [],
    firstCompletedPlayerId: null,
    finalRound: false,
    winnerPlayerId: null
  };
}

test('stateView includes the authenticated player without throwing', () => {
  const actor = makePlayer('p_host', 'Nick', 0);
  const session = makeSession([actor]);

  const view = stateView(session, actor, 1234);

  assert.equal(view.code, '64814');
  assert.equal(view.me.id, actor.id);
  assert.equal(view.me.name, 'Nick');
  assert.equal(view.ttlSeconds, 1234);
});

test('stateView exposes only the authenticated player district hand', () => {
  const actor = makePlayer('p_host', 'Nick', 0);
  const other = makePlayer('p_other', 'Anna', 1);
  actor.hand = [{ cardId: 'market_1', id: 'market', name: 'Market', type: 'trade', cost: 2, effect: null }];
  other.hand = [{ cardId: 'castle_2', id: 'castle', name: 'Castle', type: 'noble', cost: 4, effect: null }];
  const session = makeSession([actor, other]);

  const view = stateView(session, actor, 1234);
  const otherView = view.players.find((player) => player.id === other.id);

  assert.equal(view.me.hand.length, 1);
  assert.equal(view.me.hand[0].name, 'Market');
  assert.equal(otherView.handCount, 1);
  assert.equal(Object.hasOwn(otherView, 'hand'), false);
});


test('public face-up character discards remain visible after drafting', () => {
  const players = [
    makePlayer('p0', 'A', 0),
    makePlayer('p1', 'B', 1),
    makePlayer('p2', 'C', 2),
    makePlayer('p3', 'D', 3)
  ];
  const session = makeSession(players);
  session.phase = 'turns';
  session.roundFaceUpCharacterIds = ['bishop', 'merchant'];

  const view = stateView(session, players[0], 1234);
  assert.deepEqual(view.faceUpCharacters.map((character) => character.id), ['bishop', 'merchant']);
});

test('Assassin and Thief cannot target face-up discarded characters', () => {
  const players = [
    makePlayer('p0', 'A', 0),
    makePlayer('p1', 'B', 1),
    makePlayer('p2', 'C', 2),
    makePlayer('p3', 'D', 3)
  ];
  const session = makeSession(players);
  session.roundFaceUpCharacterIds = ['bishop', 'merchant'];
  session.roundEffects.assassinatedCharacterId = 'king';

  const assassinTargets = targetableCharacterIds(session, 'assassin');
  assert.equal(assassinTargets.has('assassin'), false);
  assert.equal(assassinTargets.has('bishop'), false);
  assert.equal(assassinTargets.has('merchant'), false);
  assert.equal(assassinTargets.has('thief'), true);

  const thiefTargets = targetableCharacterIds(session, 'thief');
  assert.equal(thiefTargets.has('assassin'), false);
  assert.equal(thiefTargets.has('thief'), false);
  assert.equal(thiefTargets.has('king'), false);
  assert.equal(thiefTargets.has('bishop'), false);
  assert.equal(thiefTargets.has('warlord'), true);
});
