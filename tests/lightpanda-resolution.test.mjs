import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
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

test('CDP_BROWSER=lightpanda resolves CDP_LIGHTPANDA_URL through /json/version', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'cdp-lightpanda-url-'));

  await createFakeLightpandaCDPServer({
    targets: [fakePage('lightpanda-url-0001', 'Lightpanda URL Page', 'https://lightpanda-url.test/')],
  }).using(async (server) => {
    const result = await runLightpandaList(tempDir, { CDP_LIGHTPANDA_URL: server.httpUrl });

    assertListSucceeded(result, /Lightpanda URL Page/);
    assert.deepEqual(requestUrls(server), ['/json/version']);
    assertGotTargets(server);
  });
});

test('CDP_BROWSER=lightpanda resolves CDP_LIGHTPANDA_HOST and CDP_LIGHTPANDA_PORT', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'cdp-lightpanda-host-port-'));

  await createFakeLightpandaCDPServer({
    targets: [fakePage('lightpanda-host-0001', 'Lightpanda Host Page', 'https://lightpanda-host.test/')],
  }).using(async (server) => {
    const result = await runLightpandaList(tempDir, {
      CDP_LIGHTPANDA_HOST: server.host,
      CDP_LIGHTPANDA_PORT: String(server.port),
    });

    assertListSucceeded(result, /Lightpanda Host Page/);
    assert.deepEqual(requestUrls(server), ['/json/version']);
    assertGotTargets(server);
  });
});

test('CDP_BROWSER=lightpanda resolves CDP_LIGHTPANDA_WS_URL directly after product validation', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'cdp-lightpanda-ws-url-'));

  await createFakeLightpandaCDPServer({
    targets: [fakePage('lightpanda-ws-0001', 'Lightpanda WS Page', 'https://lightpanda-ws.test/')],
  }).using(async (server) => {
    const directWsUrl = `${server.wsUrl}?direct=1`;
    const result = await runLightpandaList(tempDir, { CDP_LIGHTPANDA_WS_URL: directWsUrl });

    assertListSucceeded(result, /Lightpanda WS Page/);
    assert.deepEqual(requestUrls(server), ['/json/version']);
    assert.deepEqual(connectionUrls(server), [`${server.wsPath}?direct=1`]);
    assertGotTargets(server);
  });
});

test('CDP_BROWSER=lightpanda rejects a non-Lightpanda /json/version product', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'cdp-lightpanda-reject-'));

  await createFakeChromeCDPServer().using(async (server) => {
    const result = await runLightpandaList(tempDir, { CDP_LIGHTPANDA_URL: server.httpUrl });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Expected Lightpanda CDP endpoint/);
    assert.match(result.stderr, /Chrome\/126\.0\.0\.0/);
    assert.deepEqual(requestUrls(server), ['/json/version']);
    assert.equal(server.connectionLog.length, 0, 'product validation must fail before WebSocket connection');
  });
});

test('CDP_LIGHTPANDA_ALLOW_NON_LIGHTPANDA=1 allows explicit non-Lightpanda endpoint override', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'cdp-lightpanda-allow-'));

  await createFakeChromeCDPServer({
    targets: [fakePage('chrome-override-0001', 'Allowed Chrome Override', 'https://chrome-override.test/')],
  }).using(async (server) => {
    const result = await runLightpandaList(tempDir, {
      CDP_LIGHTPANDA_URL: server.httpUrl,
      CDP_LIGHTPANDA_ALLOW_NON_LIGHTPANDA: '1',
    });

    assertListSucceeded(result, /Allowed Chrome Override/);
    assertGotTargets(server);
  });
});

function fakePage(targetId, title, url) {
  return { targetId, title, url };
}

function assertListSucceeded(result, titlePattern) {
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, titlePattern);
}

function assertGotTargets(server) {
  assert.deepEqual(commandMethods(server), ['Target.getTargets']);
}

function requestUrls(server) {
  return server.requestLog.map((request) => request.url);
}

function connectionUrls(server) {
  return server.connectionLog.map((connection) => connection.url);
}

function commandMethods(server) {
  return server.commandLog.map((message) => message.method);
}

function runLightpandaList(tempDir, env) {
  return runCdp(['list'], { tempDir, env: { CDP_BROWSER: 'lightpanda', ...env } });
}

function runCdp(args, { tempDir, env: overrides = {} }) {
  return new Promise((resolve, reject) => {
    const childEnv = makeCleanEnv(tempDir, overrides);
    execFile(process.execPath, [CDP_CLI, ...args], { env: childEnv, timeout: 5000 }, (error, stdout, stderr) => {
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
