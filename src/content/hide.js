(globalThis.JevAd ??= {});

JevAd.createHide = function createHide(ctx) {
  const { HIDDEN_CLASS } = JevAd.constants;
  const { describeEl } = JevAd.text;
  const protect = JevAd.protect;

  function log(event, data) {
    ctx.log(event, data);
  }

  function notifyBadge() {
    if (window.top !== window) return;
    if (ctx.state.badgeTimer) return;
    ctx.state.badgeTimer = setTimeout(() => {
      ctx.state.badgeTimer = null;
      chrome.runtime
        .sendMessage({ type: "BADGE", count: ctx.state.hidden.size })
        .catch(() => {});
    }, 200);
  }

  function applyHide(el) {
    ctx.state.selfTouched.add(el);
    el.classList.add(HIDDEN_CLASS);
    if (!ctx.state.prevDisplay.has(el)) {
      ctx.state.prevDisplay.set(el, el.style.display);
    }
    el.style.setProperty("display", "none", "important");
    protect.invalidateBodyLen();
  }

  function shouldSkipHide(el, reason) {
    if (!el || el === document.body || el === document.documentElement) return true;
    // force（站点强规则）为确定性来源，直隐。
    if (reason === "force") return false;
    // 受保护内容（正文/登录/同意等）永不隐藏，即使乐观隐藏也不例外。
    if (protect.hasProtectedContent(el, ctx.state.site)) {
      log("hide_skip", { reason: "protected", el: describeEl(el) });
      return true;
    }
    // 乐观隐藏：允许大尺寸浮层（sticky/modal 本就可能很大）。
    if (reason === "optimistic") return false;
    // 反广告拦截墙天然是大尺寸浮层（"关闭拦截才能阅读"本就覆盖大片视口），
    // 与 overlay 同理跳过尺寸闸门——但受保护内容检查仍然保留在上面。
    if (reason === "anti-adblock") return false;
    if (protect.looksOversized(el) && reason !== "overlay") {
      log("hide_skip", { reason: "oversized", el: describeEl(el) });
      return true;
    }
    return false;
  }

  function hideEl(el, reason) {
    if (!el) return false;
    if (shouldSkipHide(el, reason || "rule")) return false;
    const first = !ctx.state.hidden.has(el);
    applyHide(el);
    if (first) {
      el.setAttribute("data-jev-ad", reason || "rule");
      ctx.state.hidden.add(el);
      notifyBadge();
      log("hide", { reason: reason || "rule", el: describeEl(el) });
    }
    return first;
  }

  function restoreEl(el) {
    if (!el || !ctx.state.hidden.has(el)) return false;
    ctx.state.selfTouched.add(el);
    ctx.state.hidden.delete(el);
    el.classList.remove(HIDDEN_CLASS);
    el.style.removeProperty("display");
    if (ctx.state.prevDisplay.has(el)) {
      const prev = ctx.state.prevDisplay.get(el);
      if (prev) el.style.display = prev;
      ctx.state.prevDisplay.delete(el);
    }
    el.removeAttribute("data-jev-ad");
    protect.invalidateBodyLen();
    notifyBadge();
    log("restore_el", { el: describeEl(el) });
    return true;
  }

  function reapplyHidden() {
    let re = 0;
    let dropped = 0;
    for (const el of ctx.state.hidden) {
      if (!el.isConnected) {
        ctx.state.hidden.delete(el);
        dropped += 1;
        continue;
      }
      if (!el.classList.contains(HIDDEN_CLASS) || el.style.getPropertyValue("display") !== "none") {
        applyHide(el);
        re += 1;
      }
    }
    if (re > 0) log("reapply_hidden", { count: re });
    if (dropped > 0) notifyBadge();
    return { re, dropped };
  }

  function restorePage() {
    const count = ctx.state.hidden.size;
    for (const el of ctx.state.hidden) {
      ctx.state.selfTouched.add(el);
      el.classList.remove(HIDDEN_CLASS);
      el.style.removeProperty("display");
      if (ctx.state.prevDisplay.has(el)) {
        const prev = ctx.state.prevDisplay.get(el);
        if (prev) el.style.display = prev;
        ctx.state.prevDisplay.delete(el);
      }
      el.removeAttribute("data-jev-ad");
    }
    ctx.state.hidden.clear();
    ctx.state.optimistic = new WeakSet();
    ctx.state.stats = { deterministic: 0, semantic: 0, uncertain: 0 };
    ctx.state.generation += 1;
    ctx.state.inFlight = null;
    ctx.state.judged = new WeakSet();
    ctx.state.pending.length = 0;
    ctx.state.queued.clear();
    ctx.state.addedRoots.clear();
    // 反拦截墙解锁过的滚动一并还原，否则「恢复本页」后页面仍锁着滚动。
    if (ctx.antiadblock && ctx.antiadblock.restoreScroll) ctx.antiadblock.restoreScroll();
    protect.invalidateBodyLen();
    log("restore", { count });
    notifyBadge();
    return count;
  }

  return { hideEl, restoreEl, reapplyHidden, restorePage, notifyBadge, shouldSkipHide };
};
