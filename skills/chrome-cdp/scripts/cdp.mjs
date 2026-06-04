#!/usr/bin/env node
// cdp - lightweight Chrome DevTools Protocol CLI
// Uses raw CDP over WebSocket, no Puppeteer dependency.
// Requires Node 22+ (built-in WebSocket).
//
// Per-tab persistent daemon: page commands go through a daemon that holds
// the CDP session open. Chrome's "Allow debugging" modal fires once per
// daemon (= once per tab). Daemons auto-exit after 20min idle.

import { createHash } from 'crypto';
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import { pathToFileURL } from 'url';
import { spawn } from 'child_process';
import net from 'net';

const TIMEOUT = 15000;
const NAVIGATION_TIMEOUT = 30000;
const IDLE_TIMEOUT = 20 * 60 * 1000;
const DAEMON_CONNECT_RETRIES = 20;
const DAEMON_CONNECT_DELAY = 300;
const LIGHTPANDA_VERSION_RETRY_WINDOW_MS = 2000;
const LIGHTPANDA_VERSION_RETRY_DELAY_MS = 100;
const LIGHTPANDA_VERSION_FETCH_TIMEOUT_MS = 500;
const MIN_TARGET_PREFIX_LEN = 8;
const IS_WINDOWS = process.platform === 'win32';
if (!IS_WINDOWS) process.umask(0o077);
const RUNTIME_DIR = IS_WINDOWS
  ? resolve(process.env.LOCALAPPDATA || resolve(homedir(), 'AppData', 'Local'), 'cdp')
  : process.env.XDG_RUNTIME_DIR
    ? resolve(process.env.XDG_RUNTIME_DIR, 'cdp')
    : resolve(homedir(), '.cache', 'cdp');
try { mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 }); } catch {}
const PAGES_CACHE = resolve(RUNTIME_DIR, 'pages.json');
const PAGES_CACHE_VERSION = 2;
const CHROME_FAMILY_BROWSER_IDS = new Set(['auto', 'chrome', 'chromium', 'brave', 'edge', 'vivaldi']);
const SUPPORTED_CDP_BROWSER_VALUES = [...CHROME_FAMILY_BROWSER_IDS, 'lightpanda'].join(', ');
const CHROME_FAMILY_PROFILE_ORDER = {
  mac: ['chrome', 'chromium', 'brave', 'edge'],
  linux: ['chrome', 'chromium', 'vivaldi', 'brave', 'edge'],
  flatpak: ['chromium', 'chrome', 'brave', 'edge', 'vivaldi'],
  windows: ['chrome', 'brave', 'edge'],
};
const CHROME_FAMILY_PROFILES_BY_BROWSER = {
  mac: {
    chrome: ['Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome for Testing'],
    chromium: ['Chromium'],
    brave: ['BraveSoftware/Brave-Browser'],
    edge: ['Microsoft Edge'],
  },
  linux: {
    chrome: ['google-chrome', 'google-chrome-beta'],
    chromium: ['chromium'],
    vivaldi: ['vivaldi', 'vivaldi-snapshot'],
    brave: ['BraveSoftware/Brave-Browser'],
    edge: ['microsoft-edge'],
  },
  flatpak: {
    chromium: [['org.chromium.Chromium', 'chromium']],
    chrome: [['com.google.Chrome', 'google-chrome']],
    brave: [['com.brave.Browser', 'BraveSoftware/Brave-Browser']],
    edge: [['com.microsoft.Edge', 'microsoft-edge']],
    vivaldi: [['com.vivaldi.Vivaldi', 'vivaldi']],
  },
  windows: {
    chrome: ['Google/Chrome'],
    brave: ['BraveSoftware/Brave-Browser'],
    edge: ['Microsoft/Edge'],
  },
};

