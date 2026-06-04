import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { readFile, mkdtemp } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CDP,
  CDPError,
  canonicalCommandName,
  commandMetadataFor,
  isUnsupportedCdpError,
} from '../skills/chrome-cdp/scripts/cdp.mjs';
import { createFakeChromeCDPServer } from './support/fake-cdp.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(TEST_DIR);
const CDP_CLI = join(REPO_ROOT, 'skills/chrome-cdp/scripts/cdp.mjs');

test('CDPError preserves protocol metadata from failed send', async () => {
  await createFakeChromeCDPServer({
    methodErrors: {
      'Runtime.evaluate': {
        code: -32042,
        message: 'Runtime exploded',
        data: { reason: 'fixture failure' },
      },
    },
  }).using(async (server) => {
    const cdp = new CDP();
    await cdp.connect(server.wsUrl);

    try {
      const { sessionId } = await cdp.send('Target.attachToTarget', {
        targetId: 'target-0001-fakecdp',
        flatten: true,
      });

      await assert.rejects(
        () => cdp.send('Runtime.evaluate', { expression: 'boom()' }, sessionId),
        (error) => {
          assert.ok(error instanceof CDPError);
          assert.equal(error.name, 'CDPError');
          assert.equal(error.method, 'Runtime.evaluate');
          assert.equal(error.code, -32042);
          assert.equal(error.message, 'Runtime exploded');
          assert.deepEqual(error.data, { reason: 'fixture failure' });
          assert.equal(error.sessionId, sessionId);
          return true;
        },
      );
    } finally {
      cdp.close();
    }
  });
});

test('unsupported classifier accepts only missing-method codes or exact known strings', () => {
  assertUnsupported({ code: -32601, message: 'Unexpected protocol text' });

  for (const message of ['Method not found', 'Unknown method', 'not implemented', 'unsupported']) {
    assertUnsupported({ message });
  }

  assertUnsupported({ message: 'Protocol error', data: 'unsupported' });
  assertUnsupported({ message: 'Protocol error', data: { message: 'Unknown method' } });

  for (const message of [
    'Navigation failed: site reports unsupported browser',
    'Method not found while loading app route',
    'The requested feature is not implemented by this page',
  ]) {
    assertSupported({ method: 'Page.navigate', message });
  }

  assertSupported({
    method: 'Runtime.evaluate',
    message: 'Evaluation failed',
    data: { details: 'User clicked unsupported workflow option' },
  });
});

function assertUnsupported({ method = 'Page.captureScreenshot', code = -32000, message, data }) {
  assert.equal(isUnsupportedCdpError(new CDPError(method, { code, message, data })), true, message);
}

function assertSupported({ method = 'Page.captureScreenshot', code = -32000, message, data }) {
  assert.equal(isUnsupportedCdpError(new CDPError(method, { code, message, data })), false, message);
}

test('canonical command metadata normalizes documented aliases', () => {
  const cases = [
    { alias: 'ls', metadata: { canonicalName: 'list', aliases: ['ls'], needsTarget: false } },
    { alias: 'snap', metadata: { canonicalName: 'snapshot', aliases: ['snap'], needsTarget: true } },
    { alias: 'shot', metadata: { canonicalName: 'screenshot', aliases: ['shot'], needsTarget: true } },
    { alias: 'nav', metadata: { canonicalName: 'navigate', aliases: ['nav'], needsTarget: true } },
    { alias: 'net', metadata: { canonicalName: 'network', aliases: ['net'], needsTarget: true } },
  ];

  for (const { alias, metadata } of cases) {
    assert.equal(canonicalCommandName(alias), metadata.canonicalName);
    assert.equal(canonicalCommandName(metadata.canonicalName), metadata.canonicalName);
    assert.deepEqual(commandMetadataFor(alias), metadata);
    assert.deepEqual(commandMetadataFor(metadata.canonicalName), metadata);
  }

  assert.deepEqual(commandMetadataFor('eval'), {
    canonicalName: 'eval',
    aliases: [],
    needsTarget: true,
  });
});

test('daemon responses include CDP error metadata for failed page commands', async () => {
  const tempDir = await mkdtemp(join(shortTmpRoot(), 'cdp-daemon-error-metadata-'));
  const targetId = 'daemon-error-target-0001';
  const screenshotMethod = 'Page.captureScreenshot';
  const screenshotError = {
    code: -32601,
    message: 'Method not found',
    data: { method: screenshotMethod, backend: 'fixture' },
  };

  const server = await createFakeChromeCDPServer({
    targets: [fakePage(targetId, 'Daemon Error Metadata Page', 'https://daemon-error.test/')],
    methodErrors: { [screenshotMethod]: screenshotError },
  }).start();

  try {
    const portFile = join(tempDir, 'chrome/DevToolsActivePort');
    server.writeDevToolsActivePort(portFile);
    const env = { CDP_PORT_FILE: portFile, CDP_HOST: server.host };

    assertCdpOk(await runCdp(['list'], { tempDir, env }));
    assertCdpOk(await runCdp(['eval', targetId, '1'], { tempDir, env }));

    const cache = await readPagesCache(tempDir);
    const response = await sendDaemonCommand(
      daemonSocketPath(tempDir, cache.pages[0].browserKey, targetId),
      { id: 42, cmd: 'shot', args: [join(tempDir, 'shot.png')] },
    );

    assert.deepEqual(response, {
      id: 42,
      ok: false,
      error: screenshotError.message,
      errorCode: screenshotError.code,
      errorMethod: screenshotMethod,
      errorData: screenshotError.data,
      unsupportedMethod: screenshotMethod,
    });
  } finally {
    await ignoreFailure(runCdp(['stop', targetId], { tempDir }));
    await server.stop();
  }
});

function fakePage(targetId, title, url) {
  return { targetId, title, url };
}

function shortTmpRoot() {
  return process.platform === 'win32' ? tmpdir() : '/tmp';
}

function runtimeDir(tempDir) {
  return process.platform === 'win32'
    ? join(tempDir, 'localappdata/cdp')
    : join(tempDir, 'runtime/cdp');
}

function pagesCachePath(tempDir) {
  return join(runtimeDir(tempDir), 'pages.json');
}

async function readPagesCache(tempDir) {
  return JSON.parse(await readFile(pagesCachePath(tempDir), 'utf8'));
}

function daemonSocketPath(tempDir, browserKey, targetId) {
  const socketName = `cdp-${[browserKey, targetId].map(safeSocketPart).join('-')}`;
  if (process.platform === 'win32') return `\\\\.\\pipe\\${socketName}`;
  return join(runtimeDir(tempDir), `${socketName}.sock`);
}

function safeSocketPart(value) {
  return String(value || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
}

function assertCdpOk(result) {
  assert.equal(result.code, 0, result.stderr);
}

async function ignoreFailure(promise) {
  try { await promise; } catch {}
}

async function sendDaemonCommand(socketPath, request) {
  const conn = net.connect(socketPath);
  let buffer = '';
  try {
    await withTimeout(once(conn, 'connect'), 5000, 'Timed out connecting to daemon');
    conn.write(JSON.stringify(request) + '\n');
    while (!buffer.includes('\n')) {
      const [chunk] = await withTimeout(once(conn, 'data'), 5000, 'Timed out waiting for daemon response');
      buffer += chunk.toString();
    }
    return JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
  } finally {
    conn.destroy();
  }
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
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
