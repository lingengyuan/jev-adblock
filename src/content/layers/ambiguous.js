(globalThis.JevAd ??= {});

JevAd.createAmbiguousLayer = function createAmbiguousLayer(ctx) {
  const { SCAN_SELECTOR } = JevAd.constants;
  const { describeEl } = JevAd.text;
  const protect = JevAd.protect;

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 50 || rect.height < 20) return false;
    if (rect.width > window.innerWidth * 1.6) return false;
    return true;
  }

  function dedupeCandidates(items) {
    // 预计算面积，避免排序比较器内反复 getBoundingClientRect 触发布局刷新。
    for (const item of items) {
      const r = item.el.getBoundingClientRect();
      item.area = r.width * r.height;
    }
    items.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.area !== b.area) return a.area - b.area;
      return 0;
    });
    const accepted = [];
    for (const item of items) {
      // MAX_QUEUE(300) 只管 pending 队列，MAX_BATCH 只拆批，都不限制一次扫描
      // 能塞进多少候选。没有上限时，广告重的页面一次加载就能推进数百条，
      // 每条都是一次 API 计费，把全局小时配额吃光。
      if (accepted.length >= JevAd.constants.MAX_AMBIGUOUS_CANDIDATES) break;
      const overlaps = accepted.some(
        (a) => a.el.contains(item.el) || item.el.contains(a.el)
      );
      if (!overlaps) accepted.push(item);
    }
    return accepted;
  }

  function collect(root, out) {
    const nodes = [];
    if (root.nodeType === 1) nodes.push(root);
    if (root.querySelectorAll) nodes.push(...root.querySelectorAll(SCAN_SELECTOR));
    for (const el of nodes) {
      if (
        ctx.state.judged.has(el) ||
        ctx.state.queued.has(el)
      ) {
        continue;
      }
      if (el.closest("." + JevAd.constants.HIDDEN_CLASS)) continue;
      if (!isVisible(el)) continue;
      const rect = el.getBoundingClientRect();
      const vw = window.innerWidth || 0;
      const vh = window.innerHeight || 0;
      if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) {
        continue;
      }
      if (protect.hasProtectedContent(el, ctx.state.site)) continue;
      if (protect.looksLikeMainContent(el)) {
        ctx.log("overlay_skip", { reason: "main_content", el: describeEl(el) });
        continue;
      }
      const score = ctx.score.scoreCandidate(el, { aggressive: true });
      if (score <= 0) continue;
      out.push({ el, score });
    }
  }

  function applyResults(byKey, results) {
    for (const r of results) {
      if (r.kind === "overlay") continue;
      const item = byKey.get(r.key);
      if (!item) continue;
      const el = item.el;
      if (!el.isConnected) {
        ctx.log("judge_skip", { key: r.key, reason: "detached" });
        continue;
      }
      ctx.state.judged.add(el);
      const score = Number(item.payload.score) || 0;
      const disclose = r.disclosesAd === true;
      const source = item.payload.source || "";
      const adThr = ctx.state.settings.adThreshold;
      const main = Number(r.main) || 0;
      const ad = Number(r.ad) || 0;
      const mainGuard = ctx.state.settings.mainGuard;
      const shouldHide = ad >= adThr && main <= mainGuard;
      ctx.log("judge_result", {
        key: r.key,
        el: describeEl(el),
        source,
        ad: Number(ad.toFixed(3)),
        main: Number(main.toFixed(3)),
        score,
        adThr: Number(adThr.toFixed(2)),
        thr: Number(adThr.toFixed(2)),
        disclose,
        action: shouldHide ? "hide" : ad >= 0.5 ? "uncertain" : "keep",
      });
      const wasOptimistic = ctx.state.optimistic.has(el);
      if (wasOptimistic) ctx.state.optimistic.delete(el);
      if (shouldHide) {
        const reason =
          source === "detector" ? "jev-detector" : source === "label" ? "labeled+jev" : disclose ? "labeled+jev" : "jev";
        el.setAttribute("data-jev-ad", reason);
        if (!wasOptimistic) ctx.hide.hideEl(el, reason);
        ctx.state.stats.semantic += 1;
      } else {
        // Jev 判定非广告：恢复被乐观隐藏的元素。
        if (wasOptimistic) ctx.hide.restoreEl(el);
        if (ad >= 0.5) ctx.state.stats.uncertain += 1;
      }
    }
  }

  return { collect, dedupeCandidates, applyResults };
};
