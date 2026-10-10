const API_URL = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";

// 小时级用量预算：滑动窗口，超限后返回 BUDGET，由内容脚本回退本地规则。
// 计数持久化到 chrome.storage.session：MV3 SW 空闲被杀重启后不清零。
let usageCount = 0;
let usageWindowStart = Date.now();
let usageHydratePromise = null;

// 并发 JUDGE 共享同一次 hydrate，避免标志先置位、读到未加载的计数。
function hydrateUsage() {
  if (!usageHydratePromise) {
    usageHydratePromise = (async () => {
      try {
        const stored = await chrome.storage.session.get("judgeUsage");
        const u = stored && stored.judgeUsage;
        if (u && typeof u.count === "number" && typeof u.windowStart === "number") {
          usageCount = u.count;
          usageWindowStart = u.windowStart;
        }
      } catch {}
    })();
  }
  return usageHydratePromise;
}

function persistUsage() {
  try {
    chrome.storage.session.set({
      judgeUsage: { count: usageCount, windowStart: usageWindowStart },
    });
  } catch {}
}

function resetUsageWindowIfNeeded() {
  const now = Date.now();
  if (now - usageWindowStart >= 3600000) {
    usageCount = 0;
    usageWindowStart = now;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildOverlayQuestions(i) {
  return {
    [`c${i}_blocks`]: {
      type: "noul",
      instructions: {
        question: `Is \`candidates[${i}]\` a floating overlay that sits on top of and obstructs the page beneath it?`,
        focus:
          `Use candidates[${i}].geometry: position (fixed/sticky/absolute/static), covers (viewport ratio), edge (top/bottom/left/right/null), and topLayer. Fixed/sticky layers, modals, full-screen or edge-docked bars that cover content count as obstructing overlays.`,
      },
      criteria: {
        true: "A fixed, sticky, or modal layer visually covering or blocking the underlying page content",
        false: "Normal in-flow content, or an element that does not cover what is beneath it",
      },
    },
    [`c${i}_promo`]: {
      type: "noul",
      instructions: {
        question: `Is the content of \`candidates[${i}]\` advertising, marketing, or promotional?`,
        focus:
          "Judge from visible text, CTAs, brand offers, app-download prompts, coupon/deal language, and labels such as 广告/Sponsored/推广. Login, consent, and payment UI are not promotional.",
      },
      criteria: {
        true: "Ad creative, sponsor message, discount/coupon pitch, app-install prompt, lead-gen form, or other marketing content",
        false: "Login, cookie/privacy consent, age gate, payment step, media controls, navigation, search, error dialog, or site functionality",
      },
    },
    [`c${i}_necessary`]: {
      type: "noul",
      instructions: {
        question: "Is this overlay necessary for the site to function or for the user to continue?",
        focus:
          "Necessary means the user cannot reasonably proceed without it: login/signup, cookie or privacy consent, age verification, payment/checkout step, captcha, or media player controls. Promotional overlays are not necessary.",
      },
      criteria: {
        true: "Auth, consent, age gate, payment, captcha, or player controls required to continue",
        false: "Optional promo, ad, download nag, newsletter ask, or marketing interstitial",
      },
    },
    [`c${i}_main`]: {
      type: "noul",
      instructions: {
        question: `Is \`candidates[${i}]\` part of the page's primary content?`,
        focus:
          "Primary content is what the user came to the page to read or use: the article body, main listing, inbox, core product or data, and primary navigation. A container that mostly holds ordinary messages, posts, or listings is primary content even if a few rows inside look promotional.",
      },
      criteria: {
        true: "Article or main body, primary navigation, inbox/listing the page is built around, core product or data, comments the page is built around",
        false: "Standalone promo modal, ad layer, download nag, cookie/consent banner, sidebar widget floating on top",
      },
    },
  };
}

function buildQuestions(candidates) {
  const questions = {};
  candidates.forEach((candidate, i) => {
    if (candidate.kind === "overlay") {
      Object.assign(questions, buildOverlayQuestions(i));
      return;
    }
    questions[`c${i}_ad`] = {
      type: "noul",
      instructions: {
        question: `Is \`candidates[${i}]\` an advertisement?`,
        focus:
          "Judge from visible text, sponsor or promotion labels (such as 广告, Advertisement, Sponsored, Promoted), external link hostnames, and placement. When discloses_ad, class_ad_marker, or id_ad_marker is true, or the element is a sponsored directory slot, treat it as advertising. Sponsored posts, promoted timeline content, paid recommendation widgets, game CPA banners, app-download prompts, and commercial sidebar widgets count as advertising even when they sit in main navigation or a site directory.",
      },
      criteria: {
        true: "A paid or promotional unit meant to drive clicks to an advertiser: display slot, sponsor label, promoted/native ad, affiliate offer, game install CPA, paid directory entry, or third-party recommendation widget",
        false: "Organic page content such as article text, navigation, product or listing info, comments, forms, or site UI with no promotional intent",
      },
    };
    questions[`c${i}_main`] = {
      type: "noul",
      instructions: {
        question: `Is \`candidates[${i}]\` part of the page's primary content?`,
        focus:
          "Primary content is what the user came to the page to read or use: the article body, main listing, inbox, core product or data, and primary navigation. A container that mostly holds ordinary messages, posts, or listings is primary content even if a few rows inside look promotional. A standalone ad slot, float layer, paid directory row, or promo widget is NOT primary content even when it appears inside the main column or site directory.",
      },
      criteria: {
        true: "Article or main body, primary navigation chrome, inbox/listing the page is built around, core product or data, comments the page is built around",
        false: "Standalone promo modal, ad layer, download nag, cookie/consent banner, sidebar widget floating on top, paid directory entry, commercial shortcut",
      },
    };
  });
  return questions;
}

async function callApi(apiKey, body) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    let timeout;
    let response;
    try {
      const request = (async () => {
        const res = await fetch(API_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        return { res, data: await res.json().catch(() => ({})) };
      })();
      response = await Promise.race([
        request,
        new Promise((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject({ code: "TIMEOUT", message: "Jev 请求超时" });
          }, 5000);
        }),
      ]);
    } catch (err) {
      if (timeout) clearTimeout(timeout);
      if (err && err.code === "TIMEOUT") throw err;
      lastError = { code: "NETWORK", message: String(err && err.message) };
      await sleep(1000 * (attempt + 1));
      continue;
    }
    if (timeout) clearTimeout(timeout);
    if (response.res.ok) return response.data;
    if (response.res.status === 401) {
      throw {
        code: "AUTH",
        message: (response.data && response.data.message) || "API key 无效或未授权",
      };
    }
    if (response.res.status === 429 || response.res.status === 529 || response.res.status >= 500) {
      // 限流与 5xx 均视为瞬态：重试后仍失败则整体抛 RATE，
      // 由内容脚本计入连续失败并按需冷却，回落本地规则。
      lastError = { code: "RATE", message: `服务繁忙 (${response.res.status})，已重试` };
      await sleep(attempt === 0 ? 1000 : 3000);
      continue;
    }
    throw {
      code: "API",
      message: (response.data && response.data.message) || `API 错误 (${response.res.status})`,
    };
  }
  throw lastError || { code: "NETWORK", message: "请求失败" };
}

