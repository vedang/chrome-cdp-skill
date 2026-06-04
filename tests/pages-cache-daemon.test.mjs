import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
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
    const browserKey = cache.primaryBrowserKey;
    const browser = cache.browsers[browserKey];

    assert.equal(cache.version, 2);
    assert.deepEqual(Object.keys(cache.browsers), [browserKey]);
    assert.deepEqual(cache.pages, [{
      browserKey,
      browserId: 'lightpanda',
      browserKind: 'lightpanda',
      targetId,
      title: 'Cache Metadata Page',
      url: 'https://cache-metadata.test/',
    }]);
    assert.deepEqual({ browserId: browser.browserId, browserKind: browser.browserKind, source: browser.source }, {
      browserId: 'lightpanda',
      browserKind: 'lightpanda',
      source: 'CDP_LIGHTPANDA_URL',
    });
    assert.match(browser.wsUrl, /^ws:\/\//);
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
  const page = fakePage(targetId, 'Old Cache Page', 'https://old-cache.test/');

  const server = await createFakeChromeCDPServer({ targets: [page] }).start();

  try {
    const portFile = join(tempDir, 'chrome/DevToolsActivePort');
    server.writeDevToolsActivePort(portFile);
    await writeOldPagesCache(tempDir, [page]);

    const result = await runCdp(['eval', targetId, 'document.title'], {
      tempDir,
      env: { CDP_PORT_FILE: portFile, CDP_HOST: server.host },
    });

    assertCdpOk(result);
    assertEvalTouchedPage(server);
    assertMigratedPageBrowser(await readPagesCache(tempDir), { browserKind: 'chrome-family' });
  } finally {
    await ignoreFailure(runCdp(['stop', targetId], {
      tempDir,
      env: { CDP_PORT_FILE: join(tempDir, 'chrome/DevToolsActivePort'), CDP_HOST: server.host },
    }));
    await server.stop();
  }
});

test('old array-shaped pages cache wraps entries with current primary descriptor', async () => {
  const tempDir = await mkdtemp(join(shortTmpRoot(), 'cdp-olp-'));
  const targetId = 'olp-target-0001';
  const page = fakePage(targetId, 'Old Lightpanda Cache Page', 'https://old-lightpanda-cache.test/');

  const server = await createFakeLightpandaCDPServer({ targets: [page] }).start();
  const env = { CDP_BROWSER: 'lightpanda', CDP_LIGHTPANDA_URL: server.httpUrl };

  try {
    await writeOldPagesCache(tempDir, [page]);

    const result = await runCdp(['eval', targetId, 'document.title'], { tempDir, env });

    assertCdpOk(result);
    assertEvalTouchedPage(server);
    assertMigratedPageBrowser(await readPagesCache(tempDir), {
      browserId: 'lightpanda',
      browserKind: 'lightpanda',
    });
  } finally {
    await ignoreFailure(runCdp(['stop', targetId], { tempDir, env }));
    await server.stop();
  }
});

test('old array-shaped pages cache fails clearly without current descriptor', async () => {
  const tempDir = await mkdtemp(join(shortTmpRoot(), 'cdp-old-cache-no-descriptor-'));
  const targetId = 'old-cache-no-descriptor-target-0001';
  await writeOldPagesCache(tempDir, [fakePage(targetId, 'Old Cache Missing Browser', 'https://old-cache-missing-browser.test/')]);

  const result = await runCdp(['eval', targetId, 'document.title'], { tempDir });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Old pages cache cannot be used without current browser descriptor/);
  assert.match(result.stderr, /Run "cdp list" again\./);
});

test('daemon starts from cached page browserKey when current env cannot resolve browser', async () => {
  const tempDir = await mkdtemp(join(shortTmpRoot(), 'cdp-dcd-'));
  const targetId = 'dcd-target-0001';

  const pageServer = await createFakeChromeCDPServer({
    targets: [fakePage(targetId, 'Cached Daemon Page', 'https://cached-daemon.test/')],
  }).start();
  const decoyServer = await createFakeChromeCDPServer({
    targets: [fakePage('decoy-target-0001', 'Decoy Page', 'https://decoy.test/')],
  }).start();

  try {
    const portFile = join(tempDir, 'explicit/DevToolsActivePort');
    pageServer.writeDevToolsActivePort(portFile);
    assertCdpOk(await runCdp(['list'], {
      tempDir,
      env: { CDP_PORT_FILE: portFile, CDP_HOST: pageServer.host },
    }));

    await rewritePrimaryBrowserToDecoy(tempDir, decoyServer);

    assertCdpOk(await runCdp(['eval', targetId, '99'], { tempDir }));

    assert.deepEqual(commandMethods(pageServer), [
      'Target.getTargets',
      'Target.attachToTarget',
      'Runtime.enable',
      'Runtime.evaluate',
    ]);
    assertNoContact(decoyServer, 'primaryBrowserKey decoy');
  } finally {
    await ignoreFailure(runCdp(['stop', targetId], { tempDir }));
    await decoyServer.stop();
    await pageServer.stop();
  }
});

