// SPDX-License-Identifier: MPL-2.0
// @colocated-env browser

import {
  isAllowedMetalinkUrl,
  isSafeMetalinkName,
  MetalinkParseError,
  orderMirrors,
  parseMetalink,
  strongestHash,
} from "../Metalink.sys.mts";
import {
  parseLinkValue,
  parseMetalinkHeaders,
  splitLinkHeader,
} from "../MetalinkHttp.sys.mts";
import {
  assert,
  assertEquals,
  runTests,
  type TestCase,
} from "../../../chrome/test/utils/test_harness.ts";

/** The example document from RFC 5854 §5. */
const RFC_EXAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<metalink xmlns="urn:ietf:params:xml:ns:metalink">
  <file name="example.ext">
    <size>14471447</size>
    <url>ftp://ftp.example.com/example.ext</url>
    <url>http://example.com/example.ext</url>
    <metaurl mediatype="torrent">http://example.com/example.ext.torrent</metaurl>
  </file>
</metalink>`;

const FULL_V4 = `<?xml version="1.0" encoding="UTF-8"?>
<metalink xmlns="urn:ietf:params:xml:ns:metalink">
  <file name="bork.dmg">
    <size>1024</size>
    <description>A browser</description>
    <version>1.1.1</version>
    <language>en-US</language>
    <os>macOS</os>
    <hash type="md5">0123456789abcdef0123456789abcdef</hash>
    <hash type="sha-256">abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789</hash>
    <url priority="10" location="de">http://de.example.com/bork.dmg</url>
    <url priority="1" location="us">http://us.example.com/bork.dmg</url>
    <url location="jp">http://jp.example.com/bork.dmg</url>
    <url>javascript:alert(1)</url>
    <url>file:///etc/passwd</url>
  </file>
</metalink>`;

const V3 = `<?xml version="1.0" encoding="utf-8"?>
<metalink version="3.0" xmlns="http://www.metalinker.org/">
  <files>
    <file name="old.iso">
      <size>4096</size>
      <verification>
        <hash type="sha-256">ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00</hash>
      </verification>
      <resources>
        <url type="http" preference="100">http://fast.example.com/old.iso</url>
        <url type="http" preference="10">http://slow.example.com/old.iso</url>
      </resources>
    </file>
  </files>