// ---- 签名→裁决缓存 ----
// 同站点同 slot 的候选签名跨页面重复度高；命中缓存免 API 往返，
// 内容脚本的乐观隐藏得以立即转正（闪现窗口从网络往返级降到毫秒级）。
// 签名只用语义稳定字段：CSS-in-JS 站点（哈希类名）自然 miss，无害。
// text 不进签名：广告文案轮播，且避免同 slot 换文案误用旧判决。
const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
const CACHE_MAX_PER_HOST = 100;
const CACHE_MAX_HOSTS = 200;

let cacheMemory = null;

// 构建期哈希类名（CSS Modules 的 name__hash、styled-components/emotion 的
// 生成标识）每次发版都变，原样进签名会让缓存在这类站点上永远 miss，
// 而缓存是省配额的主要手段。这里只剥离**可确认为构建产物**的形态：
//   - `Button_root__2xYz9` → `Button_root`（要求 __ 后缀含数字，避免
//     误伤 BEM 的 nav__item 这种有语义的写法）
//   - `sc-bdVaJa` / `css-1x2y3z`（纯生成标识，无任何语义残留）
// 其余 token 一律保留。
//
// 但"剥离后什么都不剩"与"剥掉一部分"必须区别对待：emotion/styled-components
// 的元素类名是**每个元素一个哈希**，同一个页面上 `css-1x2y3z` 与 `css-9a8b7c`
// 是两个不同的元素。若把它们都归一成空串，二者签名相撞、共用一个裁决——
// 广告位的结论会被用到正文块上。所以此时返回 null 表示"签名不稳定，
// 不可缓存"，退化为多一次 API 往返，而不是冒误并的风险。
const CSS_MODULE_HASH_SUFFIX = /__[A-Za-z0-9-]*[0-9][A-Za-z0-9-]*$/;
const GENERATED_CLASS = [
  /^sc-(?=[A-Za-z]*[a-z])(?=[A-Za-z]*[A-Z])[A-Za-z]{5,}$/, // styled-components
  /^css-[a-z0-9]{6,}$/, // emotion
  /^jsx-?\d{5,}$/, // glamor
];

