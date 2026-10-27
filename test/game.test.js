'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  inUseCharacters,
  draftDiscardCounts,
  createDraft,
  draftOptions,
  chooseCharacter,
  turnOrderFromChoices,
  scorePlayer
} = require('../game');

function players(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i}`, seatIndex: i }));
}

test('4-7 players use eight characters and 8 players use the Queen as ninth', () => {
  assert.equal(inUseCharacters(4).length, 8);
  assert.equal(inUseCharacters(7).length, 8);
  assert.equal(inUseCharacters(8).length, 9);
  assert.equal(inUseCharacters(8).at(-1).id, 'queen');
});

test('face-up discard counts follow the reference table', () => {
  assert.deepEqual(draftDiscardCounts(4), { faceUp: 2, faceDown: 1 });
  assert.deepEqual(draftDiscardCounts(5), { faceUp: 1, faceDown: 1 });
  assert.deepEqual(draftDiscardCounts(6), { faceUp: 0, faceDown: 1 });
});

test('rank four is never among face-up discards', () => {
  for (let i = 0; i < 50; i += 1) {
    const draft = createDraft(players(4), 'p0');
    assert.equal(draft.faceUpIds.includes('king'), false);
  }
});

test('seven-player last drafter may choose the hidden discard', () => {
  const draft = createDraft(players(7), 'p0');
  for (let i = 0; i < 6; i += 1) {
    const options = draftOptions(draft);
    chooseCharacter(draft, `p${i}`, options[0]);
  }
  const options = draftOptions(draft);
  assert.equal(options.length, 2);
  assert.ok(options.includes(draft.faceDownId));
});

test('turn order is character rank order', () => {
  const order = turnOrderFromChoices({ p1: 'warlord', p2: 'assassin', p3: 'merchant' });
  assert.deepEqual(order.map((x) => x.playerId), ['p2', 'p3', 'p1']);
});

test('score includes districts, diversity and completion without manual correction', () => {
  const player = { id: 'p1', hand: [], built: [
    { cost: 1, type: 'noble' }, { cost: 2, type: 'religious' }, { cost: 3, type: 'trade' },
    { cost: 4, type: 'military' }, { cost: 5, type: 'unique' }, { cost: 1, type: 'noble' }, { cost: 1, type: 'trade' }
  ] };
  const score = scorePlayer(player, { firstCompletedPlayerId: 'p1' });
  assert.deepEqual(score, {
    districtPoints: 17,
    diversityBonus: 3,
    completionBonus: 4,
    uniqueBonus: 0,
    hauntedQuarterType: null,
    total: 24
  });
});

test('Monument counts as two districts for city completion', () => {
  const player = {
    id: 'p1',
    gold: 0,
    hand: [],
    built: [
      { id: 'monument', cost: 4, type: 'unique' },
      { id: 'temple', cost: 1, type: 'religious' },
      { id: 'market', cost: 2, type: 'trade' },
      { id: 'castle', cost: 4, type: 'noble' },
      { id: 'prison', cost: 2, type: 'military' },
      { id: 'tavern', cost: 1, type: 'trade' }
    ]
  };
  const score = scorePlayer(player, { firstCompletedPlayerId: 'p1', crownPlayerId: 'p2' });
  assert.equal(score.completionBonus, 4);
});

test('straightforward unique district end-game bonuses are automatic', () => {
  const player = {
    id: 'p1',
    gold: 3,
    hand: [{ id: 'secret-vault' }, { id: 'market' }],
    built: [
      { id: 'dragon-gate', cost: 6, type: 'unique' },
      { id: 'imperial-treasury', cost: 5, type: 'unique' },
      { id: 'map-room', cost: 5, type: 'unique' },
      { id: 'statue', cost: 3, type: 'unique' },
      { id: 'wishing-well', cost: 5, type: 'unique' }
    ]
  };
  const score = scorePlayer(player, { firstCompletedPlayerId: null, crownPlayerId: 'p1' });
  assert.equal(score.uniqueBonus, 20);
});

test('Haunted Quarter automatically chooses the type that maximizes the final score', () => {
  const player = {
    id: 'p1',
    gold: 0,
    hand: [],
    built: [
      { id: 'haunted-quarter', cost: 2, type: 'unique' },
      { id: 'wishing-well', cost: 5, type: 'unique' },
      { id: 'temple', cost: 1, type: 'religious' },
      { id: 'market', cost: 2, type: 'trade' },
      { id: 'castle', cost: 4, type: 'noble' }
    ]
  };
  const score = scorePlayer(player, { firstCompletedPlayerId: null, crownPlayerId: 'p2' });
  assert.equal(score.hauntedQuarterType, 'military');
  assert.equal(score.diversityBonus, 3);
  assert.equal(score.uniqueBonus, 1);
});

test('Haunted Quarter interaction with Ivory Tower is scored automatically', () => {
  const player = {
    id: 'p1',
    gold: 0,
    hand: [],
    built: [
      { id: 'haunted-quarter', cost: 2, type: 'unique' },
      { id: 'ivory-tower', cost: 5, type: 'unique' },
      { id: 'temple', cost: 1, type: 'religious' },
      { id: 'market', cost: 2, type: 'trade' },
      { id: 'castle', cost: 4, type: 'noble' },
      { id: 'prison', cost: 2, type: 'military' }
    ]
  };
  const score = scorePlayer(player, { firstCompletedPlayerId: null, crownPlayerId: 'p2' });
  assert.notEqual(score.hauntedQuarterType, 'unique');
  assert.equal(score.diversityBonus, 3);
  assert.equal(score.uniqueBonus, 5);
});

test('Haunted Quarter can create the third matching type for Capitol', () => {
  const player = {
    id: 'p1',
    gold: 0,
    hand: [],
    built: [
      { id: 'capitol', cost: 5, type: 'unique' },
      { id: 'haunted-quarter', cost: 2, type: 'unique' },
      { id: 'manor', cost: 3, type: 'noble' },
      { id: 'castle', cost: 4, type: 'noble' }
    ]
  };
  const score = scorePlayer(player, { firstCompletedPlayerId: null, crownPlayerId: 'p2' });
  assert.equal(score.hauntedQuarterType, 'noble');
  assert.equal(score.uniqueBonus, 3);
});

test('Museum stored cards are included in automatic unique scoring', () => {
  const player = {
    id: 'p1',
    gold: 0,
    hand: [],
    built: [
      {
        id: 'museum',
        cost: 4,
        type: 'unique',
        storedCards: [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
      }
    ]
  };
  const score = scorePlayer(player, { firstCompletedPlayerId: null, crownPlayerId: 'p2' });
  assert.equal(score.uniqueBonus, 3);
  assert.equal(score.total, 7);
});
