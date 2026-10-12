// 反广告拦截墙识别的回归。
//
// 两个必须同时成立的约束：
//   · 真的墙要被隐藏（否则用户看不到内容）；
//   · 讲广告拦截的**文章**不能被隐藏（这是最典型的误报）。
// 二者靠「名词 ∧ 动词」双条件 + 形态判据区分：文章是普通流内元素，
// 墙是悬浮层或大覆盖弹窗。
//
// 另外覆盖繁体形：「關閉廣告攔截」「廣告攔截」在台/港站点上是主流写法，
// 旧的关键词表只有简体，整类站点漏杀。
const { test } = require("node:test");
const assert = require("node:assert");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");

for (const rel of [
  "src/shared/constants.js",
  "src/shared/text.js",
  // 层文件本身也要执行：createAntiAdblockLayer 是它的副作用产物，
  // 漏掉这行会让所有形态判据测试在 JevAd.createAntiAdblockLayer is not
  // a function 上集体失败（此前实际发生）。
  "src/content/layers/antiadblock.js",
]) {
  require(path.join(ROOT, rel));
}

const JevAd = globalThis.JevAd;
const { ANTI_ADBLOCK_NOUN, ANTI_ADBLOCK_VERB } = JevAd.text;

const hasBoth = (t) => ANTI_ADBLOCK_NOUN.test(t) && ANTI_ADBLOCK_VERB.test(t);

// ---- 文案判据 ----

test("简体墙文案被识别", () => {
  assert.ok(hasBoth("检测到您使用了广告拦截插件，请关闭后继续浏览"));
  assert.ok(hasBoth("请关闭广告拦截器以查看内容"));
  assert.ok(hasBoth("您的广告屏蔽插件导致页面无法正常显示，请禁用"));
});

test("繁体墙文案被识别（台/港站点）", () => {
  assert.ok(hasBoth("偵測到您使用了廣告攔截外掛，請關閉後繼續瀏覽"));
  assert.ok(hasBoth("請關閉廣告攔截器以查看內容"));
  assert.ok(hasBoth("您的廣告屏蔽外掛導致頁面無法正常顯示，請停用"));
  // 白名單行本身只有动词、没有名词 —— 单独出现时**不该**触发（否则页面
  // 上任何"加入白名單"提示都会被误杀）。它靠同一容器内的名词行带过闸门：
  assert.ok(!hasBoth("請將本站加入白名單"));
  assert.ok(hasBoth("偵測到廣告攔截，請將本站加入白名單"));
});

test("英文墙文案被识别", () => {
  assert.ok(hasBoth("Ad blocker detected. Please disable your adblocker to continue."));
  assert.ok(hasBoth("We noticed you are using an ad blocker, turn it off to read."));
  assert.ok(hasBoth("Please whitelist us or disable uBlock"));
});

test("只有名词不命中（讲广告拦截的文章）", () => {
  assert.ok(!hasBoth("广告拦截器的原理是通过规则列表匹配请求 URL"));
  assert.ok(!hasBoth("广告拦截技术发展简史"));
  assert.ok(!hasBoth("广告拦截"));
});

test("只有动词不命中（普通关闭按钮/提示）", () => {
  assert.ok(!hasBoth("请关闭此对话框"));
  assert.ok(!hasBoth("关闭"));
  assert.ok(!hasBoth("检测到新设备登录"));
});

test("广告位文案不误入反拦截路径", () => {
  // 「赞助去广告功能」含"广告"，不含拦截名词——不该走这条路径
  assert.ok(!hasBoth("使用贊助去廣告功能"));
  assert.ok(!hasBoth("小额支援 大幅升级 纯净阅读新体验 点击这里"));
});

// ---- 形态判据（需要 DOM stub）----
//
// 层代码在内容脚本里跑，用的是 window.innerWidth / document / getComputedStyle
// 这些浏览器全局；Node 下必须补齐，否则 looksLikeWall 直接 ReferenceError，
// 测试会以"桩不全"而非"判据错"的形式失败（此前实际发生）。
const DOM_GLOBALS = ["window", "innerWidth", "innerHeight", "getComputedStyle", "document"];

function installDom({ position = "static", zIndex = "0", rect, interactive = true }) {
  const el = {
    nodeType: 1,
    tagName: "DIV",
    style: { getPropertyValue: () => "", removeProperty: () => {}, setProperty: () => {} },
    getBoundingClientRect: () => rect,
    querySelector: () => (interactive ? {} : null),
    closest: () => null,
    classList: { contains: () => false },
  };
  globalThis.window = globalThis;
  globalThis.innerWidth = 1200;
  globalThis.innerHeight = 800;
  globalThis.getComputedStyle = () => ({ position, zIndex });
  globalThis.document = {
    body: { nodeType: 1 },
    documentElement: { nodeType: 1 },
    createTreeWalker: () => ({ nextNode: () => null }),
  };
  const ctx = { state: { judged: new WeakSet(), hidden: new Set() }, log: () => {} };
  delete require.cache[require.resolve(path.join(ROOT, "src/content/layers/antiadblock.js"))];
  const layer = JevAd.createAntiAdblockLayer(ctx);
  return { layer, el };
}

// 每个用例后清掉桩，避免污染同进程里的其他测试文件
// （node --test 默认同进程按文件串行，残留的 document 会被别的文件读到）。
test.afterEach(() => {
  for (const k of DOM_GLOBALS) delete globalThis[k];
});

const fullScreen = { width: 1200, height: 800, top: 0, bottom: 800, left: 0, right: 1200 };
const banner = { width: 1200, height: 90, top: 0, bottom: 90, left: 0, right: 1200 };
const tiny = { width: 100, height: 40, top: 0, bottom: 40, left: 0, right: 100 };

test("悬浮高 z-index 弹窗判为墙", () => {
  const { layer, el } = installDom({ position: "fixed", zIndex: "9999", rect: fullScreen });
  assert.strictEqual(layer.looksLikeWall(el), true);
});

test("大面积覆盖弹窗判为墙（即使不是 fixed）", () => {
  const { layer, el } = installDom({ position: "static", rect: fullScreen });
  assert.strictEqual(layer.looksLikeWall(el), true);
});

test("流内小元素不判为墙", () => {
  const { layer, el } = installDom({ position: "static", rect: tiny });
  assert.strictEqual(layer.looksLikeWall(el), false);
});

test("无交互元素的条状元素不判为墙（避免误伤普通 banner）", () => {
  const { layer, el } = installDom({ position: "static", rect: banner, interactive: false });
  assert.strictEqual(layer.looksLikeWall(el), false);
});

test("低 z-index 的流内块不判为墙", () => {
  const { layer, el } = installDom({ position: "static", zIndex: "1", rect: fullScreen, interactive: false });
  assert.strictEqual(layer.looksLikeWall(el), false);
});
