const { test } = require("node:test");
const assert = require("node:assert");

const {
  convertNetworkRule,
  convertCosmeticRule,
  isPlainCssSelector,
} = require("../../scripts/convert-filters.js");

// ---- option 语义映射 ----

test("$third-party / $first-party 映射到 domainType", () => {
  assert.strictEqual(
    convertNetworkRule("||ads.example.com^$third-party").condition.domainType,
    "thirdParty",
  );
  assert.strictEqual(
    convertNetworkRule("||ads.example.com^$1p").condition.domainType,
    "firstParty",
  );
});

test("$~third-party 映射为 firstParty，不再整条丢弃", () => {
  const rule = convertNetworkRule("||ads.example.com^$~third-party");
  assert.ok(rule, "~ 前缀不应导致规则被跳过");
  assert.strictEqual(rule.kind, "domain");
  assert.strictEqual(rule.domain, "ads.example.com");
  assert.strictEqual(rule.condition.domainType, "firstParty");
});

test("$~first-party 映射为 thirdParty", () => {
  assert.strictEqual(
    convertNetworkRule("||ads.example.com^$~first-party").condition.domainType,
    "thirdParty",
  );
  assert.strictEqual(
    convertNetworkRule("||ads.example.com^$~1p").condition.domainType,
    "thirdParty",
  );
});

test("~ 前缀与其他 option 组合时资源类型保留", () => {
  const rule = convertNetworkRule("-advertisement-$image,~third-party");
  assert.ok(rule, "组合形式不应被跳过");
  assert.strictEqual(rule.kind, "filter");
  assert.deepStrictEqual(rule.resourceTypes, ["image"]);
  assert.strictEqual(rule.condition.domainType, "firstParty");
});

test("domain=~x 生成 excludedInitiatorDomains 而非剥掉 ~", () => {
  const rule = convertNetworkRule("||ads.example.com^$domain=~safe.com");
  assert.deepStrictEqual(rule.condition.excludedInitiatorDomains, ["safe.com"]);
  assert.strictEqual(rule.condition.initiatorDomains, undefined);
});

test("正负域名并存整条丢弃（DNR 单条件无法表达）", () => {
  assert.strictEqual(convertNetworkRule("||ads.example.com^$domain=a.com|~b.com"), null);
});

test("未知 option 仍保守丢弃，不放宽语义", () => {
  assert.strictEqual(convertNetworkRule("||ads.example.com^$popup"), null);
  assert.strictEqual(convertNetworkRule("||ads.example.com^$redirect=noop.js"), null);
  assert.strictEqual(convertNetworkRule("||ads.example.com^$csp=script-src none"), null);
});

test("纯域名例外保持 kind=domain（空条件 allow 事故的回归）", () => {
  const rule = convertNetworkRule("@@||safe.example.com^");
  assert.strictEqual(rule.kind, "domain");
  assert.strictEqual(rule.domain, "safe.example.com");
  assert.strictEqual(rule.isException, true);
  // 除 requestDomains 写回外不应携带任何条件，否则会退化成"匹配一切"
  assert.deepStrictEqual(Object.keys(rule.condition), []);
});

test("urlFilter 字符集外的规则被拒绝，不产出非法 DNR 条件", () => {
  // 反斜杠/花括号为正则残留、||* 为左锚后跟通配，都曾导致整包 ruleset 被 Chrome 拒绝
  assert.strictEqual(convertNetworkRule("/ad\\d+\\.gif"), null);
  assert.strictEqual(convertNetworkRule("||x.com/tag{1,2}.js"), null);
  assert.strictEqual(convertNetworkRule("||*xav.*/guang/*.gif"), null);
});

// 社区列表里真实存在 `||allyes.^` / `||fpb1.chinacar.^`。
// 旧实现用 [a-z0-9.-]+ 抓域名，尾点被一起抓进去，生成 requestDomains
// ["allyes."]——Chrome 视尾点域名非法，整包 ruleset 被拒（拦截整体失效）。
test("尾点域名落到 urlFilter，不进 requestDomains", () => {
  for (const line of ["||allyes.^", "||fpb1.chinacar.^"]) {
    const rule = convertNetworkRule(line);
    assert.ok(rule, `${line} 不应被整条丢弃`);
    assert.strictEqual(rule.kind, "filter", `${line} 应作为 urlFilter 保留原语义`);
    assert.strictEqual(rule.condition.urlFilter, line);
    assert.strictEqual(rule.condition.requestDomains, undefined);
  }
});

test("正常域名仍走 requestDomains（含 IP）", () => {
  assert.strictEqual(convertNetworkRule("||allyes.com^").kind, "domain");
  assert.strictEqual(convertNetworkRule("||1.2.3.4^").domain, "1.2.3.4");
});

test("domain= 含非法域名整条丢弃，不静默收窄匹配面", () => {
  // 丢掉一个 initiatorDomains 会让规则从"仅 a.com"变成"全站生效"，
  // 所以非法项必须让整条规则作废，而不是被过滤掉。
  assert.strictEqual(convertNetworkRule("||x.com^$domain=a.com|bad."), null);
  assert.strictEqual(convertNetworkRule("||x.com^$to=a.com|.com"), null);
  // 合法项不受影响
  assert.deepStrictEqual(
    convertNetworkRule("||x.com^$domain=a.com|b.com").condition.initiatorDomains,
    ["a.com", "b.com"],
  );
});

// ---- cosmetic ----

test("procedural selector 被拒，普通 selector 通过", () => {
  assert.strictEqual(isPlainCssSelector("div:has-text(ad)"), false);
  assert.strictEqual(isPlainCssSelector(".ad-banner > div"), true);
  assert.strictEqual(isPlainCssSelector("a[href^='http']"), true);
});

test("convertCosmeticRule 解析定向与通用形式", () => {
  assert.deepStrictEqual(convertCosmeticRule("a.com,b.com##.ad"), {
    domains: ["a.com", "b.com"],
    selector: ".ad",
  });
  assert.deepStrictEqual(convertCosmeticRule("##.ad"), { domains: [], selector: ".ad" });
  assert.strictEqual(convertCosmeticRule("~a.com##.ad"), null);
});