test('stop uses v2 cache without current browser env', async () => {
  const tempDir = await mkdtemp(join(shortTmpRoot(), 'cdp-stop-v2-cache-'));
  const targetId = 'stop-v2-target-0001';

  const server = await createFakeChromeCDPServer({
    targets: [fakePage(targetId, 'Stop V2 Page', 'https://stop-v2.test/')],
  }).start();

  try {
    const portFile = join(tempDir, 'chrome/DevToolsActivePort');
    server.writeDevToolsActivePort(portFile);
    assertCdpOk(await runCdp(['list'], {
      tempDir,
      env: { CDP_PORT_FILE: portFile, CDP_HOST: server.host },
    }));

    assertCdpOk(await runCdp(['eval', targetId, '1'], { tempDir }));
    assert.equal(countMethod(server, 'Target.attachToTarget'), 1);

    assertCdpOk(await runCdp(['stop', targetId], { tempDir }));
    assertCdpOk(await runCdp(['eval', targetId, '2'], { tempDir }));

    assert.equal(countMethod(server, 'Target.attachToTarget'), 2, 'second eval must start a fresh daemon after stop');
    assert.equal(countMethod(server, 'Runtime.evaluate'), 2);
  } finally {
    await ignoreFailure(runCdp(['stop', targetId], { tempDir }));
    await server.stop();
  }
});

test('stop old array-shaped pages cache uses legacy target socket without browser env', async (t) => {
  if (process.platform === 'win32') {
    t.skip('legacy target socket path assertion is Unix-only');
    return;
  }

  const tempDir = await mkdtemp(join(shortTmpRoot(), 'cdp-stop-old-cache-'));
  const targetId = 'stop-old-target-0001';
  await writeOldPagesCache(tempDir, [fakePage(targetId, 'Stop Old Cache Page', 'https://stop-old-cache.test/')]);
  const daemon = await createFakeLegacyDaemonSocket(tempDir, targetId);

  try {
    assertCdpOk(await runCdp(['stop', targetId], { tempDir }));
    assert.equal(await waitFor(daemon.command, 1000, 'legacy daemon did not receive stop'), 'stop');
  } finally {
    await daemon.close();
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
    await assertCurrentDaemonSocketExists(tempDir, targetId);

    assertCdpOk(await runCdp(['list'], { tempDir, env: chromeEnv }));
    assertCdpOk(await runCdp(['eval', targetId, '2'], { tempDir, env: chromeEnv }));
    await assertCurrentDaemonSocketExists(tempDir, targetId);
    await assertLegacyDaemonSocketAbsent(tempDir, targetId);
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

async function createFakeLegacyDaemonSocket(tempDir, targetId) {
  const socketPath = daemonSocketPath(tempDir, targetId);
  await mkdir(dirname(socketPath), { recursive: true });

  let resolveCommand;
  let rejectCommand;
  const commandPromise = new Promise((resolve, reject) => {
    resolveCommand = resolve;
    rejectCommand = reject;
  });

  const server = createServer((conn) => {
    let buffer = '';
    conn.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const request = JSON.parse(line);
          conn.end(JSON.stringify({ id: request.id, ok: true, result: '' }) + '\n');
          resolveCommand(request.cmd);
        } catch (error) {
          rejectCommand(error);
        }
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    command: commandPromise,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function waitFor(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function assertCdpOk(result) {
  assert.equal(result.code, 0, result.stderr);
}

function assertEvalTouchedPage(server) {
  assert.deepEqual(commandMethods(server), ['Target.attachToTarget', 'Runtime.enable', 'Runtime.evaluate']);
}

function assertMigratedPageBrowser(cache, { browserId, browserKind }) {
  const browserKey = cache.primaryBrowserKey;
  assert.equal(cache.version, 2);
  assert.equal(cache.browsers[browserKey].browserKind, browserKind);
  assert.equal(cache.pages[0].browserKey, browserKey);
  assert.equal(cache.pages[0].browserKind, browserKind);
  if (browserId) {
    assert.equal(cache.browsers[browserKey].browserId, browserId);
    assert.equal(cache.pages[0].browserId, browserId);
  }
}

async function assertCurrentDaemonSocketExists(tempDir, targetId) {
  if (process.platform === 'win32') return;
  const cache = await readPagesCache(tempDir);
  await access(daemonSocketPath(tempDir, cache.primaryBrowserKey, targetId));
}

async function assertLegacyDaemonSocketAbsent(tempDir, targetId) {
  if (process.platform === 'win32') return;
  await assert.rejects(access(daemonSocketPath(tempDir, targetId)), { code: 'ENOENT' });
}

function daemonSocketPath(tempDir, ...parts) {
  return join(tempDir, 'runtime/cdp', `cdp-${parts.map(safeSocketPart).join('-')}.sock`);
}

function safeSocketPart(value) {
  return String(value || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
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

async function rewritePrimaryBrowserToDecoy(tempDir, decoyServer) {
  const cache = await readPagesCache(tempDir);
  const pageBrowserKey = cache.pages[0].browserKey;
  const decoyBrowserKey = 'chrome-decoy000001';
  await writeFile(pagesCachePath(tempDir), JSON.stringify({
    ...cache,
    primaryBrowserKey: decoyBrowserKey,
    browsers: {
      [decoyBrowserKey]: {
        browserId: 'chrome',
        browserKind: 'chrome-family',
        wsUrl: decoyServer.wsUrl,
        source: 'test-decoy',
      },
      [pageBrowserKey]: cache.browsers[pageBrowserKey],
    },
  }));
}

function assertNoContact(server, label) {
  assert.equal(server.connectionLog.length, 0, `${label} must receive no WebSocket connections`);
  assert.equal(server.commandLog.length, 0, `${label} must receive no CDP commands`);
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
