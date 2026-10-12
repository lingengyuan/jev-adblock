// 自触发扫描循环（页面周期性闪烁）的回归测试。
//
// 背景：hide/restore 写 class 会被自家的 MutationObserver 捕获 →
// invalidateJudgedAncestor 删掉 judged → debounce 后重扫 → 重新入队 →
// 乐观隐藏又恢复 → 无限循环，表现为页面每 1-2s 闪一次。
//
// 现有 bundle-smoke 的 DOM mock 里 classList 是 no-op、MutationObserver.observe()
// 是空的，因此测不出这个问题。这里用能真实累积并派发 mutation 记录的 mock，
// 断言"自身写入不得触发重扫"，同时用对照用例证明装置本身能检出 mutation。
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
  "src/content/layers/antiadblock.js",
  "src/content/pipeline.js",
  "src/content/main.js",
];

// ---- 可派发的 mutation 记录 ----
const pending = [];
const observers = [];

function emit(record) {
  pending.push(record);
}

// 模拟真实 MutationObserver：observe 时记住 attributeFilter，
// flush 时按 filter 过滤后再派发（这与浏览器行为一致——不在 filter 内的
// 属性变更根本不会产生回调）。
function flushMutations() {
  const batch = pending.splice(0, pending.length);
  for (const obs of observers) {
    const filter = obs.opts && obs.opts.attributeFilter;
    const deliver = batch.filter((m) => {
      if (m.type !== "attributes") return true;
      return !filter || filter.includes(m.attributeName);
    });
    if (deliver.length) obs.cb(deliver, obs);
  }
}

function makeElement(tag, doc) {
  const classes = new Set();
  const attrs = {};
  const styles = {};
  const el = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    children: [],
    parentElement: null,
    isConnected: true,
    innerText: "",
    textContent: "",
    style: {
      setProperty(k, v) {
        styles[k] = v;
      },
      removeProperty(k) {
        delete styles[k];
      },
      getPropertyValue(k) {
        return styles[k] || "";
      },
    },
    classList: {
      add(c) {
        if (classes.has(c)) return;
        classes.add(c);
        emit({ type: "attributes", target: el, attributeName: "class" });
      },
      remove(c) {
        if (!classes.has(c)) return;
        classes.delete(c);
        emit({ type: "attributes", target: el, attributeName: "class" });
      },
      contains: (c) => classes.has(c),
    },
    setAttribute(k, v) {
      attrs[k] = String(v);
      emit({ type: "attributes", target: el, attributeName: k });
    },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    removeAttribute(k) {
      delete attrs[k];
      emit({ type: "attributes", target: el, attributeName: k });
    },
    hasAttribute: (k) => k in attrs,
    matches: () => false,
    closest: () => null,
    querySelectorAll: () => [],
    querySelector: () => null,
    getBoundingClientRect: () => ({ width: 300, height: 250, top: 0, bottom: 250, left: 0, right: 300 }),
    addEventListener: () => {},
    appendChild(child) {
      child.parentElement = el;
      this.children.push(child);
      if (doc) emit({ type: "childList", target: el, addedNodes: [child] });
    },
  };
  if (String(tag).toLowerCase() === "a") el.tagName = "A";
  return el;
}

let ctxRef = null;

