'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  UNIQUE_DISTRICTS,
  DEFAULT_UNIQUE_DISTRICT_IDS,
  createDistrictDeck,
  districtPublic,
  effectiveBuildCost,
  canBuildDuplicate
} = require('../districts');
const {
  initializePlayerForGame,
  setupDistrictDeck
} = require('../server');

test('first-game district deck contains 54 basic and 14 unique cards', () => {
  const deck = createDistrictDeck();
  assert.equal(deck.length, 68);
  assert.equal(deck.filter((card) => card.type === 'unique').length, 14);
  assert.equal(deck.filter((card) => card.type === 'noble').length, 12);
  assert.equal(deck.filter((card) => card.type === 'religious').length, 11);
  assert.equal(deck.filter((card) => card.type === 'trade').length, 20);
  assert.equal(deck.filter((card) => card.type === 'military').length, 11);
  assert.equal(new Set(deck.map((card) => card.cardId)).size, deck.length);
});

test('starting a district game deals four private cards to every player', () => {
  const session = {
    players: Array.from({ length: 4 }, (_, index) => ({
      id: `p${index}`,
      seatIndex: index,
      gold: 0,
      built: [],
      hand: [],
      characterId: null
    })),
    districtDeck: [],
    selectedUniqueDistrictIds: [...DEFAULT_UNIQUE_DISTRICT_IDS]
  };
  session.players.forEach(initializePlayerForGame);
  setupDistrictDeck(session);

  assert.deepEqual(session.players.map((player) => player.hand.length), [4, 4, 4, 4]);
  assert.deepEqual(session.players.map((player) => player.gold), [2, 2, 2, 2]);
  assert.equal(session.districtDeck.length, 52);
});

test('Factory discounts other unique districts but not itself', () => {
  const player = {
    built: [{ id: 'factory', type: 'unique', cost: 5 }]
  };
  assert.equal(effectiveBuildCost(player, { id: 'dragon-gate', type: 'unique', cost: 6 }), 5);
  assert.equal(effectiveBuildCost(player, { id: 'factory', type: 'unique', cost: 5 }), 5);
  assert.equal(effectiveBuildCost(player, { id: 'castle', type: 'noble', cost: 4 }), 4);
});

test('Quarry permits duplicate districts', () => {
  const card = { id: 'market', type: 'trade', cost: 2 };
  assert.equal(canBuildDuplicate({ built: [{ id: 'market' }] }, card), false);
  assert.equal(canBuildDuplicate({ built: [{ id: 'market' }, { id: 'quarry' }] }, card), true);
});


test('unique district catalog contains 30 cards and a game selects exactly 14', () => {
  assert.equal(UNIQUE_DISTRICTS.length, 30);
  assert.equal(DEFAULT_UNIQUE_DISTRICT_IDS.length, 14);
  assert.equal(new Set(DEFAULT_UNIQUE_DISTRICT_IDS).size, 14);
});

test('custom unique district selection controls the 14 unique cards in the deck', () => {
  const selected = UNIQUE_DISTRICTS.slice(0, 14).map((district) => district.id);
  const deck = createDistrictDeck(selected);
  const uniqueIds = new Set(deck.filter((card) => card.type === 'unique').map((card) => card.id));

  assert.equal(deck.length, 68);
  assert.equal(uniqueIds.size, 14);
  assert.deepEqual([...uniqueIds].sort(), [...selected].sort());
});

test('district deck rejects a selection that is not exactly 14 distinct known cards', () => {
  assert.throws(() => createDistrictDeck(DEFAULT_UNIQUE_DISTRICT_IDS.slice(0, 13)), /unique_district_selection_count/);
  assert.throws(() => createDistrictDeck([...DEFAULT_UNIQUE_DISTRICT_IDS.slice(0, 13), 'missing-card']), /unknown_unique_district/);
});


test('districtPublic exposes Museum stored-card count without revealing stored cards', () => {
  const view = districtPublic({
    cardId: 'museum_1',
    id: 'museum',
    name: 'Múzeum',
    type: 'unique',
    cost: 4,
    storedCards: [{ cardId: 'a' }, { cardId: 'b' }]
  });

  assert.equal(view.storedCardCount, 2);
  assert.equal(Object.hasOwn(view, 'storedCards'), false);
});
