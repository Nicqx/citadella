'use strict';

const crypto = require('crypto');

const DISTRICT_TYPES = Object.freeze([
  { id: 'noble', label: 'Nemesi', symbol: 'N' },
  { id: 'religious', label: 'Egyházi', symbol: 'E' },
  { id: 'trade', label: 'Kereskedelmi', symbol: 'K' },
  { id: 'military', label: 'Katonai', symbol: 'H' },
  { id: 'unique', label: 'Egyedi', symbol: 'U' }
]);

const CHARACTERS = Object.freeze([
  {
    id: 'assassin', rank: 1, name: 'Orgyilkos',
    short: 'Megnevez egy karaktert; az a karakter kihagyja az egész körét.',
    detail: 'Válassz egy másik karaktert. Ha valakinél az a karakter van, nem fedi fel, amikor szólítják, és teljesen kimarad a körből.'
  },
  {
    id: 'witch', rank: 1, name: 'Boszorkány',
    short: 'Nyersanyaggyűjtés után megbabonáz egy karaktert, majd később annak képességeivel folytatja.',
    detail: 'A saját köröd elején gyűjts nyersanyagot, majd nevezz meg egy karaktert. A megbabonázott játékos a saját körében csak nyersanyagot gyűjt, utána te folytatod a körét a megnevezett karakter képességeivel, de a saját kezedet, aranyadat és városodat használod.'
  },
  {
    id: 'magistrate', rank: 1, name: 'Magisztrátus',
    short: 'Három karaktert megjelöl, közülük egy valódi célpont; annak első fizetős épületét elkobozhatja.',
    detail: 'Jelölj meg három különböző karaktert, és közülük egyet valódi célpontként. Ha a valódi célpont fizet egy kerület felépítéséért, az első ilyen kerületet elkobozhatod: a célpont visszakapja a kifizetett aranyat, a kerület pedig ingyen a te városodba kerül, ha nincs már ugyanilyen kerületed.'
  },
  {
    id: 'thief', rank: 2, name: 'Tolvaj',
    short: 'Megnevez egy karaktert; amikor sorra kerül, elveszi az összes aranyát.',
    detail: 'Nem választhatsz 1-es rangú karaktert, meggyilkolt vagy megbabonázott karaktert. Amikor a célpont karakter sorra kerül, elveszed az összes aranyát.'
  },
  {
    id: 'spy', rank: 2, name: 'Kém',
    short: 'Megnézi egy játékos kezét és egy megnevezett típus alapján aranyat és lapokat szerez.',
    detail: 'Válassz egy másik játékost és egy kerülettípust. Megnézed a kezét; minden ott lévő, megnevezett típusú kártya után elvehetsz tőle 1 aranyat, amennyit csak tud fizetni, és húzol 1 kerületlapot.'
  },
  {
    id: 'blackmailer', rank: 2, name: 'Zsaroló',
    short: 'Két karaktert fenyeget meg; az egyik a valódi célpont.',
    detail: 'Jelölj meg két különböző karaktert, egyikük legyen a valódi célpont. A fenyegetett játékos nyersanyaggyűjtés után vagy átadja aranya felét lefelé kerekítve, vagy vállalja a leleplezést; valódi célpont esetén ekkor az összes aranyát elveszti.'
  },
  {
    id: 'magician', rank: 3, name: 'Mágus',
    short: 'Teljes kezet cserélhet, vagy tetszőleges számú lapot újrahúzhat.',
    detail: 'Kicserélheted a teljes kezedet egy másik játékoséval, vagy tetszőleges számú saját lapot a pakli aljára tehetsz, és ugyanannyit húzhatsz helyettük.'
  },
  {
    id: 'wizard', rank: 3, name: 'Varázsló',
    short: 'Megnéz egy másik kezet, elvesz egy lapot, és akár azonnal meg is építheti.',
    detail: 'Nézd meg egy másik játékos kezét, vegyél el egy lapot, majd vagy tedd a saját kezedbe, vagy fizesd ki és azonnal építsd meg. Az azonnali építés nem számít bele a normál építési korlátba. Ebben a körben azonos nevű kerületet is építhetsz.'
  },
  {
    id: 'seer', rank: 3, name: 'Látnok',
    short: 'Minden más játékostól véletlenül elvesz 1 lapot, majd mindenkinek visszaad 1 lapot.',
    detail: 'Véletlenszerűen húzz egy lapot minden olyan játékos kezéből, akinek van lapja, add őket a saját kezedhez, majd minden érintett játékosnak adj vissza egy-egy lapot a saját kezedből. Az építési korlátod ebben a körben 2.'
  },
  {
    id: 'king', rank: 4, name: 'Király',
    short: 'Nemesi kerületenként 1 aranyat kap, és átveszi a koronát.',
    detail: 'Minden nemesi kerületed után 1 aranyat kaphatsz. A köröd során átveszed a koronát, így a következő kiválasztási fázisban te választasz elsőként.'
  },
  {
    id: 'emperor', rank: 4, name: 'Császár',
    short: 'Nemesi kerületenként 1 aranyat kap, majd a koronát egy másik játékosnak adja.',
    detail: 'Minden nemesi kerületed után 1 aranyat kaphatsz. A koronát el kell venned a jelenlegi birtokosától és egy másik, nem saját játékosnak kell adnod. Az új koronás játékos 1 aranyat vagy egy véletlen kézlapot ad neked, ha tud.'
  },
  {
    id: 'patrician', rank: 4, name: 'Patrícius',
    short: 'Nemesi kerületenként 1 lapot húz, és átveszi a koronát.',
    detail: 'Minden nemesi kerületed után 1 kerületlapot húzhatsz. A köröd során átveszed a koronát, így a következő kiválasztási fázisban te választasz elsőként.'
  },
  {
    id: 'bishop', rank: 5, name: 'Püspök',
    short: 'Egyházi kerületenként 1 aranyat kap; a 8-as rangú karakter nem támadhatja a kerületeit.',
    detail: 'Minden egyházi kerületed után 1 aranyat kaphatsz. Amíg életben vagy ebben a körben, a 8-as rangú karakter nem használhatja a kerületeiden a támadó vagy cserélő képességét.'
  },
  {
    id: 'abbot', rank: 5, name: 'Apát',
    short: 'Egyházi kerületenként aranyat vagy lapot kap; ha nem ő a leggazdagabb, kap 1 aranyat a leggazdagabbtól.',
    detail: 'Minden egyházi kerületed után választhatsz 1 aranyat vagy 1 lapot, tetszőleges kombinációban. Ha a köröd során nem vagy a legtöbb arannyal bíró játékosok között, a leggazdagabb játékosok egyikétől kapsz 1 aranyat.'
  },
  {
    id: 'cardinal', rank: 5, name: 'Bíboros',
    short: 'Egyházi kerületenként 1 lapot húz; építéshez hiányzó aranyat lapokért cserébe kérhet másik játékostól.',
    detail: 'Minden egyházi kerületed után 1 lapot húzhatsz. Ha egy kerület felépítéséhez nincs elég aranyad, a hiányzó aranyat elveheted egy másik játékostól, minden elvett aranyért 1 lapot adva neki, majd azonnal meg kell építened a kerületet.'
  },
  {
    id: 'merchant', rank: 6, name: 'Kereskedő',
    short: 'Kereskedelmi kerületenként 1 aranyat és ezen felül még 1 aranyat kap.',
    detail: 'Minden kereskedelmi kerületed után 1 aranyat kaphatsz. Ezen felül még 1 aranyat kapsz, függetlenül attól, milyen nyersanyagot gyűjtöttél.'
  },
  {
    id: 'alchemist', rank: 6, name: 'Alkimista',
    short: 'A kör végén visszakapja a kerületek megépítésére elköltött aranyát.',
    detail: 'A köröd végén visszakapod azt az aranyat, amit ebben a körben kerületek építési költségére fizettél ki. Más költségek, például kerülethatások vagy adó nem járnak vissza.'
  },
  {
    id: 'trader', rank: 6, name: 'Szatócs',
    short: 'Kereskedelmi kerületenként 1 aranyat kap; a kereskedelmi épületek nem számítanak az építési korlátba.',
    detail: 'Minden kereskedelmi kerületed után 1 aranyat kaphatsz. Ebben a körben a megépített kereskedelmi kerületek nem fogyasztják a normál építési korlátodat.'
  },
  {
    id: 'architect', rank: 7, name: 'Építész',
    short: '2 plusz lapot kap, és legfeljebb 3 kerületet építhet.',
    detail: 'Kapsz 2 plusz kerületlapot. Ebben a körben az építkezési korlátod 3 kerület.'
  },
  {
    id: 'navigator', rank: 7, name: 'Navigátor',
    short: '4 aranyat vagy 4 lapot kap, viszont ebben a körben nem építhet.',
    detail: 'Válassz 4 aranyat vagy 4 plusz kerületlapot. Ebben a körben semmilyen kerületet nem építhetsz.'
  },
  {
    id: 'scholar', rank: 7, name: 'Tudós',
    short: '7 lapból 1-et megtart, és ebben a körben legfeljebb 2 kerületet építhet.',
    detail: 'Húzz 7 kerületlapot, válassz közülük 1-et, a többit keverd vissza a pakliba. Ebben a körben az építkezési korlátod 2 kerület.'
  },
  {
    id: 'warlord', rank: 8, name: 'Hadúr',
    short: 'Katonai kerületenként 1 aranyat kap; egy kerületet 1 arannyal olcsóbban elpusztíthat.',
    detail: 'Minden katonai kerületed után 1 aranyat kaphatsz. Elpusztíthatsz egy kerületet az értékénél 1 arannyal olcsóbban. Befejezett város kerületét nem pusztíthatod el.'
  },
  {
    id: 'diplomat', rank: 8, name: 'Diplomata',
    short: 'Katonai kerületenként 1 aranyat kap; elcserélhet egy saját és egy ellenfél-kerületet.',
    detail: 'Minden katonai kerületed után 1 aranyat kaphatsz. Egy saját kerületedet elcserélheted egy másik játékos kerületére; ha az elvett kerület drágább, kifizeted a különbözetet. Befejezett városból nem vehetsz el kerületet, és duplikált kerületet sem hozhatsz létre.'
  },
  {
    id: 'marshal', rank: 8, name: 'Marsall',
    short: 'Katonai kerületenként 1 aranyat kap; legfeljebb 3 értékű ellenfél-kerületet megvásárolhat.',
    detail: 'Minden katonai kerületed után 1 aranyat kaphatsz. Legfeljebb 3 arany értékű kerületet elkobozhatsz egy másik játékos városából, a tulajdonosnak kifizetve a kerület árát. Befejezett városból és duplikációt okozva nem teheted.'
  },
  {
    id: 'queen', rank: 9, name: 'Királynő',
    short: 'Ha mellette ülő játékos 4-es rangú karaktert fed fel, 3 aranyat kap.',
    detail: 'Ha olyan játékos mellett ülsz, aki 4-es rangú karaktert fed fel, 3 aranyat kapsz. Ötnél kevesebb játékossal nem használható; ebben az alkalmazásban a 9-es rang 8 játékosnál kerül a karakterpakliba.'
  },
  {
    id: 'artist', rank: 9, name: 'Művész',
    short: 'Legfeljebb 2 saját kerületet megszépíthet, kerületenként 1 aranyért.',
    detail: 'Legfeljebb két még nem megszépített saját kerületre tehetsz 1-1 aranyat. A megszépített kerület értéke tartósan +1, így pontozásnál és a Hadúr rombolási költségénél is eggyel többet ér.'
  },
  {
    id: 'tax-collector', rank: 9, name: 'Adószedő',
    short: 'A játékosok építésenként 1 arany ingatlanadót fizetnek; az Adószedő a felgyűlt adót elveheti.',
    detail: 'Ha az Adószedő a karakterkészlet része, minden más karakter 1 arany adót fizet minden felépített kerület után, ha az építés után maradt aranya. Az adó a jelzőn marad körök között is. Az Adószedő a saját körében elveheti a teljes felgyűlt összeget.'
  }
]);

