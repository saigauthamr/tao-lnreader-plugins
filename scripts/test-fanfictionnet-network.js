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
const denyListBlock = () =>
  new Response('<title>Attention Required! | Cloudflare</title>', {
    status: 403,
  });

const storyHtml = (
  id,
  { title = `Story ${id}`, chapters = 1, complete = false } = {},
) => {
  const options =
    chapters > 1
      ? `<select id="chap_select">${Array.from(
          { length: chapters },
          (_, i) => `<option value="${i + 1}">${i + 1}. Ch ${i + 1}</option>`,
        ).join('')}</select>`
      : '';
  return (
    `<div id="pre_story_links"><a href="/book/">Books</a><a href="/book/Harry-Potter/">Harry Potter</a></div>` +
    `<div id="profile_top">` +
    `<b class="xcontrast_txt">${title}</b>` +
    `<a href="/u/42/Author/">Author</a>` +
    `<span class="xgray">Rated: Fiction T - English - Fantasy - Chapters: ${chapters}${complete ? ' - Status: Complete' : ''}</span>` +
    `<div class="xcontrast_txt">Summary</div>` +
    `</div>` +
    options +
    chapter
  );
};

function harness(fetchApi, fetchViaWebview, state = new Map()) {
  const time = { now: Date.UTC(2026, 10, 21, 12, 0, 0) };
  let nextTimerId = 1;
  const pendingTimers = new Map();
  const pacingDelays = [];

  class Clock extends Date {
    static now() {
      return time.now;
    }
  }

  const fakeSetTimeout = (callback, delay = 0) => {
    const id = nextTimerId++;
    if (delay <= 5000) {
      pacingDelays.push(delay);
      let cancelled = false;
      pendingTimers.set(id, {
        cancel: () => {
          cancelled = true;
        },
      });
      queueMicrotask(() => {
        if (cancelled) return;
        pendingTimers.delete(id);
        time.now += delay;
        callback();
      });
      return id;
    }
    pendingTimers.set(id, {
      fireAt: time.now + delay,
      callback,
    });
    return id;
  };

  const fakeClearTimeout = id => {
    const entry = pendingTimers.get(id);
    if (entry?.cancel) entry.cancel();
    pendingTimers.delete(id);
  };

  const advanceTime = async ms => {
    time.now += ms;
    const due = [];
    for (const [id, entry] of pendingTimers.entries()) {
      if (entry.fireAt !== undefined && entry.fireAt <= time.now) {
        pendingTimers.delete(id);
        due.push(entry);
      }
    }
    due.sort((a, b) => a.fireAt - b.fireAt);
    for (const entry of due) entry.callback();
    await new Promise(resolve => setImmediate(resolve));
  };

  const exports = {};
  const modules = {
    '@libs/fetch': { fetchApi, fetchViaWebview },
    '@libs/filterInputs': { FilterTypes: {} },
    '@libs/novelStatus': {
      NovelStatus: { Completed: 'Completed', Ongoing: 'Ongoing' },
    },
    '@libs/defaultCover': { defaultCover: 'cover' },
    '@libs/storage': {
      storage: {
        get: (key, raw) => {
          const entry = state.get(key);
          if (!entry) return undefined;
          if (entry.expires && time.now > entry.expires) {
            state.delete(key);
            return undefined;
          }
          return raw ? entry : entry.value;
        },
        set: (key, value, expires) =>
          state.set(key, { created: new Date(time.now), value, expires }),
        getAllKeys: () => Array.from(state.keys()),
        delete: key => state.delete(key),
      },
    },
  };
  vm.runInNewContext(code, {
    AbortController,
    Date: Clock,
    clearTimeout: fakeClearTimeout,
    exports,
    require: key => modules[key] ?? require(key),
    setTimeout: fakeSetTimeout,
  });
  return { plugin: exports.default, time, advanceTime, pacingDelays, state };
}

