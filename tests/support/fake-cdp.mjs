import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { once } from 'node:events';

const DEFAULT_HOST = '127.0.0.1';
const BROWSER_DEFAULTS = {
  'chrome-family': {
    product: 'Chrome/126.0.0.0',
    userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  },
  lightpanda: {
    product: 'Lightpanda/0.0.0',
    userAgent: 'Lightpanda/0.0.0',
  },
};
const ONE_BY_ONE_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

export class CDPProtocolError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'CDPProtocolError';
    this.code = code;
    this.data = data;
  }
}

export function createProtocolError(method, overrides = {}) {
  return new CDPProtocolError(
    overrides.code ?? -32601,
    overrides.message ?? 'Method not found',
    overrides.data ?? { method },
  );
}

export class FakeCDPServer {
  constructor(options = {}) {
    this.host = options.host ?? DEFAULT_HOST;
    this.browserKind = options.browserKind ?? 'chrome-family';
    const defaults = browserDefaults(this.browserKind);
    this.browserProduct = options.browserProduct ?? defaults.product;
    this.userAgent = options.userAgent ?? defaults.userAgent;
    this.protocolVersion = options.protocolVersion ?? '1.3';
    this.wsPath = options.wsPath ?? `/devtools/browser/${randomUUID()}`;
    this.defaultTitle = options.defaultTitle ?? 'Fake CDP Page';
    this.requestLog = [];
    this.connectionLog = [];
    this.commandLog = [];
    this.closed = false;
    this.#handlers = new Map(Object.entries(options.handlers ?? {}));
    this.#methodErrors = new Map(Object.entries(options.methodErrors ?? {}));
    this.#unsupportedMethods = new Set(options.unsupportedMethods ?? []);
    this.#targets = new Map();
    this.#sessions = new Map();
    for (const target of options.targets ?? [defaultTarget()]) {
      this.addTarget(target);
    }
  }

  #server;
  #sockets = new Set();
  #targets;
  #sessions;
  #handlers;
  #methodErrors;
  #unsupportedMethods;
  #nextTarget = 1;
  #nextSession = 1;

  get httpUrl() {
    if (!this.port) throw new Error('FakeCDPServer is not started');
    return `http://${this.host}:${this.port}`;
  }

  get wsUrl() {
    if (!this.port) throw new Error('FakeCDPServer is not started');
    return `ws://${this.host}:${this.port}${this.wsPath}`;
  }

  get versionUrl() {
    return `${this.httpUrl}/json/version`;
  }

