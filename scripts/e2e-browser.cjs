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

    await room(page, 'Browser E2E two-player', 1);
    assert.equal(await page.locator('#character-config-form select[data-rank="4"] option[value="emperor"]').count(), 0,
      'Emperor must be absent in 2-player mode');

    await page.locator('#help-button').click();
    await page.locator('#help-dialog').waitFor({ state: 'visible' });
    const help = await page.locator('#help-list').innerText();
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
    await page.locator('button[data-action="choose-character-pair"]').click();
    await page.locator('.owned-role-chip').first().waitFor();
    assert.equal(await page.locator('.owned-role-chip').count(), 2);
    assert.ok((await page.locator('#app').innerText()).includes('2/2 karakter'));

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
    assert.ok((await page.locator('.final-round-banner').innerText()).includes('Utolsó forduló'));
    assert.ok((await page.locator('.final-round-banner').innerText()).includes('8/8 kerület'));
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
    await page3.locator('.owned-role-chip').first().waitFor();
    assert.equal(await page3.locator('.owned-role-chip').count(), 2);
    assert.ok((await page3.locator('#app').innerText()).includes('2/2 karakter'));
    assert.deepEqual(errors3, []);
    await desktop.close();
    console.log('PASS: Chromium desktop 3-player variant restriction, bot draft and 2/2 roles');
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