const accountPage = (
  start,
  end,
  total,
  next,
  {
    accountId = '1001',
    accountName = 'ReaderA',
    updated = '11-17-2026',
    listLabel = 'Favorite Stories',
    pathFile = 'story.php',
  } = {},
) => {
  const rows = Array.from(
    { length: end - start + 1 },
    (_, index) =>
      `<tr><td><a href="/s/${start + index}/1/">Story ${start + index}</a></td><td><a href="/u/9999/Author/">Author</a></td><td>Fandom</td><td>${typeof updated === 'function' ? updated(start + index) : updated}</td></tr>`,
  ).join('');
  const profileLink = accountId
    ? `<a href="/u/${accountId}/${accountName}/">${accountName}</a>`
    : '';
  return (
    `<div id="top">${profileLink}<a href="/logout.php">Log out</a></div>` +
    `<b>${listLabel} (${total})</b>` +
    '<table><tr><th>Story</th><th>Author</th><th>Category</th><th>Updated</th></tr>' +
    rows +
    '</table>' +
    (next ? `<a href="${pathFile}?p=${next}">Next</a>` : '')
  );
};

test('opens one account page, reuses it during a challenge within stale cap, and avoids a request past the end', async () => {
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

  // 6 minutes later (> 5m fresh TTL, <= 30m stale max age): serves same account's cached page.
  time.now += 6 * 60_000;
  blocked = true;
  assert.equal((await plugin.popularNovels(1, options)).length, 50);
  await assert.rejects(plugin.parseChapter('s/1/1/'), {
    name: 'SourceUpdatePaused',
  });
  assert.equal(requests.length, 4);
  assert.equal(plugin.getRequestDiagnostics().staleHits, 1);

  // Past 30-minute stale cap: withholds stale private page during challenge.
  time.now += 31 * 60_000;
  await assert.rejects(plugin.popularNovels(1, options), {
    name: 'SourceUpdatePaused',
  });
  assert.equal(requests.length, 6);
});

test('isolates private account cache on Account A -> Account B switch and logout followed by challenge', async () => {
  let mode = 'accountA';
  const requests = [];
  const { plugin, time } = harness(async url => {
    requests.push(url);
    if (mode === 'challenge') return challenge();
    if (mode === 'loggedOut')
      return new Response('<html><body>Please sign in</body></html>');
    if (mode === 'accountB') {
      return new Response(
        accountPage(201, 250, 260, 2, {
          accountId: '2002',
          accountName: 'ReaderB',
        }),
      );
    }
    return new Response(
      url.endsWith('?p=2')
        ? accountPage(51, 60, 60, undefined, { accountId: '1001' })
        : accountPage(1, 50, 60, 2, { accountId: '1001' }),
    );
  });
  const options = { filters: { list: { value: 'favorites' } } };

  // Account A caches page 1 and page 2.
  const a1 = await plugin.popularNovels(1, options);
  const a2 = await plugin.popularNovels(2, options);
  assert.equal(a1[0].path, 's/1/');
  assert.equal(a2[0].path, 's/51/');

  // Switch to Account B after TTL expires, fetch page 1, then hit challenge on page 2.
  time.now += 6 * 60_000;
  mode = 'accountB';
  const b1 = await plugin.popularNovels(1, options);
  assert.equal(b1[0].path, 's/201/');

  mode = 'challenge';
  await assert.rejects(plugin.popularNovels(2, options), {
    name: 'SourceUpdatePaused',
  });

  // After cooldown, log out, then immediately hit a challenge on page 1: must NOT serve Account B's page 1.
  time.now += 10 * 60_000;
  mode = 'loggedOut';
  await assert.rejects(plugin.popularNovels(1, options), {
    name: 'AccountListError',
  });
  mode = 'challenge';
  await assert.rejects(plugin.popularNovels(1, options), {
    name: 'SourceUpdatePaused',
  });
});

