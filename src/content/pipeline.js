(globalThis.JevAd ??= {});

JevAd.createPipeline = function createPipeline(ctx) {
  const { extractText, extractHrefs, extractIframeSrc, regionOf, describeEl } = JevAd.text;

  function isEnabled() {
    return (
      ctx.state.settings.globalEnabled &&
      ctx.state.tabEnabled &&
      !isDomainAllowed()
    );
  }

  function isDomainAllowed() {
    const hostname = location.hostname;
    if (!hostname) return false;
    for (const domain of ctx.state.allowlist) {
      if (!domain) continue;
      if (hostname === domain || hostname.endsWith("." + domain)) return true;
    }
    return false;
  }

  function useJev() {
    return Boolean(ctx.state.hasApiKey) && !ctx.state.disposed;
  }

  function enqueue(el, opts) {
    const {
      disclosesAd = false,
      score = null,
      kind = "inline",
      geometry = null,
      signals = null,
      source = "",
      optimistic = false,
    } = opts || {};
    const s = ctx.state;
    if (s.disposed || s.pending.length >= JevAd.constants.MAX_QUEUE) return false;
    if (s.queued.has(el)) return false;
    // 帧级总量闸门。Jev 判断廉价，这个上限只需挡病态页面（无限滚动 /
    // 广告农场，一帧能产生上千候选）；正常页面远达不到。内容脚本按帧独立
    // 运行，所以这里是"每帧"而不是"每页"——跨帧的总账由 SW 的标签页预算兜底。
    // 超出后不再新增 Jev 候选：确定性来源退回本地规则直隐，
    // 低置信候选直接放弃——它们本来就只有形状证据。
    if (s.candidatesSent >= JevAd.constants.MAX_CANDIDATES_PER_FRAME) {
      if (source === "detector" || source === "label") {
        s.judged.add(el);
        const reason = source === "label" ? "labeled" : "rule";
        el.setAttribute("data-jev-ad", reason);
        if (ctx.hide.hideEl(el, reason)) s.stats.deterministic += 1;
      }
      ctx.log("frame_cap_skip", { el: describeEl(el), source, sent: s.candidatesSent });
      return false;
    }
    const uid = ++s.uidSeq;
    s.queued.set(el, uid);
    const rect = el.getBoundingClientRect();
    const classes = String(el.getAttribute("class") || "").slice(0, 200);
    const elementId = String(el.getAttribute("id") || "").slice(0, 100);
    const payload = {
      key: String(uid),
      kind,
      tag: el.tagName.toLowerCase(),
      text: extractText(el, 240),
      classes,
      elementId,
      classAdMarker: JevAd.text.AD_CLASS.test(classes),
      idAdMarker: JevAd.text.AD_CLASS.test(elementId),
      region: regionOf(el),
      size: { w: Math.round(rect.width), h: Math.round(rect.height) },
      hrefs: extractHrefs(el),
      iframeSrc: extractIframeSrc(el),
      disclosesAd: Boolean(disclosesAd),
      score,
      geometry,
      signals,
      source,
    };
    const item = { uid, el, payload, optimistic };
    if (optimistic) {
      s.optimistic.add(el);
      ctx.hide.hideEl(el, "optimistic");
    }
    s.pending.push(item);
    s.candidatesSent += 1;
    ctx.log("enqueue", {
      key: payload.key,
      kind,
      source,
      el: describeEl(el),
      score,
      disclosesAd: Boolean(disclosesAd),
      optimistic,
      geometry: geometry
        ? {
            position: geometry.position,
            covers: geometry.covers,
            edge: geometry.edge,
            topLayer: geometry.topLayer,
          }
        : null,
      text: String(payload.text).slice(0, 80),
    });
    return true;
  }

  function processSubtree(root) {
    if (!isEnabled() || !root) return;
    JevAd.protect.beginScan();

    // 反广告拦截墙最先处理，且不经 Jev：纯墙（无推广话术）Jev 判 keep——
    // 实测 blocks 0.99 但 promo 仅 0.25，而三个隐藏分支都要求 promo ≥ 0.5
    // （见 layers/antiadblock.js 顶部注释）。
    // 放在最前还有一层原因：墙的文案会被后续层的乐观隐藏当成普通候选，
    // 先由本层确定性标记后，后续层读到 judged 就不会再动它。
    if (ctx.antiadblock) ctx.antiadblock.apply(root);

    const jev = useJev();
    if (jev) {
      const overlayHits = [];
      ctx.overlays.collect(root, overlayHits);
      for (const item of ctx.ambiguous.dedupeCandidates(overlayHits)) {
        enqueue(item.el, {
          kind: "overlay",
          score: item.score,
          geometry: item.geometry,
          signals: item.signals,
          optimistic: true,
        });
      }
    }

    ctx.rules.apply(root);
    const orphans = ctx.labels.apply(root);
    for (const target of orphans) {
      if (jev) {
        enqueue(target, { disclosesAd: true, score: 7, source: "label", optimistic: true });
      } else if (!ctx.state.judged.has(target)) {
        ctx.state.judged.add(target);
        if (ctx.hide.hideEl(target, "labeled")) ctx.state.stats.deterministic += 1;
      }
    }

    if (jev) {
      const ambiguous = [];
      ctx.ambiguous.collect(root, ambiguous);
      for (const { el, score } of ctx.ambiguous.dedupeCandidates(ambiguous)) {
        enqueue(el, { score });
      }
    }
    flush();
  }

  function releaseOptimistic(batch) {
    for (const item of batch) {
      const source = item.payload.source;
      if (source === "detector" || source === "label") continue;
      if (ctx.state.optimistic.has(item.el)) {
        ctx.state.optimistic.delete(item.el);
        ctx.hide.restoreEl(item.el);
      }
    }
  }

  function applyFallback(items) {
    const s = ctx.state;
    for (const item of items) {
      if (s.queued.get(item.el) === item.uid) s.queued.delete(item.el);
      if (!item.el.isConnected || s.judged.has(item.el)) continue;
      const payload = item.payload;
      const source = payload.source || "";
      if (source !== "detector" && source !== "label") continue;
      s.judged.add(item.el);
      const wasOptimistic = ctx.state.optimistic.has(item.el);
      if (wasOptimistic) ctx.state.optimistic.delete(item.el);
      const reason = source === "label" ? "labeled" : "rule";
      item.el.setAttribute("data-jev-ad", reason);
      if (wasOptimistic) {
        ctx.state.stats.deterministic += 1;
      } else if (ctx.hide.hideEl(item.el, reason)) {
        ctx.state.stats.deterministic += 1;
      }
      ctx.log("judge_result", {
        key: payload.key,
        el: JevAd.text.describeEl(item.el),
        source,
        action: "hide",
        mode: "fallback",
      });
    }
  }

  async function flush() {
    const s = ctx.state;
    if (!isEnabled() || s.disposed || s.inFlight !== null || s.pending.length === 0) return;
    if (!s.hasApiKey) {
      applyFallback(s.pending.splice(0, s.pending.length));
      return;
    }
    if (Date.now() < s.judgeCooldownUntil) {
      applyFallback(s.pending.splice(0, s.pending.length));
      return;
    }
    const batch = s.pending.splice(0, JevAd.constants.MAX_BATCH);
    const generation = s.generation;
    s.inFlight = generation;
    ctx.log("judge_request", {
      count: batch.length,
      keys: batch.map((c) => c.payload.key),
    });
    let transient = false;
    try {
      let timer;
      const res = await Promise.race([
        chrome.runtime.sendMessage({
          type: "JUDGE",
          candidates: batch.map((c) => c.payload),
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("判断请求超时")), 20000);
        }),
      ]).finally(() => clearTimeout(timer));
      if (generation !== s.generation || !isEnabled()) {
        ctx.log("judge_skip", { reason: "stale_request" });
        releaseOptimistic(batch);
        return;
      }
      if (!res || !res.ok) {
        const code = res && res.code ? res.code : "NO_RESPONSE";
        ctx.log("judge_error", { code, message: res && res.message });
        console.warn("[jev-ad]", res && res.message ? res.message : "判断请求失败");
        if (code === "NO_KEY") {
          s.hasApiKey = false;
          applyFallback(batch.concat(s.pending.splice(0)));
          return;
        }
        if (code === "AUTH" || code === "BAD_RESPONSE") {
          s.disposed = true;
          applyFallback(batch.concat(s.pending.splice(0)));
          return;
        }
        transient = true;
        handleTransientFailure(batch, code);
        return;
      }
      s.judgeFailures = 0;
      if (res.usage) ctx.log("judge_usage", res.usage);
      try {
        const byKey = new Map(batch.map((c) => [c.payload.key, c]));
        ctx.overlays.applyResults(byKey, res.results);
        ctx.ambiguous.applyResults(byKey, res.results);
      } catch (err) {
        ctx.log("judge_exception", { message: String(err && err.message) });
      }
    } catch (err) {
      ctx.log("judge_exception", { message: String(err && err.message) });
      console.warn("[jev-ad] 消息通信失败", err);
      transient = true;
      handleTransientFailure(batch, "EXCEPTION");
    } finally {
      for (const item of batch) {
        if (s.queued.get(item.el) === item.uid) s.queued.delete(item.el);
      }
      if (s.inFlight === generation) {
        s.inFlight = null;
        if (!transient && s.pending.length > 0 && isEnabled()) flush();
      }
    }
  }

  function handleTransientFailure(batch, code) {
    const s = ctx.state;
    s.judgeFailures += 1;
    // TAB_BUDGET 是本页帧叠加超限：与其他瞬态失败同样退避，
    // 但不等同全局配额耗尽（那是整小时冷却），只按普通失败累计。
    const cooldown =
      code === "BUDGET"
        ? JevAd.constants.BUDGET_COOLDOWN_MS
        : s.judgeFailures >= JevAd.constants.MAX_JUDGE_FAILURES
          ? JevAd.constants.JUDGE_COOLDOWN_MS
          : 0;
    if (cooldown > 0) {
      s.judgeCooldownUntil = Date.now() + cooldown;
      ctx.log("judge_cooldown", {
        until: s.judgeCooldownUntil,
        failures: s.judgeFailures,
        code,
      });
    }
    releaseOptimistic(batch);
    applyFallback(batch.concat(s.pending.splice(0)));
  }

  function scheduleScan() {
    if (!isEnabled()) return;
    if (ctx.state.debounceTimer) clearTimeout(ctx.state.debounceTimer);
    ctx.state.debounceTimer = setTimeout(() => {
      ctx.state.debounceTimer = null;
      const roots = [...ctx.state.addedRoots];
      ctx.state.addedRoots.clear();
      ctx.log("mutation_scan", { roots: roots.length });
      for (const root of roots) {
        if (root.isConnected) processSubtree(root);
      }
      flush();
    }, JevAd.constants.DEBOUNCE_MS);
  }

  return { isEnabled, isDomainAllowed, enqueue, processSubtree, flush, scheduleScan };
};
