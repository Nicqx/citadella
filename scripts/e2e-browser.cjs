'use strict';

// Real Chromium smoke test, against a local ephemeral Express server and
// in-memory Redis. The test cannot read or change live NUC game sessions.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { app, setRedisClientForTests } = require('../server');
const { memoryRedis } = require('../test/support/http-e2e-rig');

async function launchServer() {
  const store = memoryRedis();
  setRedisClientForTests(store);
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  return {
    store,
    server,
    origin: 'http://127.0.0.1:' + server.address().port
  };
}

async function room(page, name, bots) {
  await page.goto(page.origin + '/citadella/', { waitUntil: 'domcontentloaded' });
  await page.locator('#create-form input[name="name"]').fill(name);
  await page.locator('#create-form button[type="submit"]').click();
  await page.locator('#bot-form').waitFor({ state: 'visible' });
  await page.locator('#bot-form select[name="count"]').selectOption(String(bots));
  await page.locator('#bot-form button[type="submit"]').click();
  await page.waitForFunction((expected) =>
    document.querySelectorAll('.lobby-player-row').length === expected,
    bots + 1
  );
}

async function draftHumanFirst(page) {
  await page.locator('.draft-grid .character-option').first().waitFor();
  await page.locator('.draft-grid .character-option').first().click();
}

