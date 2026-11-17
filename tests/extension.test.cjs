const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = (name) => fs.readFileSync(path.join(__dirname, '../extension', name), 'utf8');
const quiet = { log() {}, warn() {}, error() {} };
const flush = () => new Promise((resolve) => setImmediate(resolve));

const enMessages = JSON.parse(fs.readFileSync(path.join(__dirname, '../extension/_locales/en/messages.json'), 'utf8'));
const fakeI18n = {
  getMessage(key, substitutions) {
    const entry = enMessages[key];
    if (!entry) return '';
    const subs = substitutions == null ? [] : (Array.isArray(substitutions) ? substitutions : [substitutions]);
    return entry.message.replace(/\$([A-Za-z0-9_]+)\$/g, (match, name) => {
      const slot = entry.placeholders?.[name.toLowerCase()];
      if (!slot) return match;
      const index = Number(String(slot.content).replace('$', '')) - 1;
      return index >= 0 && subs[index] != null ? String(subs[index]) : match;
    });
  },
  getUILanguage: () => 'en',
};

test('Douyin fetches media in the source page and rejects HTML before queuing', async () => {
  const posted = [];
  const revoked = [];
  let listener;
  let mime = 'video/mp4';
  let options;
  const window = {
    location: { pathname: '/user/alice' },
    addEventListener(type, fn) { listener = fn; },
    postMessage(data) { posted.push(data); },
    async fetch(url, opts) {
      options = opts;
      return { ok: true, headers: { get: () => mime }, blob: async () => ({ size: 200000 }) };
    },
  };
  const context = vm.createContext({ console: quiet, window,
    URL: class extends URL {
      static createObjectURL() { return 'blob:https://www.douyin.com/test'; }
      static revokeObjectURL(url) { revoked.push(url); }
    },
    document: { querySelectorAll: () => [] }, XMLHttpRequest: class { send() {} },
  });
  vm.runInContext(source('douyin_media_interceptor.js'), context);
  const request = () => listener({ source: window, data: { source: 'profile-downloader', type: 'douyin-download-request', requestId: 'r', url: 'https://v26-web.douyinvod.com/video' } });
  request(); await flush();
  assert.equal(options.referrer, 'https://www.douyin.com/');
  assert.equal(posted.at(-1).success, true);
  const blobUrl = posted.at(-1).blobUrl;
  listener({ source: window, data: { source: 'profile-downloader', type: 'douyin-revoke-blob', blobUrl } });
  assert.deepEqual(revoked, [blobUrl]);
  listener({ source: window, data: { source: 'profile-downloader', type: 'douyin-download-request', requestId: 'z', url: 'https://v5-dy-o.zjcdn.com/video' } });
  await flush();
  assert.equal(posted.at(-1).success, true);
  listener({ source: window, data: { source: 'profile-downloader', type: 'douyin-download-request', requestId: 'x', url: 'https://evil.example.com/video' } });
  await flush();
  assert.match(posted.at(-1).error, /Unsupported/);
  mime = 'text/html'; request(); await flush();
  assert.equal(posted.at(-1).success, false);
  assert.match(posted.at(-1).error, /invalid media/);
});

test('WASM sorting/dedup retains metadata from the first original item', () => {
  const context = vm.createContext({
    console: quiet,
    document: { querySelector: () => null, addEventListener() {} },
  });
  vm.runInContext(source('popup.js'), context);
  // Model the Rust JSON boundary: only core fields survive serialization.
  vm.runInContext(`
    wasm = { process_media_batch: () => JSON.stringify([
      { id: 'new', timestamp: 20 }, { id: 'old', timestamp: 10 }
    ]) };
    state.wasmReady = true;
  `, context);
  context.items = [
    { id: 'old', timestamp: 10, requires_resolution: true, post_url: '/original' },
    { id: 'new', timestamp: 20, requires_resolution: false },
    { id: 'old', timestamp: 1, requires_resolution: false, post_url: '/duplicate' },
  ];
  const processed = vm.runInContext('processMedia(items)', context);
  assert.deepEqual(Array.from(processed, (item) => item.id), ['new', 'old']);
  assert.equal(processed[1].requires_resolution, true);
  assert.equal(processed[1].post_url, '/original');
  vm.runInContext('state.wasmReady = false', context);
  assert.equal(vm.runInContext('processMedia(items)[1].requires_resolution', context), true);
});

test('popup preserves source-page failure messages when restoring and completing the queue', async () => {
  const elements = new Map();
  let tick;
  const error = 'TikTok source page was closed or refreshed. Reopen the profile and retry the affected videos.';
  const context = vm.createContext({
    console: quiet,
    document: {
      addEventListener() {},
      querySelector(selector) {
        if (!elements.has(selector)) elements.set(selector, {
          style: {}, classList: { remove() {} }, addEventListener() {},
        });
        return elements.get(selector);
      },
    },
    chrome: { runtime: { async sendMessage() { return { pending: 0, active: 0, lastError: error }; } } },
    setInterval(fn) { tick = fn; return 1; }, clearInterval() {},
  });
  vm.runInContext(source('popup.js'), context);
  await vm.runInContext('restoreDownloadState()', context);
  assert.equal(elements.get('#progress-text').textContent, error);
  vm.runInContext('monitorDownloads()', context);
  await tick();
  assert.equal(elements.get('#progress-text').textContent, error);
  assert.equal(vm.runInContext('state.isDownloading', context), false);
});

