'use strict';

const crypto = require('crypto');

const BASIC_DISTRICTS = Object.freeze([
  { id: 'manor', name: 'Manor', type: 'noble', cost: 3, copies: 5 },
  { id: 'castle', name: 'Castle', type: 'noble', cost: 4, copies: 4 },
  { id: 'palace', name: 'Palace', type: 'noble', cost: 5, copies: 3 },

  { id: 'temple', name: 'Temple', type: 'religious', cost: 1, copies: 3 },
  { id: 'church', name: 'Church', type: 'religious', cost: 2, copies: 3 },
  { id: 'monastery', name: 'Monastery', type: 'religious', cost: 3, copies: 3 },
  { id: 'cathedral', name: 'Cathedral', type: 'religious', cost: 5, copies: 2 },

  { id: 'tavern', name: 'Tavern', type: 'trade', cost: 1, copies: 5 },
  { id: 'market', name: 'Market', type: 'trade', cost: 2, copies: 4 },
  { id: 'trading-post', name: 'Trading Post', type: 'trade', cost: 2, copies: 3 },
  { id: 'docks', name: 'Docks', type: 'trade', cost: 3, copies: 3 },
  { id: 'harbor', name: 'Harbor', type: 'trade', cost: 4, copies: 3 },
  { id: 'town-hall', name: 'Town Hall', type: 'trade', cost: 5, copies: 2 },

  { id: 'watchtower', name: 'Watchtower', type: 'military', cost: 1, copies: 3 },
  { id: 'prison', name: 'Prison', type: 'military', cost: 2, copies: 3 },
  { id: 'barracks', name: 'Barracks', type: 'military', cost: 3, copies: 3 },
  { id: 'fortress', name: 'Fortress', type: 'military', cost: 5, copies: 2 }
]);

const UNIQUE_DISTRICTS = Object.freeze([
  {
    id: 'dragon-gate', name: 'Dragon Gate', type: 'unique', cost: 6,
    effect: 'A játék végén további 2 pontot ér.'
  },
  {
    id: 'factory', name: 'Factory', type: 'unique', cost: 5,
    effect: 'A többi egyedi kerület megépítése 1 arannyal olcsóbb.'
  },
  {
    id: 'haunted-quarter', name: 'Haunted Quarter', type: 'unique', cost: 2,
    effect: 'A végső pontozáskor egy választott kerülettípusnak számíthat.'
  },
  {
    id: 'imperial-treasury', name: 'Imperial Treasury', type: 'unique', cost: 5,
    effect: 'A játék végén plusz pontot adhat a megmaradt aranyad után.'
  },
  {
    id: 'keep', name: 'Keep', type: 'unique', cost: 3,
    effect: 'A 8-as rangú karakter nem pusztíthatja el.'
  },
  {
    id: 'laboratory', name: 'Laboratory', type: 'unique', cost: 5,
    effect: 'Körönként egyszer egy kézlap eldobásával 2 arany szerezhető.'
  },
  {
    id: 'library', name: 'Library', type: 'unique', cost: 6,
    effect: 'Ha kerületlapot húzol nyersanyagként, mindkét húzott lapot megtarthatod.'
  },
  {
    id: 'map-room', name: 'Map Room', type: 'unique', cost: 5,
    effect: 'A játék végén plusz pontot adhat a kézben maradt lapjaid után.'
  },
  {
    id: 'quarry', name: 'Quarry', type: 'unique', cost: 5,
    effect: 'Lehetővé teszi azonos nevű kerületek megépítését.'
  },
  {
    id: 'school-of-magic', name: 'School of Magic', type: 'unique', cost: 6,
    effect: 'Karakterbevételnél egy választott színű kerületnek számíthat.'
  },
  {
    id: 'smithy', name: 'Smithy', type: 'unique', cost: 5,
    effect: 'Körönként egyszer 2 aranyért 3 kerületlap húzható.'
  },
  {
    id: 'statue', name: 'Statue', type: 'unique', cost: 3,
    effect: 'A játék végén plusz pontot adhat, ha nálad van a korona.'
  },
  {
    id: 'thieves-den', name: "Thieves' Den", type: 'unique', cost: 6,
    effect: 'A költség egy része kézlapok eldobásával is kifizethető.'
  },
  {
    id: 'wishing-well', name: 'Wishing Well', type: 'unique', cost: 5,
    effect: 'A játék végén plusz pontot adhat az egyedi kerületeid után.'
  }
]);

function shuffle(array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function createDistrictDeck() {
  let serial = 0;
  const cards = [];

  for (const district of BASIC_DISTRICTS) {
    for (let i = 0; i < district.copies; i += 1) {
      serial += 1;
      cards.push({
        cardId: `${district.id}_${serial}`,
        id: district.id,
        name: district.name,
        type: district.type,
        cost: district.cost,
        effect: null
      });
    }
  }

  for (const district of UNIQUE_DISTRICTS) {
    serial += 1;
    cards.push({
      cardId: `${district.id}_${serial}`,
      id: district.id,
      name: district.name,
      type: district.type,
      cost: district.cost,
      effect: district.effect
    });
  }

  return shuffle(cards);
}

function districtPublic(card) {
  if (!card) return null;
  return {
    cardId: card.cardId,
    id: card.id,
    name: card.name,
    type: card.type,
    cost: card.cost,
    effect: card.effect || null,
    beautified: Boolean(card.beautified),
    builtAtRound: card.builtAtRound || null
  };
}

function drawCards(session, count) {
  if (!Array.isArray(session.districtDeck)) session.districtDeck = [];
  if (session.districtDeck.length < count) throw new Error('district_deck_empty');
  return session.districtDeck.splice(0, count);
}

function putOnDeckBottom(session, cards) {
  if (!Array.isArray(session.districtDeck)) session.districtDeck = [];
  session.districtDeck.push(...cards.filter(Boolean).map((card) => ({
    cardId: card.cardId,
    id: card.id,
    name: card.name,
    type: card.type,
    cost: card.cost,
    effect: card.effect || null
  })));
}

function hasBuilt(player, districtId) {
  return Array.isArray(player.built) && player.built.some((district) => district.id === districtId);
}

function effectiveBuildCost(player, card) {
  const factoryDiscount = card.type === 'unique' && card.id !== 'factory' && hasBuilt(player, 'factory') ? 1 : 0;
  return Math.max(0, Number(card.cost || 0) - factoryDiscount);
}

function canBuildDuplicate(player, card) {
  if (hasBuilt(player, 'quarry')) return true;
  return !player.built.some((district) => district.id === card.id);
}

module.exports = {
  BASIC_DISTRICTS,
  UNIQUE_DISTRICTS,
  createDistrictDeck,
  districtPublic,
  drawCards,
  putOnDeckBottom,
  effectiveBuildCost,
  canBuildDuplicate
};
