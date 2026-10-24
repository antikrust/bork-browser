// Host tests for Cyberswine's link matching: no browser, no network.
//   deno task test:host
import { assertEquals } from "jsr:@std/assert@1";

// deno-lint-ignore no-explicit-any
const g = globalThis as any;
g.FKOF = undefined;
(0, eval)(Deno.readTextFileSync(new URL("../src/match.js", import.meta.url)));
const { hostOf } = g.FKOF.match;

Deno.test("a plain link is its own host", () => {
  assertEquals(hostOf("https://www.telegraph.co.uk/news/2026/x/"), "telegraph.co.uk");
});

Deno.test("a redirect parameter is unwrapped", () => {
  assertEquals(
    hostOf("https://www.google.com/url?q=https://www.telegraph.co.uk/news/x/&sa=U"),
    "telegraph.co.uk",
  );
});

Deno.test("Google's AMP cache path names the publisher", () => {
  assertEquals(hostOf("https://www.google.com/amp/s/www.telegraph.co.uk/news/2026/x/amp/"), "telegraph.co.uk");
  assertEquals(hostOf("/amp/s/www.telegraph.co.uk/news/x/", "https://www.google.co.uk/search?q=x"), "telegraph.co.uk");
  assertEquals(hostOf("https://www.google.co.uk/amp/www.dailymail.co.uk/news/x.amp"), "dailymail.co.uk");
});

Deno.test("the AMP project's cache path names the publisher", () => {
  assertEquals(
    hostOf("https://www-telegraph-co-uk.cdn.ampproject.org/c/s/www.telegraph.co.uk/news/x/amp/"),
    "telegraph.co.uk",
  );
  assertEquals(
    hostOf("https://www-thesun-co-uk.cdn.ampproject.org/v/s/www.thesun.co.uk/news/1/x/amp/?amp_js_v=0.1"),
    "thesun.co.uk",
  );
});

Deno.test("ordinary Google pages stay Google", () => {
  assertEquals(hostOf("https://www.google.com/search?q=amp"), "google.com");
  assertEquals(hostOf("https://www.google.com/amp/"), "google.com");
  assertEquals(hostOf("https://news.google.com/read/CBMiabc?hl=en-GB"), "news.google.com");
});

Deno.test("a site that merely has /amp/ in its path is not unwrapped", () => {
  assertEquals(hostOf("https://example.org/amp/s/www.telegraph.co.uk/"), "example.org");
});