test('withholds private stale pages when account identity cannot be established (ignoring table author links)', async () => {
  let blocked = false;
  const { plugin, time } = harness(async () => {
    if (blocked) return challenge();
    // No accountId outside <table>; story rows still have /u/9999/Author/ links inside <table>.
    return new Response(accountPage(1, 50, 50, undefined, { accountId: '' }));
  });
  const options = { filters: { list: { value: 'favorites' } } };
  assert.equal((await plugin.popularNovels(1, options)).length, 50);

  time.now += 6 * 60_000;
  blocked = true;
  await assert.rejects(plugin.popularNovels(1, options), {
    name: 'SourceUpdatePaused',
  });
  assert.equal(plugin.getRequestDiagnostics().staleHits, 0);
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

test('times out a stalled fetch so foreground reading is never blocked forever', async () => {
  let hungSignal;
  const { plugin, advanceTime } = harness(async (url, init) => {
    if (url.includes('/s/1/')) {
      hungSignal = init?.signal;
      return new Promise(() => {});
    }
    return new Response(chapter);
  });

  const stalled = plugin.parseChapter('s/1/1/', 'background');
  const stalledRejected = assert.rejects(stalled, /timed out/i);
  const reader = plugin.parseChapter('s/2/1/');
  await new Promise(resolve => setImmediate(resolve));

  await advanceTime(25_000);
  await stalledRejected;
  assert.equal(hungSignal?.aborted, true);
  assert.match(await reader, /Chapter text/);
});

test('uses bounded exponential backoff on challenges and deny-list 403s, and recovers without app callbacks', async () => {
  const storage = new Map();
  let responseMode = 'challenge';
  let requests = 0;

  const first = harness(
    async url => {
      requests += 1;
      if (url.includes('/s/1/')) return new Response(chapter);
      if (responseMode === 'ok') return new Response(chapter);
      if (responseMode === 'deny') return denyListBlock();
      return challenge();
    },
    async () => ({ ok: false }),
    storage,
  );

  await first.plugin.parseChapter('s/1/1/');
  // Strike 1: 5-minute pause (finite retryAt, never undefined).
  await assert.rejects(first.plugin.parseChapter('s/2/1/'), err => {
    assert.equal(err.name, 'SourceUpdatePaused');
    assert.equal(typeof err.retryAt, 'number');
    assert.equal(err.retryAt - first.time.now, 5 * 60_000);
    return true;
  });

  // Reload plugin: still paused, cached chapter still readable, 0 new network requests for uncached chapter.
  const next = harness(
    async () => {
      requests += 1;
      if (responseMode === 'ok') return new Response(chapter);
      if (responseMode === 'deny') return denyListBlock();
      return challenge();
    },
    async () => ({ ok: false }),
    storage,
  );
  next.time.now = first.time.now + 60_000;
  await next.plugin.parseChapter('s/1/1/');
  await assert.rejects(next.plugin.parseChapter('s/2/1/'), {
    name: 'SourceUpdatePaused',
  });
  assert.equal(requests, 3);

  // Strike 2 after 5m cooldown using a 403 Cloudflare deny-list page -> escalates to 15m.
  next.time.now = first.time.now + 5 * 60_000 + 1;
  responseMode = 'deny';
  await assert.rejects(next.plugin.parseChapter('s/2/1/'), err => {
    assert.equal(err.name, 'SourceUpdatePaused');
    assert.equal(err.retryAt - next.time.now, 15 * 60_000);
    return true;
  });
  assert.equal(requests, 5);

  // Strike 3 after 15m cooldown -> caps at 30m.
  next.time.now += 15 * 60_000 + 1;
  await assert.rejects(next.plugin.parseChapter('s/2/1/'), err => {
    assert.equal(err.name, 'SourceUpdatePaused');
    assert.equal(err.retryAt - next.time.now, 30 * 60_000);
    return true;
  });
  assert.equal(requests, 7);

  // After 30m cooldown, clean response clears pause and resets strike count.
  next.time.now += 30 * 60_000 + 1;
  responseMode = 'ok';
  assert.match(await next.plugin.parseChapter('s/2/1/'), /Chapter text/);
  assert.equal(requests, 8);

  // Next challenge starts back at 5m (strike 1), not 30m.
  responseMode = 'challenge';
  await assert.rejects(next.plugin.parseChapter('s/3/1/'), err => {
    assert.equal(err.name, 'SourceUpdatePaused');
    assert.equal(err.retryAt - next.time.now, 5 * 60_000);
    return true;
  });

  // Optional WebView callback still clears verification pause early.
  next.plugin.onSourceWebViewVerified();
  responseMode = 'ok';
  assert.match(await next.plugin.parseChapter('s/3/1/'), /Chapter text/);
});

test('caps a 995-story cold stock LNReader sweep at 15 live fetches and resumes cleanly next window', async () => {
  const storyRequests = [];
  const { plugin, time, pacingDelays } = harness(async url => {
    const match = url.match(/\/s\/(\d+)\/1\//);
    if (match) {
      storyRequests.push(Number(match[1]));
      return new Response(storyHtml(match[1], { complete: true }));
    }
    return new Response('<html><body>Sign in</body></html>');
  });

  // Simulate stock LNReader 2.1.4 updateLibrary loop: 1-arg parseNovel, 1s sleep on success, 0s on error.
  let pausedErrors = 0;
  for (let id = 1; id <= 995; id += 1) {
    try {
      await plugin.parseNovel(`s/${id}/`);
      time.now += 1000;
    } catch (error) {
      assert.equal(error.name, 'SourceUpdatePaused');
      pausedErrors += 1;
    }
  }

  assert.equal(storyRequests.length, 15);
  assert.deepEqual(
    storyRequests,
    Array.from({ length: 15 }, (_, i) => i + 1),
  );
  assert.equal(pausedErrors, 1);
  // Batch pacing delays should be jittered between 2.5s and 4.0s (accounting for LNReader's 1s sleep).
  assert.ok(pacingDelays.some(d => d >= 1500 && d <= 4000));

  // Interactive single-story open (> 5s later) still works even after batch budget is exhausted.
  time.now += 10_000;
  const interactive = await plugin.parseNovel('s/999/');
  assert.equal(interactive.name, 'Story 999');
  assert.equal(storyRequests.length, 16);

  // Next window (16 minutes later): re-running from story #1 skips completed baselines #1..#15 in 0 requests
  // (story #1 is isolated first call so 1 live fetch or #16..#30 get baselined, total <= 15 live fetches).
  storyRequests.length = 0;
  time.now += 16 * 60_000;
  for (let id = 1; id <= 40; id += 1) {
    try {
      await plugin.parseNovel(`s/${id}/`);
      time.now += 1000;
    } catch (error) {
      assert.equal(error.name, 'SourceUpdatePaused');
    }
  }
  assert.equal(storyRequests.length, 15);
  // Stories #2..#15 were skipped completely (0 requests); #16..#29 were newly baselined.
  for (let id = 2; id <= 15; id += 1) {
    assert.ok(
      !storyRequests.includes(id),
      `Expected story ${id} to be skipped`,
    );
  }
  assert.ok(storyRequests.includes(16));
  assert.ok(storyRequests.includes(29));
});

test('uses signed-in account list dates to skip unchanged stories without bumping fetchedAt', async () => {
  const storyRequests = [];
  const accountRequests = [];
  let chapterCountFor3 = 1;
  const { plugin, time, state } = harness(async url => {
    if (url.includes('/alert/story.php')) {
      accountRequests.push(url);
      return new Response(
        accountPage(1, 3, 3, undefined, {
          listLabel: 'Stories you are following',
          updated: id => (id === 3 ? '11-21-2026' : '11-10-2026'),
        }),
      );
    }
    const match = url.match(/\/s\/(\d+)\/1\//);
    if (match) {
      const id = Number(match[1]);
      storyRequests.push(id);
      return new Response(
        storyHtml(id, {
          complete: id === 1,
          chapters: id === 3 ? chapterCountFor3 : 1,
        }),
      );
    }
    return new Response('Not found', { status: 404 });
  });

  // Initial baseline fetch (simulating interactive adds) for stories 1 (Completed), 2 (Ongoing unchanged), 3 (Ongoing updated later).
  await plugin.parseNovel('s/1/', 'interactive');
  await plugin.parseNovel('s/2/', 'interactive');
  await plugin.parseNovel('s/3/', 'interactive');
  assert.deepEqual(storyRequests, [1, 2, 3]);
  const baseline2FetchedAt = state.get('novel-baseline:2').value.fetchedAt;
  const baseline3FetchedAt = state.get('novel-baseline:3').value.fetchedAt;

  // 2 hours later, story 3 gets a second chapter.
  storyRequests.length = 0;
  accountRequests.length = 0;
  time.now += 2 * 60 * 60_000;
  chapterCountFor3 = 2;

  const r1 = await plugin.parseNovel('s/1/', 'background');
  const r2 = await plugin.parseNovel('s/2/', 'background');
  const r3 = await plugin.parseNovel('s/3/', 'background');

  assert.equal(r1.status, 'Completed');
  assert.equal(r2.chapters.length, 1);
  assert.equal(r3.chapters.length, 2);
  // Only 1 account-list page request and 1 story request (story 3)!
  assert.equal(accountRequests.length, 1);
  assert.deepEqual(storyRequests, [3]);
  // Story 2's stored fetchedAt was NOT bumped when returning cached chapters!
  assert.equal(
    state.get('novel-baseline:2').value.fetchedAt,
    baseline2FetchedAt,
  );
  // Story 3's stored fetchedAt WAS updated to the new live fetch time!
  assert.ok(state.get('novel-baseline:3').value.fetchedAt > baseline3FetchedAt);
});

test('backs off account-list delta lookups for signed-out users without hammering /alert/story.php', async () => {
  const accountRequests = [];
  const storyRequests = [];
  const { plugin, time } = harness(async url => {
    if (
      url.includes('/alert/story.php') ||
      url.includes('/favorites/story.php')
    ) {
      accountRequests.push(url);
      return new Response('<html><body>Please sign in</body></html>');
    }
    const match = url.match(/\/s\/(\d+)\/1\//);
    if (match) {
      storyRequests.push(Number(match[1]));
      return new Response(storyHtml(match[1], { complete: false }));
    }
    return new Response('Not found', { status: 404 });
  });

  // Baseline 3 ongoing stories first (probes /alert/story.php once, then backs off).
  for (const id of [1, 2, 3]) await plugin.parseNovel(`s/${id}/`, 'background');
  assert.equal(accountRequests.length, 1);
  accountRequests.length = 0;
  storyRequests.length = 0;

  // 2 hours later (within 12h signed-out fallback cooldown): checks /alert/story.php once, skips live fetches.
  time.now += 2 * 60 * 60_000;
  for (const id of [1, 2, 3]) await plugin.parseNovel(`s/${id}/`, 'background');
  assert.equal(accountRequests.length, 1);
  assert.deepEqual(storyRequests, []);

  // 13 hours later (past 12h fallback cooldown): probes /alert/story.php once, then refreshes all 3 live.
  accountRequests.length = 0;
  time.now += 13 * 60 * 60_000;
  for (const id of [1, 2, 3]) await plugin.parseNovel(`s/${id}/`, 'background');
  assert.equal(accountRequests.length, 1);
  assert.deepEqual(storyRequests, [1, 2, 3]);
});

test('does not false-positive on Cloudflare passive jsd challenge-platform script in 200 OK pages', async () => {
  const seenInits = [];
  const passiveBeacon =
    "<script>var u='/cdn-cgi/challenge-platform/scripts/jsd/main.js?ray=abc';</script>";
  const { plugin } = harness(async (url, init) => {
    seenInits.push({ url, init });
    if (url.includes('/favorites/story.php')) {
      return new Response(accountPage(1, 2, 2) + passiveBeacon);
    }
    return new Response(storyHtml(42, { chapters: 3 }) + passiveBeacon);
  });

  const novel = await plugin.parseNovel('s/42/');
  assert.equal(novel.name, 'Story 42');
  assert.equal(novel.chapters.length, 3);
  assert.equal(plugin.getRequestDiagnostics().challenges, 0);

  // Account list sends both credentials: 'include' and desktop User-Agent (avoids mobile 404 redirect).
  const favs = await plugin.popularNovels(1, {
    filters: { list: { value: 'favorites' } },
  });
  assert.equal(favs.length, 2);
  const favReq = seenInits.find(r => r.url.includes('/favorites/story.php'));
  assert.equal(favReq.init.credentials, 'include');
  assert.ok(favReq.init.headers?.['User-Agent']);
});

test('falls back to WebView native UA and parses m.fanfiction.net HTML when desktop UA is challenged', async () => {
  const mobileStory =
    '<div id="content"><div align="center"><b>Mobile Story</b> by <a href="/u/7/">AuthorM</a></div>' +
    '<a href="/book/">Books</a> » <a href="/book/Harry-Potter/">Harry Potter</a>' +
    '<img class="mt icons" src="//ff77.b-cdn.net/static/fcons/script-attribute-c.png"/></div>' +
    '<div id="storycontent"><p>Mobile chapter 1</p></div>' +
    '<script>var chs = 4;</script>';
  const mobileSearch =
    '<div class="bs brb"><a href="/s/77/1/Test"><b>Mobile Hit</b></a> by <a href="/u/7/">AuthorM</a></div>';

  const { plugin } = harness(async (url, init) => {
    if (init?.headers?.['User-Agent']) return challenge();
    assert.equal(init?.credentials, 'include');
    if (url.includes('/search/')) return new Response(mobileSearch);
    return new Response(mobileStory);
  });

  const novel = await plugin.parseNovel('s/77/');
  assert.equal(novel.name, 'Mobile Story');
  assert.equal(novel.author, 'AuthorM');
  assert.equal(novel.status, 'Completed');
  assert.equal(novel.chapters.length, 4);
  assert.match(await plugin.parseChapter('s/77/1/'), /Mobile chapter 1/);

  const hits = await plugin.searchNovels('test', 1);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, 's/77/');
  assert.equal(hits[0].name, 'Mobile Hit');
});

test('advances through ongoing stories across sequential windows when signed out without looping on #1..#15', async () => {
  const storyRequests = [];
  const { plugin, time } = harness(async url => {
    const match = url.match(/\/s\/(\d+)\/1\//);
    if (match) {
      storyRequests.push(Number(match[1]));
      return new Response(storyHtml(match[1], { complete: false }));
    }
    return new Response('<html><body>Sign in</body></html>');
  });

  // Window 1: checks ongoing stories #1..#15, emits 1 toast, silently skips #16..#45.
  let toasts = 0;
  for (let id = 1; id <= 45; id += 1) {
    try {
      await plugin.parseNovel(`s/${id}/`);
      time.now += 1000;
    } catch (error) {
      assert.equal(error.name, 'SourceUpdatePaused');
      toasts += 1;
    }
  }
  assert.equal(toasts, 1);
  assert.deepEqual(
    storyRequests,
    Array.from({ length: 15 }, (_, i) => i + 1),
  );

  // Window 2 (16 min later): skips #2..#15 (within 12h fallback cooldown), advances to #16..#29.
  storyRequests.length = 0;
  toasts = 0;
  time.now += 16 * 60_000;
  for (let id = 1; id <= 45; id += 1) {
    try {
      await plugin.parseNovel(`s/${id}/`);
      time.now += 1000;
    } catch (error) {
      assert.equal(error.name, 'SourceUpdatePaused');
      toasts += 1;
    }
  }
  assert.equal(toasts, 1);
  assert.equal(storyRequests.length, 15);
  for (let id = 2; id <= 15; id += 1) {
    assert.ok(!storyRequests.includes(id), `Expected ongoing story ${id} to be skipped`);
  }
  assert.ok(storyRequests.includes(16));
  assert.ok(storyRequests.includes(29));
});

test('uses signed-in account list dates on cold-start migrated stories without live-fetching unchanged fics', async () => {
  const storyRequests = [];
  const accountRequests = [];
  let updatedMap = {
    1: '05-01-2025', // old migrated fic
    2: '11-19-2026', // updated yesterday (within 3-day cold-start window)
    3: '10-15-2026', // old migrated fic that updates later
  };
  const { plugin, time } = harness(async url => {
    if (url.includes('/alert/story.php')) {
      accountRequests.push(url);
      return new Response(
        accountPage(1, 3, 3, undefined, {
          listLabel: 'Stories you are following',
          updated: id => updatedMap[id] ?? '05-01-2025',
        }),
      );
    }
    const match = url.match(/\/s\/(\d+)\/1\//);
    if (match) {
      const id = Number(match[1]);
      storyRequests.push(id);
      return new Response(storyHtml(id, { complete: false, chapters: 5 }));
    }
    return new Response('Not found', { status: 404 });
  });

  // First background sweep on migrated stories with NO baselines:
  // Story 1 & 3 are >3 days old -> skipped with empty chapters (0 live fetches); Story 2 is recent -> live fetched.
  const r1 = await plugin.parseNovel('s/1/', 'background');
  const r2 = await plugin.parseNovel('s/2/', 'background');
  const r3 = await plugin.parseNovel('s/3/', 'background');
  assert.equal(r1.chapters.length, 0);
  assert.equal(r1.name, 'Story 1');
  assert.equal(r2.chapters.length, 5);
  assert.equal(r3.chapters.length, 0);
  assert.deepEqual(storyRequests, [2]);
  assert.equal(accountRequests.length, 1);

  // Next day: story 3 posts a new chapter!
  storyRequests.length = 0;
  accountRequests.length = 0;
  time.now += 24 * 60 * 60_000;
  updatedMap = {
    1: '05-01-2025',
    2: '11-19-2026',
    3: '11-22-2026',
  };

  const n1 = await plugin.parseNovel('s/1/', 'background');
  const n2 = await plugin.parseNovel('s/2/', 'background');
  const n3 = await plugin.parseNovel('s/3/', 'background');
  assert.equal(n1.chapters.length, 0);
  assert.equal(n2.chapters.length, 5);
  assert.equal(n3.chapters.length, 5);
  // Only story 3 triggered a live fetch!
  assert.deepEqual(storyRequests, [3]);
});

test('checkLibraryUpdates filters signed-in migrated library using DB lastUpdatedAt in one scan', async () => {
  const accountRequests = [];
  let updatedMap = {
    1: '05-01-2025', // unchanged old migrated fic
    2: '11-21-2026', // updated today (newer than DB lastUpdatedAt)
    3: '10-15-2026', // unchanged migrated fic matching DB date
  };
  const { plugin, time } = harness(async url => {
    if (url.includes('/alert/story.php')) {
      accountRequests.push(url);
      return new Response(
        accountPage(1, 3, 3, undefined, {
          listLabel: 'Stories you are following',
          updated: id => updatedMap[id] ?? '05-01-2025',
        }),
      );
    }
    return new Response('Not found', { status: 404 });
  });

  const candidates = [
    { path: 's/1/', name: 'Story 1', lastUpdatedAt: '2025-05-01T12:00:00.000Z', status: 'Ongoing' },
    { path: 's/2/', name: 'Story 2', lastUpdatedAt: '2026-10-01T12:00:00.000Z', status: 'Ongoing' },
    { path: 's/3/', name: 'Story 3', lastUpdatedAt: '2026-10-15 08:00:00', status: 'Ongoing' },
  ];

  const toUpdate = await plugin.checkLibraryUpdates(candidates);
  assert.deepEqual(Array.from(toUpdate), ['s/2/']);
  assert.equal(accountRequests.length, 1);

  // Next day: story 3 updates!
  time.now += 24 * 60 * 60_000;
  updatedMap = { 1: '05-01-2025', 2: '11-21-2026', 3: '11-22-2026' };
  const nextUpdate = await plugin.checkLibraryUpdates([
    candidates[0],
    { ...candidates[1], lastUpdatedAt: '2026-11-21T12:00:00.000Z' },
    candidates[2],
  ]);
  assert.ok(nextUpdate.includes('s/3/'));
  assert.ok(!nextUpdate.includes('s/1/'));
});

test('checkLibraryUpdates returns undefined when signed out and isBackground object throws SourceUpdatePaused directly', async () => {
  const storyRequests = [];
  const { plugin, time } = harness(async url => {
    const match = url.match(/\/s\/(\d+)\/1\//);
    if (match) {
      storyRequests.push(Number(match[1]));
      return new Response(storyHtml(match[1], { complete: false }));
    }
    return new Response('<html><body>Sign in</body></html>');
  });

  const batchResult = await plugin.checkLibraryUpdates([
    { path: 's/1/', name: 'Story 1', status: 'Ongoing' },
  ]);
  assert.equal(batchResult, undefined);

  // Pause-aware host passes { isBackground: true } -> throws SourceUpdatePaused at #16 directly
  // and does NOT lock stories #1..#15 behind the 12h fallback cooldown on the next window.
  let pausedAt;
  for (let id = 1; id <= 20; id += 1) {
    try {
      await plugin.parseNovel(`s/${id}/`, { isBackground: true });
      time.now += 1000;
    } catch (error) {
      assert.equal(error.name, 'SourceUpdatePaused');
      pausedAt = id;
      break;
    }
  }
  assert.equal(pausedAt, 16);
  assert.equal(storyRequests.length, 15);

  // 16 minutes later (past 10-min NOVEL_TTL_MS, well within 12h): story #1 can be checked again immediately
  // if a small category finishes rotating!
  storyRequests.length = 0;
  time.now += 16 * 60_000;
  await plugin.parseNovel('s/1/', { isBackground: true });
  assert.deepEqual(storyRequests, [1]);
});
