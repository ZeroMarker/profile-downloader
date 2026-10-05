const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = (name) => fs.readFileSync(path.join(__dirname, '../extension', name), 'utf8');
const quiet = { log() {}, warn() {}, error() {} };
const flush = () => new Promise((resolve) => setImmediate(resolve));

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

function backgroundHarness(stored) {
  let nextId = 0;
  let persisted;
  const started = [];
  const released = [];
  const downloads = new Map();
  const callbacks = {};
  let sourceValid = true;
  const context = vm.createContext({
    URL, console: quiet, setTimeout,
    chrome: {
      storage: { local: {
        async get(key, callback) { if (callback) callback({}); return { downloadQueueState: stored }; },
        async set(value) { persisted = JSON.parse(JSON.stringify(value.downloadQueueState)); },
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
        async download(options) { started.push(options); const id = ++nextId; downloads.set(id, { state: 'in_progress' }); return id; },
        async search({ id }) { return downloads.has(id) ? [downloads.get(id)] : []; },
        onChanged: { addListener() {} },
      },
    },
  });
  vm.runInContext(source('background.js'), context);
  return { context, started, released, callbacks, invalidateSource() { sourceValid = false; }, persisted: () => persisted, run: (code) => vm.runInContext(code, context) };
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
  assert.equal(vm.runInContext('generateFilename(item)', popup), 'douyin/bob_未命名/dy_2_0.jpg');
  location.pathname = '/';
  assert.equal((await extract()).media.length, 0);
  location.pathname = '/user/alice';
  document.querySelectorAll = () => [];
  await extract();
  await window.fetch('/aweme/v1/web/aweme/post/');
  await flush();
  assert.equal((await extract()).media.length, 1);
});


test('download paths preserve Douyin folders and Chinese nicknames safely', async () => {
  const bg = backgroundHarness();
  await bg.run("handleDownload('https://cdn.example.com/v.mp4', 'douyin/alice_小明/video.mp4')");
  assert.equal(bg.started[0].filename, 'ProfileDownloader/douyin/alice_小明/video.mp4');
  await bg.run("handleDownload('https://cdn.example.com/v.mp4', 'douyin/../video.mp4')");
  assert.equal(bg.started[1].filename, 'ProfileDownloader/douyin/_/video.mp4');
});


test('all platforms use platform/ID_nickname folders after WASM processing', async () => {
  const popup = vm.createContext({ console: quiet, document: { querySelector: () => null, addEventListener() {} } });
  vm.runInContext(source('popup.js'), popup);
  vm.runInContext(`wasm = { process_media_batch: input => JSON.stringify(JSON.parse(input).map(({ display_name, ...item }) => item)) }; state.wasmReady = true;`, popup);
  const bg = backgroundHarness();
  for (const platform of ['twitter', 'tiktok', 'instagram', 'weibo', 'onlyfans', 'douyin']) {
    popup.items = [{ id: 'post1', platform, username: 'creator', display_name: '昵称/测试', media_type: 'Video' }];
    const filename = vm.runInContext('generateFilename(processMedia(items)[0])', popup);
    assert.equal(filename, `${platform}/creator_昵称_测试/post1.mp4`);
    bg.context.filename = filename;
    await bg.run("handleDownload('https://cdn.example.com/v.mp4', filename)");
    assert.equal(bg.started.at(-1).filename, `ProfileDownloader/${filename}`);
    popup.items[0].display_name = null;
    assert.equal(vm.runInContext('generateFilename(items[0])', popup), `${platform}/creator_未命名/post1.mp4`);
  }
});
