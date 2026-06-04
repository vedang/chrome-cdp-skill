import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createFakeChromeCDPServer,
  createFakeLightpandaCDPServer,
} from './support/fake-cdp.mjs';

test('fake Chrome-family CDP server serves /json/version and Target.getTargets over WebSocket', async () => {
  const server = await createFakeChromeCDPServer({
    targets: [{ targetId: 'chrome-target-0001', title: 'Chrome Page', url: 'https://chrome.test/' }],
  }).start();
  try {
    const version = await fetch(server.versionUrl).then((response) => response.json());
    assert.equal(version.Browser, 'Chrome/126.0.0.0');
    assert.equal(version.webSocketDebuggerUrl, server.wsUrl);

    const targets = await sendCdp(version.webSocketDebuggerUrl, 'Target.getTargets');
    assert.deepEqual(targets.targetInfos.map((target) => target.targetId), ['chrome-target-0001']);
    assert.equal(server.connectionLog.length, 1);
  } finally {
    await server.stop();
  }
});

test('fake Lightpanda CDP server reports Lightpanda product and configurable unsupported method errors', async () => {
  const server = await createFakeLightpandaCDPServer({
    unsupportedMethods: ['Page.captureScreenshot'],
  }).start();
  try {
    const version = await fetch(server.versionUrl).then((response) => response.json());
    assert.equal(version.Browser, 'Lightpanda/0.0.0');
    assert.equal(version['User-Agent'], 'Lightpanda/0.0.0');

    let error;
    try {
      await sendCdp(version.webSocketDebuggerUrl, 'Page.captureScreenshot');
    } catch (caught) {
      error = caught;
    }
    assert.match(error.message, /Method not found/);
    assert.equal(error.code, -32601);
    assert.deepEqual(error.data, { method: 'Page.captureScreenshot' });
  } finally {
    await server.stop();
  }
});

function sendCdp(wsUrl, method, params = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ id: 1, method, params }));
    });
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      ws.close();
      if (message.error) {
        const error = new Error(message.error.message);
        error.code = message.error.code;
        error.data = message.error.data;
        reject(error);
      } else {
        resolve(message.result);
      }
    });
    ws.addEventListener('error', (event) => {
      reject(new Error(event.message || 'WebSocket error'));
    });
  });
}
