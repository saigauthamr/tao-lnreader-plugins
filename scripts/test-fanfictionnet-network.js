import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const code = fs.readFileSync(
  '.js/src/plugins/english/fanfictionnet.js',
  'utf8',
);
const chapter = '<div id="storytext"><p>Chapter text</p></div>';
const challenge = () =>
  new Response('<title>Just a moment</title>', {
    status: 403,
    headers: { 'cf-mitigated': 'challenge' },
  });

function harness(fetchApi, fetchViaWebview, state = new Map()) {
  const time = { now: Date.UTC(2026, 10, 21) };
  class Clock extends Date {
    static now() {
      return time.now;
    }
  }
  const exports = {};
  const modules = {
    '@libs/fetch': { fetchApi, fetchViaWebview },
    '@libs/filterInputs': { FilterTypes: {} },
    '@libs/novelStatus': { NovelStatus: {} },
    '@libs/defaultCover': { defaultCover: 'cover' },
    '@libs/storage': {
      storage: {
        get: key => state.get(key)?.value,
        set: (key, value, expires) => state.set(key, { value, expires }),
        getAllKeys: () => [],
        delete: key => state.delete(key),
      },
    },
  };
  vm.runInNewContext(code, {
    Date: Clock,
    exports,
    require: key => modules[key] ?? require(key),
    setTimeout: (callback, delay) =>
      queueMicrotask(() => {
        time.now += delay;
        callback();
      }),
  });
  return { plugin: exports.default, time };
}

const accountPage = (start, end, total, next) => {
  const rows = Array.from(
    { length: end - start + 1 },
    (_, index) =>
      `<tr><td><a href="/s/${start + index}/1/">Story</a></td><td>Author</td><td>Fandom</td><td>11-17-2026</td></tr>`,
  ).join('');
  return (
    `<a href="/logout.php">Log out</a><b>Favorite Stories (${total})</b>` +
    '<table><tr><th>Story</th><th>Author</th><th>Category</th><th>Updated</th></tr>' +
    rows +
    '</table>' +
    (next ? `<a href="story.php?p=${next}">Next</a>` : '')
  );
};

test('opens one account page, reuses it during a challenge and avoids a request past the end', async () => {
  const requests = [];
  let blocked = false;
  const { plugin, time } = harness(async url => {
    requests.push(url);
    if (blocked) return challenge();
    return new Response(
      url.endsWith('?p=2')
        ? accountPage(51, 52, 52)
        : accountPage(1, 50, 52, 2),
    );
  });
  const options = { filters: { list: { value: 'favorites' } } };
  assert.equal((await plugin.popularNovels(1, options)).length, 50);
  assert.equal(requests.length, 1);
  assert.equal((await plugin.popularNovels(2, options)).length, 2);
  assert.equal((await plugin.popularNovels(3, options)).length, 0);
  assert.equal(requests.length, 2);

  time.now += 360_000;
  blocked = true;
  assert.equal((await plugin.popularNovels(1, options)).length, 50);
  await assert.rejects(plugin.parseChapter('s/1/1/'), {
    name: 'SourceUpdatePaused',
  });
  assert.equal(requests.length, 3);
  assert.equal(plugin.getRequestDiagnostics().staleHits, 1);
});

test('prioritizes a reader and shares an overlapping chapter request', async () => {
  const order = [];
  let release;
  const firstResponse = new Promise(resolve => {
    release = resolve;
  });
  const { plugin } = harness(async url => {
    const path = new URL(url).pathname;
    order.push(path);
    if (path === '/s/100/1/') await firstResponse;
    return new Response(chapter);
  });
  const first = plugin.parseChapter('s/100/1/', 'background');
  const queued = plugin.parseChapter('s/200/1/', 'background');
  const interactive = plugin.parseChapter('s/300/1/');
  const duplicate = plugin.parseChapter('s/100/1/');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['/s/100/1/']);

  release();
  await Promise.all([first, queued, interactive, duplicate]);
  assert.deepEqual(order, ['/s/100/1/', '/s/300/1/', '/s/200/1/']);
  await plugin.parseChapter('s/100/1/');
  assert.equal(order.length, 3);
  assert.equal(plugin.getRequestDiagnostics().coalesced, 1);
  assert.equal(plugin.getRequestDiagnostics().cacheHits, 1);
});

test('keeps a verification pause across plugin reloads and allows cached reading', async () => {
  const storage = new Map();
  let requests = 0;
  const first = harness(
    async url => {
      requests += 1;
      return url.includes('/s/1/') ? new Response(chapter) : challenge();
    },
    async () => ({ ok: false }),
    storage,
  );
  await first.plugin.parseChapter('s/1/1/');
  await assert.rejects(first.plugin.parseChapter('s/2/1/'), {
    name: 'SourceUpdatePaused',
  });
  const next = harness(
    async () => {
      requests += 1;
      return new Response(chapter);
    },
    async () => ({ ok: false }),
    storage,
  );
  await next.plugin.parseChapter('s/1/1/');
  await assert.rejects(next.plugin.parseChapter('s/2/1/'), {
    name: 'SourceUpdatePaused',
  });
  assert.equal(requests, 2);

  next.plugin.onSourceWebViewVerified();
  await next.plugin.parseChapter('s/2/1/');
  assert.equal(requests, 3);
});
