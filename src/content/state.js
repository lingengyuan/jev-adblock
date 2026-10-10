(globalThis.JevAd ??= {});

function createState() {
  return {
    settings: { ...JevAd.constants.DEFAULTS },
    tabEnabled: true,
    inFlight: null,
    disposed: false,
    hasApiKey: false,
    generation: 0,
    judged: new WeakSet(),
    // 本插件 hide/restore 写过的元素：observer 回调里跳过其属性变动，
    // 防止"恢复非广告元素 → observer → 重判 → 再隐藏"的自触发闪烁循环。
    // 写入于每次 DOM 写之前，在 scheduleScan 处理前与 sweep 里清空（窗口 ≤4s）。
    selfTouched: new Set(),
    queued: new Map(),
    hidden: new Set(),
    optimistic: new WeakSet(),
    prevDisplay: new WeakMap(),
    pending: [],
    addedRoots: new Set(),
    // 本页已送 Jev 的候选总数（跨扫描累计）。全局小时配额是"所有标签页共享"的，
    // 单个页面没有闸门就能把配额吃光——广告重的页面或持续滚动的无限流站点
    // 一次访问就能消耗掉整小时预算，之后全部站点回退本地规则。
    candidatesSent: 0,
    uidSeq: 0,
    stats: { deterministic: 0, semantic: 0, uncertain: 0 },
    debounceTimer: null,
    badgeTimer: null,
    site: null,
    customSelectors: [],
    allowlist: new Set(),
    judgeFailures: 0,
    judgeCooldownUntil: 0,
  };
}

JevAd.createState = createState;
