// Google News hides by printed publisher name (its links are its own
// redirects). These run the real content script against Google News-shaped
// cards — no browser, no network.
//   deno task test:host
import { assertEquals } from "jsr:@std/assert@1";
import { parseHTML } from "npm:linkedom@0.18.12";

// deno-lint-ignore no-explicit-any
type Any = any;

const FIXTURE = `<html><body><main><c-wiz>
  <article id="logo-beside-name">
    <a href="./read/AAA"><img src="t.jpg" alt=""></a>
    <div class="src"><img class="logo" src="l.png" alt=""> The Telegraph</div>
    <a href="./read/AAA">Ministers face pressure over budget</a>
    <time>2 hours ago</time>
  </article>
  <article id="name-alone">
    <a href="./read/BBB"><img src="t.jpg" alt=""></a>
    <div><span>The Telegraph</span></div>
    <a href="./read/BBB">Another story</a>
  </article>
  <article id="about-not-by">
    <a href="./read/CCC"><img src="t.jpg" alt=""></a>
    <div class="src"><img class="logo" src="l.png" alt=""> BBC News</div>
    <a href="./read/CCC">The Telegraph changes hands again</a>
  </article>
</c-wiz></main></body></html>`;

async function run(): Promise<Any> {
  const { window, document } = parseHTML(FIXTURE) as Any;
  const g = globalThis as Any;
  g.window = window;
  g.document = document;
  g.Node = window.Node;
  g.location = {
    protocol: "https:",
    hostname: "news.google.com",
    href: "https://news.google.com/search?q=telegraph",
  };
  g.MutationObserver = class { observe() {} };
  g.addEventListener = () => {};
  g.setInterval = () => 0;
  g.browser = {
    storage: {
      local: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
      onChanged: { addListener() {} },
    },
    runtime: { sendMessage: () => Promise.resolve(), onMessage: { addListener() {} } },
  };
  g.FKOF = undefined;
  for (const f of ["src/store.js", "src/outlets.js", "src/match.js", "src/content.js"]) {
    (0, eval)(Deno.readTextFileSync(new URL(`../${f}`, import.meta.url)));
  }
  // store.load() resolves on the next turns; then the first scan runs.
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  return document;
}

const hidden = (doc: Any, id: string) =>
  doc.getElementById(id).classList.contains("fkof-hidden") ||
  !!doc.getElementById(id).closest(".fkof-hidden");

Deno.test("a publisher name sharing its element with a logo hides the card", async () => {
  const doc = await run();
  assertEquals(hidden(doc, "logo-beside-name"), true);
});

Deno.test("a publisher name alone in its element still hides the card", async () => {
  const doc = await run();
  assertEquals(hidden(doc, "name-alone"), true);
});

Deno.test("a story ABOUT the Telegraph by someone else stays", async () => {
  const doc = await run();
  assertEquals(hidden(doc, "about-not-by"), false);
});
