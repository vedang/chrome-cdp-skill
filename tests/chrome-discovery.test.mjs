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

  await createFakeChromeCDPServer({
    targets: [{ targetId: 'chrome-first-0001', title: 'First Chrome Page', url: 'https://first-chrome.test/' }],
  }).using(async (firstServer) => {
    await createFakeChromeCDPServer({
      targets: [{ targetId: 'chromium-later-0001', title: 'Later Chromium Page', url: 'https://later-chromium.test/' }],
    }).using(async (laterServer) => {
      firstServer.writeDevToolsActivePort(join(tempDir, 'home/Library/Application Support/Google/Chrome/DevToolsActivePort'));
      laterServer.writeDevToolsActivePort(join(tempDir, 'home/Library/Application Support/Chromium/DevToolsActivePort'));

      const result = await runCdp(['list'], { tempDir });

      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /First Chrome Page/);
      assert.doesNotMatch(result.stdout, /Later Chromium Page/);
      assert.equal(firstServer.connectionLog.length, 1);
      assert.equal(laterServer.connectionLog.length, 0);
      assert.deepEqual(firstServer.commandLog.map((message) => message.method), ['Target.getTargets']);
    });
  });
});

test('CDP_PORT_FILE remains highest-priority Chrome-family discovery override', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'cdp-port-file-discovery-'));

  await createFakeChromeCDPServer({
    targets: [{ targetId: 'default-chrome-0001', title: 'Default Chrome Page', url: 'https://default-chrome.test/' }],
  }).using(async (defaultServer) => {
    await createFakeChromeCDPServer({
      targets: [{ targetId: 'override-chrome-0001', title: 'Override Chrome Page', url: 'https://override-chrome.test/' }],
    }).using(async (overrideServer) => {
      defaultServer.writeDevToolsActivePort(join(tempDir, 'home/Library/Application Support/Google/Chrome/DevToolsActivePort'));
      const overridePortFile = join(tempDir, 'override/DevToolsActivePort');
      overrideServer.writeDevToolsActivePort(overridePortFile);

      const result = await runCdp(['list'], { tempDir, env: { CDP_PORT_FILE: overridePortFile } });

      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /Override Chrome Page/);
      assert.doesNotMatch(result.stdout, /Default Chrome Page/);
      assert.equal(defaultServer.connectionLog.length, 0);
      assert.equal(overrideServer.connectionLog.length, 1);
      assert.deepEqual(overrideServer.commandLog.map((message) => message.method), ['Target.getTargets']);
    });
  });
});

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
