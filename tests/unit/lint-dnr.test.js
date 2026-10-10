const { test } = require("node:test");
const assert = require("node:assert");

const { lintRuleset } = require("../../scripts/lint-dnr.js");

const block = (id, condition, extra = {}) => ({
  id,
  priority: 1,
  action: { type: "block" },
  condition,
  ...extra,
});

test("合法规则集无告警", () => {
  const rules = [
    block(1, { requestDomains: ["ads.example.com"] }),
    block(2, { urlFilter: "||ads.example.com^", resourceTypes: ["script", "image"] }),
    block(3, { urlFilter: "||x.com^", domainType: "thirdParty" }),
    {
      id: 4,
      priority: 2,
      action: { type: "allow" },
      condition: { urlFilter: "||safe.example.com^" },
    },
  ];
  assert.deepStrictEqual(lintRuleset(rules, "t"), []);
});

test("重复 id 被拦下", () => {
  const problems = lintRuleset([block(7, { urlFilter: "a" }), block(7, { urlFilter: "b" })], "t");
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /重复/);
});

test("非正整数 id 被拦下", () => {
  assert.match(lintRuleset([block(0, { urlFilter: "a" })], "t")[0], /id/);
  assert.match(lintRuleset([block(1.5, { urlFilter: "a" })], "t")[0], /id/);
});

// 静态规则集里任何一条不合法都会让整包被 Chrome 拒绝——
// 这条断言的是"错误会指到具体规则"，而不是静默通过。
test("urlFilter 字符集外字符被拦下并指名规则", () => {
  const problems = lintRuleset([block(1, { urlFilter: "a" }), block(42, { urlFilter: "a b" })], "t");
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /id=42/);
  assert.match(problems[0], /urlFilter/);
});

test("urlFilter 反斜杠/花括号被拦下", () => {
  assert.match(lintRuleset([block(1, { urlFilter: "/ad\\d+" })], "t")[0], /urlFilter/);
  assert.match(lintRuleset([block(1, { urlFilter: "tag{1,2}.js" })], "t")[0], /urlFilter/);
});

test("urlFilter 以 ||* 开头被拦下", () => {
  assert.match(lintRuleset([block(1, { urlFilter: "||*xav.*/x.gif" })], "t")[0], /\|\|\*/);
});

test("allow + 空 condition 被拦下（等于放行一切）", () => {
  const problems = lintRuleset([{ id: 1, action: { type: "allow" }, condition: {} }], "t");
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /放行/);
});

test("requestDomains 尾点/通配/带路径被拦下", () => {
  assert.match(lintRuleset([block(1, { requestDomains: ["allyes."] })], "t")[0], /点/);
  assert.match(lintRuleset([block(1, { requestDomains: ["*.x.com"] })], "t")[0], /通配/);
  assert.match(lintRuleset([block(1, { requestDomains: ["x.com/path"] })], "t")[0], /路径/);
  assert.match(
    lintRuleset([block(1, { initiatorDomains: ["https://x.com"] })], "t")[0],
    /scheme/,
  );
});

test("domainType / resourceTypes 取值被校验", () => {
  assert.match(lintRuleset([block(1, { domainType: "sameParty" })], "t")[0], /domainType/);
  assert.match(
    lintRuleset([block(1, { urlFilter: "a", resourceTypes: ["font", "bogus"] })], "t")[0],
    /未知类型/,
  );
  assert.match(
    lintRuleset([block(1, { urlFilter: "a", resourceTypes: [] })], "t")[0],
    /空数组/,
  );
});

test("静态规则里的 tabIds 被拦下（session-only）", () => {
  assert.match(lintRuleset([block(1, { urlFilter: "a", tabIds: [1] })], "t")[0], /tabIds/);
});

test("urlFilter 与 regexFilter 不能共存", () => {
  const problems = lintRuleset([block(1, { urlFilter: "a", regexFilter: "^a$" })], "t");
  assert.match(problems[0], /同时出现/);
});

test("顶层不是数组时直接报错", () => {
  assert.deepStrictEqual(lintRuleset({}, "t"), ["t: 顶层必须是数组"]);
});
