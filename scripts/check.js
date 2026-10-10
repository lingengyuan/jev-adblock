#!/usr/bin/env node
// 校验 JavaScript 语法、JSON、扩展清单路径。
// 依赖 scripts/build.js 先生成 dist/（npm run check 会先构建）。
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { lintRuleset } = require("./lint-dnr.js");

const root = path.join(__dirname, "..");
const dist = path.join(root, "dist");
const files = [];

function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === ".git") continue;
      walk(p);
    } else if (name.endsWith(".js")) {
      files.push(p);
    }
  }
}

// 源文件语法检查
walk(path.join(root, "src"));
walk(path.join(root, "rules"));
// 产物语法检查
for (const bundle of ["bundle.js", "early-bundle.js"]) {
  const p = path.join(dist, "src", "content", bundle);
  if (fs.existsSync(p)) files.push(p);
}

let failed = 0;
for (const file of files) {
  // 必须走 stdin + --input-type=module：`node --check <file>` 把 .js 当
  // CommonJS 脚本解析，遇到 ESM 语法（import/export）会**静默通过**——
  // 实测在坏掉的 judge.js（export 语句错位在函数体里）上返回 0。
  // 以模块解析对这批文件是超集：它们没有顶层 return / with。
  try {
    execFileSync(process.execPath, ["--input-type=module", "--check"], {
      stdio: ["pipe", "pipe", "pipe"],
      input: fs.readFileSync(file),
    });
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${path.relative(root, file)}`);
    console.error(String(err.stderr || err.message));
  }
}

for (const file of [
  "manifest.json",
  "dist/manifest.json",
  "rules/network/ad_networks.json",
  "rules/network/community.json",
]) {
  const p = path.join(root, file);
  if (!fs.existsSync(p)) {
    failed += 1;
    console.error(`FAIL missing ${file}`);
    continue;
  }
  try {
    JSON.parse(fs.readFileSync(p, "utf8"));
    console.log(`ok json ${file}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL json ${file}: ${err.message}`);
  }
}

// 校验 dist/manifest.json 中引用的路径都在 dist/ 内
const manifestPath = path.join(dist, "manifest.json");
if (!fs.existsSync(manifestPath)) {
  failed += 1;
  console.error("FAIL missing dist/manifest.json（先运行 npm run build）");
} else {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  function requirePath(rel, label) {
    if (!fs.existsSync(path.join(dist, rel))) {
      failed += 1;
      console.error(`FAIL missing ${label} ${rel}`);
      return false;
    }
    return true;
  }

  for (const cs of manifest.content_scripts || []) {
    for (const rel of cs.js || []) requirePath(rel, "content script");
    for (const rel of cs.css || []) requirePath(rel, "content css");
  }
  requirePath(manifest.background.service_worker, "service worker");
  // service worker 的 ES module 依赖
  const swDeps = [
    "src/background/judge.js",
    "src/background/logs.js",
  ];
  for (const rel of swDeps) requirePath(rel, "service worker dependency");
  requirePath(manifest.options_page, "options page");
  requirePath(manifest.action && manifest.action.default_popup, "popup");
  for (const size of Object.values(
    (manifest.action && manifest.action.default_icon) || {},
  )) {
    requirePath(size, "action icon");
  }
  for (const size of Object.values(manifest.icons || {})) {
    requirePath(size, "icon");
  }
  const dnrRules =
    manifest.declarative_net_request && manifest.declarative_net_request.rule_resources;
  if (!Array.isArray(dnrRules) || dnrRules.length === 0) {
    failed += 1;
    console.error("FAIL missing declarative_net_request.rule_resources");
  }
  for (const res of dnrRules || []) {
    requirePath(res.path, "dnr rules");
  }

  // DNR 静态规则集 lint：Chrome 加载静态 ruleset 是全有或全无的——只要有一条
  // 规则违反约束，整包被拒，表现为"拦截完全静默失效"。构建期拦住远比上线后排查便宜。
  for (const res of dnrRules || []) {
    const p = path.join(dist, res.path);
    if (!fs.existsSync(p)) continue; // 缺失已由上面的 requirePath 报出
    let rules;
    try {
      rules = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      continue; // JSON 语法错误已在上面的 json 检查中报出
    }
    const problems = lintRuleset(rules, res.id || res.path);
    for (const problem of problems) {
      failed += 1;
      console.error(`FAIL dnr ${problem}`);
    }
    if (!problems.length) console.log(`ok dnr ${res.id || res.path}（${rules.length} 条）`);
  }

  for (const html of ["src/popup/popup.html", "src/options/options.html"]) {
    const p = path.join(dist, html);
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, "utf8");
    const dir = path.dirname(p);
    for (const m of text.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const ref = m[1];
      if (/^(https?:|#|data:|mailto:)/.test(ref)) continue;
      const target = path.resolve(dir, ref);
      if (!fs.existsSync(target)) {
        failed += 1;
        console.error(`FAIL missing ${html} → ${ref}`);
      }
    }
  }

  // 弹窗/设置页引用的共享脚本
  for (const page of [
    ["src/popup/popup.html", "src/popup/popup.js"],
    ["src/options/options.html", "src/options/options.js"],
  ]) {
    const [htmlRel, scriptRel] = page;
    const html = fs.readFileSync(path.join(dist, htmlRel), "utf8");
    for (const m of html.matchAll(/<script src="([^"]+)"><\/script>/g)) {
      const ref = m[1];
      const target = path.resolve(path.join(dist, path.dirname(htmlRel)), ref);
      if (!fs.existsSync(target)) {
        failed += 1;
        console.error(`FAIL missing ${htmlRel} script → ${ref}`);
      }
    }
    if (!fs.existsSync(path.join(dist, scriptRel))) {
      failed += 1;
      console.error(`FAIL missing ${scriptRel}`);
    }
  }
}

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log(`\nchecked ${files.length} js files, ok`);