async function main() {
  const rig = await launchServer();
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox']
    });

    // 2-player mobile/browser UI: random-14, validation, help, both roles.
    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true, deviceScaleFactor: 2
    });
    const page = await mobile.newPage();
    page.origin = rig.origin;
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => dialog.accept());

    await room(page, 'Browser E2E two-player', 1);
    assert.equal(await page.locator('#character-config-form select[data-rank="4"] option[value="emperor"]').count(), 0,
      'Emperor must be absent in 2-player mode');

    await page.locator('#help-button').click();
    await page.locator('#help-dialog').waitFor({ state: 'visible' });
    // Text lives in collapsed <details>; textContent includes those panels.
    const help = await page.locator('#help-list').textContent();
    assert.ok(help.includes('Magisztrátus'));
    assert.ok(help.includes('Királynő'));
    assert.ok(help.includes('Adószedő'));
    await page.locator('#help-close').click();

    await page.locator('button[data-action="clear-unique"]').click();
    assert.equal(await page.locator('input[name="districtId"]:checked').count(), 0);
    assert.equal(await page.locator('#start-game-button').isDisabled(), true);
    await page.locator('button[data-action="random-unique"]').click();
    assert.equal(await page.locator('input[name="districtId"]:checked').count(), 14);
    assert.equal(await page.locator('#start-game-button').isEnabled(), true);

    await page.locator('#start-game-button').click();
    await draftHumanFirst(page);
    await page.locator('#draft-keep-character').waitFor({ state: 'visible' });
    assert.match(await page.locator('#app').innerText(), /1\/2/);

    // Install a Theater in the isolated fixture just before the final draft
    // choice. The completed draft must enter the private swap step, NOT turns.
    const theaterCode = page.url().split('/').filter(Boolean).at(-1);
    const theaterKey = 'citadella:session:' + theaterCode;
    const draftWithTheater = JSON.parse(rig.store.values.get(theaterKey));
    draftWithTheater.players[0].built.push({
      cardId: 'browser_theater', id: 'theater', name: 'Színház',
      type: 'unique', cost: 6, beautified: false
    });
    rig.store.values.set(theaterKey, JSON.stringify(draftWithTheater));

    await page.locator('button[data-action="choose-character-pair"]').click();
    await page.locator('button[data-action="theater-swap"]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#theater-own-role option').count(), 2);
    await page.locator('button[data-action="theater-swap"]').click();
    await page.locator('.city-progress').waitFor({ state: 'visible' });
    console.log('PASS: Chromium mobile Theater optional blind swap before first turn');
    await page.waitForFunction(() => document.querySelectorAll('.owned-role-chip').length === 2);
    assert.equal(await page.locator('.owned-role-chip').count(), 2);
    assert.ok((await page.locator('#app').innerText()).includes('2/2 karakter'));

    // Render all special building controls, then make real HTTP requests via
    // UI buttons against the isolated in-memory session.
    const specialCode = page.url().split('/').filter(Boolean).at(-1);
    const specialKey = 'citadella:session:' + specialCode;
    const special = JSON.parse(rig.store.values.get(specialKey));
    const specialOwner = special.players[0];
    const activeHumanIndex = special.turn.order.findIndex((entry) =>
      entry.playerId === specialOwner.id);
    assert.ok(activeHumanIndex >= 0);
    special.turn.index = activeHumanIndex;
    const activeHuman = special.turn.order[activeHumanIndex];
    if (activeHuman.characterId === 'navigator') activeHuman.characterId = 'architect';
    special.turn.action = {
      playerId: specialOwner.id, resourceGathered: true, builds: 0,
      incomeUsed: false, specialUsed: false, destructionUsed: false,
      districtUses: {}, pendingDraw: [], specialDraw: [],
      seerPendingPlayerIds: [], blackmailPending: false
    };
    specialOwner.built = [
      { cardId: 'browser_framework', id: 'framework', name: 'Állványzat', type: 'unique', cost: 3 },
      { cardId: 'browser_armory', id: 'armory', name: 'Fegyvertár', type: 'unique', cost: 3 },
      { cardId: 'browser_tavern', id: 'tavern', name: 'Kocsma', type: 'trade', cost: 1 }
    ];
    specialOwner.hand = [
      { cardId: 'browser_palace', id: 'palace', name: 'Palota', type: 'noble', cost: 5 },
      { cardId: 'browser_necropolis', id: 'necropolis', name: 'Temető', type: 'unique', cost: 5 },
      { cardId: 'browser_thieves', id: 'thieves-den', name: 'Tolvajtanya', type: 'unique', cost: 6 },
      ...Array.from({ length: 6 }, (_v, i) => ({
        cardId: 'browser_pay_' + i, id: 'pay_' + i,
        name: 'Fizetőlap ' + i, type: 'trade', cost: 1
      }))
    ];
    specialOwner.gold = 0;
    rig.store.values.set(specialKey, JSON.stringify(special));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('button[data-action="build-framework"][data-card="browser_palace"]').waitFor();
    assert.equal(await page.locator('button[data-action="build-necropolis-sacrifice"]').count(), 1);
    assert.equal(await page.locator('button[data-action="build-thieves-den"]').count(), 1);
    assert.equal(await page.locator('button[data-action="use-armory"]').count(), 1);
    await page.locator('button[data-action="build-framework"][data-card="browser_palace"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.district .name').length > 0);
    const afterFramework = JSON.parse(rig.store.values.get(specialKey));
    assert.ok(afterFramework.players[0].built.some((d) => d.id === 'palace'));
    assert.ok(!afterFramework.players[0].built.some((d) => d.id === 'framework'));

    await page.locator('#armory-target').selectOption('browser_tavern');
    await page.locator('button[data-action="use-armory"]').click();
    await page.waitForFunction(() => !document.querySelector('button[data-action="use-armory"]'));
    const afterArmory = JSON.parse(rig.store.values.get(specialKey));
    assert.ok(!afterArmory.players[0].built.some((d) => d.id === 'armory'));
    assert.ok(!afterArmory.players[0].built.some((d) => d.cardId === 'browser_tavern'));

    // Verify the actual browser reacts when server declares the final round.
    const code = page.url().split('/').filter(Boolean).at(-1);
    const key = 'citadella:session:' + code;
    const state = JSON.parse(rig.store.values.get(key));
    state.players[0].built = Array.from({ length: 8 }, (_v, i) => ({
      cardId: 'browser_district_' + i,
      id: 'browser_district_' + i,
      name: 'Browser kerület ' + i,
      type: 'trade',
      cost: 1,
      builtAtRound: state.round,
      beautified: false
    }));
    state.firstCompletedPlayerId = state.players[0].id;
    state.finalRound = true;
    rig.store.values.set(key, JSON.stringify(state));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.final-round-banner').waitFor({ state: 'visible' });
    const bannerText = await page.locator('.final-round-banner').innerText();
    assert.match(bannerText, /utolsó forduló/i);
    assert.match(bannerText, /8\/8 kerület/i);
    assert.deepEqual(errors, []);
    await mobile.close();
    console.log('PASS: Chromium mobile 2-player lobby, random-14, help, draft, 2/2 roles and final round');

    // 3-player desktop/browser UI: ninth role, two draft picks.
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page3 = await desktop.newPage();
    page3.origin = rig.origin;
    const errors3 = [];
    page3.on('pageerror', (error) => errors3.push(error.message));
    await room(page3, 'Browser E2E three-player', 2);
    assert.equal(await page3.locator('#character-config-form select[data-rank="9"] option[value="queen"]').count(), 0,
      'Queen must be absent in 3-player setup');
    const ninth = page3.locator('#character-config-form select[data-rank="9"]');
    assert.ok(['artist', 'tax-collector'].includes(await ninth.inputValue()));

    await page3.locator('#start-game-button').click();
    await draftHumanFirst(page3);
    await draftHumanFirst(page3);
    await page3.waitForFunction(() => document.querySelectorAll('.owned-role-chip').length === 2);
    assert.equal(await page3.locator('.owned-role-chip').count(), 2);
    assert.ok((await page3.locator('#app').innerText()).includes('2/2 karakter'));
    assert.deepEqual(errors3, []);
    await desktop.close();
    console.log('PASS: Chromium desktop 3-player variant restriction, bot draft and 2/2 roles');

    // 4-player 9-character optional setup, including browser -> API ->
    // persisted draft. Rank nine must not offer Queen below five players.
    const four = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page4 = await four.newPage();
    page4.origin = rig.origin;
    const errors4 = [];
    page4.on('pageerror', (error) => errors4.push(error.message));
    await room(page4, 'Browser E2E four players nine roles', 3);
    assert.equal(await page4.locator('#character-count').inputValue(), '8');
    assert.equal(
      await page4.locator('#character-config-form select[data-rank="9"] option[value="queen"]').count(),
      0, 'Queen cannot be chosen in 4-player games'
    );
    await page4.locator('#character-count').selectOption('9');
    await page4.locator('#start-game-button').click();
    await page4.locator('.draft-grid .character-option').first().waitFor();
    const fourCode = page4.url().split('/').filter(Boolean).at(-1);
    const fourKey = 'citadella:session:' + fourCode;
    const fourDraft = JSON.parse(rig.store.values.get(fourKey));
    assert.equal(fourDraft.useNinthCharacter, true);
    assert.equal(fourDraft.draft.faceUpIds.length, 3);
    assert.notEqual(fourDraft.selectedCharacterIds[8], 'queen');
    assert.equal(await page4.locator('.draft-grid .character-option').count(), 5);
    await page4.locator('.draft-grid .character-option').first().click();
    await page4.locator('.city-progress').waitFor({ state: 'visible' });
    const fourStarted = JSON.parse(rig.store.values.get(fourKey));
    assert.equal(fourStarted.players.length, 4);
    assert.equal(fourStarted.turn.order.length, 4);
    assert.equal(fourStarted.players.reduce((sum, p) => sum + p.characterIds.length, 0), 4);
    assert.deepEqual(errors4, []);
    await four.close();
    console.log('PASS: Chromium desktop 4-player optional ninth character, hidden draft and bot round');
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve, reject) =>
      rig.server.close((error) => error ? reject(error) : resolve()));
  }
}

main().catch((error) => {
  console.error('FAIL: Chromium browser E2E:', error);
  process.exitCode = 1;
});
