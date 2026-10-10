#!/usr/bin/env node
// 社区规则管道：拉取 EasyList China + CJX's Annoyance List，转换为本项目格式。
//   网络规则 → rules/network/community.json（DNR 静态规则）
//   定向 cosmetic → rules/dom/community.js（按域名分桶，进 detectors 层）
//   通用 cosmetic / procedural / scriptlet → 保留或跳过（见产物 meta）
// 用法：node scripts/convert-filters.js（npm run filters）
// 规则更新随扩展发布（构建期转换，无运行期远程代码，符合 MV3）。
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.join(__dirname, "..");

const SOURCES = [
  {
    name: "easylistchina",
    urls: [
      "https://easylist-downloads.adblockplus.org/easylistchina.txt",
      "https://cdn.jsdelivr.net/gh/easylist/easylistchina@master/easylistchina.txt",
    ],
  },
  {
    name: "cjx-annoyance",
    urls: [
      "https://cdn.jsdelivr.net/gh/cjx82630/cjxlist@master/cjx-annoyance.txt",
      "https://raw.githubusercontent.com/cjx82630/cjxlist/master/cjx-annoyance.txt",
    ],
  },
];

// urlFilter 允许的字符集：URL 中可能出现的字符 + DNR 通配符 * | ^。
// 反斜杠、花括号、空格只可能是正则残留或空白，出现即让 Chrome 拒绝整个
// ruleset。导出给 scripts/lint-dnr.js 复用，避免构建期校验与运行期生成
// 两套标准悄悄漂移。
const URL_FILTER_ALLOWED = /^[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%^|*]*$/;

// DNR resourceTypes 全集（与手写 ad_networks.json 一致）
const ALL_TYPES = [
  "stylesheet",
  "script",
  "image",
  "font",
  "sub_frame",
  "object",
  "xmlhttprequest",
  "ping",
  "media",
  "websocket",
  "other",
];

// 网络规则 option → DNR resourceTypes
const TYPE_MAP = {
  script: ["script"],
  stylesheet: ["stylesheet"],
  image: ["image"],
  font: ["font"],
  subdocument: ["sub_frame"],
  xmlhttprequest: ["xmlhttprequest"],
  object: ["object"],
  media: ["media"],
  websocket: ["websocket"],
  ping: ["ping"],
  other: ["other"],
};

// 无法映射到 DNR 的 option（整条规则跳过）
// document/popup 不是网络资源类型；修饰类 option 超出 DNR 能力。
// third-party/first-party → condition.domainType；important → priority，见下方映射。
const UNSUPPORTED_OPTIONS = new Set([
  "document",
  "popup",
  "generichide",
  "elemhide",
  "specifichide",
  "cname",
  "webrtc",
  "removeparam",
  "redirect",
  "redirect-rule",
  "replace",
  "csp",
  "permissions",
  "header",
  "badfilter",
  "dnsrewrite",
  "negative",
]);