function safeSocketPart(value) {
  return String(value || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
}

function legacySockPath(targetId) {
  const safeTargetId = safeSocketPart(targetId);
  return IS_WINDOWS
    ? `\\\\.\\pipe\\cdp-${safeTargetId}`
    : resolve(RUNTIME_DIR, `cdp-${safeTargetId}.sock`);
}

function sockPath(browserKey, targetId) {
  const safeBrowserKey = safeSocketPart(browserKey);
  const safeTargetId = safeSocketPart(targetId);
  return IS_WINDOWS
    ? `\\\\.\\pipe\\cdp-${safeBrowserKey}-${safeTargetId}`
    : resolve(RUNTIME_DIR, `cdp-${safeBrowserKey}-${safeTargetId}.sock`);
}

function socketPathsForPage(page) {
  return [...new Set([sockPath(page.browserKey, page.targetId), legacySockPath(page.targetId)])];
}

async function getBrowserDescriptor() {
  const browserId = primaryBrowserId();
  if (browserId === 'lightpanda') return resolveLightpandaBrowser();
  if (CHROME_FAMILY_BROWSER_IDS.has(browserId)) return resolveChromeFamilyBrowser(browserId, 'primary');
  throw new Error(`Unsupported CDP_BROWSER: ${process.env.CDP_BROWSER}. Expected ${SUPPORTED_CDP_BROWSER_VALUES}.`);
}

function primaryBrowserId() {
  return String(process.env.CDP_BROWSER || 'auto').trim().toLowerCase() || 'auto';
}

function resolveChromeFamilyBrowser(browserId = 'auto', role = 'primary') {
  const normalizedBrowserId = normalizeChromeFamilyBrowserId(browserId);
  return makeBrowserDescriptor({
    browserId: descriptorChromeFamilyBrowserId(normalizedBrowserId),
    browserKind: 'chrome-family',
    ...resolveChromeFamilyEndpoint(normalizedBrowserId, role),
  });
}

async function resolveLightpandaBrowser() {
  return makeBrowserDescriptor({
    browserId: 'lightpanda',
    browserKind: 'lightpanda',
    ...await resolveLightpandaEndpoint(),
  });
}

function makeBrowserDescriptor(descriptor) {
  const normalized = {
    browserId: descriptor.browserId,
    browserKind: descriptor.browserKind,
    wsUrl: descriptor.wsUrl,
    source: descriptor.source,
  };
  return { browserKey: stableBrowserKey(normalized), ...normalized };
}

function stableBrowserKey({ browserId, browserKind, wsUrl }) {
  const digest = createHash('sha256')
    .update([browserKind, browserId, wsUrl].join('\0'))
    .digest('hex')
    .slice(0, 12);
  return `${browserId}-${digest}`;
}

function normalizeChromeFamilyBrowserId(browserId) {
  const normalized = String(browserId || 'auto').toLowerCase();
  if (CHROME_FAMILY_BROWSER_IDS.has(normalized)) return normalized;
  throw new Error(`Unsupported Chrome-family browser: ${browserId}`);
}

function descriptorChromeFamilyBrowserId(browserId) {
  return browserId === 'auto' ? 'chrome' : browserId;
}

function resolveChromeFamilyEndpoint(browserId = 'auto', role = 'primary') {
  const config = chromeFamilyRoleConfig(role);
  return {
    wsUrl: readDevToolsPortFile(findChromeFamilyDevToolsPortFile(browserId, role), config.host),
    source: config.portFile ? config.portFileEnv : 'DevToolsActivePort',
  };
}

function chromeFamilyRoleConfig(role) {
  if (role === 'fallback') {
    return {
      portFile: process.env.CDP_FALLBACK_PORT_FILE,
      portFileEnv: 'CDP_FALLBACK_PORT_FILE',
      host: process.env.CDP_FALLBACK_HOST || '127.0.0.1',
    };
  }
  return {
    portFile: process.env.CDP_PORT_FILE,
    portFileEnv: 'CDP_PORT_FILE',
    host: process.env.CDP_HOST || '127.0.0.1',
  };
}

function findChromeFamilyDevToolsPortFile(browserId = 'auto', role = 'primary') {
  const portFile = chromeFamilyDevToolsPortCandidates(browserId, role).find(p => existsSync(p));
  if (!portFile) throw new Error('No DevToolsActivePort found. Enable remote debugging at chrome://inspect/#remote-debugging');
  return portFile;
}

function chromeFamilyDevToolsPortCandidates(browserId = 'auto', role = 'primary') {
  const home = homedir();
  return [
    chromeFamilyRoleConfig(role).portFile,
    ...profileDevToolsPortCandidates(resolve(home, 'Library/Application Support'), chromeFamilyProfiles(browserId, 'mac')),
    ...profileDevToolsPortCandidates(resolve(home, '.config'), chromeFamilyProfiles(browserId, 'linux')),
    ...flatpakDevToolsPortCandidates(home, chromeFamilyProfiles(browserId, 'flatpak')),
    ...windowsDevToolsPortCandidates(home, browserId),
  ].filter(Boolean);
}

function chromeFamilyProfiles(browserId, platform) {
  const browserIds = browserId === 'auto' ? CHROME_FAMILY_PROFILE_ORDER[platform] : [browserId];
  return browserIds.flatMap(id => CHROME_FAMILY_PROFILES_BY_BROWSER[platform][id] || []);
}

function profileDevToolsPortCandidates(baseDir, browsers) {
  return browsers.flatMap(b => [
    resolve(baseDir, b, 'DevToolsActivePort'),
    resolve(baseDir, b, 'Default/DevToolsActivePort'),
  ]);
}

function flatpakDevToolsPortCandidates(home, browsers) {
  return browsers.flatMap(([appId, name]) => [
    resolve(home, '.var/app', appId, 'config', name, 'DevToolsActivePort'),
    resolve(home, '.var/app', appId, 'config', name, 'Default/DevToolsActivePort'),
  ]);
}

function windowsDevToolsPortCandidates(home, browserId = 'auto') {
  if (!IS_WINDOWS) return [];
  const base = process.env.LOCALAPPDATA || resolve(home, 'AppData/Local');
  const profiles = chromeFamilyProfiles(browserId, 'windows');
  return profileDevToolsPortCandidates(resolve(base), profiles.map(b => `${b}/User Data`));
}

function readDevToolsPortFile(portFile, host = '127.0.0.1') {
  const lines = readFileSync(portFile, 'utf8').trim().split('\n');
  if (lines.length < 2 || !lines[0] || !lines[1]) throw new Error(`Invalid DevToolsActivePort file: ${portFile}`);
  return `ws://${host}:${lines[0]}${lines[1]}`;
}

async function resolveLightpandaEndpoint() {
  const explicitWsUrl = process.env.CDP_LIGHTPANDA_WS_URL;
  const httpBaseUrl = explicitWsUrl
    ? httpBaseUrlFromWsUrl(explicitWsUrl)
    : lightpandaHttpBaseUrl();
  const version = await fetchLightpandaVersion(httpBaseUrl);
  validateLightpandaVersion(version);
  return {
    wsUrl: explicitWsUrl || version.webSocketDebuggerUrl,
    source: lightpandaEndpointSource(),
  };
}

function lightpandaEndpointSource() {
  if (process.env.CDP_LIGHTPANDA_WS_URL) return 'CDP_LIGHTPANDA_WS_URL';
  if (process.env.CDP_LIGHTPANDA_URL) return 'CDP_LIGHTPANDA_URL';
  return 'CDP_LIGHTPANDA_HOST/CDP_LIGHTPANDA_PORT';
}

function lightpandaHttpBaseUrl() {
  if (process.env.CDP_LIGHTPANDA_URL) {
    const url = new URL(process.env.CDP_LIGHTPANDA_URL);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('CDP_LIGHTPANDA_URL must use http:// or https://');
    }
    return normalizeBaseUrl(url);
  }
  const host = process.env.CDP_LIGHTPANDA_HOST || '127.0.0.1';
  const port = process.env.CDP_LIGHTPANDA_PORT || '9222';
  return `http://${host}:${port}`;
}

function httpBaseUrlFromWsUrl(wsUrl) {
  const url = new URL(wsUrl);
  if (url.protocol === 'ws:') url.protocol = 'http:';
  else if (url.protocol === 'wss:') url.protocol = 'https:';
  else throw new Error('CDP_LIGHTPANDA_WS_URL must use ws:// or wss://');
  return normalizeBaseUrl(url);
}

function normalizeBaseUrl(url) {
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

async function fetchLightpandaVersion(httpBaseUrl) {
  const deadline = Date.now() + LIGHTPANDA_VERSION_RETRY_WINDOW_MS;
  for (;;) {
    try {
      return await fetchLightpandaVersionOnce(httpBaseUrl);
    } catch (error) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw error;
      await sleep(Math.min(LIGHTPANDA_VERSION_RETRY_DELAY_MS, remaining));
    }
  }
}