const DEFAULT_CHARACTER_IDS = Object.freeze([
  'assassin',
  'thief',
  'magician',
  'king',
  'bishop',
  'merchant',
  'architect',
  'warlord',
  'queen'
]);

const CHARACTER_MAP = new Map(CHARACTERS.map((c) => [c.id, c]));

function shuffle(array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function validateCharacterSelection(value) {
  const ids = Array.isArray(value) ? value.map(String) : [];
  if (ids.length !== 9 || new Set(ids).size !== 9) throw new Error('character_selection_count');
  for (let rank = 1; rank <= 9; rank += 1) {
    const character = CHARACTER_MAP.get(ids[rank - 1]);
    if (!character || character.rank !== rank) throw new Error('invalid_character_selection');
  }
  return ids;
}

function completionTarget(playerCount) {
  return Number(playerCount || 0) > 0 && Number(playerCount) <= 3 ? 8 : 7;
}

function validateCharactersForPlayerCount(playerCount, selectedCharacterIds = DEFAULT_CHARACTER_IDS) {
  const selected = validateCharacterSelection(selectedCharacterIds);
  if (playerCount < 2 || playerCount > 8) throw new Error('supported_player_count');
  if (playerCount === 2 && selected[3] === 'emperor') throw new Error('emperor_not_allowed_two_players');
  if (playerCount === 3 && selected[8] === 'queen') throw new Error('queen_not_allowed_under_five');
  return selected;
}

function inUseCharacters(playerCount, selectedCharacterIds = DEFAULT_CHARACTER_IDS) {
  const selected = validateCharactersForPlayerCount(playerCount, selectedCharacterIds);
  const maxRank = playerCount === 3 || playerCount === 8 ? 9 : 8;
  return selected.slice(0, maxRank).map((id) => CHARACTER_MAP.get(id));
}

function draftDiscardCounts(playerCount) {
  if (playerCount === 4) return { faceUp: 2, faceDown: 1 };
  if (playerCount === 5) return { faceUp: 1, faceDown: 1 };
  if (playerCount === 6 || playerCount === 7 || playerCount === 8) return { faceUp: 0, faceDown: 1 };
  throw new Error('supported_player_count');
}

function seatOrderFrom(players, firstPlayerId) {
  const ordered = [...players].sort((a, b) => a.seatIndex - b.seatIndex);
  const index = ordered.findIndex((p) => p.id === firstPlayerId);
  if (index < 0) throw new Error('first_player_missing');
  return [...ordered.slice(index), ...ordered.slice(0, index)].map((p) => p.id);
}

function initialFaceDown(pool) {
  let faceDownId = pool.shift();
  if (faceDownId === 'emperor' && pool.length) {
    const replacementIndex = crypto.randomInt(0, pool.length);
    faceDownId = pool[replacementIndex];
    pool.splice(replacementIndex, 1);
    pool.push('emperor');
    const reshuffled = shuffle(pool);
    pool.splice(0, pool.length, ...reshuffled);
  }
  return faceDownId;
}

function createDraft(players, crownPlayerId, selectedCharacterIds = DEFAULT_CHARACTER_IDS) {
  const playerCount = players.length;
  const characters = inUseCharacters(playerCount, selectedCharacterIds);
  const seatOrder = seatOrderFrom(players, crownPlayerId);
  let pool = shuffle(characters.map((character) => character.id));
  const faceDownId = initialFaceDown(pool);

  if (playerCount === 2) {
    return {
      mode: 'two-player',
      order: [seatOrder[0], seatOrder[1], seatOrder[0], seatOrder[1]],
      index: 0,
      available: pool,
      faceUpIds: [],
      faceDownId,
      discardedIds: [],
      finalDiscardId: null,
      choices: Object.fromEntries(seatOrder.map((playerId) => [playerId, []]))
    };
  }

  if (playerCount === 3) {
    return {
      mode: 'three-player',
      order: [...seatOrder, ...seatOrder],
      index: 0,
      available: pool,
      faceUpIds: [],
      faceDownId,
      discardedIds: [],
      finalDiscardId: null,
      choices: Object.fromEntries(seatOrder.map((playerId) => [playerId, []]))
    };
  }

  const counts = draftDiscardCounts(playerCount);
  const faceUpIds = [];
  for (let i = 0; i < counts.faceUp; i += 1) {
    const eligible = pool.filter((id) => CHARACTER_MAP.get(id).rank !== 4);
    const chosen = eligible[crypto.randomInt(0, eligible.length)];
    faceUpIds.push(chosen);
    pool = pool.filter((id) => id !== chosen);
  }

  return {
    mode: 'standard',
    order: seatOrder,
    index: 0,
    available: pool,
    faceUpIds,
    faceDownId,
    discardedIds: [],
    finalDiscardId: null,
    choices: Object.fromEntries(seatOrder.map((playerId) => [playerId, []]))
  };
}

function draftOptions(draft) {
  if (draft.mode === 'two-player' || draft.mode === 'three-player') return [...draft.available];
  const isLast = draft.index === draft.order.length - 1;
  if (isLast && draft.order.length >= 7) {
    return [...draft.available, draft.faceDownId].filter(Boolean);
  }
  return [...draft.available];
}

function draftDiscardRequired(draft) {
  return draft.mode === 'two-player' && draft.index > 0;
}

function chooseCharacter(draft, playerId, characterId, discardCharacterId = null) {
  if (draft.order[draft.index] !== playerId) throw new Error('not_current_drafter');
  const options = draftOptions(draft);
  if (!options.includes(characterId)) throw new Error('character_unavailable');

  if (!Array.isArray(draft.choices[playerId])) draft.choices[playerId] = [];
  draft.choices[playerId].push(characterId);

  if (draft.mode === 'two-player') {
    draft.available = draft.available.filter((id) => id !== characterId);

    if (draftDiscardRequired(draft)) {
      const discardId = String(discardCharacterId || '');
      if (!draft.available.includes(discardId)) throw new Error('discard_character_required');
      draft.available = draft.available.filter((id) => id !== discardId);
      draft.discardedIds.push(discardId);
    }

    const isLast = draft.index === draft.order.length - 1;
    if (isLast) return true;
    draft.index += 1;
    return false;
  }

  if (draft.mode === 'three-player') {
    draft.available = draft.available.filter((id) => id !== characterId);

    // Miután mindhárom játékos kiválasztotta az első karakterét,
    // a harmadik játékos véletlenszerűen eldob egyet az öt megmaradt lapból.
    if (draft.index === 2 && draft.available.length) {
      const discardIndex = crypto.randomInt(0, draft.available.length);
      const [discarded] = draft.available.splice(discardIndex, 1);
      draft.discardedIds.push(discarded);
    }

    const isLast = draft.index === draft.order.length - 1;
    if (isLast) {
      draft.finalDiscardId = draft.available[0] || null;
      draft.available = [];
      return true;
    }
    draft.index += 1;
    return false;
  }

  const choseFaceDown = characterId === draft.faceDownId;
  if (choseFaceDown) draft.faceDownId = null;
  else draft.available = draft.available.filter((id) => id !== characterId);

  const isLast = draft.index === draft.order.length - 1;
  if (isLast) {
    if (draft.available.length) draft.finalDiscardId = draft.available[0];
    else if (draft.faceDownId) draft.finalDiscardId = draft.faceDownId;
    draft.available = [];
    return true;
  }
  draft.index += 1;
  return false;
}

function turnOrderFromChoices(choices) {
  return Object.entries(choices)
    .flatMap(([playerId, value]) => {
      const characterIds = Array.isArray(value) ? value : [value];
      return characterIds.filter(Boolean).map((characterId) => ({
        playerId,
        characterId,
        rank: CHARACTER_MAP.get(characterId).rank
      }));
    })
    .sort((a, b) => a.rank - b.rank);
}

function scorePlayer(player, session) {
  const built = Array.isArray(player.built) ? player.built : [];
  const hand = Array.isArray(player.hand) ? player.hand : [];
  const has = (districtId) => built.some((district) => district.id === districtId);
  const districtPoints = built.reduce((sum, district) =>
    sum + Number(district.cost || 0) + (district.beautified ? 1 : 0), 0);
  const citySize = built.length + (has('monument') ? 1 : 0);

  let completionBonus = 0;
  const target = completionTarget(session.players?.length || session.playerCount || 0);
  if (citySize >= target) {
    completionBonus = session.firstCompletedPlayerId === player.id ? 4 : 2;
  }

  const hauntedChoices = has('haunted-quarter')
    ? ['unique', 'noble', 'religious', 'trade', 'military']
    : ['unique'];

  const candidates = hauntedChoices.map((hauntedQuarterType) => {
    const effectiveType = (district) =>
      district.id === 'haunted-quarter' ? hauntedQuarterType : district.type;
    const types = new Set(built.map(effectiveType));
    const diversityBonus = DISTRICT_TYPES.every((type) => types.has(type.id)) ? 3 : 0;
    const uniqueCount = built.filter((district) => effectiveType(district) === 'unique').length;

    let uniqueBonus = 0;
    if (has('dragon-gate')) uniqueBonus += 2;
    if (has('imperial-treasury')) uniqueBonus += Number(player.gold || 0);
    if (has('map-room')) uniqueBonus += hand.length;
    if (has('statue') && session.crownPlayerId === player.id) uniqueBonus += 5;

    if (has('basilica')) {
      uniqueBonus += built.filter((district) => Number(district.cost || 0) % 2 === 1).length;
    }

    if (has('capitol')) {
      const counts = new Map();
      for (const district of built) {
        const type = effectiveType(district);
        counts.set(type, (counts.get(type) || 0) + 1);
      }
      if ([...counts.values()].some((count) => count >= 3)) uniqueBonus += 3;
    }

    if (has('ivory-tower') && uniqueCount === 1) uniqueBonus += 5;
    if (has('wishing-well')) uniqueBonus += uniqueCount;
    if (hand.some((district) => district.id === 'secret-vault')) uniqueBonus += 3;

    const museum = built.find((district) => district.id === 'museum');
    if (museum) {
      uniqueBonus += Array.isArray(museum.storedCards)
        ? museum.storedCards.length
        : Number(museum.storedCardCount || 0);
    }

    return {
      hauntedQuarterType,
      diversityBonus,
      uniqueBonus,
      total: districtPoints + diversityBonus + completionBonus + uniqueBonus
    };
  });

  const best = candidates.reduce((winner, candidate) =>
    candidate.total > winner.total ? candidate : winner, candidates[0]);

  return {
    districtPoints,
    diversityBonus: best.diversityBonus,
    completionBonus,
    uniqueBonus: best.uniqueBonus,
    hauntedQuarterType: has('haunted-quarter') ? best.hauntedQuarterType : null,
    total: best.total
  };
}

module.exports = {
  DISTRICT_TYPES,
  CHARACTERS,
  CHARACTER_MAP,
  DEFAULT_CHARACTER_IDS,
  validateCharacterSelection,
  validateCharactersForPlayerCount,
  completionTarget,
  inUseCharacters,
  draftDiscardCounts,
  seatOrderFrom,
  createDraft,
  draftOptions,
  draftDiscardRequired,
  chooseCharacter,
  turnOrderFromChoices,
  scorePlayer
};
