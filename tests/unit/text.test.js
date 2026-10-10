const { test } = require("node:test");
const assert = require("node:assert");

globalThis.location = {
  href: "https://example.com/page?x=1",
  hostname: "example.com",
  origin: "https://example.com",
};

require("../../src/shared/constants.js");
require("../../src/shared/text.js");

const text = globalThis.JevAd.text;

test("normalizeLabelText 去除零宽字符并修剪", () => {
  assert.strictEqual(text.normalizeLabelText("广​告"), "广 告");
  assert.strictEqual(text.normalizeLabelText("  广告  "), "广告");
});

test("extractText 合并空白并截断", () => {
  const el = { innerText: "  hello   world  " };
  assert.strictEqual(text.extractText(el, 100), "hello world");
  const long = { innerText: "a".repeat(300) };
  assert.strictEqual(text.extractText(long, 10).length, 10);
});

test("extractHrefs 仅保留域名且最多 3 个", () => {
  const el = {
    tagName: "DIV",
    querySelectorAll: () => [
      { getAttribute: () => "https://ads.example.com/x" },
      { getAttribute: () => "/relative" },
      { getAttribute: () => "https://other.com/y" },
      { getAttribute: () => "https://third.com/z" },
    ],
  };
  assert.deepStrictEqual(text.extractHrefs(el), [
    "ads.example.com",
    "same-site",
    "other.com",
  ]);
});

test("extractIframeSrc 区分同源与跨域", () => {
  const cross = {
    tagName: "IFRAME",
    getAttribute: () => "https://cdn.ad.net/frame",
  };
  assert.strictEqual(text.extractIframeSrc(cross), "cdn.ad.net");
  const same = {
    tagName: "IFRAME",
    getAttribute: () => "https://example.com/embed",
  };
  assert.strictEqual(text.extractIframeSrc(same), "same-site");
});

test("describeEl 输出 tag#id.class", () => {
  const el = { tagName: "DIV", id: "ad", className: "foo bar" };
  assert.strictEqual(text.describeEl(el), "div#ad.foo.bar");
  const noId = { tagName: "SPAN", id: "", className: "" };
  assert.strictEqual(text.describeEl(noId), "span");
});

test("regionOf 识别页面区域", () => {
  const region = (target) => ({
    closest: (sel) => (sel.includes(target) ? {} : null),
  });
  assert.strictEqual(text.regionOf(region("aside")), "sidebar");
  assert.strictEqual(text.regionOf(region("header")), "header");
  assert.strictEqual(text.regionOf(region("footer")), "footer");
  assert.strictEqual(text.regionOf(region("nav")), "nav");
  assert.strictEqual(
    text.regionOf({ closest: () => null }),
    "content",
  );
});
