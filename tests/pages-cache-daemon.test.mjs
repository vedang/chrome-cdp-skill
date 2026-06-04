import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createFakeChromeCDPServer,
  createFakeLightpandaCDPServer,
} from './support/fake-cdp.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(TEST_DIR);
const CDP_CLI = join(REPO_ROOT, 'skills/chrome-cdp/scripts/cdp.mjs');

test('list writes browser-aware v2 pages cache with browser metadata', async () => {
  const tempDir = await mkdtemp(join(shortTmpRoot(), 'cdp-v2-cache-'));
  const targetId = 'cache-target-0001';

  await createFakeLightpandaCDPServer({
    targets: [fakePage(targetId, 'Cache Metadata Page', 'https://cache-metadata.test/')],
  }).using(async (server) => {
    const result = await runCdp(['list'], {
      tempDir,
      env: { CDP_BROWSER: 'lightpanda', CDP_LIGHTPANDA_URL: server.httpUrl },
    });

    assertCdpOk(result);
    const cache = await readPagesCache(tempDir);
    const [page] = cache.pages;
    const browser = cache.browsers[cache.primaryBrowserKey];

    assert.equal(cache.version, 2);
    assert.equal(cache.primaryBrowserKey, page.browserKey);
    assert.deepEqual(Object.keys(cache.browsers), [page.browserKey]);
    assert.equal(cache.pages.length, 1);
    assert.equal(page.browserKey, cache.primaryBrowserKey);
    assert.equal(page.browserId, 'lightpanda');
    assert.equal(page.browserKind, 'lightpanda');
    assert.equal(page.targetId, targetId);
    assert.equal(page.title, 'Cache Metadata Page');
    assert.equal(page.url, 'https://cache-metadata.test/');
    assert.equal(browser.browserId, 'lightpanda');
    assert.equal(browser.browserKind, 'lightpanda');
    assert.match(browser.wsUrl, /^ws:\/\//);
    assert.equal(browser.source, 'CDP_LIGHTPANDA_URL');
  });
});

test('browser keys remain stable for the same Chrome-family endpoint', async () => {
  const tempDir = await mkdtemp(join(shortTmpRoot(), 'cdp-stable-browser-key-'));
  const targetId = 'stable-key-target-0001';

  await createFakeChromeCDPServer({
    targets: [fakePage(targetId, 'Stable Key Page', 'https://stable-key.test/')],
  }).using(async (server) => {
    const portFile = join(tempDir, 'chrome/DevToolsActivePort');
    server.writeDevToolsActivePort(portFile);
    const env = { CDP_PORT_FILE: portFile, CDP_HOST: server.host };

    assertCdpOk(await runCdp(['list'], { tempDir, env }));
    const firstCache = await readPagesCache(tempDir);
    assertCdpOk(await runCdp(['list'], { tempDir, env }));
    const secondCache = await readPagesCache(tempDir);

    assert.equal(firstCache.primaryBrowserKey, secondCache.primaryBrowserKey);
    assert.equal(firstCache.pages[0].browserKey, secondCache.pages[0].browserKey);
    assert.match(firstCache.primaryBrowserKey, /^chrome-[0-9a-f]{12}$/);
  });
});

test('old array-shaped pages cache remains usable for page commands', async () => {
  const tempDir = await mkdtemp(join(shortTmpRoot(), 'cdp-old-cache-'));
  const targetId = 'old-cache-target-0001';

  const server = await createFakeChromeCDPServer({
    targets: [fakePage(targetId, 'Old Cache Page', 'https://old-cache.test/')],
  }).start();

  try {
    const portFile = join(tempDir, 'chrome/DevToolsActivePort');
    server.writeDevToolsActivePort(portFile);
    await writeOldPagesCache(tempDir, [fakePage(targetId, 'Old Cache Page', 'https://old-cache.test/')]);

    const result = await runCdp(['eval', targetId, 'document.title'], {
      tempDir,
      env: { CDP_PORT_FILE: portFile, CDP_HOST: server.host },
    });

    assertCdpOk(result);
    assert.deepEqual(commandMethods(server), ['Target.attachToTarget', 'Runtime.enable', 'Runtime.evaluate']);
    const migratedCache = await readPagesCache(tempDir);
    assert.equal(migratedCache.version, 2);
    assert.equal(migratedCache.pages[0].browserKind, 'chrome-family');
  } finally {
    await ignoreFailure(runCdp(['stop', targetId], {
      tempDir,
      env: { CDP_PORT_FILE: join(tempDir, 'chrome/DevToolsActivePort'), CDP_HOST: server.host },
    }));
    await server.stop();
  }
});

test('browser-aware daemon sockets separate identical target ids across backends', async () => {
  const tempDir = await mkdtemp(join(shortTmpRoot(), 'cdp-daemon-browser-key-'));
  const targetId = 'shared-target-0001';

  const lightpanda = await createFakeLightpandaCDPServer({
    targets: [fakePage(targetId, 'Lightpanda Shared Target', 'https://lightpanda-shared.test/')],
  }).start();
  const chrome = await createFakeChromeCDPServer({
    targets: [fakePage(targetId, 'Chrome Shared Target', 'https://chrome-shared.test/')],
  }).start();

  const chromePortFile = join(tempDir, 'chrome/DevToolsActivePort');
  chrome.writeDevToolsActivePort(chromePortFile);
  const lightpandaEnv = { CDP_BROWSER: 'lightpanda', CDP_LIGHTPANDA_URL: lightpanda.httpUrl };
  const chromeEnv = { CDP_PORT_FILE: chromePortFile, CDP_HOST: chrome.host };

  try {
    assertCdpOk(await runCdp(['list'], { tempDir, env: lightpandaEnv }));
    assertCdpOk(await runCdp(['eval', targetId, '1'], { tempDir, env: lightpandaEnv }));

    assertCdpOk(await runCdp(['list'], { tempDir, env: chromeEnv }));
    assertCdpOk(await runCdp(['eval', targetId, '2'], { tempDir, env: chromeEnv }));
    assert.equal(countMethod(lightpanda, 'Runtime.evaluate'), 1, 'Chrome eval must not reuse Lightpanda daemon socket');
    assert.equal(countMethod(chrome, 'Runtime.evaluate'), 1, 'Chrome eval must run in Chrome daemon');
    assert.equal(countMethod(chrome, 'Target.attachToTarget'), 1, 'Chrome daemon must attach to Chrome target');
  } finally {
    await ignoreFailure(runCdp(['stop', targetId], { tempDir, env: chromeEnv }));
    await ignoreFailure(runCdp(['list'], { tempDir, env: lightpandaEnv }));
    await ignoreFailure(runCdp(['stop', targetId], { tempDir, env: lightpandaEnv }));
    await chrome.stop();
    await lightpanda.stop();
  }
});

function assertCdpOk(result) {
  assert.equal(result.code, 0, result.stderr);
}

async function ignoreFailure(promise) {
  try { await promise; } catch {}
}

function fakePage(targetId, title, url) {
  return { targetId, title, url };
}

function shortTmpRoot() {
  return process.platform === 'win32' ? tmpdir() : '/tmp';
}

function pagesCachePath(tempDir) {
  return join(tempDir, 'runtime/cdp/pages.json');
}

async function readPagesCache(tempDir) {
  return JSON.parse(await readFile(pagesCachePath(tempDir), 'utf8'));
}

async function writeOldPagesCache(tempDir, pages) {
  const path = pagesCachePath(tempDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(pages));
}

function commandMethods(server) {
  return server.commandLog.map((message) => message.method);
}

function countMethod(server, method) {
  return commandMethods(server).filter((actual) => actual === method).length;
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