function contentHarness(initialPath = '/alice') {
  const callbacks = {};
  const posted = [];
  let imageName = 'alice';
  let imageOwner = 'alice';
  const location = { hostname: 'x.com', origin: 'https://x.com', protocol: 'https:', pathname: initialPath, href: 'https://x.com' + initialPath };
  const document = {
    title: '',
    documentElement: { innerHTML: '' }, body: {},
    querySelector: () => null,
    querySelectorAll: (selector) => selector === 'img[src*="pbs.twimg.com/media"], img[data-src*="pbs.twimg.com/media"]'
      ? [{ src: `https://pbs.twimg.com/media/${imageName}.jpg`, closest: (selector) =>
        selector === 'a[href*="/status/"]' && imageOwner
          ? { href: `https://x.com/${imageOwner}/status/123/photo/1` } : null }] : [],
  };
  const context = vm.createContext({
    URL, console: quiet, setTimeout, clearTimeout,
    performance: { getEntriesByType: () => [] }, document,
    window: { location, addEventListener(name, fn) { callbacks['window:' + name] = fn; }, postMessage(message) { posted.push(message); } },
    MutationObserver: class {
      constructor(fn) { callbacks.mutation = fn; }
      observe(target) { callbacks.observed = target; }
      disconnect() {}
    },
    chrome: { runtime: { sendMessage() {}, onMessage: { addListener(fn) { callbacks.message = fn; } } } },
  });
  vm.runInContext(source('content_script.js'), context);
  return {
    callbacks, document, posted,
    navigate(next, image = next.slice(1), owner = next.split('/')[1]) {
      location.pathname = next; location.href = 'https://x.com' + next; imageName = image; imageOwner = owner;
    },
    extract: () => new Promise((resolve) => callbacks.message({ action: 'extractMedia' }, {}, resolve)),
  };
}

test('SPA profiles are isolated while tabs within one profile retain accumulated media', async () => {
  const page = contentHarness();
  page.navigate('/alice/media', 'second');
  assert.equal((await page.extract()).media.length, 2);
  page.navigate('/bob');
  const bob = await page.extract();
  assert.equal(bob.username, 'bob');
  assert.deepEqual(Array.from(bob.media, (item) => item.id), ['tw_bob']);
  page.navigate('/home');
  assert.equal((await page.extract()).media.length, 0);
  page.navigate('/alice');
  assert.deepEqual(Array.from((await page.extract()).media, (item) => item.id), ['tw_alice']);
});

test('loading on a feed still installs listeners and observes above the replaceable main element', async () => {
  const page = contentHarness('/home');
  assert.equal(typeof page.callbacks['window:message'], 'function');
  assert.equal(typeof page.callbacks.message, 'function');
  assert.equal(page.callbacks.observed, page.document.documentElement);
  page.navigate('/bob');
  assert.equal((await page.extract()).media[0].id, 'tw_bob');
  const reply = await new Promise((resolve) => page.callbacks.message({ action: 'releasePreparedBlob', url: 'blob:https://x.com/test' }, {}, resolve));
  assert.equal(reply.success, true);
  assert.equal(page.posted.at(-1).type, 'tiktok-revoke-blob');
});

test('SPA navigation ignores old DOM until media links belong to the new profile', async () => {
  const page = contentHarness();
  page.navigate('/bob', 'alice', 'alice');
  assert.equal((await page.extract()).media.length, 0);
  page.navigate('/bob', 'bob', 'bob');
  assert.deepEqual(Array.from((await page.extract()).media, (item) => item.id), ['tw_bob']);
  // A later scan must not re-add unattributed or old-profile images.
  page.navigate('/bob', 'alice', null);
  assert.deepEqual(Array.from((await page.extract()).media, (item) => item.id), ['tw_bob']);
  page.navigate('/bob', 'alice', 'alice');
  assert.deepEqual(Array.from((await page.extract()).media, (item) => item.id), ['tw_bob']);
});

