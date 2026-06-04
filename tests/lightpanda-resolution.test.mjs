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

test('CDP_BROWSER=lightpanda open uses Target.createTarget instead of /json/new', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'cdp-lightpanda-open-target-'));

  await createFakeLightpandaCDPServer().using(async (server) => {
    const result = await runLightpandaOpen(tempDir, 'https://lightpanda-open.test/', {
      CDP_LIGHTPANDA_URL: server.httpUrl,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Opened new tab:/);
    assertVersionRequests(server);
    assert.deepEqual(commandMethods(server), ['Target.createTarget', 'Target.getTargets']);
    assert.equal(server.targets.some(target => target.url === 'https://lightpanda-open.test/'), true);
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

    assertProductRejected(result, server, /Chrome\/126\.0\.0\.0/);
  });
});

test('CDP_BROWSER=lightpanda rejects Lightpanda product near-misses', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'cdp-lightpanda-near-miss-'));

  await createFakeLightpandaCDPServer({
    browserProduct: 'LightpandaBrowser/1.0.0',
    userAgent: 'Mozilla/5.0 Chrome/126.0.0.0',
  }).using(async (server) => {
    const result = await runLightpandaList(tempDir, { CDP_LIGHTPANDA_URL: server.httpUrl });

    assertProductRejected(result, server, /LightpandaBrowser\/1\.0\.0/);
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

test('supported Lightpanda page commands run through cached daemon descriptor', async () => {
  const tempDir = await mkdtemp(join(shortTmpRoot(), 'cdp-lightpanda-daemon-'));
  const targetId = 'lightpanda-daemon-0001';
  const title = 'Lightpanda Daemon Page';
  const html = '<html><head><title>Lightpanda Daemon Page</title></head><body>daemon ok</body></html>';

  await createFakeLightpandaCDPServer({
    targets: [fakePage(targetId, title, 'https://lightpanda-daemon.test/')],
    handlers: {
      'Runtime.evaluate': ({ expression }) => runtimeEvaluateResult(expression, { title, html }),
    },
  }).using(async (server) => {
    const lightpandaEnv = { CDP_BROWSER: 'lightpanda', CDP_LIGHTPANDA_URL: server.httpUrl };

    try {
      assertCdpOk(await runCdp(['list'], { tempDir, env: lightpandaEnv }));

      for (const command of supportedLightpandaPageCommands(targetId)) {
        await assertCdpOutput(command.args, { tempDir }, command.stdout);
      }

      assertVersionRequests(server);
      assert.equal(server.connectionLog.length, 2, 'list uses one browser connection and page commands reuse one daemon connection');
      assert.equal(countMethod(server, 'Target.attachToTarget'), 1, 'supported page commands reuse one Lightpanda daemon session');
      assert.deepEqual(commandMethods(server), [
        'Target.getTargets',
        'Target.attachToTarget',
        'Runtime.enable',
        'Runtime.evaluate',
        'Runtime.enable',
        'Runtime.evaluate',
        'Accessibility.getFullAXTree',
        'Page.enable',
        'Page.navigate',
        'Runtime.enable',
        'Runtime.evaluate',
      ]);
      assertSinglePageCommandSession(server);
    } finally {
      await ignoreFailure(runCdp(['stop', targetId], { tempDir }));
    }
  });
});

function fakePage(targetId, title, url) {
  return { targetId, title, url };
}

function supportedLightpandaPageCommands(targetId) {
  return [
    { args: ['eval', targetId, 'document.title'], stdout: /Lightpanda Daemon Page/ },
    { args: ['html', targetId], stdout: /daemon ok/ },
    { args: ['snap', targetId], stdout: /\[RootWebArea\] Lightpanda Daemon Page/ },
    { args: ['nav', targetId, 'https://lightpanda-nav.test/'], stdout: /Navigated to https:\/\/lightpanda-nav\.test\// },
  ];
}

function shortTmpRoot() {
  return process.platform === 'win32' ? tmpdir() : '/tmp';
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

function assertCdpOk(result) {
  assert.equal(result.code, 0, result.stderr);
}

function assertListSucceeded(result, titlePattern) {
  assertCdpOk(result);
  assert.match(result.stdout, titlePattern);
}

async function assertCdpOutput(args, options, stdoutPattern) {
  const result = await runCdp(args, options);
  assertCdpOk(result);
  assert.match(result.stdout, stdoutPattern);
}

function assertGotTargets(server) {
  assert.deepEqual(commandMethods(server), ['Target.getTargets']);
}

function runtimeEvaluateResult(expression, { title, html }) {
  const valueByExpression = new Map([
    ['document.title', title],
    ['document.documentElement.outerHTML', html],
    ['document.readyState', 'complete'],
    ['window.devicePixelRatio', 1],
  ]);
  const value = valueByExpression.get(expression);
  return value === undefined
    ? { result: { type: 'undefined' } }
    : { result: { type: typeof value, value } };
}

function assertProductRejected(result, server, productPattern) {
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Expected Lightpanda CDP endpoint/);
  assert.match(result.stderr, productPattern);
  assertVersionRequests(server);
  assert.deepEqual(connectionUrls(server), [], 'product validation must fail before WebSocket connection');
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

function countMethod(server, method) {
  return commandMethods(server).filter((actual) => actual === method).length;
}

function assertSinglePageCommandSession(server) {
  const sessionIds = server.commandLog
    .filter((message) => message.sessionId)
    .map((message) => message.sessionId);
  assert.equal(new Set(sessionIds).size, 1, 'page commands must share one daemon CDP session');
}

async function ignoreFailure(promise) {
  try { await promise; } catch {}
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

function runLightpandaOpen(tempDir, url, env) {
  return runCdp(['open', url], { tempDir, env: { CDP_BROWSER: 'lightpanda', ...env } });
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
