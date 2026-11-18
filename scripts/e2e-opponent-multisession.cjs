'use strict';

// Three independent Chromium sessions. All user turns use real HTTP actions
// from the browser; only initial turn setup is a deterministic in-memory fixture.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { app, setRedisClientForTests } = require('../server');
const { memoryRedis } = require('../test/support/http-e2e-rig');
const { createDistrictDeck, DEFAULT_UNIQUE_DISTRICT_IDS } = require('../districts');

async function main() {
  const store = memoryRedis();
  setRedisClientForTests(store);
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const origin = 'http://127.0.0.1:' + server.address().port;
    const contexts = await Promise.all([
      browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true }),
      browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true }),
      browser.newContext({ viewport: { width: 1280, height: 800 } })
    ]);
    const pages = await Promise.all(contexts.map((ctx) => ctx.newPage()));
    const errors = [];
    pages.forEach((page, i) => {
      page.on('pageerror', (err) => errors.push('page ' + i + ': ' + err.message));
    });
    const [watcher, second, third] = pages;

    await watcher.goto(origin + '/citadella/');
    await watcher.locator('#create-form input[name="name"]').fill('Megfigyelő');
    await watcher.locator('#create-form button[type="submit"]').click();
    await watcher.locator('#bot-form').waitFor();
    const code = watcher.url().split('/').filter(Boolean).at(-1);
    assert.match(code, /^\d{5}$/);

    for (const [page, name] of [[second, 'Második játékos'], [third, 'Harmadik játékos']]) {
      await page.goto(origin + '/citadella/' + code);
      await page.locator('#join-form input[name="name"]').fill(name);
      await page.locator('#join-form input[name="code"]').fill(code);
      await page.locator('#join-form button[type="submit"]').click();
      await page.locator('.lobby-player-row').first().waitFor();
    }

    // Start from a known character-turn state. This deliberately bypasses only
    // the unrelated randomized draft, NOT resource or turn-end HTTP handlers.
    const key = 'citadella:session:' + code;
    const session = JSON.parse(store.values.get(key));
    assert.equal(session.players.length, 3);
    const [a, b, c] = session.players;
    const roles = ['king', 'assassin', 'thief'];
    session.players.forEach((player, i) => {
      player.characterIds = [roles[i]];
      player.characterId = roles[i];
      player.gold = 2;
      player.hand = [];
      player.built = [];
    });
    session.phase = 'turns';
    session.round = 1;
    session.gameEpoch = 1;
    session.activityLog = [];
    session.activitySeq = 0;
    session.draft = null;
    session.roundEffects = {};
    session.roundFaceUpCharacterIds = [];
    session.firstCompletedPlayerId = null;
    session.finalRound = false;
    session.districtDeck = createDistrictDeck(DEFAULT_UNIQUE_DISTRICT_IDS);
    session.turn = {
      order: [
        { playerId: b.id, characterId: 'assassin', rank: 1 },
        { playerId: c.id, characterId: 'thief', rank: 2 },
        { playerId: a.id, characterId: 'king', rank: 4 }
      ],
      index: 0,
      revealedPlayerIds: [b.id],
      revealedCharacterIds: ['assassin'],
      skippedPlayerIds: [],
      action: {
        playerId: b.id,
        resourceGathered: false,
        builds: 0,
        incomeUsed: false,
        specialUsed: false,
        destructionUsed: false,
        districtUses: {},
        pendingDraw: [],
        specialDraw: [],
        inspectedHand: [],
        inspectedPlayerId: null,
        seerPendingPlayerIds: [],
        buildGoldSpent: 0,
        artistUses: 0,
        blackmailPending: false,
        activitySnapshot: session.players.map((player) => ({
          id: player.id, name: player.name, gold: player.gold,
          handCount: player.hand.length, built: []
        }))
      }
    };
    store.values.set(key, JSON.stringify(session));
    await Promise.all(pages.map((page) => page.reload({ waitUntil: 'domcontentloaded' })));

    await second.locator('button[data-action="take-resource"][data-mode="gold"]').click();
    await second.locator('button[data-action="end-turn"]').click();
    await watcher.locator('#activity-dialog').waitFor({ state: 'visible' });
    assert.match(await watcher.locator('#activity-dialog').innerText(), /Második játékos/);
    assert.match(await watcher.locator('#activity-dialog').innerText(), /arany/i);
    assert.equal(await watcher.locator('#activity-dialog .activity-group').count(), 1);
    console.log('PASS: second human ends real turn, observer sees dialog');

    await third.locator('button[data-action="take-resource"][data-mode="gold"]').waitFor();
    await third.locator('button[data-action="take-resource"][data-mode="gold"]').click();
    await third.locator('button[data-action="end-turn"]').click();
    await watcher.waitForFunction(() => {
      const dialog = document.getElementById('activity-dialog');
      return dialog?.open && dialog.textContent.includes('Harmadik játékos');
    });
    const summary = await watcher.locator('#activity-dialog').innerText();
    assert.match(summary, /Második játékos/);
    assert.match(summary, /Harmadik játékos/);
    assert.equal(await watcher.locator('#activity-dialog .activity-group').count(), 2);
    assert.equal(await watcher.locator('#activity-dialog .activity-entry').count(), 2);
    assert.equal(await watcher.locator('#activity-dialog').count(), 1);
    console.log('PASS: two real human turns consolidate in existing unacknowledged dialog');

    await watcher.locator('#activity-ack').click();
    await watcher.locator('#activity-dialog').waitFor({ state: 'hidden' });
    await watcher.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(await watcher.locator('#activity-dialog').isVisible(), false);
    console.log('PASS: acknowledged real turn summaries stay dismissed after reload');

    const saved = JSON.parse(store.values.get(key));
    assert.deepEqual(saved.activityLog.filter((entry) => !entry.isBot).map((entry) => entry.playerId), [b.id, c.id]);
    assert.deepEqual(errors, []);
    console.log('PASS: PR20 THREE-SESSION REAL-TURN CHROMIUM E2E');
    await Promise.all(contexts.map((ctx) => ctx.close()));
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

main().catch((error) => {
  console.error('FAIL: PR20 THREE-SESSION REAL-TURN CHROMIUM E2E:', error);
  process.exitCode = 1;
});
