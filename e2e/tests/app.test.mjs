import { test as rawTest, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { remote } from 'webdriverio';

// On failure, dump the live accessibility tree and a screenshot so a CI run that fails can be
// diagnosed from its uploaded artifacts instead of guessing blind.
let testIndex = 0;
function test(name, fn) {
  rawTest(name, async (t) => {
    testIndex++;
    try {
      await fn(t);
    } catch (err) {
      try { fs.writeFileSync(`debug-${testIndex}.xml`, await driver.getPageSource()); } catch {}
      try { fs.writeFileSync(`debug-${testIndex}.png`, Buffer.from(await driver.takeScreenshot(), 'base64')); } catch {}
      throw err;
    }
  });
}

const APP_PACKAGE = 'org.truship.milkledger';
const WAIT = 10000;

let driver;
let monthName; // e.g. "November", read from the app itself so the suite works on any date

const byText = (text) => driver.$(`android=new UiSelector().text(${JSON.stringify(text)})`);
const byTextContains = (text) => driver.$(`android=new UiSelector().textContains(${JSON.stringify(text)})`);
// "1 litre" / "½ litre" also appear as plain labels in the bill section, so an exact-text
// match is ambiguous — the tab itself reads "1 litre ₹70 per day", scope to the tab strip.
const tabButton = (label) => driver.$(`//android.widget.TabWidget//*[starts-with(@text,${JSON.stringify(label)})]`);

// isExisting() checks once with no retry, unlike click()/setValue() which wait for their target.
// These wrap the same retrying wait WebdriverIO already uses elsewhere, so a still-settling
// render doesn't read as "not there yet".
async function appears(elPromise, timeout = WAIT) {
  const el = await elPromise;
  try { await el.waitForExist({ timeout }); return true; } catch { return false; }
}
async function disappears(elPromise, timeout = WAIT) {
  const el = await elPromise;
  try { await el.waitForExist({ timeout, reverse: true }); return true; } catch { return false; }
}

// The app's text inputs live inside the WebView, so UiAutomator2's setValue() only updates its
// own accessibility-tree cache, not the real DOM value the app reads on submit. Typing through
// adb (real IME key events) reaches the actual input. Blurring by tapping the dialog's own title
// (rather than pressing BACK) avoids closing the whole dialog on emulators with no on-screen
// keyboard to consume the back-press.
async function typeInto(el, text) {
  await el.click();
  await driver.pause(200);
  execSync(`adb shell input text ${JSON.stringify(text.replace(/ /g, '%s'))}`);
  await driver.pause(200);
  await (await driver.$('//android.app.Dialog//android.widget.TextView[@text="Settings"]')).click();
  await driver.pause(300);
}

before(async () => {
  execSync(`adb shell pm clear ${APP_PACKAGE}`);
  driver = await remote({
    hostname: '127.0.0.1',
    port: 4723,
    path: '/wd/hub',
    logLevel: 'warn',
    capabilities: {
      platformName: 'Android',
      'appium:automationName': 'UiAutomator2',
      'appium:appPackage': APP_PACKAGE,
      'appium:appActivity': '.MainActivity',
      'appium:noReset': true,
      'appium:newCommandTimeout': 180,
    },
  });
});

after(async () => {
  await driver?.deleteSession();
});

test('shows the sign-in screen and opens the ledger', async () => {
  assert.equal(await appears(byText('Open ledger')), true);
  await (await byText('Open ledger')).click();

  // monthLabel reads like "November 2026" — pull the month name out so later
  // tests can address "today" regardless of which month this actually runs in.
  let label;
  await driver.waitUntil(async () => {
    const textViews = await driver.$$('android.widget.TextView');
    for (const el of textViews) {
      const t = await el.getText();
      if (/^[A-Za-z]+ \d{4}$/.test(t)) { label = t; return true; }
    }
    return false;
  }, { timeout: WAIT, timeoutMsg: 'month label (e.g. "November 2026") never appeared' });
  [monthName] = label.split(' ');
});

test('prompts to add the milk seller before any UPI ID is set', async () => {
  assert.equal(await appears(byTextContains('Add your milk seller')), true);
});

test('saves seller name, UPI ID and rates from Settings', async () => {
  await (await byText('Settings')).click();
  assert.equal(await appears(driver.$('android=new UiSelector().className("android.app.Dialog").text("Settings")')), true);

  const edits = await driver.$$('//android.app.Dialog//android.widget.EditText');
  assert.equal(edits.length, 4, 'expected Name, UPI ID, rate-one and rate-half fields');
  await typeInto(edits[0], 'Raju');
  await typeInto(edits[1], 'raju@okaxis');

  await (await byText('Save')).click();
  assert.equal(await disappears(byTextContains('Add your milk seller')), true);
});

test('marking day 1 as received adds it to the bill at the 1-litre rate', async () => {
  await (await byText(`${monthName} 1, not marked`)).click();
  assert.equal(await appears(byText(`${monthName} 1, received`)), true);
  // The tab label always shows "₹70 per day" regardless of marks, so check the bill's litre
  // total instead — "0 L" unmarked, "1 L" once day 1 is the month's only marked day.
  assert.equal(await appears(byTextContains('1 L')), true);
});

test('tapping the same day again marks it not received and zeroes the bill', async () => {
  await (await byText(`${monthName} 1, received`)).click();
  assert.equal(await appears(byText(`${monthName} 1, not received`)), true);
  assert.equal(await appears(byTextContains('0 L')), true);
});

test('tapping a third time clears the day back to not marked', async () => {
  await (await byText(`${monthName} 1, not received`)).click();
  assert.equal(await appears(byText(`${monthName} 1, not marked`)), true);
});

test('the half-litre tab tracks day 1 independently of the 1-litre tab', async () => {
  await (await tabButton('½ litre')).click();
  await (await byText(`${monthName} 1, not marked`)).click();
  assert.equal(await appears(byText(`${monthName} 1, received`)), true);
  assert.equal(await appears(byTextContains('0.5 L')), true, 'the half-litre day should count towards the month\'s total litres');

  await (await tabButton('1 litre')).click();
  assert.equal(await appears(byText(`${monthName} 1, not marked`)), true, 'the 1-litre tab should still show day 1 as unmarked');
});