function isGeneratedClass(tok) {
  return GENERATED_CLASS.some((re) => re.test(tok));
}

// 返回归一化后的类名串；无法得到稳定签名时返回 null（调用方跳过缓存）。
function normalizeClasses(raw) {
  const tokens = String(raw || "").split(/\s+/).filter(Boolean);
  const out = [];
  for (const tok of tokens) {
    if (isGeneratedClass(tok)) continue;
    out.push(tok.replace(CSS_MODULE_HASH_SUFFIX, ""));
  }
  if (out.length) return out.join(" ");
  // 原本有类名但全是生成标识 → 不稳定；本来就没有类名 → 空串是稳定值。
  return tokens.length ? null : "";
}

// 返回签名串；类名全为生成标识等不稳定情况返回 null，表示该候选不可缓存
// （宁多一次往返，不可误并）。
function candidateSig(host, c) {
  const classes = normalizeClasses(c.classes);
  if (classes === null) return null;
  return [
    host,
    c.kind || "inline",
    c.tag || "",
    classes,
    String(c.elementId || ""),
    c.disclosesAd ? 1 : 0,
    String(c.iframeSrc || ""),
    Array.isArray(c.hrefs) ? c.hrefs.join("|") : "",
  ].join("\t");
}

async function loadCache() {
  if (cacheMemory) return cacheMemory;
  try {
    const stored = await chrome.storage.local.get("judgeCache");
    cacheMemory =
      stored && stored.judgeCache && typeof stored.judgeCache === "object" && stored.judgeCache.hosts
        ? stored.judgeCache
        : { hosts: {} };
  } catch {
    cacheMemory = { hosts: {} };
  }
  return cacheMemory;
}

function persistCache() {
  try {
    chrome.storage.local.set({ judgeCache: cacheMemory }).catch(() => {});
  } catch {}
}

// 全局 host 数上限（storage.local 默认 10MB 配额）。对象键按插入序，
// 删最早的 host 即近似 FIFO。
function evictHosts(cache) {
  const hosts = Object.keys(cache.hosts);
  if (hosts.length <= CACHE_MAX_HOSTS) return;
  for (const h of hosts.slice(0, hosts.length - CACHE_MAX_HOSTS)) {
    delete cache.hosts[h];
  }
}

function evictBucket(bucket) {
  const keys = Object.keys(bucket);
  if (keys.length <= CACHE_MAX_PER_HOST) return;
  keys
    .sort((a, b) => (bucket[a].ts || 0) - (bucket[b].ts || 0))
    .slice(0, keys.length - CACHE_MAX_PER_HOST)
    .forEach((k) => delete bucket[k]);
}

