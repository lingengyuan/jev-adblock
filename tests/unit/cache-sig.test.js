// 缓存签名归一化的回归。
//
// 背景：candidateSig 原来直接用 classes 原文，构建期哈希类名（CSS Modules、
// styled-components）每次发版都变，缓存在这类站点上永远 miss，而缓存是省
// 配额的主要手段。归一化只剥离**可确认为构建产物**的形态。
//
// 这个方向的风险不对称：多 miss 只是多一次 API 往返；误并会让两个不同的
// 元素共用一份裁决，给出错误的隐藏结论并持续整个 TTL（7 天）。所以下面
// 除了断言"该剥的剥掉"，同样重要的是断言"不该动的原样保留"。
const { test } = require("node:test");
const assert = require("node:assert");

const { __testing } = require("../../src/background/judge.js");
const { normalizeClasses, candidateSig } = __testing;

test("CSS Modules 哈希后缀被剥离", () => {
  assert.strictEqual(normalizeClasses("Button_root__2xYz9"), "Button_root");
  assert.strictEqual(
    normalizeClasses("ad-slot Banner_root__2xYz9 active"),
    "ad-slot Banner_root active",
  );
});

test("BEM 风格的双下划线不被误伤", () => {
  // 这些是本项目 fixture 与真实站点里常见的语义类名，没有数字后缀，
  // 必须原样保留——剥掉会让不同元素并成同一个签名。
  for (const cls of [
    "nav__item nav__item--active",
    "header__title",
    "sidebar__menu__link",
    "qq-sidebar-menus",
  ]) {
    assert.strictEqual(normalizeClasses(cls), cls);
  }
});

test("类名全是生成标识时签名不稳定（返回 null，不可缓存）", () => {
  // 关键：emotion/styled-components 是**每个元素一个哈希**。若把它们都归一成
  // 空串，同页两个不同元素会共用一个签名——广告位的裁决会被用到正文块上。
  // 所以此时必须放弃缓存，而不是并合。
  for (const cls of ["sc-bdVaJa", "css-1x2y3z", "jsx-1234567"]) {
    assert.strictEqual(normalizeClasses(cls), null, `${cls} 应为不稳定`);
  }
  assert.strictEqual(normalizeClasses("css-1x2y3z sc-bdVaJa"), null);
  // 本来就没有类名则是稳定值，不能误判为不稳定
  assert.strictEqual(normalizeClasses(""), "");
  assert.strictEqual(normalizeClasses(undefined), "");
});

test("低熵短名不被当作生成标识（避免误伤真实语义名）", () => {
  // sc- 前缀但全小写、css- 但后缀过短：可能是人写的，保留。
  assert.strictEqual(normalizeClasses("sc-header"), "sc-header");
  assert.strictEqual(normalizeClasses("css-grid"), "css-grid");
});

test("全哈希类名使签名返回 null，不同元素绝不共用一个签名", () => {
  const base = { kind: "inline", tag: "div", elementId: "", hrefs: [] };
  const a = candidateSig("h.com", { ...base, classes: "css-1x2y3z" });
  const b = candidateSig("h.com", { ...base, classes: "css-9z8y7x" });
  assert.strictEqual(a, null, "不稳定候选不得产出可缓存签名");
  assert.strictEqual(b, null);
  // 有稳定类名/id 时仍应产出正常签名
  assert.notStrictEqual(
    candidateSig("h.com", { ...base, classes: "ad-slot" }),
    null,
  );
});

test("签名对语义字段敏感（缓存不得跨槽位误用）", () => {
  const mk = (over) =>
    candidateSig("h.com", {
      kind: "inline", tag: "div", classes: "ad-slot", elementId: "s1",
      disclosesAd: false, iframeSrc: "", hrefs: [], ...over,
    });
  assert.notStrictEqual(mk({}), mk({ disclosesAd: true }));
  assert.notStrictEqual(mk({}), mk({ tag: "aside" }));
  assert.notStrictEqual(mk({}), mk({ kind: "overlay" }));
  assert.notStrictEqual(mk({}), mk({ hrefs: ["ads.example.com"] }));
  assert.notStrictEqual(mk({}), mk({ iframeSrc: "ads.example.com" }));
  assert.notStrictEqual(candidateSig("a.com", { kind: "inline", tag: "div", classes: "x" }),
                        candidateSig("b.com", { kind: "inline", tag: "div", classes: "x" }));
});