  get targets() {
    return [...this.#targets.values()].map(copyTargetInfo);
  }

  async start() {
    if (this.#server) return this;
    this.#server = createServer((req, res) => this.#handleHttp(req, res));
    this.#server.on('upgrade', (req, socket, head) => this.#handleUpgrade(req, socket, head));
    this.#server.listen(0, this.host);
    await once(this.#server, 'listening');
    this.port = this.#server.address().port;
    return this;
  }

  async stop() {
    this.closed = true;
    for (const socket of this.#sockets) {
      socket.destroy();
    }
    this.#sockets.clear();
    if (!this.#server) return;
    const server = this.#server;
    this.#server = undefined;
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }

  async using(callback) {
    await this.start();
    try {
      return await callback(this);
    } finally {
      await this.stop();
    }
  }

  addTarget(target = {}) {
    const targetId = target.targetId ?? this.#makeTargetId();
    const url = target.url ?? 'about:blank';
    const info = {
      targetId,
      type: target.type ?? 'page',
      title: target.title ?? (url === 'about:blank' ? this.defaultTitle : url),
      url,
      attached: target.attached ?? false,
      canAccessOpener: target.canAccessOpener ?? false,
      browserContextId: target.browserContextId,
    };
    this.#targets.set(targetId, info);
    return copyTargetInfo(info);
  }

  setMethodError(method, error) {
    this.#methodErrors.set(method, error);
  }

  setUnsupported(method, enabled = true) {
    if (enabled) this.#unsupportedMethods.add(method);
    else this.#unsupportedMethods.delete(method);
  }

  writeDevToolsActivePort(filePath) {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    writeFileSync(filePath, `${this.port}\n${this.wsPath}\n`, { mode: 0o600 });
  }

  versionPayload() {
    return {
      Browser: this.browserProduct,
      'Protocol-Version': this.protocolVersion,
      'User-Agent': this.userAgent,
      V8: 'fake-v8',
      'WebKit-Version': 'fake-webkit',
      webSocketDebuggerUrl: this.wsUrl,
    };
  }

  async #handleHttp(req, res) {
    this.requestLog.push({ method: req.method, url: req.url });
    const url = new URL(req.url, this.httpUrl);
    if (url.pathname === '/json/version') {
      writeJson(res, this.versionPayload());
      return;
    }
    if (url.pathname === '/json/list') {
      writeJson(res, this.targets.map((target) => targetWithDebuggerUrl(target, this.wsUrl)));
      return;
    }
    if (url.pathname === '/json/new') {
      const target = this.addTarget({ url: url.searchParams.get('url') || 'about:blank' });
      writeJson(res, targetWithDebuggerUrl(target, this.wsUrl));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  #handleUpgrade(req, socket, head) {
    const url = new URL(req.url, this.httpUrl);
    if (url.pathname !== this.wsPath) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n'));
    this.#sockets.add(socket);
    this.connectionLog.push({ url: req.url });
    socket.on('close', () => this.#sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    const consume = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const parsed = parseClientFrames(buffer);
      buffer = parsed.rest;
      for (const frame of parsed.frames) {
        if (frame.opcode === 0x8) {
          socket.end(encodeServerFrame(Buffer.alloc(0), 0x8));
        } else if (frame.opcode === 0x9) {
          socket.write(encodeServerFrame(frame.payload, 0xA));
        } else if (frame.opcode === 0x1) {
          this.#handleWsMessage(socket, frame.payload.toString('utf8'));
        }
      }
    };
    if (head?.length) consume(head);
    socket.on('data', consume);
  }

  async #handleWsMessage(socket, text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      sendWsJson(socket, { error: { code: -32700, message: 'Parse error' } });
      return;
    }
    this.commandLog.push(message);
    try {
      const result = await this.#dispatch(message);
      if (message.id !== undefined) sendWsJson(socket, { id: message.id, result });
    } catch (error) {
      if (message.id !== undefined) sendWsJson(socket, { id: message.id, error: protocolErrorPayload(error, message.method) });
    }
  }

  async #dispatch(message) {
    const { method, params = {}, sessionId } = message;
    if (this.#unsupportedMethods.has(method)) throw createProtocolError(method);
    if (this.#methodErrors.has(method)) throw normalizeConfiguredError(method, this.#methodErrors.get(method));
    if (this.#handlers.has(method)) return await this.#handlers.get(method)(params, message, this);

    switch (method) {
      case 'Target.getTargets':
        return { targetInfos: this.targets };
      case 'Target.createTarget': {
        const target = this.addTarget({ url: params.url || 'about:blank' });
        this.#broadcast({ method: 'Target.targetCreated', params: { targetInfo: target } });
        return { targetId: target.targetId };
      }
      case 'Target.attachToTarget': {
        const targetId = params.targetId;
        if (!this.#targets.has(targetId)) throw new CDPProtocolError(-32000, `No target with given id ${targetId}`);
        const next = `session-${this.#nextSession++}`;
        this.#sessions.set(next, targetId);
        return { sessionId: next };
      }
      case 'Target.closeTarget':
        this.#targets.delete(params.targetId);
        this.#broadcast({ method: 'Target.targetDestroyed', params: { targetId: params.targetId } });
        return { success: true };
      case 'Runtime.enable':
      case 'Page.enable':
      case 'Network.enable':
      case 'DOM.enable':
        return {};
      case 'Runtime.evaluate':
        return { result: { type: 'undefined' } };
      case 'Accessibility.getFullAXTree':
        return { nodes: [{ nodeId: '1', role: { value: 'RootWebArea' }, name: { value: this.#targetForSession(sessionId)?.title ?? '' } }] };
      case 'Page.getLayoutMetrics':
        return {
          cssContentSize: { x: 0, y: 0, width: 800, height: 600 },
          layoutViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 },
          visualViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600, scale: 1 },
        };
      case 'Emulation.getDeviceMetricsOverride':
        return { deviceScaleFactor: 1 };
      case 'Page.captureScreenshot':
        return { data: ONE_BY_ONE_PNG_BASE64 };
      case 'Page.navigate': {
        const target = this.#targetForSession(sessionId);
        if (target) {
          target.url = params.url;
          target.title = params.url;
        }
        queueMicrotask(() => this.#broadcast({ method: 'Page.loadEventFired', params: { timestamp: Date.now() / 1000 }, sessionId }));
        return { frameId: 'frame-1', loaderId: `loader-${Date.now()}`, isDownload: false };
      }
      case 'DOM.getDocument':
        return { root: { nodeId: 1, backendNodeId: 1, nodeName: 'HTML', localName: 'html' } };
      case 'DOM.querySelector':
        return { nodeId: 2 };
      case 'DOM.getOuterHTML':
        return { outerHTML: '<html><body>Fake CDP Page</body></html>' };
      case 'Input.dispatchMouseEvent':
      case 'Input.insertText':
        return {};
      default:
        return {};
    }
  }

  #targetForSession(sessionId) {
    const targetId = this.#sessions.get(sessionId);
    return targetId ? this.#targets.get(targetId) : undefined;
  }

  #broadcast(message) {
    const payload = JSON.stringify(message);
    for (const socket of this.#sockets) socket.write(encodeServerFrame(Buffer.from(payload, 'utf8')));
  }

  #makeTargetId() {
    return `target-${String(this.#nextTarget++).padStart(4, '0')}-${randomUUID().replaceAll('-', '')}`;
  }
}

export function createFakeChromeCDPServer(options = {}) {
  return new FakeCDPServer({ ...options, browserKind: 'chrome-family' });
}

export function createFakeLightpandaCDPServer(options = {}) {
  return new FakeCDPServer({ ...options, browserKind: 'lightpanda' });
}

function defaultTarget() {
  return {
    targetId: 'target-0001-fakecdp',
    type: 'page',
    title: 'Fake CDP Page',
    url: 'https://example.test/',
  };
}

function browserDefaults(browserKind) {
  return BROWSER_DEFAULTS[browserKind] ?? BROWSER_DEFAULTS['chrome-family'];
}

function copyTargetInfo(target) {
  return withoutUndefined(target);
}

function targetWithDebuggerUrl(target, wsUrl) {
  return { ...target, webSocketDebuggerUrl: wsUrl };
}

function withoutUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function writeJson(res, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function normalizeConfiguredError(method, error) {
  if (error instanceof CDPProtocolError) return error;
  if (typeof error === 'string') return createProtocolError(method, { message: error });
  return createProtocolError(method, error);
}

function protocolErrorPayload(error, method) {
  if (error instanceof CDPProtocolError) {
    return withoutUndefined({ code: error.code, message: error.message, data: error.data });
  }
  return { code: -32000, message: error?.message ?? `Fake CDP handler failed for ${method}` };
}

function parseClientFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (buffer.length - offset < 4) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (buffer.length - offset < 10) break;
      const longLength = buffer.readBigUInt64BE(offset + 2);
      if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('WebSocket frame too large');
      length = Number(longLength);
      headerLength = 10;
    }
    const maskLength = masked ? 4 : 0;
    const payloadOffset = offset + headerLength + maskLength;
    const frameEnd = payloadOffset + length;
    if (buffer.length < frameEnd) break;
    let payload = Buffer.from(buffer.subarray(payloadOffset, frameEnd));
    if (masked) {
      const mask = buffer.subarray(offset + headerLength, offset + headerLength + 4);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    }
    frames.push({ opcode, payload });
    offset = frameEnd;
  }
  return { frames, rest: buffer.subarray(offset) };
}

function encodeServerFrame(payload, opcode = 0x1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, body.length]);
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([header, body]);
}

function sendWsJson(socket, payload) {
  socket.write(encodeServerFrame(Buffer.from(JSON.stringify(payload), 'utf8')));
}
