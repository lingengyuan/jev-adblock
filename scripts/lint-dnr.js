#!/usr/bin/env node
// 静态 DNR 规则集校验。
//
// 为什么需要：Chrome 加载静态 ruleset 是**全有或全无**的——rules/network/*.json
// 里只要有一条规则违反约束，整个 ruleset 会被整体拒绝，表现为"广告拦截悄悄
// 完全失效"，而控制台未必有明显报错。构建期把它拦下来，比上线后排查便宜得多。
//
// 覆盖三类问题：
//   ① 契约问题：Chrome 会直接拒绝整包（非法 urlFilter 字符、重复 id、
//      静态规则里出现 session-only 的 tabIds 等）；
//   ② 语义事故：语法合法但会放大影响面（allow + 空 condition 等于放行一切）；
//   ③ 静默缩水：逐条合法、Chrome 照常加载，但整包规则数暴跌。
//
// 校验在生成的 JSON 上做（而非转换器中间态），所以无论规则来自哪个转换路径
// 都受同一道约束。

const RESOURCE_TYPES = new Set([
  "main_frame", "sub_frame", "stylesheet", "script", "image", "font",
  "object", "xmlhttprequest", "ping", "csp_report", "media", "websocket",
  "webtransport", "webbundle", "other",
]);

const ACTION_TYPES = new Set([
  "block", "redirect", "allow", "upgradeScheme", "modifyHeaders", "allowAllRequests",
]);

const DOMAIN_TYPE = new Set(["firstParty", "thirdParty"]);

// urlFilter 字符集与域名形状直接复用转换器的定义——两边若各写一套，构建期
// 校验会比运行期生成更宽松（或反之），这道 lint 就失去了意义。
const { URL_FILTER_ALLOWED, DOMAIN_LABELED } = require("./convert-filters.js");
const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");
const MAX_URL_FILTER_LEN = 2000;
const MAX_REGEX_LEN = 1000;
const MAX_RULES = 30000; // Chrome GUARANTEED_MINIMUM_STATIC_RULES

// 规则数缩水的判定阈值（思路借自 esp32-c3-adblock 的 tools/build_blocklist.py：
// 源列表读不到时它宁可报错退出，也不产出一个更小的 blocklist，理由是
// "静默缩水没人会发现"）。我们的同类风险换了形态：源站改版、CDN 返回残缺内容、
// 镜像回了错误页——规则条条合法，拦截面却悄悄缩小。逐条 lint 看不见，只能比总量。
const SHRINK_MAX_DROP = 50; // 少于这么多条不值得报警：上游日常波动
const SHRINK_MAX_RATIO = 0.02; // 掉幅同时要超过 2% 才判定为事故

