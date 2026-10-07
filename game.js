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
    short: 'Nevezz meg egy másik karaktert: az a karakter kihagyja az egész körét.',
    detail: 'Jelents be egy másik karaktert, akit meg szeretnél gyilkolni. A játékos, akinél ez a karakter van, nem fedheti fel magát, amikor szólítják, és kihagyja az egész körét.'
  },
  {
    id: 'thief', rank: 2, name: 'Tolvaj',
    short: 'Nevezz meg egy karaktert; amikor sorra kerül, elveszed az összes aranyát.',
    detail: 'Nem választhatsz 1-es rangú karaktert, illetve olyan karaktert, akit az Orgyilkos már célba vett. Amikor a kiválasztott karakter sorra kerül, elveszed az összes aranyát.'
  },
  {
    id: 'magician', rank: 3, name: 'Mágus',
    short: 'Cseréld el a teljes kezed valakivel, vagy dobj el tetszőleges számú lapot és húzz ugyanannyit.',
    detail: 'Két lehetőség közül választhatsz: a teljes kézben tartott kerületlap-készletedet elcseréled egy másik játékoséval; vagy tetszőleges számú lapot a pakli aljára teszel, és ugyanannyit húzol helyettük.'
  },
  {
    id: 'king', rank: 4, name: 'Király',
    short: 'Nemesi kerületenként 1 aranyat kapsz, és a köröd során átveszed a koronát.',
    detail: 'Minden nemesi kerületed után 1 aranyat kaphatsz. A köröd során átveszed a koronát, így a következő kiválasztási fázisban te választasz először karaktert.'
  },
  {
    id: 'bishop', rank: 5, name: 'Püspök',
    short: 'Egyházi kerületenként 1 aranyat kapsz; a 8-as rangú karakter nem támadhatja a kerületeidet ebben a körben.',
    detail: 'Minden egyházi kerületed után 1 aranyat kaphatsz. Ebben a körben a 8-as rangú karakter (például a Hadúr) nem használhatja a kerületeiden a karakterképességét.'
  },
  {
    id: 'merchant', rank: 6, name: 'Kereskedő',
    short: 'Kereskedelmi kerületenként 1 aranyat és ezen felül még 1 aranyat kapsz.',
    detail: 'Minden kereskedelmi kerületed után 1 aranyat kaphatsz. Ezen felül még 1 aranyat kapsz, függetlenül attól, hogy a köröd elején milyen nyersanyagot választottál.'
  },
  {
    id: 'architect', rank: 7, name: 'Építész',
    short: '2 plusz kerületlapot kapsz, és ebben a körben legfeljebb 3 kerületet építhetsz.',
    detail: 'Kapsz 2 plusz kerületlapot. Ebben a körben az építkezési korlátod 3 kerület.'
  },
  {
    id: 'warlord', rank: 8, name: 'Hadúr',
    short: 'Katonai kerületenként 1 aranyat kapsz; egy kerületet az értékénél 1 arannyal olcsóbban elpusztíthatsz.',
    detail: 'Minden katonai kerületed után 1 aranyat kaphatsz. Elpusztíthatsz egy kerületet: ez az építési költségénél 1 arannyal kevesebbe kerül. Befejezett város kerületét nem pusztíthatod el.'
  },
  {
    id: 'queen', rank: 9, name: 'Királynő',
    short: 'Ha egy melletted ülő játékos 4-es rangú karaktert fed fel, 3 aranyat kapsz.',
    detail: 'Ha olyan játékos mellett ülsz, aki 4-es rangú karaktert fedett fel, 3 aranyat kapsz. Nyolc játékosnál ezt a karaktert használjuk kilencedik karakterként.'
  }
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

function inUseCharacters(playerCount) {
  if (playerCount < 4 || playerCount > 8) {
    throw new Error('supported_player_count');
  }
  return CHARACTERS.filter((c) => c.rank <= (playerCount === 8 ? 9 : 8));
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

function createDraft(players, crownPlayerId) {
  const playerCount = players.length;
  const characters = inUseCharacters(playerCount);
  const counts = draftDiscardCounts(playerCount);
  let pool = shuffle(characters.map((c) => c.id));

  const faceDownId = pool.shift();
  const faceUpIds = [];
  for (let i = 0; i < counts.faceUp; i += 1) {
    const eligible = pool.filter((id) => CHARACTER_MAP.get(id).rank !== 4);
    const chosen = eligible[crypto.randomInt(0, eligible.length)];
    faceUpIds.push(chosen);
    pool = pool.filter((id) => id !== chosen);
  }

  return {
    order: seatOrderFrom(players, crownPlayerId),
    index: 0,
    available: pool,
    faceUpIds,
    faceDownId,
    finalDiscardId: null,
    choices: {}
  };
}

function draftOptions(draft) {
  const isLast = draft.index === draft.order.length - 1;
  if (isLast && draft.order.length >= 7) {
    return [...draft.available, draft.faceDownId].filter(Boolean);
  }
  return [...draft.available];
}

function chooseCharacter(draft, playerId, characterId) {
  if (draft.order[draft.index] !== playerId) throw new Error('not_current_drafter');
  const options = draftOptions(draft);
  if (!options.includes(characterId)) throw new Error('character_unavailable');

  draft.choices[playerId] = characterId;
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
    .map(([playerId, characterId]) => ({ playerId, characterId, rank: CHARACTER_MAP.get(characterId).rank }))
    .sort((a, b) => a.rank - b.rank);
}

function scorePlayer(player, session) {
  const districtPoints = player.built.reduce((sum, d) => sum + Number(d.cost || 0) + (d.beautified ? 1 : 0), 0);
  const types = new Set(player.built.map((d) => d.type));
  const diversityBonus = DISTRICT_TYPES.every((t) => types.has(t.id)) ? 3 : 0;
  let completionBonus = 0;
  if (player.built.length >= 7) {
    completionBonus = session.firstCompletedPlayerId === player.id ? 4 : 2;
  }
  const manualBonus = Number(player.manualBonus || 0);
  const total = districtPoints + diversityBonus + completionBonus + manualBonus;
  return { districtPoints, diversityBonus, completionBonus, manualBonus, total };
}

module.exports = {
  DISTRICT_TYPES,
  CHARACTERS,
  CHARACTER_MAP,
  inUseCharacters,
  draftDiscardCounts,
  seatOrderFrom,
  createDraft,
  draftOptions,
  chooseCharacter,
  turnOrderFromChoices,
  scorePlayer
};