function cacheEntryOf(result) {
  if (result.kind === "overlay") {
    return {
      v: [num(result.blocks), num(result.promo), num(result.necessary), num(result.main)],
      ts: Date.now(),
    };
  }
  return { v: [num(result.ad), num(result.main)], ts: Date.now() };
}

function resultFromCache(c, entry) {
  if (c.kind === "overlay") {
    return {
      key: c.key,
      kind: "overlay",
      blocks: entry.v[0],
      promo: entry.v[1],
      necessary: entry.v[2],
      main: entry.v[3],
      disclosesAd: Boolean(c.disclosesAd),
    };
  }
  return {
    key: c.key,
    kind: "inline",
    ad: entry.v[0],
    main: entry.v[1],
    disclosesAd: Boolean(c.disclosesAd),
  };
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// ---- 标签页级预算 ----
// 内容脚本按帧独立运行（manifest 的 all_frames），每个帧都有自己的一套
// 上限；广告重的页面嵌十几个广告 iframe 时，各帧的上限互相独立，
// 叠加起来仍能把全局小时配额吃光，之后所有站点一起回退本地规则。
// 只有 SW 能同时看到一页的所有帧，所以在这里按 tab 计总账。
//
// 只统计真正发往 API 的候选（缓存命中的不计），超限时返回 TAB_BUDGET，
// 内容脚本按瞬态处理、短暂冷却后回落本地规则。窗口而非硬停：
// 无限滚动站点持续产生候选时，不会永久停用该标签页的判断。
const TAB_WINDOW_MS = 10 * 60 * 1000;
const TAB_CANDIDATE_BUDGET = 400;
const tabUsage = new Map();

function tabBudgetExceeded(tabId, misses) {
  if (tabId == null) return false;
  const now = Date.now();
  let u = tabUsage.get(tabId);
  if (!u || now - u.windowStart >= TAB_WINDOW_MS) {
    u = { count: 0, windowStart: now };
    tabUsage.set(tabId, u);
  }
  if (u.count + misses > TAB_CANDIDATE_BUDGET) return true;
  u.count += misses;
  return false;
}

export function clearTabUsage(tabId) {
  tabUsage.delete(tabId);
}

export async function handleJudge(candidates, host, tabId) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { ok: false, code: "EMPTY", message: "没有候选元素" };
  }
  const { apiKey, hourlyBudget } = await chrome.storage.local.get([
    "apiKey",
    "hourlyBudget",
  ]);
  if (!apiKey) {
    return { ok: false, code: "NO_KEY", message: "尚未配置 API key" };
  }
  const budget =
    typeof hourlyBudget === "number" && hourlyBudget > 0
      ? hourlyBudget
      : 1500;
  await hydrateUsage();
  resetUsageWindowIfNeeded();

  // 1) 查缓存：命中直接成形结果，剩余进 API。
  const hostKey = String(host || "");
  const cache = await loadCache();
  const bucket = (cache.hosts[hostKey] ??= {});
  const now = Date.now();
  const hits = [];
  const misses = [];
  for (const c of candidates) {
    // sig 为 null = 类名全为构建期生成标识，签名不稳定：直接走 API，
    // 不查也不写缓存（误并会把广告位的裁决用到正文块上）。
    const sig = candidateSig(hostKey, c);
    const entry = sig === null ? undefined : bucket[sig];
    if (entry && now - (entry.ts || 0) <= CACHE_TTL_MS) {
      hits.push(resultFromCache(c, entry));
    } else {
      if (entry) delete bucket[sig];
      misses.push(c);
    }
  }
  if (misses.length === 0) {
    return { ok: true, results: hits, cached: hits.length };
  }

  // 2) 预算只计未命中的候选。标签页闸门先于全局闸门：
  // 单页帧叠加超限时只冷却这一页，不影响其他标签页。
  if (tabBudgetExceeded(tabId, misses.length)) {
    return {
      ok: false,
      code: "TAB_BUDGET",
      message: "本页判断量已达上限，暂时回退本地规则",
    };
  }
  if (usageCount + misses.length > budget) {
    return {
      ok: false,
      code: "BUDGET",
      message: `本小时判断配额（${budget}）已用尽，已回退本地规则`,
    };
  }
  try {
    const json = await callApi(apiKey, {
      model: MODEL,
      state: {
        candidates: misses.map((c) => ({
          key: c.key,
          kind: c.kind || "inline",
          tag: c.tag,
          text: c.text,
          class_ad_marker: Boolean(c.classAdMarker),
          id_ad_marker: Boolean(c.idAdMarker),
          region: c.region,
          size: c.size,
          hrefs: c.hrefs,
          iframe_src: c.iframeSrc,
          discloses_ad: Boolean(c.disclosesAd),
          geometry: c.geometry,
          signals: c.signals,
        })),
      },
      questions: buildQuestions(misses),
    });
    usageCount += misses.length;
    persistUsage();
    const answers = json && json.answers;
    const complete = misses.every((candidate, i) => {
      const keys = candidate.kind === "overlay"
        ? [`c${i}_blocks`, `c${i}_promo`, `c${i}_necessary`, `c${i}_main`]
        : [`c${i}_ad`, `c${i}_main`];
      return keys.every((key) => {
        const value = answers && answers[key] && answers[key].noul;
        return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
      });
    });
    if (!complete) throw { code: "BAD_RESPONSE", message: "Jev 返回结果不完整" };
    const missResults = misses.map((c, i) => {
      if (c.kind === "overlay") {
        const a1 = (json.answers && json.answers[`c${i}_blocks`]) || {};
        const a2 = (json.answers && json.answers[`c${i}_promo`]) || {};
        const a3 = (json.answers && json.answers[`c${i}_necessary`]) || {};
        const a4 = (json.answers && json.answers[`c${i}_main`]) || {};
        return {
          key: c.key,
          kind: "overlay",
          blocks: typeof a1.noul === "number" ? a1.noul : 0,
          promo: typeof a2.noul === "number" ? a2.noul : 0,
          necessary: typeof a3.noul === "number" ? a3.noul : 0,
          main: typeof a4.noul === "number" ? a4.noul : 0,
          disclosesAd: Boolean(c.disclosesAd),
        };
      }
      const adA = (json.answers && json.answers[`c${i}_ad`]) || {};
      const mainA = (json.answers && json.answers[`c${i}_main`]) || {};
      return {
        key: c.key,
        kind: "inline",
        ad: typeof adA.noul === "number" ? adA.noul : 0,
        main: typeof mainA.noul === "number" ? mainA.noul : 0,
        disclosesAd: Boolean(c.disclosesAd),
      };
    });

    // 3) 回写缓存。签名不稳定的候选（sig === null）跳过，不污染缓存。
    for (let i = 0; i < misses.length; i++) {
      const sig = candidateSig(hostKey, misses[i]);
      if (sig !== null) bucket[sig] = cacheEntryOf(missResults[i]);
    }
    evictBucket(bucket);
    evictHosts(cache);
    persistCache();

    return {
      ok: true,
      results: hits.concat(missResults),
      cached: hits.length,
      usage: json.usage,
    };
  } catch (err) {
    const e = err || {};
    return {
      ok: false,
      code: e.code || "API",
      message: e.message || "判断失败",
    };
  }
}

export async function handleTestKey(apiKey) {
  if (!apiKey) {
    return { ok: false, code: "NO_KEY", message: "请输入 API key" };
  }
  try {
    await callApi(apiKey, {
      model: MODEL,
      state: "This is a connection test.",
      questions: {
        is_test: {
          type: "noul",
          instructions: "Does the text say it is a connection test?",
        },
      },
    });
    return { ok: true };
  } catch (err) {
    const e = err || {};
    return {
      ok: false,
      code: e.code || "API",
      message: e.message || "连接失败",
    };
  }
}

// 导出供测试：签名归一化是缓存正确性的关键路径，误并会给出错误的隐藏
// 结论并持续整个 TTL，比 miss 的代价高得多。
export const __testing = { normalizeClasses, candidateSig };