// cosmetic selector 黑名单：uBO/ABP procedural 语法，纯 CSS 引擎不支持
const PROCEDURAL_RE =
  /:has-text\(|:-abp-|:matches-|:nth-ancest|:upward\(|:xpath\(|:spath|:style\(|:remove-attr\(|:remove-class\(|:matches-attr|\)\s*\^|^\^|\+\js\(|:expects\(|:min-text-length\(|:others\(/;

// 近似合法 CSS selector 校验（字符白名单 + 括号配平 + 长度）
function isPlainCssSelector(sel) {
  if (!sel || sel.length > 300) return false;
  if (PROCEDURAL_RE.test(sel)) return false;
  if (!/^[\w\s.#[\](){}:*=+~>"'^$|,\\%_/@-]+$/.test(sel)) return false;
  let depth = 0;
  for (const ch of sel) {
    if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

function parseOptions(raw) {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// domain=/from=/to= 的域名列表：~ 前缀为排除域。
// DNR 表达：正例 → initiatorDomains/requestDomains，负例 → excluded*（Chrome 114+）。
// 正负并存无法单条表达（旧实现剥掉 ~ 造成语义反转），整条跳过。
// 域名形状：点分标签，不接受空标签（尾点/连续点）或域名外字符。
// 每条 requestDomains/initiatorDomains 条目都必须是这种形状——单个标签
// （如 "ads"）会匹配整个 TLD，是危险的过度匹配，导出给 lint-dnr.js 复用。
// 注意非法项不能静默丢弃——少一个 initiatorDomains 会让规则的匹配面变大，
// 所以 parseDomainOption 只标记 invalid，由调用方整条丢弃（宁缺毋滥）。
const DOMAIN_SHAPE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/;
const DOMAIN_LABELED = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

function parseDomainOption(raw) {
  const included = [];
  const excluded = [];
  let invalid = false;
  for (const part of raw.split("|")) {
    const d = part.trim().toLowerCase();
    if (!d) continue;
    const negated = d.startsWith("~");
    const host = negated ? d.slice(1).trim() : d;
    if (!host || !DOMAIN_SHAPE.test(host)) {
      invalid = true;
      continue;
    }
    if (negated) excluded.push(host);
    else included.push(host);
  }
  return { included, excluded, invalid };
}

// 解析网络规则 → DNR 规则或 null（跳过）
function convertNetworkRule(line) {
  const isException = line.startsWith("@@");
  let body = isException ? line.slice(2) : line;

  let options = [];
  const dollar = body.lastIndexOf("$");
  if (dollar >= 0 && !body.slice(dollar + 1).includes("/")) {
    options = parseOptions(body.slice(dollar + 1));
    body = body.slice(0, dollar);
  }
  if (!body) return null;

  const condition = {};
  const resourceTypes = [];
  let important = false;
  let mixedDomains = false;

  for (const opt of options) {
    const key = opt.split("=")[0];
    if (UNSUPPORTED_OPTIONS.has(key)) return null;
    // $third-party/$3p 与 $~first-party/$~1p 同义；$first-party/$1p 与 $~third-party/$~3p 同义。
    // 旧实现只认无 ~ 的形式，~ 前缀的键落进"未知 option"分支被整条丢弃。
    if (key === "third-party" || key === "3p" || key === "~first-party" || key === "~1p") {
      condition.domainType = "thirdParty";
      continue;
    }
    if (key === "first-party" || key === "1p" || key === "~third-party" || key === "~3p") {
      condition.domainType = "firstParty";
      continue;
    }
    if (key === "important") {
      // ABP 语义：压过列表例外规则。DNR 用 priority 表达（见 sw.js 梯度注释）。
      important = true;
      continue;
    }
    if (opt.startsWith("domain=") || opt.startsWith("from=")) {
      const { included, excluded, invalid } = parseDomainOption(opt.slice(opt.indexOf("=") + 1));
      if (invalid) return null;
      if (included.length && excluded.length) {
        mixedDomains = true;
        continue;
      }
      if (included.length) condition.initiatorDomains = included;
      if (excluded.length) condition.excludedInitiatorDomains = excluded;
      continue;
    }
    if (opt.startsWith("to=")) {
      const { included, excluded, invalid } = parseDomainOption(opt.slice(3));
      if (invalid) return null;
      if (included.length && excluded.length) {
        mixedDomains = true;
        continue;
      }
      if (included.length) condition.requestDomains = included;
      if (excluded.length) condition.excludedRequestDomains = excluded;
      continue;
    }
    const types = TYPE_MAP[key];
    if (types) {
      resourceTypes.push(...types);
      continue;
    }
    if (key === "match-case" || key === "network") continue;
    // 未知 option：保守跳过
    return null;
  }
  // 正负域名并存：DNR 单条件无法表达，整条丢弃（宁缺毋滥）。
  if (mixedDomains) return null;

  // ||domain^ 纯域名形式 → requestDomains（可与其他域名合并）。
  // 域名形状收紧为点分标签：字符类里的 `.` 会让 `||allyes.^` 抓出带尾点的
  // "allyes."，而 requestDomains 不接受尾点（Chrome 拒绝整包）。这类形式
  // 现在落到下面的 urlFilter 分支，语义与源过滤规则一致。
  const domainMatch = body.match(/^\|\|([a-z0-9-]+(?:\.[a-z0-9-]+)*)\^?$/i);
  if (domainMatch && !Object.prototype.hasOwnProperty.call(condition, "initiatorDomains")) {
    return {
      kind: "domain",
      domain: domainMatch[1].toLowerCase(),
      condition,
      resourceTypes,
      isException,
      important,
    };
  }

  // 其余形式 → urlFilter（DNR 支持 || | * ^ 语法）。
  // Chrome 校验：仅可打印非空白 ASCII，且只支持 DNR 通配符；
  // 反斜杠/花括号（正则残留）与 ||*（左锚后跟通配）都会被整包拒绝。
  if (body.length > 500) return null;
  if (!URL_FILTER_ALLOWED.test(body)) return null;
  if (body.startsWith("||*")) return null;
  condition.urlFilter = body;
  return {
    kind: "filter",
    condition,
    resourceTypes,
    isException,
    important,
  };
}

function convertCosmeticRule(line) {
  // domain1,domain2##selector / ##selector
  const hashIdx = line.indexOf("##");
  if (hashIdx < 0) return null;
  let domainsPart = line.slice(0, hashIdx);
  const selector = line.slice(hashIdx + 2);
  if (domainsPart.startsWith("~") || domainsPart.includes("~")) return null;
  const domains = domainsPart
    .split(/[,~]/)
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  return { domains, selector };
}

async function fetchText(url) {
  // Node 22 的 fetch 不读 HTTP(S)_PROXY 环境变量；失败时降级 curl（走系统代理）。
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "jev-adblock-filter-converter/1.0" },
      signal: AbortSignal.timeout(30000),
    });
    if (res.ok) return await res.text();
    throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    return execFileSync("curl", ["-sL", "--max-time", "60", url], {
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
    });
  }
}

async function fetchList(source) {
  let lastErr = null;
  for (const url of source.urls) {
    try {
      const text = await fetchText(url);
      if (text && (text.includes("##") || text.length > 1000)) return text.split(/\r?\n/);
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`拉取 ${source.name} 失败（已尝试 ${source.urls.length} 个镜像）: ${lastErr}`);
}

async function main() {
  const stats = {
    networkDomain: 0,
    networkFilter: 0,
    networkSkipped: 0,
    exception: 0,
    domainType: 0,
    important: 0,
    excludedDomains: 0,
    cosmeticDomainSelectors: 0,
    cosmeticGeneric: 0,
    cosmeticProceduralSkipped: 0,
    cosmeticInvalidSkipped: 0,
  };

  const blockDomains = new Set();
  const urlFilterRules = [];
  const allowRules = [];
  const byDomain = new Map();
  const generic = new Set();

  for (const source of SOURCES) {
    const lines = await fetchList(source);
    for (let raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("!") || line.startsWith("[")) continue;

      // scriptlet / 例外 cosmetic / procedural 标记
      if (line.includes("#@#") || line.includes("#?#") || line.includes("##+js")) {
        stats.cosmeticProceduralSkipped += 1;
        continue;
      }
      if (line.includes("##")) {
        const parsed = convertCosmeticRule(line);
        if (!parsed) {
          stats.cosmeticProceduralSkipped += 1;
          continue;
        }
        if (!isPlainCssSelector(parsed.selector)) {
          stats.cosmeticInvalidSkipped += 1;
          continue;
        }
        if (parsed.domains.length === 0) {
          generic.add(parsed.selector);
        } else {
          for (const d of parsed.domains) {
            if (!byDomain.has(d)) byDomain.set(d, new Set());
            byDomain.get(d).add(parsed.selector);
          }
          stats.cosmeticDomainSelectors += 1;
        }
        continue;
      }

      const rule = convertNetworkRule(line);
      if (!rule) {
        stats.networkSkipped += 1;
        continue;
      }
      if (rule.condition.domainType) stats.domainType += 1;
      if (rule.important) stats.important += 1;
      if (
        rule.condition.excludedInitiatorDomains ||
        rule.condition.excludedRequestDomains
      ) {
        stats.excludedDomains += 1;
      }
      if (rule.isException) {
        stats.exception += 1;
        allowRules.push(rule);
        continue;
      }
      if (rule.kind === "domain") {
        // 纯域名合并条仅承载无附加条件的域名；带类型/第三方/排除域的
        // 必须独立成条，否则条件丢失导致过宽或过窄。
        const needsOwnRule =
          rule.resourceTypes.length ||
          rule.condition.domainType ||
          rule.condition.excludedInitiatorDomains ||
          rule.condition.excludedRequestDomains;
        if (needsOwnRule) {
          urlFilterRules.push({
            condition: { ...rule.condition, requestDomains: [rule.domain] },
            resourceTypes: rule.resourceTypes,
            important: rule.important,
          });
        } else {
          blockDomains.add(rule.domain);
          if (rule.important) {
            // $important 纯域名也独立成条（priority 4 需单条承载）
            urlFilterRules.push({
              condition: { requestDomains: [rule.domain] },
              resourceTypes: [],
              important: true,
            });
          }
        }
      } else {
        urlFilterRules.push(rule);
      }
    }
  }

  // ---- 生成 DNR 静态规则 ----
  const dnr = [];
  let nextId = 1000;
  // 纯域名 block：每 500 域名合并一条
  const domainList = [...blockDomains];
  for (let i = 0; i < domainList.length; i += 500) {
    dnr.push({
      id: nextId++,
      priority: 1,
      action: { type: "block" },
      condition: {
        requestDomains: domainList.slice(i, i + 500),
        resourceTypes: ALL_TYPES,
      },
    });
  }
  for (const rule of urlFilterRules) {
    const condition = { ...rule.condition };
    if (rule.resourceTypes.length) condition.resourceTypes = [...new Set(rule.resourceTypes)];
    dnr.push({
      id: nextId++,
      // $important：压过列表例外（priority 2）。用户白名单（5）与本页暂停（6）仍在其上。
      priority: rule.important ? 4 : 1,
      action: { type: "block" },
      condition,
    });
  }
  // 例外规则：allow 优先级高于普通 block。
  // 纯域名例外（@@||x^）必须写回 requestDomains —— 曾生成 13 条空条件 allow，
  // 空条件匹配一切请求且 priority 2 压过全部 block，整包网络拦截被击穿。
  for (const rule of allowRules) {
    const condition = { ...rule.condition };
    if (rule.kind === "domain") condition.requestDomains = [rule.domain];
    if (rule.resourceTypes.length) condition.resourceTypes = [...new Set(rule.resourceTypes)];
    dnr.push({
      id: nextId++,
      priority: 2,
      action: { type: "allow" },
      condition,
    });
  }

  // ---- 写 rules/network/community.json ----
  const networkDir = path.join(root, "rules", "network");
  fs.mkdirSync(networkDir, { recursive: true });
  fs.writeFileSync(
    path.join(networkDir, "community.json"),
    JSON.stringify(dnr, null, 2) + "\n",
  );

  // ---- 写 rules/dom/community.js ----
  const domObj = {};
  for (const [domain, selectors] of byDomain) {
    domObj[domain] = [...selectors];
  }
  const version = new Date().toISOString().slice(0, 10);
  const lines = [
    "// 由 scripts/convert-filters.js 生成，请勿直接编辑。",
    `// 来源：EasyList China + CJX's Annoyance List（转换于 ${version}）。`,
    `// 定向 cosmetic（domain##selector）按域名分桶，由 src/content/early.js 在`,
    `// document_start 注入 CSS（不可经「恢复本页」还原，刷新恢复）；`,
    `// generic 池默认不注入（与 uBO Lite 默认关闭通用 cosmetic 的策略一致）。`,
    "(globalThis.JevAd ??= {});",
    `JevAd.communityRules = ${JSON.stringify(
      { version, generic: [...generic], byDomain: domObj },
      null,
      0,
    )};`,
    "",
  ];
  const domDir = path.join(root, "rules", "dom");
  fs.mkdirSync(domDir, { recursive: true });
  fs.writeFileSync(path.join(domDir, "community.js"), lines.join("\n"));

  // ---- 报告 ----
  const totalSelectors = Object.values(domObj).reduce((n, v) => n + v.length, 0);
  console.log(`社区规则转换完成（${version}）`);
  console.log(`  网络规则: ${domainList.length} 纯域名 + ${urlFilterRules.length} urlFilter, ${allowRules.length} 例外, 跳过 ${stats.networkSkipped}`);
  console.log(`  能力映射: domainType ${stats.domainType}, important ${stats.important}, 排除域 ${stats.excludedDomains}`);
  console.log(`  DNR 规则总数: ${dnr.length}`);
  console.log(`  定向 cosmetic: ${Object.keys(domObj).length} 域名 / ${totalSelectors} selector`);
  console.log(`  通用 cosmetic: ${generic.size}（默认不注入）`);
  console.log(`  cosmetic 跳过: procedural ${stats.cosmeticProceduralSkipped}, 无效 ${stats.cosmeticInvalidSkipped}`);
}

// 作为脚本运行时执行转换；被 require 时（单元测试）只导出纯函数。
if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = {
  convertNetworkRule,
  convertCosmeticRule,
  isPlainCssSelector,
  URL_FILTER_ALLOWED,
  DOMAIN_LABELED,
};
