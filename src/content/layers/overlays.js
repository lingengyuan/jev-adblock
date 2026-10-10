(globalThis.JevAd ??= {});

JevAd.createOverlaysLayer = function createOverlaysLayer(ctx) {
  const { extractText, describeEl } = JevAd.text;
  const { MAX_OVERLAY_BATCH } = JevAd.constants;
  const protect = JevAd.protect;

  function selector() {
    const site = ctx.state.site;
    return (site && site.overlaySelectors ? site.overlaySelectors : []).join(",");
  }

  function overlayGeometry(el) {
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const cs = getComputedStyle(el);
    const visW = Math.max(0, Math.min(rect.right, vw) - Math.max(rect.left, 0));
    const visH = Math.max(0, Math.min(rect.bottom, vh) - Math.max(rect.top, 0));
    const covers = vw * vh > 0 ? Math.min(1, (visW * visH) / (vw * vh)) : 0;
    let edge = null;
    const near = 8;
    if (rect.top <= near && rect.height < vh * 0.92) edge = "top";
    else if (rect.bottom >= vh - near && rect.height < vh * 0.92) edge = "bottom";
    else if (rect.left <= near && rect.width < vw * 0.92) edge = "left";
    else if (rect.right >= vw - near && rect.width < vw * 0.92) edge = "right";
    let topLayer = false;
    const cx = Math.min(vw - 1, Math.max(0, rect.left + rect.width / 2));
    const cy = Math.min(vh - 1, Math.max(0, rect.top + rect.height / 2));
    try {
      const hit = document.elementFromPoint(cx, cy);
      topLayer = Boolean(hit && (hit === el || el.contains(hit)));
    } catch {
      topLayer = false;
    }
    return {
      position: cs.position,
      covers: Number(covers.toFixed(3)),
      edge,
      z: Number.parseInt(cs.zIndex, 10) || 0,
      topLayer,
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    };
  }

  function overlaySignals(el) {
    const t = extractText(el);
    const hasClose = Boolean(
      el.querySelector(
        "[aria-label*='close' i],[aria-label*='关闭' i],.close,.btn-close,[data-dismiss],[class*='close' i]"
      )
    ) || /\b(close|dismiss|关闭|✕|×)\b/i.test(t.slice(0, 120));
    const hasVideo = Boolean(
      el.querySelector("video,iframe[src*='youtube'],iframe[src*='player'],iframe[src*='bilibili']")
    );
    const hasForm = Boolean(el.querySelector("form,input,textarea,select"));
    return { hasClose, hasVideo, hasForm };
  }

  function collect(root, out) {
    const sel = selector();
    if (!sel) return;
    if (!root || (root.nodeType !== 1 && root.nodeType !== 9)) return;
    const nodes = [];
    try {
      if (root.nodeType === 1 && root.matches && root.matches(sel)) nodes.push(root);
      if (root.querySelectorAll) nodes.push(...root.querySelectorAll(sel));
    } catch {
      return;
    }
    for (const el of nodes) {
      if (
        ctx.state.judged.has(el) ||
        ctx.state.queued.has(el)
      ) {
        continue;
      }
      if (ctx.state.hidden.has(el) || el.closest("." + JevAd.constants.HIDDEN_CLASS)) continue;
      if (el === document.body || el === document.documentElement) continue;
      if (el.closest("video,audio")) continue;
      if (protect.hasProtectedContent(el, ctx.state.site)) continue;
      if (protect.looksLikeMainContent(el)) {
        ctx.log("overlay_skip", { reason: "main_content", el: describeEl(el) });
        continue;
      }
      const rect = el.getBoundingClientRect();
      if (rect.width < 80 || rect.height < 40) continue;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) continue;
      const geometry = overlayGeometry(el);
      const isDialog =
        el.getAttribute("role") === "dialog" ||
        el.getAttribute("role") === "alertdialog" ||
        el.getAttribute("aria-modal") === "true";
      const isFixed = geometry.position === "fixed" || geometry.position === "sticky";
      const eligible = isDialog || isFixed || geometry.edge || geometry.covers >= 0.18;
      if (!eligible) continue;
      const signals = overlaySignals(el);
      const score =
        20 +
        (isDialog ? 8 : 0) +
        (isFixed ? 6 : 0) +
        (geometry.edge ? 4 : 0) +
        geometry.covers * 10 +
        Math.min(geometry.z, 1000) * 0.001;
      out.push({ el, score, geometry, signals });
      if (out.length >= MAX_OVERLAY_BATCH) break;
    }
  }

  function shouldHideOverlay(r, geometry, signals, el) {
    const blocks = Number(r.blocks) || 0;
    const promo = Number(r.promo) || 0;
    const necessary = Number(r.necessary) || 0;
    const main = Number(r.main) || 0;
    if (necessary >= 0.55) return false;
    if (main >= 0.55) return false;
    if (el && protect.looksLikeMainContent(el)) return false;
    if (el && protect.hasProtectedContent(el, ctx.state.site)) return false;
    if (signals && signals.hasVideo && geometry && geometry.covers > 0.75 && !r.disclosesAd) {
      return false;
    }
    if (
      geometry &&
      geometry.covers > 0.9 &&
      signals &&
      (signals.hasVideo || signals.hasForm) &&
      promo < 0.75
    ) {
      return false;
    }
    const edgeCase = Boolean(geometry && geometry.edge) && promo >= 0.65;
    const coverCase = geometry && geometry.covers >= 0.4 && blocks >= 0.6 && promo >= 0.65;
    const strong =
      geometry && geometry.covers >= 0.75 && blocks >= 0.75 && promo >= 0.5 && necessary < 0.4;
    const detectorDisclose = Boolean(r.disclosesAd) && promo >= 0.7 && main < 0.45;
    return edgeCase || coverCase || strong || detectorDisclose;
  }

  function applyResults(byKey, results) {
    for (const r of results) {
      if (r.kind !== "overlay") continue;
      const item = byKey.get(r.key);
      if (!item) continue;
      const el = item.el;
      if (!el.isConnected) continue;
      ctx.state.judged.add(el);
      const geometry = item.payload.geometry || {};
      const signals = item.payload.signals || {};
      const shouldHide = shouldHideOverlay(r, geometry, signals, el);
      const wasOptimistic = ctx.state.optimistic.has(el);
      if (wasOptimistic) ctx.state.optimistic.delete(el);
      ctx.log("judge_result", {
        key: r.key,
        kind: "overlay",
        el: describeEl(el),
        blocks: Number((r.blocks || 0).toFixed(3)),
        promo: Number((r.promo || 0).toFixed(3)),
        necessary: Number((r.necessary || 0).toFixed(3)),
        main: Number((r.main || 0).toFixed(3)),
        covers: geometry.covers,
        edge: geometry.edge,
        action: shouldHide ? "hide" : r.promo >= 0.5 ? "uncertain" : "keep",
      });
      if (shouldHide) {
        el.setAttribute("data-jev-ad", "overlay");
        if (!wasOptimistic) ctx.hide.hideEl(el, "overlay");
        ctx.state.stats.semantic += 1;
      } else if (wasOptimistic) {
        ctx.hide.restoreEl(el);
        if (r.promo >= 0.5) ctx.state.stats.uncertain += 1;
      } else if (r.promo >= 0.5) {
        ctx.state.stats.uncertain += 1;
      }
    }
  }

  return { collect, applyResults, shouldHideOverlay };
};