async function fetchLightpandaVersionOnce(httpBaseUrl) {
  let response;
  try {
    response = await fetch(`${httpBaseUrl}/json/version`, {
      signal: AbortSignal.timeout(LIGHTPANDA_VERSION_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`Lightpanda /json/version failed: ${error.message}`);
  }
  if (!response.ok) throw new Error(`Lightpanda /json/version failed: HTTP ${response.status}`);
  const version = await response.json();
  if (!version.webSocketDebuggerUrl) throw new Error('Lightpanda /json/version missing webSocketDebuggerUrl');
  return version;
}

function validateLightpandaVersion(version) {
  if (process.env.CDP_LIGHTPANDA_ALLOW_NON_LIGHTPANDA === '1') return;
  const browser = String(version.Browser || '');
  const userAgent = String(version['User-Agent'] || '');
  if (browser.startsWith('Lightpanda/') || userAgent.startsWith('Lightpanda/')) return;
  throw new Error(`Expected Lightpanda CDP endpoint, got Browser=${browser || '<missing>'} User-Agent=${userAgent || '<missing>'}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function exitAfterCdpCleanup() {
  setTimeout(() => process.exit(0), 100);
}

function resolvePrefix(prefix, candidates, noun = 'target', missingHint = '') {
  const upper = prefix.toUpperCase();
  const matches = candidates.filter(candidate => candidate.toUpperCase().startsWith(upper));
  if (matches.length === 0) {
    const hint = missingHint ? ` ${missingHint}` : '';
    throw new Error(`No ${noun} matching prefix "${prefix}".${hint}`);
  }
  if (matches.length > 1) {
    throw new Error(`Ambiguous prefix "${prefix}" — matches ${matches.length} ${noun}s. Use more characters.`);
  }
  return matches[0];
}

function getDisplayPrefixLength(targetIds) {
  if (targetIds.length === 0) return MIN_TARGET_PREFIX_LEN;
  const maxLen = Math.max(...targetIds.map(id => id.length));
  for (let len = MIN_TARGET_PREFIX_LEN; len <= maxLen; len++) {
    const prefixes = new Set(targetIds.map(id => id.slice(0, len).toUpperCase()));
    if (prefixes.size === targetIds.length) return len;
  }
  return maxLen;
}

function cacheBrowserDescriptor(descriptor) {
  return {
    browserId: descriptor.browserId,
    browserKind: descriptor.browserKind,
    wsUrl: descriptor.wsUrl,
    source: descriptor.source,
  };
}

function cachePageRecord(page, descriptor) {
  return {
    browserKey: page.browserKey || descriptor.browserKey,
    browserId: page.browserId || descriptor.browserId,
    browserKind: page.browserKind || descriptor.browserKind,
    targetId: page.targetId,
    title: page.title || '',
    url: page.url || '',
  };
}

function pagesCacheV2(primaryBrowserKey, browsers, pages) {
  return { version: PAGES_CACHE_VERSION, primaryBrowserKey, browsers, pages };
}

function makePagesCache(descriptor, pages) {
  const browserKey = descriptor.browserKey;
  return pagesCacheV2(
    browserKey,
    { [browserKey]: cacheBrowserDescriptor(descriptor) },
    pages.map(page => cachePageRecord(page, descriptor)),
  );
}

function writePagesCache(descriptor, pages) {
  writeNormalizedPagesCache(makePagesCache(descriptor, pages));
}

function writeNormalizedPagesCache(cache) {
  writeFileSync(PAGES_CACHE, JSON.stringify(normalizePagesCache(cache)), { mode: 0o600 });
}

function readRawPagesCache() {
  return JSON.parse(readFileSync(PAGES_CACHE, 'utf8'));
}

function legacyBrowserDescriptor() {
  return {
    browserKey: 'legacy',
    browserId: 'chrome',
    browserKind: 'chrome-family',
    wsUrl: '',
    source: 'legacy-pages-cache',
  };
}

function normalizePagesCache(raw, currentDescriptor) {
  if (Array.isArray(raw)) {
    if (!currentDescriptor) throw new Error('Old pages cache requires current browser. Run "cdp list" again.');
    return makePagesCache(currentDescriptor, raw);
  }
  if (!raw || typeof raw !== 'object') throw new Error('Invalid pages cache. Run "cdp list" again.');

  const browsers = (raw.browsers && typeof raw.browsers === 'object') ? { ...raw.browsers } : {};
  if (currentDescriptor && !browsers[currentDescriptor.browserKey]) {
    browsers[currentDescriptor.browserKey] = cacheBrowserDescriptor(currentDescriptor);
  }
  const primaryBrowserKey = raw.primaryBrowserKey || currentDescriptor?.browserKey || Object.keys(browsers)[0];
  const pages = Array.isArray(raw.pages) ? raw.pages : [];
  const normalizedPages = pages.map(page => {
    const browserKey = page.browserKey || primaryBrowserKey || currentDescriptor?.browserKey;
    const browser = browsers[browserKey] || (currentDescriptor?.browserKey === browserKey ? currentDescriptor : {});
    return {
      browserKey,
      browserId: page.browserId || browser.browserId || 'chrome',
      browserKind: page.browserKind || browser.browserKind || 'chrome-family',
      targetId: page.targetId,
      title: page.title || '',
      url: page.url || '',
    };
  }).filter(page => page.targetId && page.browserKey);

  return pagesCacheV2(primaryBrowserKey, browsers, normalizedPages);
}

function readPagesCache(currentDescriptor) {
  return normalizePagesCache(readRawPagesCache(), currentDescriptor);
}

async function readPagesCacheForPageCommand() {
  const raw = readRawPagesCache();
  if (!Array.isArray(raw)) return normalizePagesCache(raw);
  let descriptor;
  try { descriptor = await getBrowserDescriptor(); }
  catch (error) {
    throw new Error(`Old pages cache cannot be used without current browser descriptor (${error.message}). Run "cdp list" again.`);
  }
  const cache = normalizePagesCache(raw, descriptor);
  writeNormalizedPagesCache(cache);
  return cache;
}

async function readPagesCacheForStop() {
  const raw = readRawPagesCache();
  if (!Array.isArray(raw)) return normalizePagesCache(raw);
  let descriptor;
  try { descriptor = await getBrowserDescriptor(); }
  catch { descriptor = legacyBrowserDescriptor(); }
  return normalizePagesCache(raw, descriptor);
}

function getCachedBrowserDescriptor(browserKey) {
  const cache = readPagesCache();
  const browser = cache.browsers[browserKey];
  if (!browser?.wsUrl) throw new Error(`Browser ${browserKey} missing from pages cache. Run "cdp list" again.`);
  return { browserKey, ...browser };
}

function resolvePageRecord(targetPrefix, cache) {
  const targetIds = [...new Set(cache.pages.map(p => p.targetId))];
  const targetId = resolvePrefix(targetPrefix, targetIds, 'target', 'Run "cdp list".');
  const page = cache.pages.find(p => p.targetId === targetId);
  if (!page) throw new Error(`No target matching prefix "${targetPrefix}". Run "cdp list".`);
  return page;
}

// ---------------------------------------------------------------------------
// CDP WebSocket client
// ---------------------------------------------------------------------------

export class CDPError extends Error {
  constructor(method, error = {}, sessionId) {
    super(String(error.message || `CDP error: ${method}`));
    this.name = 'CDPError';
    this.method = method;
    this.code = error.code;
    this.data = error.data;
    this.sessionId = sessionId;
  }
}

export class CDP {
  #ws; #id = 0; #pending = new Map(); #eventHandlers = new Map(); #closeHandlers = [];

  async connect(wsUrl) {
    return new Promise((res, rej) => {
      this.#ws = new WebSocket(wsUrl);
      this.#ws.onopen = () => res();
      this.#ws.onerror = (e) => rej(new Error('WebSocket error: ' + (e.message || e.type)));
      this.#ws.onclose = () => this.#closeHandlers.forEach(h => h());
      this.#ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && this.#pending.has(msg.id)) {
          const { resolve, reject, method, sessionId, timer } = this.#pending.get(msg.id);
          this.#pending.delete(msg.id);
          clearTimeout(timer);
          if (msg.error) reject(new CDPError(method, msg.error, sessionId));
          else resolve(msg.result);
        } else if (msg.method && this.#eventHandlers.has(msg.method)) {
          for (const handler of [...this.#eventHandlers.get(msg.method)]) {
            handler(msg.params || {}, msg);
          }
        }
      };
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#pending.has(id)) {
          this.#pending.delete(id);
          reject(new Error(`Timeout: ${method}`));
        }
      }, TIMEOUT);
      this.#pending.set(id, { resolve, reject, method, sessionId, timer });
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      this.#ws.send(JSON.stringify(msg));
    });
  }

  onEvent(method, handler) {
    if (!this.#eventHandlers.has(method)) this.#eventHandlers.set(method, new Set());
    const handlers = this.#eventHandlers.get(method);
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.#eventHandlers.delete(method);
    };
  }

  waitForEvent(method, timeout = TIMEOUT) {
    let settled = false;
    let off;
    let timer;
    const promise = new Promise((resolve, reject) => {
      off = this.onEvent(method, (params) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        resolve(params);
      });
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        off();
        reject(new Error(`Timeout waiting for event: ${method}`));
      }, timeout);
    });
    return {
      promise,
      cancel() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off?.();
      },
    };
  }

  onClose(handler) { this.#closeHandlers.push(handler); }
  close() { this.#ws.close(); }
}

const UNSUPPORTED_CDP_ERROR_MESSAGES = new Set([
  'method not found',
  'unknown method',
  'not implemented',
  'unsupported',
]);

export function isUnsupportedCdpError(error) {
  if (!(error instanceof CDPError)) return false;
  if (error.code === -32601) return true;
  return unsupportedCdpMessageCandidates(error).some(message => UNSUPPORTED_CDP_ERROR_MESSAGES.has(message));
}

function unsupportedCdpMessageCandidates(error) {
  const dataMessages = typeof error.data === 'string'
    ? [error.data]
    : [error.data?.message, error.data?.error];
  return [error.message, ...dataMessages]
    .filter(value => typeof value === 'string')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
}

function formatErrorData(data) {
  if (data == null) return '';
  if (typeof data === 'string') return data;
  try { return JSON.stringify(data); }
  catch { return String(data); }
}

function commandErrorResponse(error) {
  const response = { ok: false, error: error.message };
  if (error instanceof CDPError) {
    response.errorCode = error.code;
    response.errorMethod = error.method;
    response.errorData = error.data;
  }
  if (isUnsupportedCdpError(error)) response.unsupportedMethod = error.method;
  return response;
}

// ---------------------------------------------------------------------------
// Command implementations — return strings, take (cdp, sessionId)
// ---------------------------------------------------------------------------

async function getPages(cdp) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  return targetInfos.filter(t => t.type === 'page' && !t.url.startsWith('chrome://'));
}

function formatPageList(pages) {
  const prefixLen = getDisplayPrefixLength(pages.map(p => p.targetId));
  return pages.map(p => {
    const id = p.targetId.slice(0, prefixLen).padEnd(prefixLen);
    const title = p.title.substring(0, 54).padEnd(54);
    return `${id}  ${title}  ${p.url}`;
  }).join('\n');
}

function shouldShowAxNode(node, compact = false) {
  const role = node.role?.value || '';
  const name = node.name?.value ?? '';
  const value = node.value?.value;
  if (compact && role === 'InlineTextBox') return false;
  return role !== 'none' && role !== 'generic' && !(name === '' && (value === '' || value == null));
}

function formatAxNode(node, depth) {
  const role = node.role?.value || '';
  const name = node.name?.value ?? '';
  const value = node.value?.value;
  const indent = '  '.repeat(Math.min(depth, 10));
  let line = `${indent}[${role}]`;
  if (name !== '') line += ` ${name}`;
  if (!(value === '' || value == null)) line += ` = ${JSON.stringify(value)}`;
  return line;
}

function orderedAxChildren(node, nodesById, childrenByParent) {
  const children = [];
  const seen = new Set();
  for (const childId of node.childIds || []) {
    const child = nodesById.get(childId);
    if (child && !seen.has(child.nodeId)) {
      seen.add(child.nodeId);
      children.push(child);
    }
  }
  for (const child of childrenByParent.get(node.nodeId) || []) {
    if (!seen.has(child.nodeId)) {
      seen.add(child.nodeId);
      children.push(child);
    }
  }
  return children;
}

async function snapshotStr(cdp, sid, compact = false) {
  const { nodes } = await cdp.send('Accessibility.getFullAXTree', {}, sid);
  const nodesById = new Map(nodes.map(node => [node.nodeId, node]));
  const childrenByParent = new Map();
  for (const node of nodes) {
    if (!node.parentId) continue;
    if (!childrenByParent.has(node.parentId)) childrenByParent.set(node.parentId, []);
    childrenByParent.get(node.parentId).push(node);
  }

  const lines = [];
  const visited = new Set();
  function visit(node, depth) {
    if (!node || visited.has(node.nodeId)) return;
    visited.add(node.nodeId);
    if (shouldShowAxNode(node, compact)) lines.push(formatAxNode(node, depth));
    for (const child of orderedAxChildren(node, nodesById, childrenByParent)) {
      visit(child, depth + 1);
    }
  }

  const roots = nodes.filter(node => !node.parentId || !nodesById.has(node.parentId));
  for (const root of roots) visit(root, 0);
  for (const node of nodes) visit(node, 0);

  return lines.join('\n');
}

async function evalStr(cdp, sid, expression) {
  await cdp.send('Runtime.enable', {}, sid);
  const result = await cdp.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  }, sid);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || result.exceptionDetails.exception?.description);
  }
  const val = result.result.value;
  return typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val ?? '');
}

async function shotStr(cdp, sid, filePath, targetId) {
  // Get device scale factor so we can report coordinate mapping
  let dpr = 1;
  try {
    const metrics = await cdp.send('Page.getLayoutMetrics', {}, sid);
    dpr = metrics.visualViewport?.clientWidth
      ? metrics.cssVisualViewport?.clientWidth
        ? Math.round((metrics.visualViewport.clientWidth / metrics.cssVisualViewport.clientWidth) * 100) / 100
        : 1
      : 1;
    // Simpler: deviceScaleFactor is on the root Page metrics
    const { deviceScaleFactor } = await cdp.send('Emulation.getDeviceMetricsOverride', {}, sid).catch(() => ({}));
    if (deviceScaleFactor) dpr = deviceScaleFactor;
  } catch {}
  // Fallback: try to get DPR from JS
  if (dpr === 1) {
    try {
      const raw = await evalStr(cdp, sid, 'window.devicePixelRatio');
      const parsed = parseFloat(raw);
      if (parsed > 0) dpr = parsed;
    } catch {}
  }

  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sid);
  const out = filePath || resolve(RUNTIME_DIR, `screenshot-${(targetId || 'unknown').slice(0, 8)}.png`);
  writeFileSync(out, Buffer.from(data, 'base64'));

  const lines = [out];
  lines.push(`Screenshot saved. Device pixel ratio (DPR): ${dpr}`);
  lines.push(`Coordinate mapping:`);
  lines.push(`  Screenshot pixels → CSS pixels (for CDP Input events): divide by ${dpr}`);
  lines.push(`  e.g. screenshot point (${Math.round(100 * dpr)}, ${Math.round(200 * dpr)}) → CSS (100, 200) → use clickxy <target> 100 200`);
  if (dpr !== 1) {
    lines.push(`  On this ${dpr}x display: CSS px = screenshot px / ${dpr} ≈ screenshot px × ${Math.round(100/dpr)/100}`);
  }
  return lines.join('\n');
}

async function htmlStr(cdp, sid, selector) {
  const expr = selector
    ? `document.querySelector(${JSON.stringify(selector)})?.outerHTML || 'Element not found'`
    : `document.documentElement.outerHTML`;
  return evalStr(cdp, sid, expr);
}

async function waitForDocumentReady(cdp, sid, timeoutMs = NAVIGATION_TIMEOUT) {
  const deadline = Date.now() + timeoutMs;
  let lastState = '';
  let lastError;
  while (Date.now() < deadline) {
    try {
      const state = await evalStr(cdp, sid, 'document.readyState');
      lastState = state;
      if (state === 'complete') return;
    } catch (e) {
      lastError = e;
    }
    await sleep(200);
  }

  if (lastState) {
    throw new Error(`Timed out waiting for navigation to finish (last readyState: ${lastState})`);
  }
  if (lastError) {
    throw new Error(`Timed out waiting for navigation to finish (${lastError.message})`);
  }
  throw new Error('Timed out waiting for navigation to finish');
}

async function navStr(cdp, sid, url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      throw new Error(`Only http/https URLs allowed, got: ${url}`);
  } catch (e) {
    if (e.message.startsWith('Only')) throw e;
    throw new Error(`Invalid URL: ${url}`);
  }
  await cdp.send('Page.enable', {}, sid);
  const loadEvent = cdp.waitForEvent('Page.loadEventFired', NAVIGATION_TIMEOUT);
  const result = await cdp.send('Page.navigate', { url }, sid);
  if (result.errorText) {
    loadEvent.cancel();
    throw new Error(result.errorText);
  }
  if (result.loaderId) {
    await loadEvent.promise;
  } else {
    loadEvent.cancel();
  }
  await waitForDocumentReady(cdp, sid, 5000);
  return `Navigated to ${url}`;
}

async function netStr(cdp, sid) {
  const raw = await evalStr(cdp, sid, `JSON.stringify(performance.getEntriesByType('resource').map(e => ({
    name: e.name.substring(0, 120), type: e.initiatorType,
    duration: Math.round(e.duration), size: e.transferSize
  })))`);
  return JSON.parse(raw).map(e =>
    `${String(e.duration).padStart(5)}ms  ${String(e.size || '?').padStart(8)}B  ${e.type.padEnd(8)}  ${e.name}`
  ).join('\n');
}

// Click element by CSS selector
async function clickStr(cdp, sid, selector) {
  if (!selector) throw new Error('CSS selector required');
  const expr = `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
      el.scrollIntoView({ block: 'center' });
      el.click();
      return { ok: true, tag: el.tagName, text: el.textContent.trim().substring(0, 80) };
    })()
  `;
  const result = await evalStr(cdp, sid, expr);
  const r = JSON.parse(result);
  if (!r.ok) throw new Error(r.error);
  return `Clicked <${r.tag}> "${r.text}"`;
}

// Click at CSS pixel coordinates using Input.dispatchMouseEvent
async function clickXyStr(cdp, sid, x, y) {
  const cx = parseFloat(x);
  const cy = parseFloat(y);
  if (isNaN(cx) || isNaN(cy)) throw new Error('x and y must be numbers (CSS pixels)');
  const base = { x: cx, y: cy, button: 'left', clickCount: 1, modifiers: 0 };
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved' }, sid);
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' }, sid);
  await sleep(50);
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' }, sid);
  return `Clicked at CSS (${cx}, ${cy})`;
}

// Type text using Input.insertText (works in cross-origin iframes, unlike eval)
async function typeStr(cdp, sid, text) {
  if (text == null || text === '') throw new Error('text required');
  await cdp.send('Input.insertText', { text }, sid);
  return `Typed ${text.length} characters`;
}

// Load-more: repeatedly click a button/selector until it disappears
async function loadAllStr(cdp, sid, selector, intervalMs = 1500) {
  if (!selector) throw new Error('CSS selector required');
  let clicks = 0;
  const deadline = Date.now() + 5 * 60 * 1000; // 5-minute hard cap
  while (Date.now() < deadline) {
    const exists = await evalStr(cdp, sid,
      `!!document.querySelector(${JSON.stringify(selector)})`
    );
    if (exists !== 'true') break;
    const clickExpr = `
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        el.click();
        return true;
      })()
    `;
    const clicked = await evalStr(cdp, sid, clickExpr);
    if (clicked !== 'true') break;
    clicks++;
    await sleep(intervalMs);
  }
  return `Clicked "${selector}" ${clicks} time(s) until it disappeared`;
}

// Send a raw CDP command and return the result as JSON
async function evalRawStr(cdp, sid, method, paramsJson) {
  if (!method) throw new Error('CDP method required (e.g. "DOM.getDocument")');
  let params = {};
  if (paramsJson) {
    try { params = JSON.parse(paramsJson); }
    catch { throw new Error(`Invalid JSON params: ${paramsJson}`); }
  }
  const result = await cdp.send(method, params, sid);
  return JSON.stringify(result, null, 2);
}

// ---------------------------------------------------------------------------
// Per-tab daemon
// ---------------------------------------------------------------------------

async function runDaemon(browserKey, targetId) {
  if (!browserKey || !targetId) {
    process.stderr.write('Daemon: missing browser key or target id\n');
    process.exit(1);
  }
  const descriptor = getCachedBrowserDescriptor(browserKey);
  const sp = sockPath(browserKey, targetId);

  const cdp = new CDP();
  try {
    await cdp.connect(descriptor.wsUrl);
  } catch (e) {
    process.stderr.write(`Daemon: cannot connect to browser: ${e.message}\n`);
    process.exit(1);
  }

  let sessionId;
  try {
    const res = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    sessionId = res.sessionId;
  } catch (e) {
    process.stderr.write(`Daemon: attach failed: ${e.message}\n`);
    cdp.close();
    process.exit(1);
  }

  // Shutdown helpers
  let alive = true;
  function shutdown() {
    if (!alive) return;
    alive = false;
    server.close();
    if (!IS_WINDOWS) try { unlinkSync(sp); } catch {}
    cdp.close();
    process.exit(0);
  }

  // Exit if target goes away or Chrome disconnects
  cdp.onEvent('Target.targetDestroyed', (params) => {
    if (params.targetId === targetId) shutdown();
  });
  cdp.onEvent('Target.detachedFromTarget', (params) => {
    if (params.sessionId === sessionId) shutdown();
  });
  cdp.onClose(() => shutdown());
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Idle timer
  let idleTimer = setTimeout(shutdown, IDLE_TIMEOUT);
  function resetIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(shutdown, IDLE_TIMEOUT);
  }

  // Handle a command
  async function handleCommand({ cmd, args }) {
    resetIdle();
    try {
      let result;
      switch (cmd) {
        case 'list': {
          const pages = await getPages(cdp);
          result = formatPageList(pages);
          break;
        }
        case 'list_raw': {
          const pages = await getPages(cdp);
          result = JSON.stringify(pages);
          break;
        }
        case 'snap': case 'snapshot': result = await snapshotStr(cdp, sessionId, true); break;
        case 'eval': result = await evalStr(cdp, sessionId, args[0]); break;
        case 'shot': case 'screenshot': result = await shotStr(cdp, sessionId, args[0], targetId); break;
        case 'html': result = await htmlStr(cdp, sessionId, args[0]); break;
        case 'nav': case 'navigate': result = await navStr(cdp, sessionId, args[0]); break;
        case 'net': case 'network': result = await netStr(cdp, sessionId); break;
        case 'click': result = await clickStr(cdp, sessionId, args[0]); break;
        case 'clickxy': result = await clickXyStr(cdp, sessionId, args[0], args[1]); break;
        case 'type': result = await typeStr(cdp, sessionId, args[0]); break;
        case 'loadall': result = await loadAllStr(cdp, sessionId, args[0], args[1] ? parseInt(args[1]) : 1500); break;
        case 'evalraw': result = await evalRawStr(cdp, sessionId, args[0], args[1]); break;
        case 'stop': return { ok: true, result: '', stopAfter: true };
        default: return { ok: false, error: `Unknown command: ${cmd}` };
      }
      return { ok: true, result: result ?? '' };
    } catch (e) {
      return commandErrorResponse(e);
    }
  }

  // Unix socket server — NDJSON protocol
  // Wire format: each message is one JSON object followed by \n (newline-delimited JSON).
  // Request:  { "id": <number>, "cmd": "<command>", "args": ["arg1", "arg2", ...] }
  // Response: { "id": <number>, "ok": <boolean>, "result": "<string>" }
  //           or { "id": <number>, "ok": false, "error": "<message>" }
  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop(); // keep incomplete last line
      for (const line of lines) {
        if (!line.trim()) continue;
        let req;
        try {
          req = JSON.parse(line);
        } catch {
          conn.write(JSON.stringify({ ok: false, error: 'Invalid JSON request', id: null }) + '\n');
          continue;
        }
        handleCommand(req).then((res) => {
          const payload = JSON.stringify({ ...res, id: req.id }) + '\n';
          if (res.stopAfter) conn.end(payload, shutdown);
          else conn.write(payload);
        });
      }
    });
  });

  server.on('error', (e) => {
    process.stderr.write(`Daemon server listen failed: ${e.message}\n`);
    process.exit(1);
  });

  if (!IS_WINDOWS) try { unlinkSync(sp); } catch {}
  server.listen(sp);
}

// ---------------------------------------------------------------------------
// CLI ↔ daemon communication
// ---------------------------------------------------------------------------

function connectToSocket(sp) {
  return new Promise((resolve, reject) => {
    const conn = net.connect(sp);
    conn.on('connect', () => resolve(conn));
    conn.on('error', reject);
  });
}

async function getOrStartTabDaemon(page) {
  const sp = sockPath(page.browserKey, page.targetId);
  // Try existing daemon
  try { return await connectToSocket(sp); } catch {}

  // Clean stale socket
  if (!IS_WINDOWS) try { unlinkSync(sp); } catch {}

  // Spawn daemon
  const child = spawn(process.execPath, [process.argv[1], '_daemon', page.browserKey, page.targetId], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // Wait for socket (includes time for user to click Allow)
  for (let i = 0; i < DAEMON_CONNECT_RETRIES; i++) {
    await sleep(DAEMON_CONNECT_DELAY);
    try { return await connectToSocket(sp); } catch {}
  }
  throw new Error('Daemon failed to start — did you click Allow in Chrome?');
}

function sendCommand(conn, req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let settled = false;

    const cleanup = () => {
      conn.off('data', onData);
      conn.off('error', onError);
      conn.off('end', onEnd);
      conn.off('close', onClose);
    };

    const onData = (chunk) => {
      buf += chunk.toString();
      const idx = buf.indexOf('\n');
      if (idx === -1) return;
      settled = true;
      cleanup();
      resolve(JSON.parse(buf.slice(0, idx)));
      conn.end();
    };

    const onError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Connection closed before response'));
    };

    const onClose = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Connection closed before response'));
    };

    conn.on('data', onData);
    conn.on('error', onError);
    conn.on('end', onEnd);
    conn.on('close', onClose);
    req.id = 1;
    conn.write(JSON.stringify(req) + '\n');
  });
}

// ---------------------------------------------------------------------------
// Stop daemons
// ---------------------------------------------------------------------------

async function stopDaemons(targetPrefix) {
  if (!existsSync(PAGES_CACHE)) return;
  const cache = await readPagesCacheForStop();
  const pages = targetPrefix
    ? [resolvePageRecord(targetPrefix, cache)]
    : cache.pages;

  for (const page of pages) {
    await Promise.all(socketPathsForPage(page).map(stopSocket));
  }
}

async function stopSocket(sp) {
  try {
    const conn = await connectToSocket(sp);
    await sendCommand(conn, { cmd: 'stop' });
  } catch {
    if (!IS_WINDOWS) try { unlinkSync(sp); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const USAGE = `cdp - lightweight Chrome DevTools Protocol CLI (no Puppeteer)

