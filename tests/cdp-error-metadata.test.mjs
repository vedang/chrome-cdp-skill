import test from 'node:test';
import assert from 'node:assert/strict';

import { CDP, CDPError } from '../skills/chrome-cdp/scripts/cdp.mjs';
import { createFakeChromeCDPServer } from './support/fake-cdp.mjs';

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