</metalink>`;

const tests: TestCase[] = [
  // --- name safety (RFC 5854 §4.1.2.1) ---
  {
    name: "isSafeMetalinkName accepts an ordinary filename",
    fn() {
      assert(isSafeMetalinkName("bork.dmg"), "plain name should be allowed");
      assert(isSafeMetalinkName("sub/dir/file.txt"), "subpaths are allowed");
    },
  },
  {
    name: "isSafeMetalinkName rejects traversal and absolute paths",
    fn() {
      const bad = [
        "../etc/passwd",
        "a/../../b",
        "/etc/passwd",
        "\\windows\\system32",
        "..\\..\\x",
        "C:\\evil",
        "",
        "with\0null",
        ".",
      ];
      for (const name of bad) {
        assert(
          !isSafeMetalinkName(name),
          `should reject ${JSON.stringify(name)}`,
        );
      }
    },
  },

  // --- URL scheme allowlist ---
  {
    name: "isAllowedMetalinkUrl allows transfer protocols only",
    fn() {
      assert(isAllowedMetalinkUrl("http://a/b"), "http allowed");
      assert(isAllowedMetalinkUrl("https://a/b"), "https allowed");
      assert(isAllowedMetalinkUrl("ftp://a/b"), "ftp allowed");
      assert(!isAllowedMetalinkUrl("javascript:alert(1)"), "js rejected");
      assert(!isAllowedMetalinkUrl("file:///etc/passwd"), "file rejected");
      assert(!isAllowedMetalinkUrl("data:text/html,x"), "data rejected");
      assert(!isAllowedMetalinkUrl("chrome://browser/x"), "chrome rejected");
      assert(!isAllowedMetalinkUrl("not a url"), "garbage rejected");
    },
  },

  // --- v4 parsing ---
  {
    name: "parses the RFC 5854 example",
    fn() {
      const doc = parseMetalink(RFC_EXAMPLE);
      assertEquals(doc.version, 4, "should detect Metalink 4");
      assertEquals(doc.files.length, 1, "one file");
      const f = doc.files[0];
      assertEquals(f.name, "example.ext", "name");
      assertEquals(f.size, 14471447, "size");
      assertEquals(f.urls.length, 2, "two mirrors");
      assertEquals(f.metaurls.length, 1, "one metaurl");
      assertEquals(f.metaurls[0].mediatype, "torrent", "torrent mediatype");
    },
  },
  {
    name: "parses metadata, hashes and priorities",
    fn() {
      const doc = parseMetalink(FULL_V4);
      const f = doc.files[0];
      assertEquals(f.description, "A browser", "description");
      assertEquals(f.version, "1.1.1", "version");
      assertEquals(f.language[0], "en-US", "language");
      assertEquals(f.hashes.length, 2, "two hashes");
      assertEquals(f.urls[0].priority, 10, "priority parsed");
      assertEquals(f.urls[0].location, "DE", "location uppercased");
    },
  },
  {
    name: "drops mirrors with dangerous schemes but keeps the good ones",
    fn() {
      const doc = parseMetalink(FULL_V4);
      const f = doc.files[0];
      assertEquals(f.urls.length, 3, "only the three http mirrors survive");
      assert(
        !f.urls.some((u) => u.url.startsWith("javascript:")),
        "no javascript: mirror",
      );
      assert(
        !f.urls.some((u) => u.url.startsWith("file:")),
        "no file: mirror",
      );
      assert(doc.warnings.length >= 2, "should warn about what it dropped");
    },
  },
  {
    name: "strongestHash prefers sha-256 over md5",
    fn() {
      const doc = parseMetalink(FULL_V4);
      assertEquals(strongestHash(doc.files[0])?.type, "sha-256", "sha-256 wins");
    },
  },
  {
    name: "rejects a file whose name would escape the download directory",
    fn() {
      const evil = RFC_EXAMPLE.replace(
        'name="example.ext"',
        'name="../../evil.sh"',
      );
      const doc = parseMetalink(evil);
      assertEquals(doc.files.length, 0, "traversal file must be dropped");
      assert(doc.warnings.length > 0, "and warned about");
    },
  },

  // --- error handling ---
  {
    name: "throws on malformed XML rather than returning an empty document",
    fn() {
      let threw = false;
      try {
        parseMetalink("<metalink><unclosed>");
      } catch (e) {
        threw = e instanceof MetalinkParseError;
      }
      assert(threw, "should throw MetalinkParseError");
    },
  },
  {
    name: "throws on well-formed XML that is not Metalink",
    fn() {
      let threw = false;
      try {
        parseMetalink('<?xml version="1.0"?><rss><channel/></rss>');
      } catch (e) {
        threw = e instanceof MetalinkParseError;
      }
      assert(threw, "non-Metalink XML should be rejected");
    },
  },

  // --- v3 compatibility ---
  {
    name: "parses Metalink 3.0 and inverts its ascending preference",
    fn() {
      const doc = parseMetalink(V3);
      assertEquals(doc.version, 3, "should detect Metalink 3");
      assertEquals(doc.files.length, 1, "one file");
      const f = doc.files[0];
      assertEquals(f.name, "old.iso", "name");
      assertEquals(f.hashes.length, 1, "hash from <verification>");
      // preference 100 (best) must sort ahead of preference 10.
      const ordered = orderMirrors(f);
      assert(
        ordered[0].url.includes("fast."),
        `best-preference mirror should sort first, got ${ordered[0].url}`,
      );
    },
  },

  // --- mirror ordering ---
  {
    name: "orderMirrors sorts by ascending priority",
    fn() {
      const doc = parseMetalink(FULL_V4);
      const ordered = orderMirrors(doc.files[0]);
      assertEquals(ordered[0].location, "US", "priority 1 comes first");
      assertEquals(ordered[1].location, "DE", "then priority 10");
    },
  },
  {
    name: "orderMirrors puts a local mirror ahead of a better-priority remote",
    fn() {
      const doc = parseMetalink(FULL_V4);
      const ordered = orderMirrors(doc.files[0], "JP");
      assertEquals(ordered[0].location, "JP", "local mirror wins");
    },
  },

  // --- RFC 6249 Link header parsing ---
  {
    name: "splitLinkHeader does not split inside <> or quotes",
    fn() {
      const parts = splitLinkHeader(
        '<http://a/x,y>; rel=duplicate, <http://b/z>; rel=duplicate; title="a,b"',
      );
      assertEquals(parts.length, 2, "comma inside <> and quotes is not a split");
    },
  },
  {
    name: "parseLinkValue reads url and parameters",
    fn() {
      const link = parseLinkValue('<http://m/f.iso>; rel=duplicate; pri=3; geo=de');
      assert(link !== null, "should parse");
      assertEquals(link!.url, "http://m/f.iso", "url");
      assertEquals(link!.params["rel"], "duplicate", "rel");
      assertEquals(link!.params["pri"], "3", "pri");
    },
  },
  {
    name: "parseMetalinkHeaders collects mirrors and normalises the digest",
    fn() {
      const headers: Record<string, string> = {
        // "abc" -> sha-256 is not what matters; the base64->hex conversion is.
        "Link":
          '<http://m1/f.iso>; rel=duplicate; pri=1; geo=us, <http://m2/f.iso>; rel=duplicate',
        "Digest": "MD5=hpZTfSpjfvJhWiHR2QRXAg==",
      };
      const info = parseMetalinkHeaders(
        (n) => headers[n] ?? null,
        "http://origin/f.iso",
      );
      assert(info !== null, "should find Metalink/HTTP info");
      assertEquals(info!.mirrors.length, 2, "two mirrors");
      assertEquals(info!.mirrors[0].location, "US", "geo uppercased");
      assertEquals(info!.mirrors[0].priority, 1, "pri parsed");
      assertEquals(info!.digest?.type, "md5", "digest algorithm mapped");
      assertEquals(
        info!.digest?.value,
        "8696537d2a637ef2615a21d1d9045702",
        "base64 digest converted to lowercase hex",
      );
    },
  },
  {
    name: "parseMetalinkHeaders finds a describedby .meta4",
    fn() {
      const headers: Record<string, string> = {
        "Link":
          '<http://origin/f.meta4>; rel=describedby; type="application/metalink4+xml"',
      };
      const info = parseMetalinkHeaders(
        (n) => headers[n] ?? null,
        "http://origin/f.iso",
      );
      assertEquals(
        info?.describedBy,
        "http://origin/f.meta4",
        "describedby link found",
      );
    },
  },
  {
    name: "parseMetalinkHeaders rejects a mirror with a dangerous scheme",
    fn() {
      const headers: Record<string, string> = {
        "Link": "<file:///etc/passwd>; rel=duplicate",
      };
      const info = parseMetalinkHeaders(
        (n) => headers[n] ?? null,
        "http://origin/f.iso",
      );
      assert(info === null, "a file: mirror is not Metalink/HTTP info");
    },
  },
  {
    name: "parseMetalinkHeaders returns null when nothing is advertised",
    fn() {
      const info = parseMetalinkHeaders(() => null, "http://origin/f.iso");
      assert(info === null, "no headers means no info");
    },
  },
];

export async function runAllTests(): Promise<void> {
  await runTests("Metalink.test.mts", tests);
}