test('TikTok SPA navigation excludes stale initial state and links from another author', async () => {
  const callbacks = {};
  const location = { hostname: 'www.tiktok.com', origin: 'https://www.tiktok.com', protocol: 'https:', pathname: '/@alice' };
  const initialState = (author, id) => '<script>window.SIGI_STATE=' + JSON.stringify({
    ItemModule: { [id]: { id, author, video: { playAddr: `https://cdn.example.com/${id}.mp4` } } },
  }) + ';</script>';
  const document = {
    documentElement: { innerHTML: initialState('alice', '1') }, body: {},
    querySelector: () => null, querySelectorAll: () => [],
  };
  const context = vm.createContext({
    URL, document, console: quiet, setTimeout, clearTimeout,
    performance: { getEntriesByType: () => [] },
    window: { location, addEventListener() {}, postMessage() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    chrome: { runtime: { sendMessage() {}, onMessage: { addListener(fn) { callbacks.message = fn; } } } },
  });
  vm.runInContext(source('content_script.js'), context);
  const extract = () => new Promise((resolve) => callbacks.message({ action: 'extractMedia' }, {}, resolve));
  assert.equal((await extract()).media[0].id, 'tt_1');
  location.pathname = '/@bob';
  assert.equal((await extract()).media.length, 0);
  document.documentElement.innerHTML = initialState('bob', '2');
  // Old links remain mounted during the transition and must not trigger resolution.
  document.querySelectorAll = (selector) => selector === 'a[href*="/video/"]'
    ? [{ href: 'https://www.tiktok.com/@alice/video/1' }] : [];
  assert.deepEqual(Array.from((await extract()).media, (item) => item.id), ['tt_2']);
});

function backgroundHarness(stored, history = {}, existingDownloads = []) {
  let nextId = 0;
  let persisted;
  let persistedPending = [];
  let persistedHistory = history;
  const searches = [];
  let writes = 0;
  const started = [];
  const released = [];
  const downloads = new Map();
  const callbacks = {};
  let sourceValid = true;
  const context = vm.createContext({
    URL, console: quiet, setTimeout,
    chrome: {
      i18n: fakeI18n,
      storage: { local: {
        async get(key, callback) { if (callback) callback({}); return { downloadQueueState: stored, downloadHistory: JSON.parse(JSON.stringify(persistedHistory)) }; },
        async set(value) {
          writes++;
          if (value.downloadQueuePending) persistedPending = JSON.parse(JSON.stringify(value.downloadQueuePending));
          if (value.downloadQueueState) persisted = JSON.parse(JSON.stringify(value.downloadQueueState));
          if (value.downloadHistory) persistedHistory = JSON.parse(JSON.stringify(value.downloadHistory));
        },
      } },
      runtime: { onMessage: { addListener() {} }, onInstalled: { addListener() {} } },
      tabs: {
        async sendMessage(tabId, message, options) {
          if (message.action === 'validatePreparedBlob') {
            callbacks.validation = { tabId, options };
            return { valid: sourceValid };
          }
          released.push({ tabId, ...message, options });
        },
        onRemoved: { addListener(fn) { callbacks.removed = fn; } },
        onUpdated: { addListener(fn) { callbacks.updated = fn; } },
      },
      downloads: {
        async download(options) { started.push(options); const id = ++nextId; downloads.set(id, { id, filename: `/home/me/Downloads/${options.filename}`, state: 'in_progress' }); return id; },
        async search(query) {
          searches.push(query);
          if (query.id != null) return downloads.has(query.id) ? [downloads.get(query.id)] : [];
          return [...existingDownloads, ...downloads.values()].filter((d) => !query.state || d.state === query.state);
        },
        onChanged: { addListener() {} },
      },
    },
  });
  vm.runInContext(source('background.js'), context);
  return { context, started, released, callbacks, downloads, searches, writes: () => writes, invalidateSource() { sourceValid = false; }, persisted: () => persisted && { ...persisted, pending: persistedPending.slice(persisted.pendingConsumed || 0) }, history: () => persistedHistory, run: (code) => vm.runInContext(code, context) };
}

test('prepared and ordinary batches share the limit and advance on completion/failure', async () => {
  const bg = backgroundHarness();
  await flush();
  await bg.run(`startPreparedDownload({ id: 'blob', url: 'blob:https://www.tiktok.com/video', filename: 'blob.mp4' }, 42)`);
  await Promise.all(Array.from({ length: 4 }, (_, index) => bg.run(`startPreparedDownload({ id: '${index}', url: 'https://cdn.example.com/${index}.mp4', filename: '${index}.mp4' })`)));
  await bg.run(`enqueueDownloadBatch([{ id: 'regular', url: 'https://cdn.example.com/regular.jpg', filename: 'regular.jpg' }])`);
  await flush();
  assert.equal(bg.started.length, 3);
  assert.equal((await bg.run('getDownloadQueueStatus()')).pending, 3);
  assert.equal(bg.persisted().pending.length, 3);
  await bg.run('settleQueuedDownload(1, false)');
  await flush();
  assert.equal(bg.started.length, 4);
  assert.equal(bg.released[0].tabId, 42);
  assert.equal(bg.released[0].url, 'blob:https://www.tiktok.com/video');
  await bg.run('settleQueuedDownload(2, true)');
  await flush();
  assert.equal(bg.started.length, 5);
  const status = await bg.run('getDownloadQueueStatus()');
  assert.equal(status.active, 3);
  assert.equal(status.completed, 1);
  assert.equal(status.failed, 1);
  await bg.run('settleQueuedDownload(3, false)');
  await flush();
  assert.equal(bg.started.at(-1).url, 'https://cdn.example.com/regular.jpg');
});

test('duplicate paths are skipped while queued, after completion, and across restarts', async () => {
  const bg = backgroundHarness();
  await flush();
  const item = (id) => `{ id: '${id}', url: 'https://cdn.example.com/${id}.jpg', filename: 'x/alice_A/${id}.jpg' }`;
  let result = await bg.run(`enqueueDownloadBatch([${item('a')}, ${item('a')}, ${item('b')}])`);
  assert.equal(result.queued, 2);
  assert.equal(result.skipped, 1);
  await flush();
  result = await bg.run(`enqueueDownloadBatch([${item('a')}])`);
  assert.equal(result.skipped, 1, 'in-flight duplicate');
  bg.downloads.get(1).state = 'complete';
  await bg.run('settleQueuedDownload(1, false)');
  assert.equal(bg.history()['ProfileDownloader/x/alice_A/a.jpg'], undefined, 'saved in groups');
  await bg.run('settleQueuedDownload(2, false)');
  assert.equal(bg.history()['ProfileDownloader/x/alice_A/a.jpg'], 1, 'saved when the queue drains');
  result = await bg.run(`enqueueDownloadBatch([${item('a')}])`);
  assert.equal(result.skipped, 1, 'completed duplicate');
  assert.deepEqual(Array.from(await bg.run(`findDownloadedFilenames(['x/alice_A/a.jpg', 'x/alice_A/b.jpg', 'x/alice_A/c.jpg'])`)), ['x/alice_A/a.jpg', 'x/alice_A/b.jpg']);
  assert.equal(bg.started.length, 2);
  assert.equal(bg.started[0].conflictAction, 'overwrite');

  // History survives a worker restart even if Chrome's download list was cleared.
  const restarted = backgroundHarness(undefined, bg.history());
  await flush();
  result = await restarted.run(`enqueueDownloadBatch([${item('a')}])`);
  assert.equal(result.skipped, 1);
  // A file Chrome reports as deleted may be downloaded again.
  restarted.downloads.set(1, { id: 1, filename: '/home/me/Downloads/ProfileDownloader/x/alice_A/a.jpg', state: 'complete', exists: false });
  result = await restarted.run(`enqueueDownloadBatch([${item('a')}])`);
  assert.equal(result.queued, 1);
});

test('1000-item batches check duplicates with one search and coalesce storage writes', async () => {
  const existing = Array.from({ length: 300 }, (_, i) => ({ id: 10000 + i, filename: `/home/me/Downloads/ProfileDownloader/x/alice_A/${i}.jpg`, state: 'complete', exists: true }));
  const bg = backgroundHarness(undefined, {}, existing);
  await flush();
  const items = JSON.stringify(Array.from({ length: 1000 }, (_, i) => ({ id: String(i), url: `https://cdn.example.com/${i}.jpg`, filename: `x/alice_A/${i}.jpg` })));
  const names = JSON.stringify(Array.from({ length: 1000 }, (_, i) => `x/alice_A/${i}.jpg`));
  assert.equal((await bg.run(`findDownloadedFilenames(${names})`)).length, 300);
  assert.equal(bg.searches.length, 1);
  const writesBefore = bg.writes();
  const result = await bg.run(`enqueueDownloadBatch(${items})`);
  assert.equal(result.queued, 700);
  assert.equal(result.skipped, 300);
  assert.equal(bg.searches.length, 2);
  await flush(); await flush();
  assert.equal(bg.started.length, 3);
  assert.ok(bg.writes() - writesBefore <= 4, `expected coalesced writes, got ${bg.writes() - writesBefore}`);
  assert.equal(bg.persisted().pending.length, 697);
});

test('a download that finishes before its ID is returned still frees its slot', async () => {
  const bg = backgroundHarness();
  await flush();
  const download = bg.context.chrome.downloads.download;
  bg.context.chrome.downloads.download = async (options) => {
    const id = await download(options);
    bg.run(`settleQueuedDownload(${id}, false)`);
    return id;
  };
  await bg.run(`enqueueDownloadBatch(Array.from({ length: 5 }, (_, i) => ({ id: String(i), url: 'blob:https://www.tiktok.com/' + i, filename: i + '.mp4' })), 1)`);
  for (let i = 0; i < 20; i++) await flush();
  const status = await bg.run('getDownloadQueueStatus()');
  assert.equal(status.active, 0);
  assert.equal(status.completed, 5);
});

test('files already in Chrome downloads are skipped and skipped blobs are released', async () => {
  const bg = backgroundHarness(undefined, {}, [
    { id: 7, filename: 'C:\\Users\\me\\Downloads\\ProfileDownloader\\tiktok\\bob_B\\tt_1.mp4', state: 'complete', exists: true },
  ]);
  await flush();
  const result = await bg.run(`startPreparedDownload({ id: 'tt_1', url: 'blob:https://www.tiktok.com/v', filename: 'tiktok/bob_B/tt_1.mp4' }, 42, 'doc')`);
  assert.equal(result.skipped, 1);
  assert.equal(bg.started.length, 0);
  assert.equal(bg.released[0].action, 'releasePreparedBlob');
  assert.equal(bg.released[0].url, 'blob:https://www.tiktok.com/v');
  assert.equal(bg.history()['ProfileDownloader/tiktok/bob_B/tt_1.mp4'], 7);
});

test('prepared downloads persist and resume after a worker restart', async () => {
  const bg = backgroundHarness();
  await flush();
  for (let i = 0; i < 4; i++) {
    await bg.run(`startPreparedDownload({ id: '${i}', url: 'https://cdn.example.com/${i}.mp4', filename: '${i}.mp4' })`);
  }
  await flush();
  const snapshot = bg.persisted();
  assert.equal(snapshot.pending.length, 1);
  // A new worker finds old downloads no longer in progress and pumps pending work.
  const resumed = backgroundHarness(snapshot);
  await flush();
  assert.equal(resumed.started.length, 1);
  assert.equal(resumed.started[0].url, 'https://cdn.example.com/3.mp4');
});

for (const event of ['closed', 'refreshed']) {
  test(`a ${event} source removes only its pending blobs and reports a retryable error`, async () => {
    const bg = backgroundHarness();
    await flush();
    for (let i = 0; i < 3; i++) {
      await bg.run(`enqueueDownloadBatch([{ id: '${i}', url: 'https://cdn.example.com/${i}', filename: '${i}.mp4' }])`);
    }
    await flush();
    await bg.run(`startPreparedDownload({ id: 'stale', url: 'blob:https://www.tiktok.com/stale', filename: 'stale.mp4' }, 42, 'old-document')`);
    await bg.run(`startPreparedDownload({ id: 'other', url: 'blob:https://www.tiktok.com/other', filename: 'other.mp4' }, 43, 'other-document')`);
    await bg.run(`enqueueDownloadBatch([{ id: 'regular', url: 'https://cdn.example.com/regular', filename: 'regular.mp4' }])`);
    if (event === 'closed') bg.callbacks.removed(42);
    else bg.callbacks.updated(42, { status: 'loading' });
    await flush();
    const status = await bg.run('getDownloadQueueStatus()');
    assert.equal(status.pending, 2);
    assert.equal(status.active, 3);
    assert.equal(status.failed, 1);
    assert.match(status.lastError, /closed or refreshed/);
    assert.deepEqual(bg.persisted().pending.map((item) => item.id), ['other', 'regular']);
    assert.equal(bg.released[0].options.documentId, 'old-document');
    await bg.run('settleQueuedDownload(1, false)');
    await flush();
    assert.equal(bg.started.at(-1).url, 'blob:https://www.tiktok.com/other');
    assert.equal(bg.callbacks.validation.options.documentId, 'other-document');
  });
}

test('a worker restart rejects a persisted blob from an unavailable document and continues CDN work', async () => {
  const bg = backgroundHarness({
    pending: [
      { id: 'stale', url: 'blob:https://www.tiktok.com/stale', filename: 'stale.mp4', sourceTabId: 42, sourceDocumentId: 'old-document' },
      { id: 'regular', url: 'https://cdn.example.com/regular', filename: 'regular.mp4' },
    ], active: {}, completed: 0, failed: 0,
  });
  bg.invalidateSource();
  await flush();
  assert.equal(bg.started.length, 1);
  assert.equal(bg.started[0].url, 'https://cdn.example.com/regular');
  const status = await bg.run('getDownloadQueueStatus()');
  assert.equal(status.failed, 1);
  assert.match(status.lastError, /retry/);
});

test('TikTok blobs survive queue delays and are released only on completion', async () => {
  let listener;
  const posted = [];
  const revoked = [];
  const timers = [];
  const context = vm.createContext({
    URL: { createObjectURL: () => 'blob:https://www.tiktok.com/test', revokeObjectURL: (url) => revoked.push(url) },
    setTimeout: (fn, delay) => timers.push(delay),
    fetch: async () => ({ ok: true, headers: { get: () => 'video/mp4' }, blob: async () => ({ size: 200000, type: 'video/mp4' }) }),
    window: { addEventListener(type, fn) { listener = fn; }, postMessage(message) { posted.push(message); } },
    XMLHttpRequest: class { open() {} send() {} },
  });
  vm.runInContext(source('tiktok_video_interceptor.js'), context);
  listener({ source: context.window, data: { source: 'profile-downloader', type: 'tiktok-download-request', requestId: 'r', url: 'https://cdn.example.com/video' } });
  await flush();
  assert.equal(posted[0].success, true);
  assert.equal(timers.length, 0);
  assert.equal(revoked.length, 0);
  listener({ source: context.window, data: { source: 'profile-downloader', type: 'tiktok-revoke-blob', blobUrl: posted[0].blobUrl } });
  assert.deepEqual(revoked, ['blob:https://www.tiktok.com/test']);
});


test('Douyin captures loaded videos and galleries and isolates SPA profiles', async () => {
  const callbacks = {};
  const location = { hostname: 'www.douyin.com', origin: 'https://www.douyin.com', protocol: 'https:', pathname: '/user/alice' };
  const posts = { aweme_list: [
    { aweme_id: '1', author: { sec_uid: 'alice', nickname: '小明', unique_id: 'alice_handle', avatar_thumb: { url_list: ['https://cdn.example.com/avatar.jpg'] } }, video: { play_addr: { url_list: ['https://www.douyin.com/video/1', 'https://cdn.example.com/1.mp4'] } } },
    { aweme_id: '2', author: { sec_uid: 'bob' }, images: [{ url_list: ['https://cdn.example.com/2.jpg'] }, { url_list: ['https://cdn.example.com/3.jpg'] }] },
  ] };
  const listeners = [];
  const window = { location, addEventListener(type, fn) { if (type === 'message') listeners.push(fn); },
    postMessage(data) { queueMicrotask(() => listeners.forEach(fn => fn({ source: window, data }))); },
    fetch: async () => ({ headers: { get: () => 'application/json' }, clone: () => ({ json: async () => posts }) }),
  };
  const document = { documentElement: { innerHTML: '' }, body: {}, querySelector: () => null,
    querySelectorAll: () => [{ textContent: encodeURIComponent(JSON.stringify(posts)) }] };
  const context = vm.createContext({ URL, window, document, console: quiet, setTimeout, clearTimeout,
    XMLHttpRequest: class { send() {} }, MutationObserver: class { observe() {} disconnect() {} },
    chrome: { runtime: { sendMessage() {}, onMessage: { addListener(fn) { callbacks.message = fn; } } } },
  });
  vm.runInContext(source('douyin_media_interceptor.js'), context);
  vm.runInContext(source('content_script.js'), context);
  await flush();
  const extract = () => new Promise(resolve => callbacks.message({ action: 'extractMedia' }, {}, resolve));
  assert.deepEqual(Array.from((await extract()).media, m => m.id), ['dy_1_video']);
  assert.equal((await extract()).username, 'alice');
  assert.equal((await extract()).profileInfo.username, 'alice_handle');
  assert.equal((await extract()).media[0].username, 'alice_handle');
  const popup = vm.createContext({ console: quiet, document: { querySelector: () => null, addEventListener() {} } });
  vm.runInContext(source('popup.js'), popup);
  popup.item = (await extract()).media[0];
  assert.equal(vm.runInContext('generateFilename(item)', popup), 'douyin/alice_handle_小明/dy_1_video.mp4');
  assert.equal((await extract()).profileInfo.display_name, '小明');
  assert.equal((await extract()).profileInfo.avatar_url, 'https://cdn.example.com/avatar.jpg');
  location.pathname = '/user/bob';
  assert.equal((await extract()).media.length, 0);
  assert.equal((await extract()).profileInfo.display_name, null);
  await flush();
  assert.deepEqual(Array.from((await extract()).media, m => m.id), ['dy_2_0', 'dy_2_1']);
  popup.item = (await extract()).media[0];
  assert.equal(vm.runInContext('generateFilename(item)', popup), 'douyin/bob/dy_2_0.jpg');
  location.pathname = '/';
  assert.equal((await extract()).media.length, 0);
  location.pathname = '/user/alice';
  document.querySelectorAll = () => [];
  await extract();
  await window.fetch('/aweme/v1/web/aweme/post/');
  await flush();
  assert.equal((await extract()).media.length, 1);
});


function instagramHarness({ title = '', h1 = null, profile = null } = {}) {
  const callbacks = {};
  const messageListeners = [];
  const location = { hostname: 'www.instagram.com', origin: 'https://www.instagram.com', protocol: 'https:', pathname: '/alice' };
  const nameEl = h1 == null ? null : { textContent: h1 };
  const header = {
    querySelector(selector) {
      return selector === 'h1' ? nameEl : null;
    },
  };
  const document = {
    title,
    documentElement: { innerHTML: '' }, body: {},
    querySelector(selector) {
      return selector === 'header' ? header : null;
    },
    querySelectorAll: () => [],
  };
  const window = {
    location,
    addEventListener(type, fn) { if (type === 'message') messageListeners.push(fn); },
    postMessage() {},
  };
  const context = vm.createContext({
    URL, console: quiet, setTimeout, clearTimeout,
    performance: { getEntriesByType: () => [] }, document, window,
    MutationObserver: class { observe() {} disconnect() {} },
    chrome: { runtime: { sendMessage() {}, onMessage: { addListener(fn) { callbacks.message = fn; } } } },
  });
  vm.runInContext(source('content_script.js'), context);
  if (profile) {
    const event = { source: window, data: { source: 'profile-downloader', type: 'instagram-profile', profiles: [profile] } };
    messageListeners.forEach((fn) => fn(event));
  }
  return () => new Promise((resolve) => callbacks.message({ action: 'extractMedia' }, {}, resolve));
}

test('Instagram reads the display name from the page title or profile header', async () => {
  let extract = instagramHarness({ title: '小明 (@alice) • Instagram photos and videos' });
  assert.equal((await extract()).profileInfo.display_name, '小明');

  // Current Instagram markup has no h1 for the full name; the title still works.
  extract = instagramHarness({ title: 'Instagram' });
  assert.equal((await extract()).profileInfo.display_name, undefined);

  // Older markup kept the display name in the profile header's h1.
  extract = instagramHarness({ title: 'Instagram', h1: '小明' });
  assert.equal((await extract()).profileInfo.display_name, '小明');

  // An account whose name is just its handle must not become "handle_handle".
  extract = instagramHarness({ title: 'alice (@alice) • Instagram photos and videos' });
  assert.equal((await extract()).profileInfo.display_name, undefined);

  // A title left over from another profile is ignored.
  extract = instagramHarness({ title: 'Bob (@bob) • Instagram photos and videos' });
  assert.equal((await extract()).profileInfo.display_name, undefined);

  // A display name that itself contains "(@…)" keeps the real handle's name.
  extract = instagramHarness({ title: 'Foo (@bar) (@alice) • Instagram photos and videos' });
  assert.equal((await extract()).profileInfo.display_name, 'Foo (@bar)');

  // The SPA can leave the title as plain "Instagram"; the full_name captured
  // from the page's JSON payload is used instead.
  extract = instagramHarness({
    title: 'Instagram',
    profile: { username: 'alice', full_name: '拍羽想@NORÉVE', avatar: 'https://cdn.example.com/a.jpg' },
  });
  assert.equal((await extract()).profileInfo.display_name, '拍羽想@NORÉVE');
  assert.equal((await extract()).profileInfo.avatar_url, 'https://cdn.example.com/a.jpg');

  // Captured profiles from other handles must not leak into this profile.
  extract = instagramHarness({
    title: 'Instagram',
    profile: { username: 'bob', full_name: 'Bob Name' },
  });
  assert.equal((await extract()).profileInfo.display_name, undefined);

  // A captured full_name that is just the handle is not a real display name.
  extract = instagramHarness({
    title: 'Instagram',
    profile: { username: 'alice', full_name: 'alice' },
  });
  assert.equal((await extract()).profileInfo.display_name, undefined);
});

test('Instagram interceptor publishes full_name from JSON responses', async () => {
  const posted = [];
  const listeners = [];
  const payload = {
    data: { user: { username: 'alice', full_name: '拍羽想@NORÉVE', profile_pic_url_hd: 'https://cdn.example.com/a.jpg' } },
  };
  const response = {
    headers: { get: () => 'application/json' },
    clone: () => ({ text: async () => JSON.stringify(payload) }),
  };
  const window = {
    addEventListener(type, fn) { if (type === 'message') listeners.push(fn); },
    postMessage(message) { posted.push(message); },
    async fetch() { return response; },
  };
  const context = vm.createContext({
    window, console: quiet,
    XMLHttpRequest: class { send() {} },
  });
  vm.runInContext(source('instagram_media_interceptor.js'), context);
  await window.fetch('/api/v1/users/web_profile_info/?username=alice');
  await flush();

  const profileMessage = posted.find((message) => message.type === 'instagram-profile');
  assert.ok(profileMessage, 'expected an instagram-profile message');
  assert.deepEqual(JSON.parse(JSON.stringify(profileMessage.profiles)), [{
    username: 'alice',
    full_name: '拍羽想@NORÉVE',
    avatar: 'https://cdn.example.com/a.jpg',
  }]);

  // Re-publish the captured profile when the content script asks for data
  // after the API response has already arrived.
  posted.length = 0;
  listeners.forEach((fn) => fn({
    source: window,
    data: { source: 'profile-downloader', type: 'instagram-media-request' },
  }));
  assert.equal(posted.filter((message) => message.type === 'instagram-profile').length, 1);
});

test('filenames do not repeat a media extension already present in the id', () => {
  const popup = vm.createContext({ console: quiet, document: { querySelector: () => null, addEventListener() {} } });
  vm.runInContext(source('popup.js'), popup);
  popup.item = { id: 'ig_500100731_1823267538531568_5514530159845209663_n.jpg', platform: 'instagram', username: 'ssunbiki', display_name: '昵称', media_type: 'Image' };
  assert.equal(vm.runInContext('generateFilename(item)', popup),
    'instagram/ssunbiki_昵称/ig_500100731_1823267538531568_5514530159845209663_n.jpg');
  popup.item = { id: 'ig_clip.mp4', platform: 'instagram', username: 'ssunbiki', display_name: '昵称', media_type: 'Video' };
  assert.equal(vm.runInContext('generateFilename(item)', popup), 'instagram/ssunbiki_昵称/ig_clip.mp4');
  popup.item = { id: '.jpg', platform: 'instagram', username: 'ssunbiki' };
  assert.equal(vm.runInContext('generateFilename(item)', popup), 'instagram/ssunbiki/media.jpg');
});

test('profile folders keep handle underscores and normalize stylised names', () => {
  const popup = vm.createContext({ console: quiet, document: { querySelector: () => null, addEventListener() {} } });
  vm.runInContext(source('popup.js'), popup);

  // Enclosed letters in an Instagram display name are plain text after NFKC,
  // not the boxed glyphs that show up as mojibake in file managers.
  popup.item = { id: 'ig_1_n.jpg', platform: 'instagram', username: '__kkr____', display_name: '🄺🄾🄺🄾🅁🄾', media_type: 'Image' };
  assert.equal(vm.runInContext('generateFilename(item)', popup),
    'instagram/__kkr_____KOKORO/ig_1_n.jpg');

  // Emoji are part of the display name and must be preserved, not stripped.
  popup.item = { id: 'ig_2_n.jpg', platform: 'instagram', username: '__kkr____', display_name: '✨🇰🇷✨', media_type: 'Image' };
  assert.equal(vm.runInContext('generateFilename(item)', popup),
    'instagram/__kkr_____✨🇰🇷✨/ig_2_n.jpg');
});



test('Kuaishou reads profile metadata and media from INIT_STATE', async () => {
  const callbacks = {};
  const listeners = [];
  const location = { hostname: 'www.kuaishou.com', origin: 'https://www.kuaishou.com', protocol: 'https:', pathname: '/profile/3xde323hhpr9dju' };
  const state = {
    prefetch: {
      'profile': { result: 1, userProfile: {
        profile: { user_id: '3xde323hhpr9dju', user_name: '-小瑾·', headurl: 'https://p22.a.yximgs.com/uhead/a.jpg', user_text: 'bio' },
        userDefineId: 'jin970608', ownerCount: { fan: 1477000, follow: 89, photo_public: 25172 },
      } },
      'feed': { result: 1, feeds: [
        { type: 1, author: { id: '3xde323hhpr9dju', name: '-小瑾·' }, photo: {
          id: '3xabc', caption: 'hello', timestamp: 1700000000000, duration: 10000,
          coverUrl: 'https://p1.a.yximgs.com/cover.jpg',
          manifest: { adaptationSet: [{ representation: [
            { url: 'https://v1.kwaicdn.com/low.mp4', maxBitrate: 1000 },
            { url: 'https://v1.kwaicdn.com/high.mp4', maxBitrate: 2000 },
          ] }] },
        } },
        { type: 1, author: { id: '3xde323hhpr9dju', name: '-小瑾·' }, photo: {
          id: '3ximg', caption: 'atlas', timestamp: 1700000001000,
          coverUrl: 'https://p1.a.yximgs.com/cover2.jpg',
          ext_params: JSON.stringify({ atlas: { cdn: [
            { url: 'https://p1.a.yximgs.com/1.jpg' },
            { url: 'https://p1.a.yximgs.com/2.jpg' },
          ] } }),
        } },
        { type: 1, author: { id: '3xother', name: 'other' }, photo: { id: '3xforeign', duration: 1000, photoUrls: [{ url: 'https://v1.kwaicdn.com/x.mp4' }] } },
      ] },
    },
  };
  const window = {
    location,
    INIT_STATE: JSON.stringify(state),
    addEventListener(type, fn) { if (type === 'message') listeners.push(fn); },
    postMessage(data) { queueMicrotask(() => listeners.forEach((fn) => fn({ source: window, data }))); },
  };
  const document = {
    documentElement: { innerHTML: '' }, body: {}, title: '',
    querySelector: () => null, querySelectorAll: () => [],
  };
  const context = vm.createContext({
    URL, console: quiet, setTimeout, clearTimeout,
    performance: { getEntriesByType: () => [] }, document, window,
    XMLHttpRequest: class { send() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    chrome: { runtime: { sendMessage() {}, onMessage: { addListener(fn) { callbacks.message = fn; } } } },
  });
  vm.runInContext(source('kuaishou_media_interceptor.js'), context);
  vm.runInContext(source('content_script.js'), context);
  await flush();
  const extract = () => new Promise((resolve) => callbacks.message({ action: 'extractMedia' }, {}, resolve));
  const result = await extract();
  assert.equal(result.profileInfo.username, 'jin970608');
  assert.equal(result.profileInfo.profile_id, '3xde323hhpr9dju');
  assert.equal(result.profileInfo.display_name, '-小瑾·');
  assert.equal(result.profileInfo.follower_count, 1477000);
  assert.equal(result.profileInfo.post_count, 25172);
  assert.deepEqual(Array.from(result.media, (item) => item.id),
    ['ks_3xabc_video', 'ks_3ximg_img_0', 'ks_3ximg_img_1']);
  assert.equal(result.media[0].url, 'https://v1.kwaicdn.com/high.mp4');
  assert.equal(result.media[0].platform, 'kuaishou');
  assert.equal(result.media[0].username, 'jin970608');
  assert.equal(result.media[0].post_url, 'https://www.kuaishou.com/short-video/3xabc');
  assert.equal(result.media[1].media_type, 'Image');
  const popup = vm.createContext({ console: quiet, document: { querySelector: () => null, addEventListener() {} } });
  vm.runInContext(source('popup.js'), popup);
  popup.item = result.media[0];
  assert.equal(vm.runInContext('generateFilename(item)', popup), 'kuaishou/jin970608_-小瑾·/ks_3xabc_video.mp4');
});


test('download paths preserve Douyin folders and Chinese nicknames safely', async () => {
  const bg = backgroundHarness();
  await bg.run("handleDownload('https://cdn.example.com/v.mp4', 'douyin/alice_小明/video.mp4')");
  assert.equal(bg.started[0].filename, 'ProfileDownloader/douyin/alice_小明/video.mp4');
  await bg.run("handleDownload('https://cdn.example.com/v.mp4', 'douyin/../video.mp4')");
  assert.equal(bg.started[1].filename, 'ProfileDownloader/douyin/_/video.mp4');
  // Instagram handles may start/end with underscores; they are part of the
  // profile slug and must not be stripped from the folder name.
  await bg.run("handleDownload('https://cdn.example.com/v.mp4', 'instagram/__kkr_____KOKORO/ig_1.jpg')");
  assert.equal(bg.started[2].filename, 'ProfileDownloader/instagram/__kkr_____KOKORO/ig_1.jpg');
  await bg.run("handleDownload('https://cdn.example.com/v.mp4', 'instagram/user_🄺🄾🄺🄾🅁🄾/ig_2.jpg')");
  assert.equal(bg.started[3].filename, 'ProfileDownloader/instagram/user_KOKORO/ig_2.jpg');
  await bg.run("handleDownload('https://cdn.example.com/v.mp4', 'instagram/user_💓/ig_3.jpg')");
  assert.equal(bg.started[4].filename, 'ProfileDownloader/instagram/user_💓/ig_3.jpg');
});


test('all platforms use platform/ID_nickname folders after WASM processing', async () => {
  const popup = vm.createContext({ console: quiet, document: { querySelector: () => null, addEventListener() {} } });
  vm.runInContext(source('popup.js'), popup);
  vm.runInContext(`wasm = { process_media_batch: input => JSON.stringify(JSON.parse(input).map(({ display_name, ...item }) => item)) }; state.wasmReady = true;`, popup);
  const bg = backgroundHarness();
  for (const platform of ['twitter', 'tiktok', 'instagram', 'weibo', 'onlyfans', 'douyin', 'kuaishou']) {
    popup.items = [{ id: 'post1', platform, username: 'creator', display_name: '昵称/测试', media_type: 'Video' }];
    const filename = vm.runInContext('generateFilename(processMedia(items)[0])', popup);
    assert.equal(filename, `${platform}/creator_昵称_测试/post1.mp4`);
    bg.context.filename = filename;
    await bg.run("handleDownload('https://cdn.example.com/v.mp4', filename)");
    assert.equal(bg.started.at(-1).filename, `ProfileDownloader/${filename}`);
    popup.items[0].display_name = null;
    assert.equal(vm.runInContext('generateFilename(items[0])', popup), `${platform}/creator/post1.mp4`);
  }
});


test('video and image downloads queue only the matching media types', async () => {
  const elements = new Map();
  const batches = [];
  const context = vm.createContext({
    console: quiet,
    document: {
      addEventListener() {},
      querySelector(selector) {
        if (!elements.has(selector)) elements.set(selector, {
          style: {}, disabled: false, textContent: '',
          classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {},
        });
        return elements.get(selector);
      },
      querySelectorAll: () => [],
    },
    chrome: {
      i18n: fakeI18n,
      runtime: {
        async sendMessage(message) {
          if (message.action === 'getDownloadedFilenames') return { filenames: [] };
          if (message.action === 'downloadBatch') {
            batches.push(message.items);
            return { queued: message.items.length, skipped: 0, failed: 0 };
          }
          if (message.action === 'getDownloadQueueStatus') return { pending: 0, active: 0 };
          return {};
        },
      },
    },
  });
  vm.runInContext(source('popup.js'), context);
  context.items = [
    { id: 'v1', media_type: 'Video', url: 'https://cdn.example.com/1.mp4', platform: 'twitter', username: 'alice' },
    { id: 'i1', media_type: 'Image', url: 'https://cdn.example.com/1.jpg', platform: 'twitter', username: 'alice' },
    { id: 'v2', media_type: 'video', url: 'https://cdn.example.com/2.mp4', platform: 'twitter', username: 'alice' },
  ];
  vm.runInContext("state.platform = 'twitter'; state.mediaItems = items; updateDownloadButton();", context);
  assert.equal(elements.get('#download-videos-btn').textContent, '🎬 Videos (2)');
  assert.equal(elements.get('#download-images-btn').textContent, '🖼️ Images (1)');

  await vm.runInContext("startDownload('videos')", context);
  assert.deepEqual(Array.from(batches[0], (item) => item.id), ['v1', 'v2']);
  await vm.runInContext("startDownload('images')", context);
  assert.deepEqual(Array.from(batches[1], (item) => item.id), ['i1']);
  await vm.runInContext("startDownload('selected')", context);
  assert.equal(batches.length, 2, 'an empty selection must not queue a batch');
});

test('popup strings resolve through chrome.i18n placeholders', () => {
  const popup = vm.createContext({
    console: quiet, chrome: { i18n: fakeI18n },
    document: { querySelector: () => null, addEventListener() {} },
  });
  vm.runInContext(source('popup.js'), popup);
  assert.equal(vm.runInContext("t('statPosts', ['3'])", popup), '3 posts');
  assert.equal(vm.runInContext("t('downloadSelectedCount', ['2'])", popup), 'Download Selected (2)');
});

test('locale catalogs cover the same keys and declare their placeholders', () => {
  const catalogs = {};
  for (const locale of ['en', 'zh_CN']) {
    catalogs[locale] = JSON.parse(fs.readFileSync(
      path.join(__dirname, `../extension/_locales/${locale}/messages.json`), 'utf8'));
  }
  assert.deepEqual(Object.keys(catalogs.en).sort(), Object.keys(catalogs.zh_CN).sort());

  const manifest = JSON.parse(source('manifest.json'));
  assert.equal(manifest.default_locale, 'en');
  const refs = JSON.stringify(manifest).match(/__MSG_[A-Za-z0-9_]+__/g) || [];
  assert.ok(refs.length >= 3, 'manifest should localize name, description and action title');
  for (const ref of refs) {
    const key = ref.slice(6, -2);
    assert.ok(catalogs.en[key], `manifest references missing message ${key}`);
  }

  for (const [locale, catalog] of Object.entries(catalogs)) {
    for (const [key, entry] of Object.entries(catalog)) {
      const used = [...entry.message.matchAll(/\$([A-Za-z0-9_]+)\$/g)].map((m) => m[1].toLowerCase());
      const declared = Object.keys(entry.placeholders || {}).map((name) => name.toLowerCase());
      for (const name of used) {
        assert.ok(declared.includes(name), `${locale}.${key} uses undeclared placeholder $${name}$`);
      }
      for (const name of declared) {
        assert.ok(used.includes(name), `${locale}.${key} declares unused placeholder ${name}`);
      }
    }
  }
});
