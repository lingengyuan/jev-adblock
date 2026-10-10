(globalThis.JevAd ??= {});

JevAd.constants = {
  HIDDEN_CLASS: "jev-ad-hidden",
  MAX_BATCH: 32,
  MAX_QUEUE: 300,
  // 单次扫描 / 整页的 Jev 候选上限。MAX_BATCH 只是拆批、MAX_QUEUE 只管瞬时队列，
  // 都不限制"一页总共能问多少次"；广告重的页面一次加载就能产生数百候选，
  // 把全局小时配额（默认 1500）吃掉，之后所有站点回退本地规则。
  MAX_AMBIGUOUS_CANDIDATES: 60,
  // 帧级上限（内容脚本按帧独立运行）。跨帧总账在 SW 的标签页预算里。
  MAX_CANDIDATES_PER_FRAME: 150,
  DEBOUNCE_MS: 900,
  SWEEP_MS: 4000,
  MAX_OVERLAY_BATCH: 12,
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
  DEFAULT_HOURLY_BUDGET: 1500,
};
