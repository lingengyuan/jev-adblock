// 内容脚本冒烟测试：用最小的 chrome/DOM mock 按构建顺序加载全部
// 内容脚本并执行 init()，捕获加载期与初始化期的引用错误。
// 无需 API key、无需真实浏览器，可纳入 npm test。
const { test } = require("node:test");
const assert = require("node:assert");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");

// 与 scripts/build.js 一致的加载顺序
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
  "src/content/layers/antiadblock.js",
  "src/content/pipeline.js",
  "src/content/main.js",
];

function makeElement(tag) {
  const el = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    style: {
      setProperty: () => {},
      removeProperty: () => {},
    },
    classList: {
      add: () => {},
      remove: () => {},
      contains: () => false,
    },
    setAttribute: () => {},
    getAttribute: () => null,
    removeAttribute: () => {},
    hasAttribute: () => false,
    matches: () => false,
    closest: () => null,
    querySelectorAll: () => [],
    querySelector: () => null,
    getBoundingClientRect: () => ({
      width: 0,
      height: 0,
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
    }),
    addEventListener: () => {},
    isConnected: true,
    innerText: "",
    textContent: "",
    parentElement: null,
  };
  return el;
}

function setupGlobals() {
  const noop = () => {};
  globalThis.chrome = {
    runtime: {
      sendMessage: async (msg) => {
        if (msg && msg.type === "GET_TAB_ENABLED") return { enabled: true };
        if (msg && msg.type === "JUDGE") {
          return { ok: false, code: "NO_KEY", message: "smoke" };
        }
        return { ok: true };
      },
      onMessage: { addListener: noop },
      getManifest: () => ({ content_scripts: [] }),
      openOptionsPage: noop,
    },
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {},
        onChanged: { addListener: noop },
      },
      session: { get: async () => ({}), set: async () => {} },
      onChanged: { addListener: noop },
    },
    tabs: {
      query: async () => [],
      sendMessage: async () => ({}),
      onRemoved: { addListener: noop },
    },
    declarativeNetRequest: {
      getEnabledRulesets: async () => [],
      updateEnabledRulesets: async () => {},
      updateSessionRules: async () => {},
      getSessionRules: async () => [],
    },
    commands: { onCommand: { addListener: noop } },
    action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
    scripting: { executeScript: async () => [] },
  };

  globalThis.location = {
    hostname: "example.com",
    href: "https://example.com/page",
    origin: "https://example.com",
  };

  const body = makeElement("body");
  const html = makeElement("html");
  html.appendChild = (child) => {
    child.parentElement = html;
  };
  html.appendChild(body);
  body.parentElement = html;

  globalThis.document = {
    nodeType: 9,
    body,
    documentElement: html,
    createTreeWalker: () => ({ nextNode: () => null }),
    createNodeIterator: () => ({ nextNode: () => null }),
    elementFromPoint: () => null,
    addEventListener: noop,
    querySelectorAll: () => [],
    querySelector: () => null,
    getElementById: () => null,
  };

  globalThis.window = globalThis;
  globalThis.addEventListener = noop;
  globalThis.removeEventListener = noop;
  globalThis.innerWidth = 1280;
  globalThis.innerHeight = 900;
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.NodeFilter = { SHOW_TEXT: 4 };
  globalThis.getComputedStyle = () => ({
    position: "static",
    zIndex: "0",
  });
  // 避免 setInterval 让测试进程挂起；setTimeout 保留真实实现。
  globalThis.setInterval = () => 0;
  globalThis.clearInterval = noop;
}

test("内容脚本加载并初始化", () => {
  setupGlobals();
  for (const rel of FILES.slice(0, -1)) {
    require(path.join(ROOT, rel));
  }
  // main.js 的 IIFE 入口有 __jevAdBlockLoaded 守卫；
  // 先置空再加载，让其完整执行 init()。
  globalThis.__jevAdBlockLoaded = false;
  require(path.join(ROOT, "src/content/main.js"));

  const JevAd = globalThis.JevAd;
  assert.ok(JevAd, "JevAd 命名空间应存在");
  assert.ok(JevAd.constants, "constants 应已注册");
  assert.ok(JevAd.text, "text 应已注册");
  assert.strictEqual(typeof JevAd.createState, "function");
  assert.strictEqual(typeof JevAd.createHide, "function");
  assert.strictEqual(typeof JevAd.createScore, "function");
  assert.strictEqual(typeof JevAd.createRulesLayer, "function");
  assert.strictEqual(typeof JevAd.createLabelsLayer, "function");
  assert.strictEqual(typeof JevAd.createOverlaysLayer, "function");
  assert.strictEqual(typeof JevAd.createAmbiguousLayer, "function");
  assert.strictEqual(typeof JevAd.createPipeline, "function");
  assert.ok(JevAd.protect, "protect 应已注册");
  assert.strictEqual(typeof JevAd.resolveSite, "function");
  assert.ok(JevAd.commonRules, "commonRules 应已注册");
  assert.ok(Array.isArray(JevAd.siteModules), "siteModules 应为数组");
  assert.strictEqual(JevAd.siteModules.length, 5, "应有 5 个站点规则");
  assert.ok(
    globalThis.__jevAdBlockLoaded,
    "main.js 应标记已加载",
  );
});

test("管线在无 key 时回退本地规则且不抛错", () => {
  setupGlobals();
  for (const rel of FILES.slice(0, -1)) {
    require(path.join(ROOT, rel));
  }
  globalThis.__jevAdBlockLoaded = false;
  require(path.join(ROOT, "src/content/main.js"));

  const JevAd = globalThis.JevAd;
  const state = JevAd.createState();
  const ctx = {
    state,
    log: () => {},
    hide: JevAd.createHide({ state, log: () => {} }),
    score: JevAd.createScore({ state, log: () => {} }),
    rules: null,
    labels: null,
    overlays: null,
    ambiguous: null,
    pipeline: null,
  };
  ctx.rules = JevAd.createRulesLayer(ctx);
  ctx.labels = JevAd.createLabelsLayer(ctx);
  ctx.overlays = JevAd.createOverlaysLayer(ctx);
  ctx.ambiguous = JevAd.createAmbiguousLayer(ctx);
  ctx.pipeline = JevAd.createPipeline(ctx);

  assert.strictEqual(ctx.pipeline.isEnabled(), true, "默认应启用");
  assert.doesNotThrow(() => ctx.pipeline.processSubtree(globalThis.document.body));
  assert.strictEqual(state.pending.length, 0, "无候选时队列应为空");
  assert.strictEqual(ctx.state.settings.adThreshold, 0.75);
  assert.strictEqual(ctx.state.settings.mainGuard, 0.55);
});

test("白名单域名完全跳过", () => {
  setupGlobals();
  for (const rel of FILES.slice(0, -1)) {
    require(path.join(ROOT, rel));
  }
  globalThis.__jevAdBlockLoaded = false;
  require(path.join(ROOT, "src/content/main.js"));

  const JevAd = globalThis.JevAd;
  const state = JevAd.createState();
  const ctx = { state, log: () => {} };
  ctx.pipeline = JevAd.createPipeline(ctx);
  assert.strictEqual(ctx.pipeline.isDomainAllowed(), false);
  state.allowlist = new Set(["example.com"]);
  assert.strictEqual(ctx.pipeline.isDomainAllowed(), true, "白名单应命中");
  assert.strictEqual(ctx.pipeline.isEnabled(), false, "白名单域名应禁用");
  state.allowlist = new Set(["other.com"]);
  assert.strictEqual(ctx.pipeline.isDomainAllowed(), false);
});
