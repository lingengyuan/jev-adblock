(globalThis.JevAd ??= {});

JevAd.constants = {
  HIDDEN_CLASS: "jev-ad-hidden",
  // 拆批大小。实测 Jev 的往返延迟几乎不随候选数增长：1 个 364ms、
  // 64 个 406ms（+12%），而 judge.js 的单次超时是 5s。所以放宽拆批几乎
  // 没有延迟代价，只是让一次请求覆盖更多候选。
  MAX_BATCH: 64,
  MAX_QUEUE: 2000,
  // 单次扫描 / 整页的 Jev 候选上限。
  //
  // 这些数字此前是为"省配额"设的（早期按调用计价，默认小时配额仅 1500）。
  // 现在 Jev 判断很廉价（批量近免费），配额不再是限制项——真正的约束只剩
  // 病态页面（无限滚动 / 广告农场，一页能产生数千候选）。
  // 因此阈值整体上调一个数量级：正常页面（几十~几百候选）完全不触发，
  // 闸门只在异常页面上兜底，避免把"上限"当成判断质量的代价。
  MAX_AMBIGUOUS_CANDIDATES: 600,
  // 帧级上限（内容脚本按帧独立运行）。跨帧总账在 SW 的标签页预算里。
  MAX_CANDIDATES_PER_FRAME: 1200,
  DEBOUNCE_MS: 900,
  SWEEP_MS: 4000,
  MAX_OVERLAY_BATCH: 120,
  MAX_HIDE_H: 1400,
  MAX_HIDE_W: 1400,
  MAX_CARD_H: 900,
  MAX_CARD_W: 900,
  DEFAULTS: { adThreshold: 0.75, mainGuard: 0.55, globalEnabled: true },
  SCAN_SELECTOR: "div,section,article,aside,li,span,a,iframe,ins",
  LABEL_CONTAINER_SELECTOR:
    "article,[role='article'],li,[data-testid='tweet'],[data-testid='cellInnerDiv'],.tweet,.post,.comment",
  MAX_JUDGE_FAILURES: 3,
  JUDGE_COOLDOWN_MS: 60000,
  BUDGET_COOLDOWN_MS: 3600000,
  // 全局小时配额。仅作病态页面（跨标签页的广告农场）的最终兜底；
  // 正常使用远达不到，达到后一小时内的新站点退回本地规则。
  DEFAULT_HOURLY_BUDGET: 30000,
};
