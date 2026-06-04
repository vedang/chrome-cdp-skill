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
const UNSUPPORTED_SHOT_METHOD = 'Page.captureScreenshot';
const SCREENSHOT_CDP_METHODS_TEXT = 'Page.getLayoutMetrics, Emulation.getDeviceMetricsOverride, Runtime.enable, Runtime.evaluate, Page.captureScreenshot';
const STATE_DIVERGENCE_WARNING = 'Fallback browser is not the same state: it may lack cookies, login, local storage (localStorage), DOM mutations, typed text, JS heap, or current user workflow.';
function manualFallbackSequence(browserId) {
  const nextBrowser = browserId || '<approved fallback browser>';
  return [
    'Manual fallback only:',
    '1. Ask the user before fallback execution.',
    '2. If approved, enable remote debugging in the fallback browser.',
    `3. Run CDP_BROWSER=${nextBrowser} scripts/cdp.mjs list or open in that browser.`,
    '4. Select the fallback browser target; do not reuse the Lightpanda target id.',
    `5. Rerun this command with CDP_BROWSER=${nextBrowser} against the approved fallback target.`,
  ];
}

test('unsupported Lightpanda page command emits fallback approval prompt without contacting fallback browser', async () => {
  const tempDir = await mkdtemp(join(shortTmpRoot(), 'cdp-lp-fallback-'));
  const targetId = 'lightshot-target-0001';
  const lightpandaEnv = { CDP_BROWSER: 'lightpanda' };

  const lightpanda = await createFakeLightpandaCDPServer({
    targets: [fakePage(targetId, 'Unsupported Shot Page', 'https://lightpanda-shot.test/workflow')],
    unsupportedMethods: [UNSUPPORTED_SHOT_METHOD],
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

    await assertLightpandaPageListed(tempDir, env, /Unsupported Shot Page/);

    const commandTarget = 'lightshot';
    const shot = await runCdp(['shot', commandTarget], { tempDir, env });
    assertFallbackPrompt(shot, {
      commandTarget,
      targetId,
      primaryUrl: 'https://lightpanda-shot.test/workflow',
      suggestedFallback: 'brave',
    });
    assertFallbackUntouched(fallback);
  } finally {
    await stopLightpandaDaemon(tempDir, targetId, lightpanda);
    await fallback.stop();
    await lightpanda.stop();
  }
});

test('unsupported Lightpanda exits before resolving configured fallback browser', async () => {
  const tempDir = await mkdtemp(join(shortTmpRoot(), 'cdp-lp-nores-'));
  const targetId = 'lp-nofb1';
  const primaryUrl = 'https://lightpanda-no-fallback.test/workflow';

  const lightpanda = await createFakeLightpandaCDPServer({
    targets: [fakePage(targetId, 'No Fallback Resolve Page', primaryUrl)],
    unsupportedMethods: [UNSUPPORTED_SHOT_METHOD],
  }).start();

  try {
    const env = missingFallbackResolverEnv(tempDir, lightpanda);
    await assertLightpandaPageListed(tempDir, env, /No Fallback Resolve Page/);

    const shot = await runCdp(['shot', targetId], { tempDir, env });
    assertFallbackPrompt(shot, { targetId, primaryUrl, suggestedFallback: 'chrome' });
    assertNoFallbackResolverError(shot);
  } finally {
    await stopLightpandaDaemon(tempDir, targetId, lightpanda);
    await lightpanda.stop();
  }
});

test('unsupported Lightpanda fallback prompt suppresses fallback suggestion when configured none', async () => {
  const tempDir = await mkdtemp(join(shortTmpRoot(), 'cdp-lp-none-'));
  const targetId = 'lp-none-0001';
  const primaryUrl = 'https://lightpanda-none.test/workflow';

  const lightpanda = await createFakeLightpandaCDPServer({
    targets: [fakePage(targetId, 'No Suggested Fallback Page', primaryUrl)],
    unsupportedMethods: [UNSUPPORTED_SHOT_METHOD],
  }).start();

  try {
    const env = { ...makeLightpandaEnv(lightpanda), CDP_FALLBACK_BROWSER: 'none' };
    await assertLightpandaPageListed(tempDir, env, /No Suggested Fallback Page/);

    const shot = await runCdp(['shot', targetId], { tempDir, env });
    assertFallbackPrompt(shot, { targetId, primaryUrl, suggestedFallback: null });
    assert.doesNotMatch(shot.stderr, /^Suggested fallback browser:/m);
  } finally {
    await stopLightpandaDaemon(tempDir, targetId, lightpanda);
    await lightpanda.stop();
  }
});

test('unsupported Lightpanda fallback prompt uses cached page record when current env changes', async () => {
  const tempDir = await mkdtemp(join(shortTmpRoot(), 'cdp-lp-cache-'));
  const targetId = 'clp-shot-0001';
  const primaryUrl = 'https://cached-lightpanda-shot.test/workflow';

  const lightpanda = await createFakeLightpandaCDPServer({
    targets: [fakePage(targetId, 'Cached Lightpanda Shot Page', primaryUrl)],
    unsupportedMethods: [UNSUPPORTED_SHOT_METHOD],
  }).start();
  const chrome = await createFakeChromeCDPServer({
    targets: [fakePage('chrome-current-target-0001', 'Current Chrome Page', 'https://current-chrome.test/')],
  }).start();

  try {
    const lightpandaEnv = makeLightpandaEnv(lightpanda);
    const chromeEnv = {
      CDP_BROWSER: 'chrome',
      CDP_HOST: chrome.host,
      CDP_FALLBACK_BROWSER: 'chrome',
    };

    await assertLightpandaPageListed(tempDir, lightpandaEnv, /Cached Lightpanda Shot Page/);

    const shot = await runCdp(['shot', targetId], { tempDir, env: chromeEnv });
    assertFallbackPrompt(shot, { targetId, primaryUrl, suggestedFallback: 'chrome' });
    assertFallbackUntouched(chrome);
  } finally {
    await stopLightpandaDaemon(tempDir, targetId, lightpanda);
    await chrome.stop();
    await lightpanda.stop();
  }
});

function fakePage(targetId, title, url) {
  return { targetId, title, url };
}

function makeLightpandaEnv(lightpanda) {
  return { CDP_BROWSER: 'lightpanda', CDP_LIGHTPANDA_URL: lightpanda.httpUrl };
}

function missingFallbackResolverEnv(tempDir, lightpanda) {
  return {
    ...makeLightpandaEnv(lightpanda),
    CDP_FALLBACK_BROWSER: 'chrome',
    CDP_FALLBACK_PORT_FILE: join(tempDir, 'missing/DevToolsActivePort'),
    CDP_FALLBACK_HOST: '127.0.0.250',
  };
}

async function assertLightpandaPageListed(tempDir, env, titlePattern) {
  const list = await runCdp(['list'], { tempDir, env });
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, titlePattern);
}

