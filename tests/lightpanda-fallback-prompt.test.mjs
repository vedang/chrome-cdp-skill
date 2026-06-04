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

test('unsupported Lightpanda page command emits fallback approval prompt without contacting fallback browser', async () => {
  const tempDir = await mkdtemp(join(shortTmpRoot(), 'cdp-lp-fallback-'));
  const targetId = 'lightshot-target-0001';
  const lightpandaEnv = { CDP_BROWSER: 'lightpanda' };

  const lightpanda = await createFakeLightpandaCDPServer({
    targets: [fakePage(targetId, 'Unsupported Shot Page', 'https://lightpanda-shot.test/workflow')],
    unsupportedMethods: ['Page.captureScreenshot'],
  }).start();
  const fallback = await createFakeChromeCDPServer({
    targets: [fakePage('fallback-target-0001', 'Fallback Browser Page', 'https://fallback.test/')],
  }).start();

  try {
    const fallbackPortFile = join(tempDir, 'fallback/DevToolsActivePort');
    fallback.writeDevToolsActivePort(fallbackPortFile);

    const env = {
      ...lightpandaEnv,
      CDP_LIGHTPANDA_URL: lightpanda.httpUrl,
      CDP_FALLBACK_BROWSER: 'brave',
      CDP_FALLBACK_PORT_FILE: fallbackPortFile,
      CDP_FALLBACK_HOST: fallback.host,
    };

    const list = await runCdp(['list'], { tempDir, env });
    assert.equal(list.code, 0, list.stderr);
    assert.match(list.stdout, /Unsupported Shot Page/);

    const shot = await runCdp(['shot', targetId], { tempDir, env });
    assertFallbackPrompt(shot);
    assertFallbackUntouched(fallback);
  } finally {
    await runCdp(['stop', targetId], {
      tempDir,
      env: { ...lightpandaEnv, CDP_LIGHTPANDA_URL: lightpanda.httpUrl },
    }).catch(() => {});
    await fallback.stop();
    await lightpanda.stop();
  }
});

function fakePage(targetId, title, url) {
  return { targetId, title, url };
}

function shortTmpRoot() {
  return process.platform === 'win32' ? tmpdir() : '/tmp';
}

function assertFallbackPrompt(result) {
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /LIGHTPANDA_UNSUPPORTED_FALLBACK_REQUIRED/);
  assert.match(result.stderr, /Command: shot/);
  assert.match(result.stderr, /Normalized command: screenshot/);
  assert.match(result.stderr, /Target: lightshot-target-0001/);
  assert.match(result.stderr, /Failed CDP method: Page\.captureScreenshot \(-32601 Method not found\)/);
  assert.match(result.stderr, /Primary URL: https:\/\/lightpanda-shot\.test\/workflow/);
  assert.match(result.stderr, /Suggested fallback browser: brave/);
  assert.match(result.stderr, /did not run fallback automatically/);
  assert.match(result.stderr, /cookies, login, localStorage, DOM mutations, typed text, JS heap, or in-page workflow may differ/);
  assert.match(result.stderr, /Ask the user before fallback execution/);
}

function assertFallbackUntouched(server) {
  assert.equal(server.requestLog.length, 0, 'fallback /json endpoints must not be requested');
  assert.equal(server.connectionLog.length, 0, 'fallback WebSocket must not be opened');
  assert.equal(server.commandLog.length, 0, 'fallback CDP commands must not run');
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
