// scoreCandidate 的 aggressive 兜底回归。
//
// 背景：旧实现里 `region !== "content"` 的兜底分支把 `a,button` 和
// `own.length >= 20` 也算作命中条件，等价于"非正文区凡带链接或够长的块
// 一律 score 1"。后果是侧栏导航、页脚链接群被整批送进 Jev：既浪费调用
// （每个真实用户页面都会命中），又必然产生误判——e2e 里 #qq-sidebar
// （邮箱文件夹导航，8 个 href="#..." 锚点）被判 ad=0.87 → 隐藏。
//
// 收紧后只认真正的广告位痕迹：广告 <ins> 单元 / 站外 iframe / promo 文案。
// 下面既断言噪声被排除，也用对照用例证明装置仍能识别广告——否则
// "score 0" 可能只是元素压根没进评分路径，测试就变成了空转。
const { test } = require("node:test");
const assert = require("node:assert");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");

for (const rel of [
  "src/shared/constants.js",
  "src/shared/text.js",
  "src/content/protect.js",
  "src/content/score.js",
]) {
  require(path.join(ROOT, rel));
}

const JevAd = globalThis.JevAd;

function makeEl({ cls = "", id = "", text = "", ins = false, iframe = false, adClass = "" } = {}) {
  const classes = [cls, adClass].filter(Boolean).join(" ");
  const attrs = { class: classes, id };
  return {
    tagName: "DIV",
    innerText: text,
    textContent: text,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    hasAttribute: (k) => k in attrs && attrs[k] !== "",
    // regionOf 用这四组精确选择器判定区域，只有 aside 命中才是侧栏
    closest: (sel) => (sel === "aside,[role='complementary']" ? {} : null),
    querySelector: (sel) => {
      if (sel === "iframe,ins") return ins || iframe ? {} : null;
      if (sel === "a,button,[role='button']") return text.includes("链接") ? {} : null;
      return null;
    },
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({
      width: 300, height: 300, top: 0, left: 1000, right: 1300, bottom: 300,
    }),
  };
}

function scoreFor(el) {
  const ctx = { state: { site: {} } };
  const scorer = JevAd.createScore(ctx);
  return scorer.scoreCandidate(el, { aggressive: true });
}

// 还原 fixture 里 #qq-sidebar 的形状：侧栏、8 个站内锚点、一段说明文字，
// 无广告类名、无 promo 文案、无 iframe/ins。
const NAV_TEXT = "收件箱 1082 重要联系人 星标邮件 群邮件 已发送 草稿箱 已删除 垃圾箱 链接";

test("侧栏导航块不再因「带链接/够长」被兜底成 score 1", () => {
  const el = makeEl({
    cls: "qq-sidebar-menus ui-float-scroll-body sidebar-menus",
    id: "qq-sidebar",
    text: NAV_TEXT,
  });
  assert.strictEqual(
    scoreFor(el),
    0,
    "纯站内导航不应产生候选——旧实现给它 score 1，进而被送进 Jev 误判",
  );
});

test("兜底仍捕获侧栏里的广告 <ins> 单元", () => {
  const el = makeEl({ cls: "sidebar-box", id: "side-1", text: NAV_TEXT, ins: true });
  assert.strictEqual(scoreFor(el), 1, "ad <ins> 单元是真实广告位痕迹，应保留");
});

test("兜底仍捕获侧栏里的站外 iframe", () => {
  const el = makeEl({ cls: "sidebar-box", id: "side-2", text: NAV_TEXT, iframe: true });
  assert.strictEqual(scoreFor(el), 1, "站外 iframe 同为真实广告位痕迹，应保留");
});

// 对照：证明装置能打分，上面几个 0 不是因为元素没进评分路径
test("对照：侧栏 promo 文案仍得高分", () => {
  const el = makeEl({ cls: "sidebar-box", id: "side-3", text: "限时优惠券 打开App领取" });
  assert.ok(scoreFor(el) >= 2, "含 promo 信号的侧栏块必须仍被识别");
});

test("对照：广告类名仍得高分", () => {
  const el = makeEl({ cls: "sidebar-box", id: "side-4", text: NAV_TEXT, adClass: "ad-slot" });
  assert.ok(scoreFor(el) >= 2, "命中 AD_CLASS 的元素必须仍被识别");
});
