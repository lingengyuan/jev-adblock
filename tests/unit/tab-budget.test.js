// 标签页级预算的回归。
//
// 背景：内容脚本按帧独立运行（manifest all_frames），广告重的页面嵌十几个
// 广告 iframe 时各帧的上限互相独立，叠加起来仍能把全局小时配额吃光——
// 之后**所有站点**一起回退本地规则。只有 SW 能同时看到一页的所有帧，
// 所以总账记在这里。
//
// 这里直接驱动 handleJudge，检查：
//   · 超限返回 TAB_BUDGET（内容脚本按瞬态退避，不会整小时停用）；
//   · 缓存命中的候选不占预算（否则热门站点反而先被限流）；
//   · 导航/关标签页后额度重置。
const { test } = require("node:test");
const assert = require("node:assert");
const path = require("path");

const JUDGE = path.join(__dirname, "..", "..", "src", "background", "judge.js");

let fetchCalls = 0;
let nextResponse = null;

function installChrome(store) {
  globalThis.chrome = {
    storage: {
      local: {
        get: async (keys) => {
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of list) if (k in store) out[k] = store[k];
          return out;
        },
        set: async (obj) => {
          Object.assign(store, obj);
        },
      },
      session: {
        get: async (k) => (k in store ? { [k]: store[k] } : {}),
        set: async (obj) => {
          Object.assign(store, obj);
        },
      },
    },
  };
  globalThis.fetch = async () => {
    fetchCalls += 1;
    const body = nextResponse;
    return {
      ok: true,
      status: 200,
      json: async () => body,
    };
  };
}

function freshJudge() {
  delete require.cache[require.resolve(JUDGE)];
  return require(JUDGE);
}

// 每个候选两个 noul 回答（inline 候选问 c{i}_ad 与 c{i}_main）
function apiResponse(n) {
  const answers = {};
  for (let i = 0; i < n; i++) {
    answers[`c${i}_ad`] = { noul: 0.9 };
    answers[`c${i}_main`] = { noul: 0.1 };
  }
  return { answers, usage: { tokens: 1 } };
}

// 稳定类名（不进生成标识分支），保证每次能算出签名
function cand(i) {
  return {
    key: String(i),
    kind: "inline",
    tag: "div",
    text: "限时优惠 广告",
    classes: `ad-slot slot-${i}`,
    elementId: `e${i}`,
    classAdMarker: true,
    idAdMarker: false,
    region: "sidebar",
    size: { w: 300, h: 250 },
    hrefs: [],
    iframeSrc: "",
    disclosesAd: false,
  };
}

const KEY = { apiKey: "ts-test", hourlyBudget: 100000 };

test("超过标签页预算返回 TAB_BUDGET，且不影响其他标签页", async () => {
  const store = { ...KEY };
  installChrome(store);
  const { handleJudge, clearTabUsage } = freshJudge();

  // 每批 40 条，预算 400 → 第 11 批应被拒
  let blocked = null;
  for (let batch = 0; batch < 12 && !blocked; batch++) {
    nextResponse = apiResponse(40);
    const res = await handleJudge(
      Array.from({ length: 40 }, (_, i) => cand(batch * 40 + i)),
      "example.com",
      7,
    );
    if (!res.ok) blocked = res;
  }
  assert.ok(blocked, "持续累积后应触发标签页预算");
  assert.strictEqual(blocked.code, "TAB_BUDGET");

  // 换一个标签页不受影响
  nextResponse = apiResponse(5);
  const other = await handleJudge([5, 6, 7, 8, 9].map(cand), "example.com", 8);
  assert.strictEqual(other.ok, true, "其他标签页的额度应独立");

  // 重置后同一标签页恢复
  clearTabUsage(7);
  nextResponse = apiResponse(5);
  const again = await handleJudge([0, 1, 2, 3, 4].map(cand), "example.com", 7);
  assert.strictEqual(again.ok, true, "clearTabUsage 后应恢复");
});

test("缓存命中的候选不占预算", async () => {
  const store = { ...KEY };
  installChrome(store);
  const { handleJudge } = freshJudge();

  const batch = [0, 1, 2].map(cand);
  nextResponse = apiResponse(3);
  const first = await handleJudge(batch, "cached.com", 21);
  assert.strictEqual(first.ok, true);
  const callsAfterFirst = fetchCalls;

  // 同一批再问：应全部命中缓存，不产生新的 API 调用
  const second = await handleJudge(batch, "cached.com", 21);
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.cached, 3, "重复候选应全部命中缓存");
  assert.strictEqual(fetchCalls, callsAfterFirst, "缓存命中不得发 API 请求");
});

test("签名不稳定的候选不写缓存（避免误并）", async () => {
  const store = { ...KEY };
  installChrome(store);
  const { handleJudge } = freshJudge();

  const gen = (i) => ({ ...cand(i), classes: "css-1x2y3z", elementId: "" });
  nextResponse = apiResponse(2);
  await handleJudge([gen(0), gen(1)], "gen.com", 31);

  // 同形生成类名不得命中缓存——它们可能是两个不同元素
  nextResponse = apiResponse(2);
  const res = await handleJudge([gen(0), gen(1)], "gen.com", 31);
  assert.strictEqual(res.cached, 0, "生成类名候选不得互相命中缓存");
});
