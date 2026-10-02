/**
 * Logic tests — run with: deno test -A
 *
 * The filtering and threading modules are deliberately free of DOM and storage,
 * so the rules that decide whether a stranger gets muted can be checked without
 * a browser, a live stream, or waiting for someone to say something awful.
 *
 * They are plain scripts that hang themselves off globalThis (content scripts
 * cannot be ES modules), so the test loads them the same way the browser does.
 */

const here = new URL(".", import.meta.url).pathname;

for (const file of ["src/filters.js", "src/threads.js"]) {
  const source = await Deno.readTextFile(`${here}../${file}`);
  // Indirect eval so the scripts land in global scope, as they do in a page.
  (0, eval)(source);
}

// deno-lint-ignore no-explicit-any
const YTCT = (globalThis as any).YTCT;
const { compile, decide, blockSet, normalizeName } = YTCT.filters;
const { ThreadStore } = YTCT.threads;

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}\n  expected: ${expected}\n  actual:   ${actual}`);
  }
}

const baseConfig = {
  enabled: true,
  wholeWord: false,
  caseSensitive: false,
  matchAuthorNames: false,
  protectStaff: true,
};

function judge(
  message: Record<string, unknown>,
  { words = [] as string[], banWords = [] as string[], authors = [] as unknown[], config = {} },
) {
  const cfg = { ...baseConfig, ...config };
  return decide(
    { authorType: "", ...message },
    {
      config: cfg,
      rules: compile(words, cfg),
      banRules: compile(banWords, cfg),
      blocked: blockSet(authors),
    },
  );
}

/* ------------------------------------------------------------------ filters */

Deno.test("plain word rule hides the message, case-insensitively", () => {
  const verdict = judge({ author: "Bob", text: "get your FREE VBUCKS here" }, {
    words: ["free vbucks"],
  });
  equal(verdict.hide, true, "should hide");
  equal(verdict.reason, "word", "should cite the word rule");
});

Deno.test("whole-word mode stops a substring false positive", () => {
  const loose = judge({ author: "Bob", text: "back to class everyone" }, {
    words: ["ass"],
  });
  equal(loose.hide, true, "substring match hides by default");

  const strict = judge({ author: "Bob", text: "back to class everyone" }, {
    words: ["ass"],
    config: { wholeWord: true },
  });
  equal(strict.hide, false, "whole-word mode should leave 'class' alone");
});

Deno.test("regex rules keep their own flags", () => {
  const cased = judge({ author: "Bob", text: "FIRST" }, { words: ["/^first$/"] });
  equal(cased.hide, false, "a regex without /i must stay case-sensitive");

  const insensitive = judge({ author: "Bob", text: "FIRST" }, { words: ["/^first$/i"] });
  equal(insensitive.hide, true, "an /i regex should match");
});

Deno.test("a broken regex is reported, not thrown, and other rules survive", () => {
  const compiled = compile(["/unclosed(/", "spam"], baseConfig);
  assert(compiled[0].error, "the bad rule should carry an error");
  assert(compiled[1].re, "the good rule should still compile");
});

Deno.test("ban words block the person, and outrank ordinary hide rules", () => {
  const verdict = judge({ author: "Nigel", text: "honestly, woke nonsense" }, {
    words: ["nonsense"],
    banWords: ["woke"],
  });
  equal(verdict.hide, true, "should hide");
  equal(verdict.reason, "banword", "ban rule must win over the hide rule");
  equal(verdict.rule, "woke", "should report which phrase did it");
});

Deno.test("a blocked author is hidden whatever they say", () => {
  const verdict = judge({ author: "Nigel", text: "lovely weather today" }, {
    authors: [{ name: "Nigel" }],
  });
  equal(verdict.hide, true, "blocked authors stay blocked");
  equal(verdict.reason, "author", "should cite the author block");
});

Deno.test("blocklist survives zero-width and full-width name padding", () => {
  const padded = "N​ige‍l";
  equal(normalizeName(padded), "nigel", "zero-width padding should fold away");
  equal(normalizeName("Ｎｉｇｅｌ"), "nigel", "full-width letters should fold away");

  const verdict = judge({ author: padded, text: "back again" }, {
    authors: [{ name: "Nigel" }],
  });
  equal(verdict.hide, true, "the same person under a padded name is still blocked");
});

Deno.test("moderators and the owner are protected from word rules", () => {
  const mod = judge({ author: "Mod", text: "please stop saying woke", authorType: "moderator" }, {
    banWords: ["woke"],
  });
  equal(mod.hide, false, "a moderator answering the noise must not be caught by it");

  const viewer = judge({ author: "Someone", text: "please stop saying woke" }, {
    banWords: ["woke"],
  });
  equal(viewer.hide, true, "an ordinary viewer saying it still trips the rule");
});

Deno.test("filtering off means nothing is hidden", () => {
  const verdict = judge({ author: "Nigel", text: "woke" }, {
    banWords: ["woke"],
    authors: [{ name: "Nigel" }],
    config: { enabled: false },
  });
  equal(verdict.hide, false, "the master switch should win");
});

/* ----------------------------------------------------------------- channels */

Deno.test("channel blocklist matching folds names like author matching does", () => {
  const set = blockSet([{ name: "Talk TV" }]);
  assert(set.has(normalizeName("talk tv")), "case should fold");
  assert(set.has(normalizeName("Ｔａｌｋ ＴＶ")), "full-width letters should fold");
});

/* ------------------------------------------------------------------ threads */

function makeStore() {
  return new ThreadStore({ windowMs: 60_000, maxRecent: 50, maxThreads: 10 });
}

Deno.test("an @mention attaches the reply to the message it answers", () => {
  const store = makeStore();
  const now = Date.now();
  store.add({ id: "1", author: "Alice", text: "what time does it start?", ts: now });
  const result = store.add({ id: "2", author: "Bob", text: "@Alice about eight", ts: now + 1000 });

  equal(result.isReply, true, "should be recognised as a reply");
  equal(result.rootId, "1", "should hang off Alice's message");
  equal(store.threads.get("1")!.replies.length, 1, "thread should hold the reply");
});

Deno.test("the longest matching name wins when two people share a prefix", () => {
  const store = makeStore();
  const now = Date.now();
  store.add({ id: "1", author: "Bob", text: "hello", ts: now });
  store.add({ id: "2", author: "Bob Smith", text: "hello too", ts: now + 10 });
  const result = store.add({ id: "3", author: "Cal", text: "@Bob Smith hi", ts: now + 20 });

  equal(result.rootId, "2", "'@Bob Smith' must not be read as '@Bob'");
});

Deno.test("replies chain onto the root, not into ever-deeper nesting", () => {
  const store = makeStore();
  const now = Date.now();
  store.add({ id: "1", author: "Alice", text: "question?", ts: now });
  store.add({ id: "2", author: "Bob", text: "@Alice answer", ts: now + 10 });
  const third = store.add({ id: "3", author: "Alice", text: "@Bob thanks", ts: now + 20 });

  equal(third.rootId, "1", "the whole exchange stays one thread");
  equal(store.threads.get("1")!.replies.length, 2, "both replies live under the root");
});

Deno.test("a mention older than the window starts its own thread", () => {
  const store = makeStore();
  const now = Date.now();
  store.add({ id: "1", author: "Alice", text: "ancient message", ts: now - 120_000 });
  const result = store.add({ id: "2", author: "Bob", text: "@Alice still there?", ts: now });

  equal(result.isReply, false, "a mention should not reach back forever");
});

Deno.test("mentioning yourself is a correction, not a reply", () => {
  const store = makeStore();
  const now = Date.now();
  store.add({ id: "1", author: "Alice", text: "teh answer is 4", ts: now });
  const result = store.add({ id: "2", author: "Alice", text: "@Alice *the", ts: now + 10 });

  equal(result.isReply, false, "self-mention should not thread onto itself");
});

Deno.test("re-adding the same message does not duplicate it", () => {
  const store = makeStore();
  const message = { id: "1", author: "Alice", text: "hello", ts: Date.now() };
  store.add(message);
  const again = store.add(message);

  equal(again.known, true, "a rescan should recognise messages it has already filed");
  equal(store.threads.size, 1, "and not add a second thread for it");
});

Deno.test("old threads are trimmed and reported so the view can unmount them", () => {
  const store = makeStore();
  const now = Date.now();
  for (let i = 0; i < 13; i++) {
    store.add({ id: `m${i}`, author: `User${i}`, text: "hi", ts: now + i });
  }
  const dropped = store.trim();

  equal(store.threads.size, 10, "should trim down to maxThreads");
  equal(dropped.length, 3, "should report what it dropped");
  equal(dropped[0], "m0", "oldest goes first");
});
