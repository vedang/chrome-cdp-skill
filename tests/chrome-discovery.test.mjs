import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFakeChromeCDPServer } from './support/fake-cdp.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(TEST_DIR);
const CDP_CLI = join(REPO_ROOT, 'skills/chrome-cdp/scripts/cdp.mjs');
const CHROME_FAMILY_BROWSER_CASES = [
  { browserId: 'auto', profile: 'google-chrome', title: 'Auto Chrome Page' },
  { browserId: 'chrome', profile: 'google-chrome', title: 'Explicit Chrome Page' },
  { browserId: 'chromium', profile: 'chromium', title: 'Explicit Chromium Page' },
  { browserId: 'brave', profile: 'BraveSoftware/Brave-Browser', title: 'Explicit Brave Page' },
  { browserId: 'edge', profile: 'microsoft-edge', title: 'Explicit Edge Page' },
  { browserId: 'vivaldi', profile: 'vivaldi', title: 'Explicit Vivaldi Page' },
];

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

test('CDP_BROWSER supports explicit Chrome-family browser ids', async (t) => {
  for (const browserCase of CHROME_FAMILY_BROWSER_CASES) {
    await t.test(browserCase.browserId, () => assertBrowserIdSelectable(browserCase));
  }
});

test('CDP_BROWSER narrows profile discovery to the requested Chrome-family browser', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'cdp-browser-narrow-'));

  await withFakeChromeServers([
    { targets: [fakePage('chrome-skipped-0001', 'Skipped Chrome Page', 'https://skipped-chrome.test/')] },
    { targets: [fakePage('brave-selected-0001', 'Selected Brave Page', 'https://selected-brave.test/')] },
  ], async ([chromeServer, braveServer]) => {
    chromeServer.writeDevToolsActivePort(linuxProfilePortFile(tempDir, 'google-chrome'));
    braveServer.writeDevToolsActivePort(linuxProfilePortFile(tempDir, 'BraveSoftware/Brave-Browser'));

    const result = await runCdp(['list'], { tempDir, env: { CDP_BROWSER: 'brave' } });

    assertListShows(result, 'Selected Brave Page', 'Skipped Chrome Page');
    assertOnlyQueried(braveServer, chromeServer);
  });
});

test('CDP_BROWSER preserves CDP_PORT_FILE and CDP_HOST override semantics', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'cdp-browser-port-host-'));

  await withFakeChromeServers([
    { targets: [fakePage('profile-vivaldi-0001', 'Profile Vivaldi Page', 'https://profile-vivaldi.test/')] },
    { targets: [fakePage('override-vivaldi-0001', 'Override Vivaldi Page', 'https://override-vivaldi.test/')] },
  ], async ([profileServer, overrideServer]) => {
    profileServer.writeDevToolsActivePort(linuxProfilePortFile(tempDir, 'vivaldi'));
    const overridePortFile = join(tempDir, 'override/DevToolsActivePort');
    overrideServer.writeDevToolsActivePort(overridePortFile);

    const result = await runCdp(['list'], {
      tempDir,
      env: { CDP_BROWSER: 'vivaldi', CDP_PORT_FILE: overridePortFile, CDP_HOST: overrideServer.host },
    });

    assertListShows(result, 'Override Vivaldi Page', 'Profile Vivaldi Page');
    assertOnlyQueried(overrideServer, profileServer);
    const browser = await readPrimaryBrowser(tempDir);
    assert.equal(browser.browserId, 'vivaldi');
    assert.equal(browser.wsUrl, overrideServer.wsUrl);
    assert.equal(browser.source, 'CDP_PORT_FILE');
  });
});

async function assertBrowserIdSelectable({ browserId, profile, title }) {
  const tempDir = await mkdtemp(join(tmpdir(), `cdp-browser-${browserId}-`));

  await createFakeChromeCDPServer({
    targets: [fakePage(`${browserId}-target-0001`, title, `https://${browserId}.test/`)],
  }).using(async (server) => {
    server.writeDevToolsActivePort(linuxProfilePortFile(tempDir, profile));

    const result = await runCdp(['list'], { tempDir, env: { CDP_BROWSER: browserId } });

    assertListSucceeded(result, title);
    assertGotTargets(server);
    assert.equal((await readPrimaryBrowser(tempDir)).browserId, expectedDescriptorBrowserId(browserId));
  });
}

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

function linuxProfilePortFile(tempDir, profile) {
  return join(tempDir, 'home/.config', profile, 'DevToolsActivePort');
}

async function readPagesCache(tempDir) {
  return JSON.parse(await readFile(join(tempDir, 'runtime/cdp/pages.json'), 'utf8'));
}

async function readPrimaryBrowser(tempDir) {
  const cache = await readPagesCache(tempDir);
  return cache.browsers[cache.primaryBrowserKey];
}

function expectedDescriptorBrowserId(browserId) {
  return browserId === 'auto' ? 'chrome' : browserId;
}

function assertListSucceeded(result, visibleTitle) {
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, new RegExp(visibleTitle));
}

function assertListShows(result, visibleTitle, hiddenTitle) {
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, new RegExp(visibleTitle));
  assert.doesNotMatch(result.stdout, new RegExp(hiddenTitle));
}

function assertOnlyQueried(selectedServer, skippedServer) {
  assert.equal(selectedServer.connectionLog.length, 1);
  assert.equal(skippedServer.connectionLog.length, 0);
  assertGotTargets(selectedServer);
}

function assertGotTargets(server) {
  assert.deepEqual(server.commandLog.map((message) => message.method), ['Target.getTargets']);
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
