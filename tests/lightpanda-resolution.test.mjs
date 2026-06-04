import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
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
    assertVersionRequests(server);
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
    assertVersionRequests(server);
    assertGotTargets(server);
  });
});

test('CDP_BROWSER=lightpanda retries /json/version while endpoint becomes ready', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'cdp-lightpanda-version-retry-'));

  await createFakeLightpandaCDPServer({
    versionFailures: 2,
    targets: [fakePage('lightpanda-retry-0001', 'Lightpanda Retry Page', 'https://lightpanda-retry.test/')],
  }).using(async (server) => {
    const result = await runLightpandaList(tempDir, { CDP_LIGHTPANDA_URL: server.httpUrl });

    assertListSucceeded(result, /Lightpanda Retry Page/);
    assertVersionRequests(server, 3);
    assert.deepEqual(connectionUrls(server), [server.wsPath]);
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
    assertVersionRequests(server);
    assert.deepEqual(connectionUrls(server), [`${server.wsPath}?direct=1`]);
    assertGotTargets(server);
  });
});

test('CDP_LIGHTPANDA_WS_URL takes precedence over URL and host/port', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'cdp-lightpanda-ws-precedence-'));

  await usingLightpandaServers([
    { targets: [fakePage('lightpanda-ws-precedence-0001', 'Lightpanda WS Precedence Page', 'https://lightpanda-ws-precedence.test/')] },
    {},
    {},
  ], async ([wsServer, urlServer, hostPortServer]) => {
    const directWsUrl = `${wsServer.wsUrl}?winner=ws`;
    const result = await runLightpandaList(tempDir, {
      CDP_LIGHTPANDA_WS_URL: directWsUrl,
      CDP_LIGHTPANDA_URL: urlServer.httpUrl,
      CDP_LIGHTPANDA_HOST: hostPortServer.host,
      CDP_LIGHTPANDA_PORT: String(hostPortServer.port),
    });

    assertListSucceeded(result, /Lightpanda WS Precedence Page/);
    assertVersionRequests(wsServer);
    assert.deepEqual(connectionUrls(wsServer), [`${wsServer.wsPath}?winner=ws`]);
    assertGotTargets(wsServer);
    assertNoContact(urlServer, 'CDP_LIGHTPANDA_URL loser');
    assertNoContact(hostPortServer, 'CDP_LIGHTPANDA_HOST/CDP_LIGHTPANDA_PORT loser');
    assert.equal(await primaryBrowserSource(tempDir), 'CDP_LIGHTPANDA_WS_URL');
  });
});

test('CDP_LIGHTPANDA_URL takes precedence over host/port', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'cdp-lightpanda-url-precedence-'));

  await usingLightpandaServers([
    { targets: [fakePage('lightpanda-url-precedence-0001', 'Lightpanda URL Precedence Page', 'https://lightpanda-url-precedence.test/')] },
    {},
  ], async ([urlServer, hostPortServer]) => {
    const result = await runLightpandaList(tempDir, {
      CDP_LIGHTPANDA_URL: urlServer.httpUrl,
      CDP_LIGHTPANDA_HOST: hostPortServer.host,
      CDP_LIGHTPANDA_PORT: String(hostPortServer.port),
    });

    assertListSucceeded(result, /Lightpanda URL Precedence Page/);
    assertVersionRequests(urlServer);
    assert.deepEqual(connectionUrls(urlServer), [urlServer.wsPath]);
    assertGotTargets(urlServer);
    assertNoContact(hostPortServer, 'CDP_LIGHTPANDA_HOST/CDP_LIGHTPANDA_PORT loser');
    assert.equal(await primaryBrowserSource(tempDir), 'CDP_LIGHTPANDA_URL');
  });
});

test('CDP_BROWSER=lightpanda accepts a Lightpanda User-Agent when Browser product differs', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'cdp-lightpanda-user-agent-'));

  await createFakeChromeCDPServer({
    userAgent: 'Lightpanda/0.1.0',
    targets: [fakePage('lightpanda-user-agent-0001', 'Lightpanda User-Agent Page', 'https://lightpanda-user-agent.test/')],
  }).using(async (server) => {
    const result = await runLightpandaList(tempDir, { CDP_LIGHTPANDA_URL: server.httpUrl });

    assertListSucceeded(result, /Lightpanda User-Agent Page/);
    assertVersionRequests(server);
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
    assertVersionRequests(server);
    assert.equal(server.connectionLog.length, 0, 'product validation must fail before WebSocket connection');
  });
});

test('CDP_BROWSER=lightpanda rejects Lightpanda product near-misses', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'cdp-lightpanda-near-miss-'));

  await createFakeLightpandaCDPServer({
    browserProduct: 'LightpandaBrowser/1.0.0',
    userAgent: 'Mozilla/5.0 Chrome/126.0.0.0',
  }).using(async (server) => {
    const result = await runLightpandaList(tempDir, { CDP_LIGHTPANDA_URL: server.httpUrl });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Expected Lightpanda CDP endpoint/);
    assert.match(result.stderr, /LightpandaBrowser\/1\.0\.0/);
    assertVersionRequests(server);
    assert.equal(server.connectionLog.length, 0, 'near-miss validation must fail before WebSocket connection');
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

async function usingLightpandaServers(configs, callback) {
  const servers = [];
  try {
    for (const config of configs) {
      servers.push(await createFakeLightpandaCDPServer(config).start());
    }
    return await callback(servers);
  } finally {
    for (const server of servers.reverse()) {
      await server.stop();
    }
  }
}

function assertListSucceeded(result, titlePattern) {
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, titlePattern);
}

function assertGotTargets(server) {
  assert.deepEqual(commandMethods(server), ['Target.getTargets']);
}

function assertVersionRequests(server, count = 1) {
  assert.deepEqual(requestUrls(server), Array(count).fill('/json/version'));
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

function assertNoContact(server, label) {
  assert.deepEqual(requestUrls(server), [], `${label} received HTTP requests`);
  assert.deepEqual(connectionUrls(server), [], `${label} received WebSocket connections`);
  assert.deepEqual(commandMethods(server), [], `${label} received CDP commands`);
}

async function primaryBrowserSource(tempDir) {
  const cache = JSON.parse(await readFile(join(tempDir, 'runtime/cdp/pages.json'), 'utf8'));
  return cache.browsers[cache.primaryBrowserKey].source;
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