async function stopLightpandaDaemon(tempDir, targetId, lightpanda) {
  await runCdp(['stop', targetId], { tempDir, env: makeLightpandaEnv(lightpanda) }).catch(() => {});
}

function shortTmpRoot() {
  return process.platform === 'win32' ? tmpdir() : '/tmp';
}

function assertFallbackPrompt(result, { commandTarget, targetId, primaryUrl, suggestedFallback }) {
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, '');

  assertPromptLines(result.stderr, [
    'LIGHTPANDA_UNSUPPORTED_FALLBACK_REQUIRED',
    `Command: shot ${commandTarget || targetId}`,
    'Normalized command: screenshot',
    `Target: ${targetId}`,
    'Failed CDP method: Page.captureScreenshot (-32601 Method not found)',
    `Command CDP methods: ${SCREENSHOT_CDP_METHODS_TEXT}`,
    `Primary URL: ${primaryUrl}`,
    ...(suggestedFallback ? [`Suggested fallback browser: ${suggestedFallback}`] : []),
    STATE_DIVERGENCE_WARNING,
    ...manualFallbackSequence(suggestedFallback),
  ]);

  assert.match(result.stderr, /did not run fallback automatically/);
}

function assertPromptLines(stderr, requiredLines) {
  const lines = stderr.trimEnd().split('\n');
  assert.equal(lines[0], requiredLines[0]);
  for (const line of requiredLines.slice(1)) assert.equal(lines.includes(line), true, line);
}

function assertFallbackUntouched(server) {
  assert.equal(server.requestLog.length, 0, 'fallback /json endpoints must not be requested');
  assert.equal(server.connectionLog.length, 0, 'fallback WebSocket must not be opened');
  assert.equal(server.commandLog.length, 0, 'fallback CDP commands must not run');
}

function assertNoFallbackResolverError(result) {
  assert.doesNotMatch(result.stderr, /No DevToolsActivePort found|ECONNREFUSED|Daemon failed to start/);
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
