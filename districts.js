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
  { id: 'armory', name: 'Fegyvertár', type: 'unique', cost: 3, effect: 'A körödben elpusztíthatod a Fegyvertárat, hogy elpusztíts egy másik kerületet.' },
  { id: 'basilica', name: 'Bazilika', type: 'unique', cost: 4, effect: 'Játékvégén +1 pont minden páratlan építési költségű kerületed után.' },
  { id: 'capitol', name: 'Capitolium', type: 'unique', cost: 5, effect: 'Játékvégén +3 pont, ha legalább 3 azonos típusú kerületed van.' },
  { id: 'dragon-gate', name: 'Sárkánykapu', type: 'unique', cost: 6, effect: 'A játék végén további 2 pontot ér.' },
  { id: 'factory', name: 'Gyár', type: 'unique', cost: 5, effect: 'A többi egyedi kerület megépítése 1 arannyal olcsóbb.' },
  { id: 'framework', name: 'Állványzat', type: 'unique', cost: 3, effect: 'Egy kerületet az Állványzat elpusztításával is megépíthetsz a költség kifizetése helyett.' },
  { id: 'gold-mine', name: 'Aranybánya', type: 'unique', cost: 6, effect: 'Ha nyersanyagként aranyat választasz, 1 extra aranyat kapsz.' },
  { id: 'great-wall', name: 'Nagy fal', type: 'unique', cost: 6, effect: 'A 8-as rangú karakter 1 arannyal többet fizet, ha másik kerületedre használja a képességét.' },
  { id: 'haunted-quarter', name: 'Kísértetváros', type: 'unique', cost: 2, effect: 'A végső pontozáskor egy választott, nem egyedi kerülettípusnak számíthat.' },
  { id: 'imperial-treasury', name: 'Birodalmi kincstár', type: 'unique', cost: 5, effect: 'Játékvégén +1 pont minden megmaradt aranyad után.' },
  { id: 'ivory-tower', name: 'Elefántcsonttorony', type: 'unique', cost: 5, effect: 'Játékvégén +5 pont, ha ez az egyetlen egyedi kerület a városodban.' },
  { id: 'keep', name: 'Erődítmény', type: 'unique', cost: 3, effect: 'A 8-as rangú karakter nem használhatja rá a képességét.' },
  { id: 'laboratory', name: 'Laboratórium', type: 'unique', cost: 5, effect: 'Körönként egyszer egy kézlap eldobásával 2 arany szerezhető.' },
  { id: 'library', name: 'Könyvtár', type: 'unique', cost: 6, effect: 'Ha kerületlapot húzol nyersanyagként, minden húzott lapot megtarthatsz.' },
  { id: 'map-room', name: 'Térképszoba', type: 'unique', cost: 5, effect: 'Játékvégén +1 pont minden kézben maradt lapod után.' },
  { id: 'monument', name: 'Emlékmű', type: 'unique', cost: 4, effect: '5 vagy több kerülettel már nem építhető; a város befejezésénél 2 kerületnek számít.' },
  { id: 'museum', name: 'Múzeum', type: 'unique', cost: 4, effect: 'Körönként egyszer egy kézlapot képpel lefelé alátehetsz; játékvégén mindegyik ilyen lap +1 pont.' },
  { id: 'necropolis', name: 'Temető', type: 'unique', cost: 5, effect: 'Megépíthető egy saját kerület elpusztításával az aranyköltség helyett.' },
  { id: 'observatory', name: 'Csillagvizsgáló', type: 'unique', cost: 4, effect: 'Lapnyersanyagnál 3 lapot húzol 2 helyett.' },
  { id: 'park', name: 'Park', type: 'unique', cost: 6, effect: 'Ha a köröd végén nincs kézlapod, húzz 2 lapot.' },
  { id: 'poor-house', name: 'Szegényház', type: 'unique', cost: 4, effect: 'Ha a köröd végén nincs aranyad, kapsz 1 aranyat.' },
  { id: 'quarry', name: 'Kőfejtő', type: 'unique', cost: 5, effect: 'Lehetővé teszi azonos nevű kerületek megépítését.' },
  { id: 'school-of-magic', name: 'Varázstanoda', type: 'unique', cost: 6, effect: 'Karakterbevételnél egy választott színű kerületnek számíthat.' },
  { id: 'secret-vault', name: 'Titkos kripta', type: 'unique', cost: 0, effect: 'Nem építhető meg; ha játékvégén a kezedben van, +3 pontot ér.' },
  { id: 'smithy', name: 'Kovácsműhely', type: 'unique', cost: 5, effect: 'Körönként egyszer 2 aranyért 3 kerületlap húzható.' },
  { id: 'stables', name: 'Istálló', type: 'unique', cost: 2, effect: 'Megépítése nem számít bele a köröd építési korlátjába.' },
  { id: 'statue', name: 'Szobor', type: 'unique', cost: 3, effect: 'Ha a játék végén nálad van a korona, +5 pontot ér.' },
  { id: 'theater', name: 'Színház', type: 'unique', cost: 6, effect: 'A kiválasztási fázis végén elcserélheted karakteredet egy ellenfélére.' },
  { id: 'thieves-den', name: 'Tolvajtanya', type: 'unique', cost: 6, effect: 'Építési költségét részben vagy egészben kézlapok eldobásával is fizetheted: 1 lap = 1 arany.' },
  { id: 'wishing-well', name: 'Kívánságkút', type: 'unique', cost: 5, effect: 'Játékvégén +1 pont minden egyedi kerületed után, önmagát is beleszámítva.' }
]);

const DEFAULT_UNIQUE_DISTRICT_IDS = Object.freeze([
  'dragon-gate',
  'factory',
  'haunted-quarter',
  'imperial-treasury',
  'keep',
  'laboratory',
  'library',
  'map-room',
  'quarry',
  'school-of-magic',
  'smithy',
  'statue',
  'thieves-den',
  'wishing-well'
]);


function shuffle(array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function createDistrictDeck(uniqueDistrictIds = DEFAULT_UNIQUE_DISTRICT_IDS) {
  const selectedIds = Array.isArray(uniqueDistrictIds) ? [...uniqueDistrictIds] : [];
  if (selectedIds.length !== 14 || new Set(selectedIds).size !== 14) {
    throw new Error('unique_district_selection_count');
  }
  const uniqueById = new Map(UNIQUE_DISTRICTS.map((district) => [district.id, district]));
  const selectedUniqueDistricts = selectedIds.map((districtId) => uniqueById.get(districtId));
  if (selectedUniqueDistricts.some((district) => !district)) {
    throw new Error('unknown_unique_district');
  }

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

  for (const district of selectedUniqueDistricts) {
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
    storedCardCount: Array.isArray(card.storedCards) ? card.storedCards.length : Number(card.storedCardCount || 0),
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
  DEFAULT_UNIQUE_DISTRICT_IDS,
  createDistrictDeck,
  districtPublic,
  drawCards,
  putOnDeckBottom,
  effectiveBuildCost,
  canBuildDuplicate
};
