'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CHARACTERS,
  DEFAULT_CHARACTER_IDS,
  validateCharacterSelection,
  validateCharactersForPlayerCount,
  completionTarget,
  inUseCharacters,
  draftDiscardCounts,
  createDraft,
  draftOptions,
  draftDiscardRequired,
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


test('modern edition exposes exactly three character variants for every rank', () => {
  assert.equal(CHARACTERS.length, 27);
  for (let rank = 1; rank <= 9; rank += 1) {
    assert.equal(CHARACTERS.filter((character) => character.rank === rank).length, 3);
  }
});

test('character setup requires exactly one matching character for every rank', () => {
  assert.deepEqual(validateCharacterSelection(DEFAULT_CHARACTER_IDS), DEFAULT_CHARACTER_IDS);
  assert.throws(
    () => validateCharacterSelection(DEFAULT_CHARACTER_IDS.slice(0, 8)),
    /character_selection_count/
  );

  const invalid = [...DEFAULT_CHARACTER_IDS];
  invalid[0] = 'spy';
  assert.throws(() => validateCharacterSelection(invalid), /invalid_character_selection/);
});

test('custom rank replacements are used by the draft and rank four is still protected face-up', () => {
  const custom = [
    'witch', 'spy', 'seer', 'emperor', 'abbot',
    'trader', 'scholar', 'marshal', 'artist'
  ];

  assert.deepEqual(inUseCharacters(8, custom).map((character) => character.id), custom);
  assert.deepEqual(inUseCharacters(4, custom).map((character) => character.id), custom.slice(0, 8));

  for (let i = 0; i < 50; i += 1) {
    const draft = createDraft(players(4), 'p0', custom);
    assert.equal(draft.faceUpIds.includes('emperor'), false);
  }
});


test('Emperor is never the initial face-down discard', () => {
  const custom = [
    'magistrate', 'blackmailer', 'wizard', 'emperor', 'cardinal',
    'alchemist', 'navigator', 'diplomat', 'tax-collector'
  ];

  for (let i = 0; i < 200; i += 1) {
    const draft = createDraft(players(6), 'p0', custom);
    assert.notEqual(draft.faceDownId, 'emperor');
    assert.ok(draft.available.includes('emperor'));
  }
});


test('two-player mode uses ranks 1-8 and forbids the Emperor', () => {
  assert.equal(inUseCharacters(2).length, 8);

  const emperorSetup = [...DEFAULT_CHARACTER_IDS];
  emperorSetup[3] = 'emperor';
  assert.throws(
    () => validateCharactersForPlayerCount(2, emperorSetup),
    /emperor_not_allowed_two_players/
  );
});

test('three-player mode uses all nine ranks and forbids the Queen', () => {
  const setup = [...DEFAULT_CHARACTER_IDS];
  setup[8] = 'artist';
  assert.equal(inUseCharacters(3, setup).length, 9);
  assert.equal(inUseCharacters(3, setup).at(-1).id, 'artist');

  assert.throws(
    () => validateCharactersForPlayerCount(3, DEFAULT_CHARACTER_IDS),
    /queen_not_allowed_under_five/
  );
});

test('two-player draft gives both players two characters with a hidden discard each later pick', () => {
  const draft = createDraft(players(2), 'p0');
  assert.equal(draft.mode, 'two-player');
  assert.deepEqual(draft.order, ['p0', 'p1', 'p0', 'p1']);
  assert.equal(draft.faceDownId !== null, true);
  assert.equal(draftDiscardRequired(draft), false);

  chooseCharacter(draft, 'p0', draftOptions(draft)[0]);
  assert.equal(draft.choices.p0.length, 1);
  assert.equal(draftDiscardRequired(draft), true);

  for (const playerId of ['p1', 'p0']) {
    const options = draftOptions(draft);
    chooseCharacter(draft, playerId, options[0], options[1]);
  }

  const finalOptions = draftOptions(draft);
  const completed = chooseCharacter(draft, 'p1', finalOptions[0], finalOptions[1]);
  assert.equal(completed, true);
  assert.equal(draft.choices.p0.length, 2);
  assert.equal(draft.choices.p1.length, 2);
  assert.equal(draft.discardedIds.length, 3);
  assert.equal(draft.available.length, 0);
});

test('three-player draft gives everyone two characters and performs the two hidden discards', () => {
  const setup = [...DEFAULT_CHARACTER_IDS];
  setup[8] = 'artist';
  const draft = createDraft(players(3), 'p0', setup);

  assert.equal(draft.mode, 'three-player');
  assert.deepEqual(draft.order, ['p0', 'p1', 'p2', 'p0', 'p1', 'p2']);

  for (const playerId of ['p0', 'p1', 'p2']) {
    chooseCharacter(draft, playerId, draftOptions(draft)[0]);
  }
  assert.equal(draft.discardedIds.length, 1);
  assert.equal(draft.available.length, 4);

  chooseCharacter(draft, 'p0', draftOptions(draft)[0]);
  chooseCharacter(draft, 'p1', draftOptions(draft)[0]);
  const completed = chooseCharacter(draft, 'p2', draftOptions(draft)[0]);

  assert.equal(completed, true);
  assert.equal(draft.finalDiscardId !== null, true);
  assert.equal(draft.available.length, 0);
  assert.deepEqual(
    Object.values(draft.choices).map((choices) => choices.length),
    [2, 2, 2]
  );
});

test('turn order flattens two characters per player by character rank', () => {
  const order = turnOrderFromChoices({
    p1: ['warlord', 'thief'],
    p2: ['merchant', 'assassin']
  });
  assert.deepEqual(
    order.map((entry) => [entry.playerId, entry.characterId]),
    [
      ['p2', 'assassin'],
      ['p1', 'thief'],
      ['p2', 'merchant'],
      ['p1', 'warlord']
    ]
  );
});

test('two and three player cities complete at eight districts, not seven', () => {
  assert.equal(completionTarget(2), 8);
  assert.equal(completionTarget(3), 8);
  assert.equal(completionTarget(4), 7);

  const sevenDistricts = {
    id: 'p1',
    gold: 0,
    hand: [],
    built: Array.from({ length: 7 }, (_, index) => ({
      id: `d${index}`,
      type: index % 2 ? 'trade' : 'noble',
      cost: 1
    }))
  };
  const twoPlayerSession = {
    players: [{ id: 'p1' }, { id: 'p2' }],
    firstCompletedPlayerId: 'p1',
    crownPlayerId: 'p2'
  };
  assert.equal(scorePlayer(sevenDistricts, twoPlayerSession).completionBonus, 0);

  const eightDistricts = {
    ...sevenDistricts,
    built: [...sevenDistricts.built, { id: 'd7', type: 'military', cost: 1 }]
  };
  assert.equal(scorePlayer(eightDistricts, twoPlayerSession).completionBonus, 4);
});
