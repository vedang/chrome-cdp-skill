import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFakeChromeCDPServer } from './support/fake-cdp.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(TEST_DIR);
const CDP_CLI = join(REPO_ROOT, 'skills/chrome-cdp/scripts/cdp.mjs');

test('default Chrome-family discovery uses first existing profile DevToolsActivePort', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'cdp-chrome-discovery-'));

  await withFakeChromeServers([
    { targets: [fakePage('chrome-first-0001', 'First Chrome Page', 'https://first-chrome.test/')] },
    { targets: [fakePage('chromium-later-0001', 'Later Chromium Page', 'https://later-chromium.test/')] },
  ], async ([firstServer, laterServer]) => {
    firstServer.writeDevToolsActivePort(profilePortFile(tempDir, 'Google/Chrome'));
    laterServer.writeDevToolsActivePort(profilePortFile(tempDir, 'Chromium'));

    const result = await runCdp(['list'], { tempDir });

    assertListShows(result, 'First Chrome Page', 'Later Chromium Page');
    assertOnlyQueried(firstServer, laterServer);
  });
});

test('CDP_PORT_FILE remains highest-priority Chrome-family discovery override', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'cdp-port-file-discovery-'));

  await withFakeChromeServers([
    { targets: [fakePage('default-chrome-0001', 'Default Chrome Page', 'https://default-chrome.test/')] },
    { targets: [fakePage('override-chrome-0001', 'Override Chrome Page', 'https://override-chrome.test/')] },
  ], async ([defaultServer, overrideServer]) => {
    defaultServer.writeDevToolsActivePort(profilePortFile(tempDir, 'Google/Chrome'));
    const overridePortFile = join(tempDir, 'override/DevToolsActivePort');
    overrideServer.writeDevToolsActivePort(overridePortFile);

    const result = await runCdp(['list'], { tempDir, env: { CDP_PORT_FILE: overridePortFile } });

    assertListShows(result, 'Override Chrome Page', 'Default Chrome Page');
    assertOnlyQueried(overrideServer, defaultServer);
  });
});

async function withFakeChromeServers(serverOptions, callback) {
  const servers = [];
  try {
    for (const options of serverOptions) {
      servers.push(await createFakeChromeCDPServer(options).start());
    }
    return await callback(servers);
  } finally {
    await Promise.all(servers.toReversed().map((server) => server.stop()));
  }
}

function fakePage(targetId, title, url) {
  return { targetId, title, url };
}

function profilePortFile(tempDir, profile) {
  return join(tempDir, 'home/Library/Application Support', profile, 'DevToolsActivePort');
}

function assertListShows(result, visibleTitle, hiddenTitle) {
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, new RegExp(visibleTitle));
  assert.doesNotMatch(result.stdout, new RegExp(hiddenTitle));
}

function assertOnlyQueried(selectedServer, skippedServer) {
  assert.equal(selectedServer.connectionLog.length, 1);
  assert.equal(skippedServer.connectionLog.length, 0);
  assert.deepEqual(selectedServer.commandLog.map((message) => message.method), ['Target.getTargets']);
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