Usage: cdp <command> [args]

  list                              List open pages (shows unique target prefixes)
  snap  <target>                    Accessibility tree snapshot
  eval  <target> <expr>             Evaluate JS expression
  shot  <target> [file]             Screenshot (default: screenshot-<target>.png in runtime dir); prints coordinate mapping
  html  <target> [selector]         Get HTML (full page or CSS selector)
  nav   <target> <url>              Navigate to URL and wait for load completion
  net   <target>                    Network performance entries
  click   <target> <selector>       Click an element by CSS selector
  clickxy <target> <x> <y>          Click at CSS pixel coordinates (see coordinate note below)
  type    <target> <text>           Type text at current focus via Input.insertText
                                    Works in cross-origin iframes unlike eval-based approaches
  loadall <target> <selector> [ms]  Repeatedly click a "load more" button until it disappears
                                    Optional interval in ms between clicks (default 1500)
  evalraw <target> <method> [json]  Send a raw CDP command; returns JSON result
                                    e.g. evalraw <t> "DOM.getDocument" '{}'
  open  [url]                       Open a new tab (default: about:blank)
                                    Note: each new tab triggers a fresh "Allow debugging?" prompt
  stop  [target]                    Stop daemon(s)

<target> is a unique targetId prefix from "cdp list". If a prefix is ambiguous,
use more characters.

