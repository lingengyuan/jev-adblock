const { test } = require("node:test");
const assert = require("node:assert");

require("../../src/shared/log-format.js");

const { jevFormatLog, jevFmtTime } = globalThis;

test("formatLog 站点事件", () => {
  assert.strictEqual(
    jevFormatLog({ event: "site", data: { name: "zhihu" } }),
    "站点 zhihu",
  );
});

test("formatLog 隐藏事件带原因", () => {
  const line = jevFormatLog({
    event: "hide",
    data: { reason: "rule", el: "div.ad-slot" },
  });
  assert.ok(line.includes("隐藏"), `应包含"隐藏": ${line}`);
  assert.ok(line.includes("规则"), `应包含"规则": ${line}`);
});

test("formatLog 浮层结果", () => {
  const line = jevFormatLog({
    event: "judge_result",
    data: {
      kind: "overlay",
      el: "div.modal",
      blocks: 0.9,
      promo: 0.8,
      main: 0.1,
      action: "hide",
    },
  });
  assert.ok(line.includes("浮层"), `应包含"浮层": ${line}`);
  assert.ok(line.includes("隐藏"), `应包含"隐藏": ${line}`);
});

test("formatLog 跳过 bg_judge 等噪音事件", () => {
  assert.strictEqual(jevFormatLog({ event: "bg_judge", data: {} }), "");
  assert.strictEqual(jevFormatLog({ event: "judge_usage", data: {} }), "");
  assert.strictEqual(jevFormatLog({ event: "mutation_scan", data: {} }), "");
});

test("formatLog 未知事件回退到键值摘要", () => {
  const line = jevFormatLog({ event: "custom", data: { a: 1, b: "x" } });
  assert.ok(line.startsWith("custom"), `应以事件名开头: ${line}`);
});

test("jevFmtTime 输出 HH:MM:SS", () => {
  assert.match(jevFmtTime(0), /^\d{2}:\d{2}:\d{2}$/);
});