// requestDomains / initiatorDomains 只接受域名本身：不带 scheme、路径、端口、
// 通配，且需为 punycode（非 ASCII 一律拒绝）。
const DOMAIN_BAD_CHARS = /[\s/?#@:@*]/;

function checkDomainList(cond, key, push) {
  const list = cond[key];
  if (list === undefined) return;
  if (!Array.isArray(list)) {
    push(`${key} 必须是数组`);
    return;
  }
  list.forEach((d, i) => {
    const at = `${key}[${i}]`;
    if (typeof d !== "string" || !d) {
      push(`${at} 必须是非空字符串`);
      return;
    }
    if (DOMAIN_BAD_CHARS.test(d)) {
      push(`${at} "${d}" 含 scheme/路径/端口/通配等非法字符`);
    }
    if (d.startsWith(".") || d.endsWith(".")) {
      push(`${at} "${d}" 不应以点开头或结尾`);
    }
    // 单标签条目（"ads"）会匹配整个 TLD——Chrome 接受但语义是危险的过度匹配。
    // 这是转换器与 lint 共用的形状常量，两边不会漂移。
    if (!DOMAIN_LABELED.test(d)) {
      push(`${at} "${d}" 不是可注册域名形状（至少两个点分标签）`);
    }
    if (/[^\x20-\x7e]/.test(d)) {
      push(`${at} "${d}" 含非 ASCII 字符，requestDomains 需用 punycode`);
    }
  });
}

function checkUrlFilter(cond, push) {
  const uf = cond.urlFilter;
  if (uf === undefined) return;
  if (typeof uf !== "string") {
    push("urlFilter 必须是字符串");
    return;
  }
  if (uf.length === 0) {
    push("urlFilter 为空字符串，会匹配所有请求");
  } else if (!URL_FILTER_ALLOWED.test(uf)) {
    push(`urlFilter ${JSON.stringify(uf)} 含字符集外的字符（空白/非 ASCII/正则残留）`);
  }
  if (uf.length > MAX_URL_FILTER_LEN) {
    push(`urlFilter 长度 ${uf.length} 超过 ${MAX_URL_FILTER_LEN}`);
  }
  // ||* 是左锚点后紧跟通配，Chrome 视为非法模式
  if (uf.startsWith("||*")) {
    push(`urlFilter ${JSON.stringify(uf)} 以 "||*" 开头，Chrome 拒绝该模式`);
  }
}

function lintRule(rule, index, problems, seenIds) {
  const where = rule && rule.id != null ? `id=${rule.id}` : `[${index}]`;
  const push = (msg) => problems.push(`${where}: ${msg}`);

  if (!rule || typeof rule !== "object") {
    problems.push(`[${index}]: 规则不是对象`);
    return;
  }
  if (!Number.isInteger(rule.id) || rule.id <= 0) {
    push("id 必须是正整数");
  } else if (seenIds.has(rule.id)) {
    push("id 在同一规则集内重复");
  } else {
    seenIds.add(rule.id);
  }
  if (rule.priority !== undefined && !Number.isInteger(rule.priority)) {
    push("priority 必须是整数");
  }

  const action = rule.action;
  if (!action || typeof action !== "object") {
    push("缺少 action");
  } else if (!ACTION_TYPES.has(action.type)) {
    push(`action.type "${action.type}" 非法`);
  }

  const cond = rule.condition;
  if (cond === undefined || cond === null) {
    push("缺少 condition");
    return;
  }
  if (typeof cond !== "object" || Array.isArray(cond)) {
    push("condition 必须是对象");
    return;
  }

  // allow + 空条件 = 放行一切。语法合法，后果最严重。
  if (action && action.type === "allow" && Object.keys(cond).length === 0) {
    push("allow 规则带空 condition，等于放行所有请求");
  }

  if (cond.urlFilter !== undefined && cond.regexFilter !== undefined) {
    push("urlFilter 与 regexFilter 不能同时出现");
  }
  checkUrlFilter(cond, push);
  if (cond.regexFilter !== undefined) {
    if (typeof cond.regexFilter !== "string") {
      push("regexFilter 必须是字符串");
    } else if (cond.regexFilter.length > MAX_REGEX_LEN) {
      push(`regexFilter 长度 ${cond.regexFilter.length} 超过 ${MAX_REGEX_LEN}`);
    } else {
      try {
        new RegExp(cond.regexFilter);
      } catch (err) {
        push(`regexFilter 不是合法正则：${err.message}`);
      }
    }
  }

  if (cond.resourceTypes !== undefined) {
    if (!Array.isArray(cond.resourceTypes)) {
      push("resourceTypes 必须是数组");
    } else if (cond.resourceTypes.length === 0) {
      push("resourceTypes 为空数组，不会匹配任何请求");
    } else {
      for (const rt of cond.resourceTypes) {
        if (!RESOURCE_TYPES.has(rt)) push(`resourceTypes 含未知类型 "${rt}"`);
      }
    }
  }

  if (cond.domainType !== undefined && !DOMAIN_TYPE.has(cond.domainType)) {
    push(`domainType "${cond.domainType}" 非法`);
  }

  for (const key of [
    "requestDomains",
    "excludedRequestDomains",
    "initiatorDomains",
    "excludedInitiatorDomains",
  ]) {
    checkDomainList(cond, key, push);
  }

  // tabIds 只允许出现在 session/dynamic 规则里，静态规则集出现即整包被拒
  if (cond.tabIds !== undefined) {
    push("静态规则不得使用 tabIds（仅 session/dynamic 规则支持）");
  }
}

function lintRuleset(rules, label = "ruleset") {
  const problems = [];
  if (!Array.isArray(rules)) {
    return [`${label}: 顶层必须是数组`];
  }
  if (rules.length > MAX_RULES) {
    problems.push(`${label}: 规则数 ${rules.length} 超过静态上限 ${MAX_RULES}`);
  }
  if (rules.length === 0) {
    // 空规则集能过所有逐条校验——没有规则可查——却让整个拦截静默失效。
    problems.push(`${label}: 规则集为空`);
  }
  const seenIds = new Set();
  rules.forEach((rule, i) => lintRule(rule, i, problems, seenIds));
  return problems.map((p) => `${label}: ${p}`);
}

// 基线存在 artifact 目录（与 Chrome 自己写生成物的地方同一处）：被 .gitignore
// 排除、随生成物一起重建，不进版本库。两者对齐后每次转换都能回答"这次是不是
// 少了一大截"。局限要说清：CI 全新克隆时首次运行只建立基线，不会报警——这是
// 给"正在跑 npm run filters 的人"设的绊线，而那个人正是需要看见缩水的人。
const BASELINE_DIR = path.join(__dirname, "..", "_metadata", "generated_indexed_rulesets");

function artifactBaselinePath(basename, baselineDir) {
  return path.join(baselineDir, `_${basename}.baseline`);
}

// ruleset 路径不存在（如单测里没有实体文件）时返回 null，调用方跳过该项。
function checkShrink(abspath, ruleset, label, problems, baselineDir = BASELINE_DIR) {
  if (!abspath || !fs.existsSync(abspath)) return;
  const p = artifactBaselinePath(path.basename(abspath), baselineDir);
  if (!fs.existsSync(p)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `${ruleset.length}\n`);
    return;
  }
  const prev = Number.parseInt(fs.readFileSync(p, "utf8").trim(), 10);
  // 基线缺失或损坏时只报告、不判失败——数据坏了要修，不能静默当没有。
  if (!Number.isInteger(prev) || prev < 0) {
    problems.push(`${label}: 基线文件损坏，无法判断规则集是否缩水（${p}）`);
    return;
  }
  if (prev === 0) {
    fs.writeFileSync(p, `${ruleset.length}\n`);
    return;
  }
  const ratio = (prev - ruleset.length) / prev;
  if (ruleset.length < prev && prev - ruleset.length > SHRINK_MAX_DROP && ratio > SHRINK_MAX_RATIO) {
    // 只报告、不自动改基线：少掉的规则要被看见，而不是被下次写入抹平。
    problems.push(
      `${label}: 规则数从 ${prev} 降到 ${ruleset.length}（-${(ratio * 100).toFixed(1)}%）` +
        `，逐条合法但拦截面缩小——确认上游是否改版/镜像残缺，再删 ${p} 重建基线`,
    );
  }
}

function main() {
  const root = path.join(__dirname, "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const resources = (manifest.declarative_net_request || {}).rule_resources || [];
  let problems = [];
  for (const res of resources) {
    const p = path.join(root, res.path);
    if (!fs.existsSync(p)) {
      problems.push(`${res.path}: 文件不存在`);
      continue;
    }
    const ruleset = JSON.parse(fs.readFileSync(p, "utf8"));
    problems = problems.concat(lintRuleset(ruleset, res.id || res.path));
    checkShrink(path.join(root, res.path), ruleset, res.id || res.path, problems);
  }
  if (problems.length) {
    for (const p of problems) console.error(`FAIL dnr ${p}`);
    process.exit(1);
  }
  console.log(`ok dnr ${resources.length} ruleset(s)`);
}

if (require.main === module) main();

module.exports = { lintRuleset, checkShrink, RESOURCE_TYPES, ACTION_TYPES };