COORDINATE SYSTEM
  shot captures the viewport at the device's native resolution.
  The screenshot image size = CSS pixels × DPR (device pixel ratio).
  For CDP Input events (clickxy, etc.) you need CSS pixels, not image pixels.

    CSS pixels = screenshot image pixels / DPR

  shot prints the DPR and an example conversion for the current page.
  Typical Retina (DPR=2): CSS px ≈ screenshot px × 0.5
  If your viewer rescales the image further, account for that scaling too.

EVAL SAFETY NOTE
  Avoid index-based DOM selection (querySelectorAll(...)[i]) across multiple
  eval calls when the list can change between calls (e.g. after clicking
  "Ignore" buttons on a feed — indices shift). Prefer stable selectors or
  collect all data in a single eval.

DAEMON IPC (for advanced use / scripting)
  Each tab runs a persistent daemon at Unix socket in the runtime dir (see below).
  Protocol: newline-delimited JSON (one JSON object per line, UTF-8).
    Request:  {"id":<number>, "cmd":"<command>", "args":["arg1","arg2",...]}
    Response: {"id":<number>, "ok":true,  "result":"<string>"}
           or {"id":<number>, "ok":false, "error":"<message>"}
  Commands mirror the CLI: snap, eval, shot, html, nav, net, click, clickxy,
  type, loadall, evalraw, stop. Use evalraw to send arbitrary CDP methods.
  The socket disappears after 20 min of inactivity or when the tab closes.