function setupGlobals() {
  pending.length = 0;
  observers.length = 0;
  ctxRef = null;

  const noop = () => {};
  const body = makeElement("body");
  const html = makeElement("html");
  html.appendChild(body);

  const doc = {
    nodeType: 9,
    body,
    documentElement: html,
    createTreeWalker: () => ({ nextNode: () => null }),
    elementFromPoint: () => null,
    addEventListener: noop,
    querySelectorAll: () => [],
    querySelector: () => null,
    getElementById: () => null,
  };
  body.parentElement = html;

  globalThis.document = doc;
  globalThis.window = globalThis;
  globalThis.location = {
    hostname: "example.com",
    href: "https://example.com/page",
    origin: "https://example.com",
  };
  globalThis.addEventListener = noop;
  globalThis.removeEventListener = noop;
  globalThis.innerWidth = 1280;
  globalThis.innerHeight = 900;
  globalThis.NodeFilter = { SHOW_TEXT: 4 };
  globalThis.getComputedStyle = () => ({ position: "static", zIndex: "0" });
  globalThis.setInterval = () => 0; // 扫描定时器单独手动驱动
  globalThis.clearInterval = noop;

  globalThis.MutationObserver = class {
    constructor(cb) {
      this.cb = cb;
      observers.push(this);
    }
    observe(target, opts) {
      this.target = target;
      this.opts = opts || {};
    }
    disconnect() {}
  };

  globalThis.chrome = {
    runtime: {
      sendMessage: async (msg) => {
        if (msg && msg.type === "GET_TAB_ENABLED") return { enabled: true };
        if (msg && msg.type === "JUDGE") {
          // 一律回"非广告"：这正是原先触发 restore→重扫循环的判决。
          return {
            ok: true,
            results: msg.candidates.map((c) => ({
              key: c.key,
              kind: c.kind,
              ad: 0.05,
              main: 0.1,
              disclosesAd: false,
            })),
          };
        }
        return { ok: true };
      },
      onMessage: { addListener: noop },
      getManifest: () => ({ content_scripts: [] }),
      openOptionsPage: noop,
    },
    storage: {
      // 有 key → 走 Jev 路径（无 key 会走 fallback，掩盖本例的 restore 路径）
      local: { get: async () => ({ apiKey: "ts-test" }), set: async () => {}, onChanged: { addListener: noop } },
      session: { get: async () => ({}), set: async () => {} },
      onChanged: { addListener: noop },
    },
    tabs: { query: async () => [], sendMessage: async () => ({}), onRemoved: { addListener: noop } },
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

  return { body, html };
}

// 强制重新执行全部内容脚本，拿到干净的 JevAd 命名空间与 main.js 的私有 ctx。
function freshLoad() {
  for (const rel of FILES) {
    delete require.cache[require.resolve(path.join(ROOT, rel))];
  }
  delete globalThis.JevAd;
  globalThis.__jevAdBlockLoaded = false;
  for (const rel of FILES.slice(0, -1)) {
    require(path.join(ROOT, rel));
  }
  const JevAd = globalThis.JevAd;
  const origHide = JevAd.createHide;
  JevAd.createHide = (ctx) => {
    ctxRef = ctx;
    return origHide(ctx);
  };
  require(path.join(ROOT, "src/content/main.js"));
  assert.ok(ctxRef, "main.js 应通过 createHide 暴露 ctx");
}

const tick = () => new Promise((r) => setTimeout(r, 5));

async function boot() {
  const dom = setupGlobals();
  freshLoad();
  await tick();
  await tick();
  return dom;
}

test("自身写入（class 增删）不得触发重扫", async () => {
  const { body } = await boot();
  const el = makeElement("div");
  body.appendChild(el);
  flushMutations(); // 消化建树产生的 childList

  // 模拟内容脚本自身的隐藏写入
  ctxRef.pipeline.enqueue(el, { optimistic: true });
  assert.strictEqual(ctxRef.state.hidden.has(el), true, "应已隐藏");
  flushMutations();

  assert.strictEqual(
    ctxRef.state.addedRoots.size,
    0,
    "hide 写 class 不应进入待重扫队列（否则 debounce 后会重扫重判）",
  );

  // Jev 判"非广告" → 走 restore 路径（原先循环的起点）
  await ctxRef.pipeline.flush();
  assert.strictEqual(ctxRef.state.hidden.has(el), false, "应已恢复");

  flushMutations();
  assert.strictEqual(
    ctxRef.state.addedRoots.size,
    0,
    "restore 移除 class 不应触发重扫——这正是闪烁循环的根因",
  );
});

test("restore 后 judged 不得被误删，否则会重新入队", async () => {
  const { body } = await boot();
  const el = makeElement("div");
  body.appendChild(el);
  flushMutations();

  ctxRef.pipeline.enqueue(el, { optimistic: true });
  flushMutations();
  await ctxRef.pipeline.flush();
  flushMutations();

  assert.strictEqual(
    ctxRef.state.judged.has(el),
    true,
    "判定过的元素必须留在 judged 中，否则下轮扫描会重新入队→再判→再恢复",
  );
  assert.strictEqual(ctxRef.state.pending.length, 0, "不应有残留待判队列");
  assert.strictEqual(ctxRef.state.queued.has(el), false, "queued 应已释放");
  assert.strictEqual(ctxRef.state.debounceTimer, null, "不应有待执行的扫描");
});

test("对照：页面自身的 class 变更必须触发重扫（证明装置能检出 mutation）", async () => {
  const { body } = await boot();
  const el = makeElement("div");
  body.appendChild(el);
  flushMutations();

  ctxRef.state.judged.add(el);
  el.classList.add("page-own-animation"); // 不经 selfTouched
  flushMutations();

  assert.strictEqual(ctxRef.state.addedRoots.size, 1, "页面侧变更应进入重扫队列");
  assert.strictEqual(ctxRef.state.judged.has(el), false, "页面侧变更应使 judged 失效");
});

test("对照：未被 attributeFilter 覆盖的属性变更不得触发重扫", async () => {
  const { body } = await boot();
  const el = makeElement("div");
  body.appendChild(el);
  flushMutations();

  ctxRef.state.judged.add(el);
  el.setAttribute("data-jev-ad", "optimistic"); // 不在 attributeFilter 内
  flushMutations();

  assert.strictEqual(ctxRef.state.addedRoots.size, 0, "data-jev-ad 不应产生观察记录");
  assert.strictEqual(ctxRef.state.judged.has(el), true, "judged 不应因此失效");
});

test("sweep 重写 hidden 元素不自触发；页面改 display 后重写仍不自触发", async () => {
  const { body } = await boot();
  const el = makeElement("div");
  body.appendChild(el);
  flushMutations();

  ctxRef.hide.hideEl(el, "optimistic");
  flushMutations();

  // 无漂移时应零写入
  const before = pending.length;
  ctxRef.hide.reapplyHidden();
  assert.strictEqual(pending.length, before, "无漂移时 sweep 不应写 DOM");
  flushMutations();
  assert.strictEqual(ctxRef.state.addedRoots.size, 0, "sweep 空转不得触发重扫");

  // 模拟页面脚本把 display 改回来（sweep 需要重写的场景）
  el.style.removeProperty("display");
  ctxRef.hide.reapplyHidden();
  flushMutations();
  assert.strictEqual(
    ctxRef.state.addedRoots.size,
    0,
    "sweep 重写 class 也必须走 selfTouched，否则每 4s 一次自触发",
  );
});
