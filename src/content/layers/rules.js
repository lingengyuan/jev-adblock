(globalThis.JevAd ??= {});

JevAd.createRulesLayer = function createRulesLayer(ctx) {
  const protect = JevAd.protect;
  const { MAX_HIDE_H, MAX_HIDE_W, SCAN_SELECTOR } = JevAd.constants;

  function detectorSelectors() {
    const site = ctx.state.site;
    return ((site && site.detectors) || []).filter(Boolean);
  }

  // 自定义选择器与站点 forceDetectors 同属"确定性来源"：用户在选项里显式写了
  // 要隐藏什么，就不该再交 Jev 复核、更不能被判非广告后恢复——否则用户输入
  // 的选择器会被 LLM 推翻。二者合并为一段"强制"选择器。
  function forceSelectors() {
    const site = ctx.state.site;
    const force = (site && site.forceDetectors) || [];
    const custom = ctx.state.customSelectors || [];
    return [...force, ...custom].filter(Boolean);
  }

  function useJev() {
    return Boolean(ctx.state.hasApiKey) && !ctx.state.disposed;
  }

  function isForce(el, fsegs) {
    for (const sel of fsegs) {
      try {
        if (el.matches(sel)) return true;
      } catch {}
    }
    return false;
  }

  // 社区定向 cosmetic 已迁至 early.js（document_start CSS 注入），
  // 此处只剩站点 detectors / forceDetectors / 自定义选择器。
  function collect(root, out) {
    const fsegs = forceSelectors();
    const raw = [];
    const seen0 = new Set();
    // 逐条查询，不拼成一个大选择器：用户自定义选择器可能是无效 CSS，
    // 一旦拼在一起，那一条语法错误会让整段 querySelectorAll 抛错，
    // 连累站点 detectors 一起失效。
    for (const sel of [...detectorSelectors(), ...fsegs]) {
      const push = (el) => {
        if (seen0.has(el)) return;
        seen0.add(el);
        raw.push(el);
      };
      try {
        if (root.nodeType === 1 && root.matches(sel)) push(root);
        if (root.querySelectorAll) for (const el of root.querySelectorAll(sel)) push(el);
      } catch {}
    }
    const seen = new Set();
    for (const el of raw) {
      if (seen.has(el)) continue;
      seen.add(el);
      const force = isForce(el, fsegs);
      if (!force) {
        if (protect.hasProtectedContent(el, ctx.state.site)) continue;
        const r = el.getBoundingClientRect();
        if (r.height > MAX_HIDE_H || r.width > MAX_HIDE_W) continue;
        if (r.height > 0 && r.width > 0 && el.querySelectorAll(SCAN_SELECTOR).length >= 6 && r.height >= 600) {
          continue;
        }
      }
      out.push(el);
    }
  }

  function apply(root) {
    const hits = [];
    collect(root, hits);
    const fsegs = forceSelectors();
    if (hits.length) ctx.log("detector_hits", { count: hits.length, mode: useJev() ? "jev" : "fallback" });
    for (const el of hits) {
      if (ctx.state.judged.has(el)) continue;
      if (ctx.state.queued.has(el)) continue;
      if (el.closest("." + JevAd.constants.HIDDEN_CLASS)) continue;
      if (el === document.body || el === document.documentElement) continue;
      const force = isForce(el, fsegs);
      if (useJev() && !force) {
        // 强信号广告位（data-tu / data-adsite / unionad / float-ad 等站内
        // 广告 slot 命名）曾经在这里直接隐藏、不问 Jev——那是为省配额的
        // 优化。Jev 判断廉价后不再需要直隐：省下的是一次近免费的往返，
        // 代价却是这类选择器可能命中"名字像广告位但实为站点功能"的元素
        // （站内 union 导航、float 工具条），而它们只有 Jev 能分辨。
        //
        // 但强信号本身不能丢：data-tu/data-adsite 是属性，AD_CLASS 只看
        // class/id，payload 里没有对应字段；float-ad/topbar-ad 等也大多不在
        // AD_CLASS 内。若照普通 detector 原样入队，等于把这些证据降级成
        // 弱候选。所以命中强信号时置 disclosesAd，由 Jev 的 ad 问题明确
        // 采信该证据后再判——判断权交出去，证据不交出去。
        const cls = String(el.getAttribute("class") || "");
        const id = String(el.getAttribute("id") || "");
        const strongSlot =
          el.hasAttribute("data-tu") ||
          el.hasAttribute("data-adsite") ||
          /float-ad|topbar-ad|unionad|fallback-ad|lefttip|topbe|bottom-banner|navrecommend|elevator-ad|rightTip|game-box|mingzhan|puzzle|siye|js-site-slot|coolsitead|ad-icon/i.test(
            `${id} ${cls}`
          );
        ctx.pipeline.enqueue(el, {
          score: strongSlot ? 9 : 8,
          kind: "inline",
          source: "detector",
          disclosesAd: strongSlot,
          optimistic: true,
        });
        continue;
      }
      ctx.state.judged.add(el);
      if (ctx.hide.hideEl(el, force ? "force" : "rule")) {
        ctx.state.stats.deterministic += 1;
      }
    }
  }

  return { apply, collect };
};
