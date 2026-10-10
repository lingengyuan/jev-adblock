const { test } = require("node:test");
const assert = require("node:assert");

globalThis.location = {
  href: "https://example.com/page",
  hostname: "example.com",
  origin: "https://example.com",
};

require("../../src/shared/constants.js");
require("../../src/shared/text.js");
require("../../src/shared/site-resolve.js");
require("../../rules/dom/common.js");
require("../../rules/dom/sites/zhihu.js");
require("../../rules/dom/sites/qqmail.js");

test("resolveSite 命中站点规则并合并通用规则", () => {
  const site = globalThis.JevAd.resolveSite("www.zhihu.com");
  assert.strictEqual(site.name, "zhihu");
  assert.ok(site.matched, "应命中站点模块");
  // 通用 detectors 与站点 detectors 合并
  assert.ok(site.detectors.length > (site.matched.detectors || []).length);
  // exclude 合并
  assert.ok(site.exclude.length > 0);
});

test("resolveSite 子域名匹配", () => {
  const site = globalThis.JevAd.resolveSite("zhuanlan.zhihu.com");
  assert.strictEqual(site.name, "zhihu");
});

test("resolveSite 未命中时回退通用规则", () => {
  const site = globalThis.JevAd.resolveSite("unknown.example.org");
  assert.strictEqual(site.name, "common");
  assert.strictEqual(site.matched, null);
  assert.ok(site.detectors.length > 0);
});

test("resolveSite 精确主机名匹配", () => {
  const site = globalThis.JevAd.resolveSite("mail.qq.com");
  assert.strictEqual(site.name, "qqmail");
});

test("resolveSite scoreBoost 取通用与站点的较大值", () => {
  const site = globalThis.JevAd.resolveSite("www.zhihu.com");
  const el = { innerText: "去投稿赚高收益" };
  const boost = site.scoreBoost(el);
  assert.ok(boost > 0, `知乎专属文案应有加分: ${boost}`);
  const unknown = globalThis.JevAd.resolveSite("unknown.example.org");
  assert.strictEqual(unknown.scoreBoost(el), 0);
});
