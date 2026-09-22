import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from '@playwright/test';

test('installed browser SDK uses real multiplayer admission, buy-in and optional payment overlays', { timeout: 60000 }, async () => {
  const child = spawn(process.execPath, ['examples/local-multiplayer-approval.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Example startup timed out: ' + stderr)), 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Example exited ' + code + ': ' + stderr)); });
    child.stdout.on('data', data => {
      output += data;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/players\/[a-z0-9-]+#cap=[a-zA-Z0-9_-]{43}/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
  }).catch(error => { child.kill(); throw error; });
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.status() >= 400) errors.push(response.status() + ' ' + response.url()); });
    await page.goto(url);
    const frame = page.frameLocator('iframe');
    await frame.getByRole('button', { name: 'Sit with 10 LOCAL' }).click();
    await page.getByText('Simulated Spawn Test Token', { exact: true }).waitFor();
    await page.getByRole('button', { name: /^Approve/ }).click();
    await frame.getByText('Buy-in confirmed', { exact: true }).waitFor();
    await frame.getByRole('button', { name: 'Buy item for 0.25 LOCAL' }).click();
    await page.getByRole('button', { name: 'Confirm · spend 0.25 LOCAL', exact: true }).click();
    await page.getByRole('button', { name: /Continue/ }).click();
    await frame.getByText('Payment paid', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no mobile horizontal overflow');
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
  }
});
