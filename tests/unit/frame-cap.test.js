// 帧级候选上限的回归。
//
// 背景：小时配额是所有标签页共享的。内容脚本按帧独立运行（manifest 的
// all_frames），没有帧级闸门时，广告重的页面或无限滚动站点一次访问就能
// 把整小时预算吃光，之后所有站点一起回退本地规则。MAX_BATCH 只是拆批、
// MAX_QUEUE 只管瞬时队列，都不限制"一帧总共能问多少次"。
//
// 上限的行为约定：
//   · 达到上限后，确定性来源（detector/label）退回本地规则**直隐**——
//     它们本来就不依赖 Jev 也能判定；
//   · 低置信候选直接放弃（本来就只有形状证据，不值得花配额）。
const { test } = require("node:test");
const assert = require("node:assert");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");

const FILES = [
  "src/shared/constants.js",
  "src/shared/text.js",
  "src/shared/site-resolve.js",
  "rules/dom/common.js",
  "rules/dom/sites/zhihu.js",
  "rules/dom/sites/weibo.js",
  "rules/dom/sites/bilibili.js",
  "rules/dom/sites/qqmail.js",
  "rules/dom/sites/hao123.js",
  "src/content/state.js",
  "src/content/protect.js",
  "src/content/hide.js",
  "src/content/score.js",
  "src/content/layers/rules.js",
  "src/content/layers/labels.js",
  "src/content/layers/overlays.js",
  "src/content/layers/ambiguous.js",
  "src/content/pipeline.js",
];

function makeElement(tag = "div") {
  const classes = new Set();
  const attrs = {};
  return {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    style: { setProperty: () => {}, removeProperty: () => {}, getPropertyValue: () => "" },
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    setAttribute: (k, v) => { attrs[k] = String(v); },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    removeAttribute: (k) => { delete attrs[k]; },
    hasAttribute: (k) => k in attrs,
    matches: () => false,
    closest: () => null,
    querySelectorAll: () => [],
    querySelector: () => null,
    getBoundingClientRect: () => ({ width: 300, height: 250, top: 0, bottom: 250, left: 0, right: 300 }),
    addEventListener: () => {},
    isConnected: true,
    innerText: "限时优惠 广告 推广",
    textContent: "",
    parentElement: null,
  };
}

function freshEnv() {
  for (const rel of FILES) delete require.cache[require.resolve(path.join(ROOT, rel))];
  delete globalThis.JevAd;
  const noop = () => {};
  globalThis.document = {
    nodeType: 9, body: makeElement("body"), documentElement: makeElement("html"),
    addEventListener: noop, querySelectorAll: () => [], querySelector: () => null,
  };
  globalThis.window = globalThis;
  globalThis.location = { hostname: "example.com", href: "https://example.com/", origin: "https://example.com" };
  globalThis.addEventListener = noop;
  globalThis.innerWidth = 1280; globalThis.innerHeight = 900;
  globalThis.NodeFilter = { SHOW_TEXT: 4 };
  globalThis.getComputedStyle = () => ({ position: "static", zIndex: "0" });
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  globalThis.chrome = { runtime: { sendMessage: async () => ({ ok: true }) } };
  for (const rel of FILES) require(path.join(ROOT, rel));
  return globalThis.JevAd;
}

function makePipeline(JevAd, cap) {
  const constants = JevAd.constants;
  const saved = constants.MAX_CANDIDATES_PER_FRAME;
  constants.MAX_CANDIDATES_PER_FRAME = cap;
  const state = JevAd.createState();
  state.hasApiKey = true;
  const logs = [];
  const ctx = { state, log: (e, d) => logs.push({ e, d }) };
  ctx.hide = JevAd.createHide(ctx);
  ctx.pipeline = JevAd.createPipeline(ctx);
  return { ctx, state, logs, restore: () => { constants.MAX_CANDIDATES_PER_FRAME = saved; } };
}

test("达到帧上限后，低置信候选不再入队", () => {
  const JevAd = freshEnv();
  const { ctx, state, logs, restore } = makePipeline(JevAd, 3);
  for (let i = 0; i < 5; i++) {
    ctx.pipeline.enqueue(makeElement(), { score: 3 });
  }
  assert.strictEqual(state.pending.length, 3, "只应入队 cap 条");
  assert.strictEqual(state.candidatesSent, 3, "计数应等于 cap");
  assert.strictEqual(
    logs.filter((l) => l.e === "frame_cap_skip").length,
    2,
    "超出部分应留下 frame_cap_skip 日志",
  );
  restore();
});

test("达到帧上限后，确定性来源退回本地直隐而非静默放弃", () => {
  const JevAd = freshEnv();
  const { ctx, state, restore } = makePipeline(JevAd, 1);
  ctx.pipeline.enqueue(makeElement(), { score: 3 }); // 用掉额度
  const det = makeElement();
  ctx.pipeline.enqueue(det, { source: "detector", score: 8 });
  assert.strictEqual(state.pending.length, 1, "超限的 detector 不进 Jev 队列");
  assert.strictEqual(state.judged.has(det), true, "但应被标记已判定，避免反复重扫");
  assert.strictEqual(state.hidden.has(det), true, "且必须已被隐藏（本地规则直隐）");
  assert.strictEqual(det.getAttribute("data-jev-ad"), "rule", "reason 应为本地规则");

  const lab = makeElement();
  ctx.pipeline.enqueue(lab, { source: "label", score: 7, disclosesAd: true });
  assert.strictEqual(lab.getAttribute("data-jev-ad"), "labeled", "label 来源 reason 应为 labeled");
  assert.strictEqual(state.hidden.has(lab), true);
  restore();
});

test("未达上限时行为不变", () => {
  const JevAd = freshEnv();
  const { ctx, state, restore } = makePipeline(JevAd, 100);
  for (let i = 0; i < 5; i++) ctx.pipeline.enqueue(makeElement(), { score: 3 });
  assert.strictEqual(state.pending.length, 5);
  assert.strictEqual(state.candidatesSent, 5);
  restore();
});
