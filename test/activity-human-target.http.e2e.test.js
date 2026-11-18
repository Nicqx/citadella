'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openRig, seedTurn } = require('./support/http-e2e-rig');

for (const role of ['assassin', 'thief']) {
  test('human ' + role + ' publicly reports target after turn end', async (t) => {
    const h = await openRig(t);
    seedTurn(h, role, { opponentRole: 'king' });
    h.mutate((session) => {
      session.turn.action.activitySnapshot = session.players.map((player) => ({
        id: player.id, name: player.name, gold: player.gold,
        handCount: player.hand.length,
        built: player.built.map((district) => ({
          cardId: district.cardId, name: district.name
        }))
      }));
    });
    await h.post('/turn/ability', {
      action: 'target-character', targetCharacterId: 'king'
    });
    const before = await h.get(1);
    assert.equal((before.activityLog || []).length, 0,
      'human targets must wait until the character turn is ended');
    await h.post('/turn/end');
    const after = await h.get(1);
    const entry = after.activityLog.find((item) =>
      item.playerId === h.auth[0].playerId);
    assert.ok(entry, 'opponent can read human turn summary');
    assert.match(entry.messages.join(' '), /Király/);
    assert.match(entry.messages.join(' '), role === 'assassin' ? /Orgyilkos/ : /Tolvaj/);
  });
}