`;

const NEEDS_TARGET = new Set([
  'snap','snapshot','eval','shot','screenshot','html','nav','navigate',
  'net','network','click','clickxy','type','loadall','evalraw',
]);

const COMMAND_ALIASES = new Map([
  ['ls', 'list'],
  ['snap', 'snapshot'],
  ['shot', 'screenshot'],
  ['nav', 'navigate'],
  ['net', 'network'],
]);
const FALLBACK_BROWSER_IDS = new Set(['chrome', 'chromium', 'brave', 'edge', 'vivaldi']);

function canonicalCommandName(cmd) {
  return COMMAND_ALIASES.get(cmd) || cmd;
}

function isLightpandaPageRecord(page) {
  return page?.browserKind === 'lightpanda' || page?.browserId === 'lightpanda';
}

function fallbackBrowserSuggestion() {
  const requested = (process.env.CDP_FALLBACK_BROWSER || 'chrome').trim().toLowerCase();
  if (requested === 'none') return null;
  return FALLBACK_BROWSER_IDS.has(requested) ? requested : 'chrome';
}

function formatCdpErrorSummary(response) {
  const parts = [];
  if (response.errorCode != null) parts.push(String(response.errorCode));
  if (response.error) parts.push(response.error);
  return parts.length ? ` (${parts.join(' ')})` : '';
}

function formatLightpandaFallbackPrompt({ cmd, targetPrefix, targetId, page, response }) {
  const failedMethod = response.unsupportedMethod || response.errorMethod || '<unknown>';
  const suggestion = fallbackBrowserSuggestion();
  const nextBrowser = suggestion || '<approved fallback browser>';
  const lines = [
    'LIGHTPANDA_UNSUPPORTED_FALLBACK_REQUIRED',
    `Command: ${[cmd, targetPrefix].filter(Boolean).join(' ')}`,
    `Normalized command: ${canonicalCommandName(cmd)}`,
    `Target: ${targetId || targetPrefix || '<unknown>'}`,
    `Failed CDP method: ${failedMethod}${formatCdpErrorSummary(response)}`,
    `Primary browser: ${page?.browserId || 'lightpanda'}`,
    `Primary URL: ${page?.url || '<unknown>'}`,
  ];
  if (response.errorData != null) lines.push(`CDP error data: ${formatErrorData(response.errorData)}`);
  if (suggestion) lines.push(`Suggested fallback browser: ${suggestion}`);
  lines.push(
    '',
    'Lightpanda does not support this operation. chrome-cdp did not run fallback automatically.',
    'Fallback browser may not have the same state: cookies, login, localStorage, DOM mutations, typed text, JS heap, or in-page workflow may differ.',
    '',
    `Ask the user before fallback execution. If approved, enable remote debugging in the fallback browser, run cdp list/open there, then rerun this command with CDP_BROWSER=${nextBrowser}.`,
  );
  return lines.join('\n');
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  // Daemon mode (internal)
  if (cmd === '_daemon') { await runDaemon(args[0], args[1]); return; }

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(USAGE); process.exit(0);
  }

  if (cmd === 'list' || cmd === 'ls') {
    const descriptor = await getBrowserDescriptor();
    const cdp = new CDP();
    await cdp.connect(descriptor.wsUrl);
    const pages = await getPages(cdp);
    cdp.close();
    writePagesCache(descriptor, pages);
    console.log(formatPageList(pages));
    exitAfterCdpCleanup();
    return;
  }

  // Open new tab
  if (cmd === 'open') {
    const url = args[0] || 'about:blank';
    const descriptor = await getBrowserDescriptor();
    const cdp = new CDP();
    await cdp.connect(descriptor.wsUrl);
    const { targetId } = await cdp.send('Target.createTarget', { url });
    // Refresh cache; new tab may not appear in getTargets immediately, so add it manually
    const pages = await getPages(cdp);
    if (!pages.some(p => p.targetId === targetId)) {
      pages.push({ targetId, title: url, url });
    }
    cdp.close();
    writePagesCache(descriptor, pages);
    console.log(`Opened new tab: ${targetId.slice(0, 8)}  ${url}`);
    console.log('Note: this tab will need "Allow debugging?" approval on first access.');
    exitAfterCdpCleanup();
    return;
  }

  // Stop
  if (cmd === 'stop') {
    await stopDaemons(args[0]);
    return;
  }

  // Page commands — need target prefix
  if (!NEEDS_TARGET.has(cmd)) {
    console.error(`Unknown command: ${cmd}\n`);
    console.log(USAGE);
    process.exit(1);
  }

  const targetPrefix = args[0];
  if (!targetPrefix) {
    console.error('Error: target ID required. Run "cdp list" first.');
    process.exit(1);
  }

  // Resolve prefix → full targetId from pages cache
  if (!existsSync(PAGES_CACHE)) {
    console.error('No page list cached. Run "cdp list" first.');
    process.exit(1);
  }
  const cache = await readPagesCacheForPageCommand();
  const page = resolvePageRecord(targetPrefix, cache);
  const targetId = page.targetId;

  const conn = await getOrStartTabDaemon(page);

  const cmdArgs = args.slice(1);

  if (cmd === 'eval') {
    const expr = cmdArgs.join(' ');
    if (!expr) { console.error('Error: expression required'); process.exit(1); }
    cmdArgs[0] = expr;
  } else if (cmd === 'type') {
    // Join all remaining args as text (allows spaces)
    const text = cmdArgs.join(' ');
    if (!text) { console.error('Error: text required'); process.exit(1); }
    cmdArgs[0] = text;
  } else if (cmd === 'evalraw') {
    // args: [method, ...jsonParts] — join json parts in case of spaces
    if (!cmdArgs[0]) { console.error('Error: CDP method required'); process.exit(1); }
    if (cmdArgs.length > 2) cmdArgs[1] = cmdArgs.slice(1).join(' ');
  }

  if ((cmd === 'nav' || cmd === 'navigate') && !cmdArgs[0]) {
    console.error('Error: URL required');
    process.exit(1);
  }

  const response = await sendCommand(conn, { cmd, args: cmdArgs });

  if (response.ok) {
    if (response.result) console.log(response.result);
  } else if (isLightpandaPageRecord(page) && response.unsupportedMethod) {
    console.error(formatLightpandaFallbackPrompt({ cmd, targetPrefix, targetId, page, response }));
    process.exitCode = 1;
  } else {
    console.error('Error:', response.error);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
