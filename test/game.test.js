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

test('score includes districts, diversity, completion and manual unique bonus', () => {
  const player = { id: 'p1', manualBonus: 2, built: [
    { cost: 1, type: 'noble' }, { cost: 2, type: 'religious' }, { cost: 3, type: 'trade' },
    { cost: 4, type: 'military' }, { cost: 5, type: 'unique' }, { cost: 1, type: 'noble' }, { cost: 1, type: 'trade' }
  ] };
  const score = scorePlayer(player, { firstCompletedPlayerId: 'p1' });
  assert.deepEqual(score, { districtPoints: 17, diversityBonus: 3, completionBonus: 4, manualBonus: 2, total: 26 });
});
