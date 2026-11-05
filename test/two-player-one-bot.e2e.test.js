'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_CHARACTER_IDS,
  createDraft,
  draftOptions,
  chooseCharacter
} = require('../game');
const { DEFAULT_UNIQUE_DISTRICT_IDS } = require('../districts');
const {
  stateView,
  initializePlayerForGame,
  setupDistrictDeck,
  runBots
} = require('../server');

function player(id, name, seatIndex, isBot = false) {
  return {
    id,
    name,
    seatIndex,
    tokenHash: isBot ? null : 'unused',
    gold: 0,
    built: [],
    hand: [],
    characterIds: [],
    characterId: null,
    isBot,
    botStrategy: isBot ? 'adaptive' : null
  };
}

function sessionWithOneHumanAndOneBot() {
  const human = player('p_human', 'Nick', 0, false);
  const bot = player('bot_1', 'Bot 1', 1, true);
  return {
    code: '24680',
    phase: 'lobby',
    round: 1,
    createdAt: 1,
    updatedAt: 1,
    hostPlayerId: human.id,
    crownPlayerId: human.id,
    players: [human, bot],
    selectedUniqueDistrictIds: [...DEFAULT_UNIQUE_DISTRICT_IDS],
    selectedCharacterIds: [...DEFAULT_CHARACTER_IDS],
    taxPool: 0,
    districtDeck: [],
    draft: null,
    turn: null,
    roundEffects: {},
    roundFaceUpCharacterIds: [],
    botActionLog: [],
    botActionSeq: 0,
    finalRevealedCharacterIds: [],
    firstCompletedPlayerId: null,
    finalRound: false,
    winnerPlayerId: null
  };
}

test('E2E flow: one human + one bot gives both players exactly two characters', () => {
  const session = sessionWithOneHumanAndOneBot();
  const human = session.players[0];
  const bot = session.players[1];

  // Equivalent of POST /start after validation.
  session.players.forEach(initializePlayerForGame);
  setupDistrictDeck(session);
  session.draft = createDraft(session.players, session.crownPlayerId, session.selectedCharacterIds);
  session.phase = 'draft';

  // First human pick.
  const firstOptions = draftOptions(session.draft);
  assert.ok(firstOptions.length >= 1);
  const firstHumanCharacter = firstOptions[0];
  assert.equal(chooseCharacter(session.draft, human.id, firstHumanCharacter), false);

  // POST /draft/choose runs bots until the next human decision.
  runBots(session);
  assert.equal(session.phase, 'draft');
  assert.equal(session.draft.order[session.draft.index], human.id);
  assert.equal(session.draft.choices[human.id].length, 1);
  assert.equal(session.draft.choices[bot.id].length, 1);

  // Second human pick in two-player mode also secretly discards another card.
  const secondOptions = draftOptions(session.draft);
  assert.ok(secondOptions.length >= 2);
  const secondHumanCharacter = secondOptions[0];
  const humanDiscard = secondOptions[1];
  assert.equal(
    chooseCharacter(session.draft, human.id, secondHumanCharacter, humanDiscard),
    false
  );

  // Bot completes its second pick; beginTurns happens inside runBots.
  runBots(session);

  assert.equal(session.phase, 'turns');
  assert.equal(session.draft, null);
  assert.equal(session.turn.order.length, 4);
  assert.equal(session.turn.order.filter((entry) => entry.playerId === human.id).length, 2);
  assert.equal(session.turn.order.filter((entry) => entry.playerId === bot.id).length, 2);

  assert.equal(human.characterIds.length, 2);
  assert.equal(new Set(human.characterIds).size, 2);
  assert.equal(bot.characterIds.length, 2);
  assert.equal(new Set(bot.characterIds).size, 2);

  // What the authenticated browser actually receives from GET /state.
  const view = stateView(session, human, 3600);
  assert.equal(view.me.characterCount, 2);
  assert.equal(view.me.characters.length, 2);
  assert.deepEqual(
    new Set(view.me.characters.map((character) => character.id)),
    new Set(human.characterIds)
  );
});
