import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFakeChromeCDPServer } from './support/fake-cdp.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(TEST_DIR);
const CDP_CLI = join(REPO_ROOT, 'skills/chrome-cdp/scripts/cdp.mjs');

test('open uses selected primary browser descriptor wsUrl', async () => {
  const tempDir = await mkdtemp(join(shortTmpRoot(), 'cdp-open-primary-descriptor-'));

  await withChromeAndBrave(async ({ chrome, brave, braveEnv }) => {
    chrome.writeDevToolsActivePort(linuxProfilePortFile(tempDir, 'google-chrome'));
    brave.writeDevToolsActivePort(linuxProfilePortFile(tempDir, 'BraveSoftware/Brave-Browser'));

    const result = await runCdp(['open', 'https://opened-in-brave.test/'], {
      tempDir,
      env: braveEnv,
    });

    assertCdpOk(result);
    assert.deepEqual(commandMethods(brave), ['Target.createTarget', 'Target.getTargets']);
    assertNoContact(chrome);
    const cache = await readPagesCache(tempDir);
    const browser = cache.browsers[cache.primaryBrowserKey];
    assert.equal(browser.browserId, 'brave');
    assert.equal(browser.wsUrl, brave.wsUrl);
    assert.equal(cache.pages.some(page => page.url === 'https://opened-in-brave.test/'), true);
  });
});

test('page command uses cached primary browser descriptor wsUrl after list', async () => {
  const tempDir = await mkdtemp(join(shortTmpRoot(), 'cdp-page-primary-descriptor-'));
  const targetId = 'brave-primary-0001';

  await withChromeAndBrave({
    chromeTargets: [fakePage('chrome-alternate-0001', 'Alternate Chrome Page', 'https://alternate-chrome.test/')],
    braveTargets: [fakePage(targetId, 'Primary Brave Page', 'https://primary-brave.test/')],
  }, async ({ chrome, brave, chromeEnv, braveEnv }) => {
    chrome.writeDevToolsActivePort(linuxProfilePortFile(tempDir, 'google-chrome'));
    brave.writeDevToolsActivePort(linuxProfilePortFile(tempDir, 'BraveSoftware/Brave-Browser'));

    assertCdpOk(await runCdp(['list'], { tempDir, env: braveEnv }));
    assertCdpOk(await runCdp(['eval', targetId, '42'], { tempDir, env: chromeEnv }));

    assert.deepEqual(commandMethods(brave), [
      'Target.getTargets',
      'Target.attachToTarget',
      'Runtime.enable',
      'Runtime.evaluate',
    ]);
    assertNoContact(chrome);
  }, async ({ chromeEnv }) => {
    await ignoreFailure(runCdp(['stop', targetId], { tempDir, env: chromeEnv }));
  });
});

async function withChromeAndBrave(optionsOrCallback, maybeCallback, maybeFinallyCallback) {
  const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
  const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
  const finallyCallback = typeof optionsOrCallback === 'function' ? maybeCallback : maybeFinallyCallback;
  const chrome = await createFakeChromeCDPServer({
    targets: options.chromeTargets || [fakePage('chrome-primary-0001', 'Chrome Page', 'https://chrome.test/')],
  }).start();
  const brave = await createFakeChromeCDPServer({
    targets: options.braveTargets || [fakePage('brave-primary-0001', 'Brave Page', 'https://brave.test/')],
  }).start();
  const context = {
    chrome,
    brave,
    chromeEnv: { CDP_BROWSER: 'chrome', CDP_HOST: chrome.host },
    braveEnv: { CDP_BROWSER: 'brave', CDP_HOST: brave.host },
  };
  try {
    return await callback(context);
  } finally {
    await finallyCallback?.(context);
    await brave.stop();
    await chrome.stop();
  }
}

function fakePage(targetId, title, url) {
  return { targetId, title, url };
}

function shortTmpRoot() {
  return process.platform === 'win32' ? tmpdir() : '/tmp';
}

function linuxProfilePortFile(tempDir, profile) {
  return join(tempDir, 'home/.config', profile, 'DevToolsActivePort');
}

async function readPagesCache(tempDir) {
  return JSON.parse(await readFile(join(tempDir, 'runtime/cdp/pages.json'), 'utf8'));
}

function commandMethods(server) {
  return server.commandLog.map(message => message.method);
}

function assertCdpOk(result) {
  assert.equal(result.code, 0, result.stderr);
}

function assertNoContact(server) {
  assert.equal(server.connectionLog.length, 0, 'unexpected WebSocket connection');
  assert.equal(server.commandLog.length, 0, 'unexpected CDP commands');
}

async function ignoreFailure(promise) {
  try { await promise; } catch {}
}

function runCdp(args, { tempDir, env: overrides = {} }) {
  return new Promise((resolve, reject) => {
    const childEnv = makeCleanEnv(tempDir, overrides);
    execFile(process.execPath, [CDP_CLI, ...args], { env: childEnv, timeout: 10000 }, (error, stdout, stderr) => {
      if (error?.killed || error?.signal) {
        reject(error);
        return;
      }
      resolve({
        code: error?.code ?? 0,
        stdout,
        stderr,
      });
    });
  });
}

function makeCleanEnv(tempDir, overrides) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('CDP_')) delete env[key];
  }
  env.HOME = join(tempDir, 'home');
  env.XDG_RUNTIME_DIR = join(tempDir, 'runtime');
  env.LOCALAPPDATA = join(tempDir, 'localappdata');
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}
