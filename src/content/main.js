(() => {
  if (globalThis.__jevAdBlockLoaded) return;
  globalThis.__jevAdBlockLoaded = true;

  const state = JevAd.createState();
  const logBuffer = [];
  let logTimer = 0;
  function flushLogs() {
    logTimer = 0;
    if (!logBuffer.length) return;
    const entries = logBuffer.splice(0, logBuffer.length);
    try {
      chrome.runtime.sendMessage({ type: "LOG_BATCH", entries }).catch(() => {});
    } catch {}
  }
  const ctx = {
    state,
    log(event, data) {
      const entry = { ts: Date.now(), event, data: data || {} };
      try {
        console.debug("[jev-ad]", event, data || {});
      } catch {}
      logBuffer.push(entry);
      if (!logTimer) logTimer = setTimeout(flushLogs, 200);
    },
  };
  window.addEventListener("pagehide", flushLogs);
  ctx.hide = JevAd.createHide(ctx);
  ctx.score = JevAd.createScore(ctx);
  ctx.rules = JevAd.createRulesLayer(ctx);
  ctx.labels = JevAd.createLabelsLayer(ctx);
  ctx.overlays = JevAd.createOverlaysLayer(ctx);
  ctx.ambiguous = JevAd.createAmbiguousLayer(ctx);
  ctx.antiadblock = JevAd.createAntiAdblockLayer(ctx);
  ctx.pipeline = JevAd.createPipeline(ctx);

  function resolveSite() {
    state.site = JevAd.resolveSite(location.hostname);
    ctx.log("site", { name: state.site.name, host: location.hostname });
  }

  async function loadSettings() {
    const tabState = await chrome.runtime
      .sendMessage({ type: "GET_TAB_ENABLED" })
      .catch(() => null);
    const stored = await chrome.storage.local.get([
      "adThreshold",
      "mainGuard",
      "globalEnabled",
      "apiKey",
      "customSelectors",
      "allowlist",
      "hourlyBudget",
    ]);
    const { DEFAULTS } = JevAd.constants;
    state.settings.adThreshold =
      typeof stored.adThreshold === "number" ? stored.adThreshold : DEFAULTS.adThreshold;
    state.settings.mainGuard =
      typeof stored.mainGuard === "number" ? stored.mainGuard : DEFAULTS.mainGuard;
    state.settings.globalEnabled =
      typeof stored.globalEnabled === "boolean" ? stored.globalEnabled : DEFAULTS.globalEnabled;
    state.tabEnabled = !tabState || typeof tabState.enabled !== "boolean" ? true : tabState.enabled;
    state.hasApiKey = Boolean(stored.apiKey);
    state.customSelectors = Array.isArray(stored.customSelectors)
      ? stored.customSelectors
      : typeof stored.customSelectors === "string"
        ? stored.customSelectors.split("\n").map((s) => s.trim()).filter(Boolean)
        : [];
    state.allowlist = new Set(
      Array.isArray(stored.allowlist) ? stored.allowlist : [],
    );
    state.settings.hourlyBudget =
      typeof stored.hourlyBudget === "number"
        ? stored.hourlyBudget
        : JevAd.constants.DEFAULT_HOURLY_BUDGET;
    ctx.log("init", {
      url: location.href,
      site: state.site && state.site.name,
      adThreshold: state.settings.adThreshold,
      mainGuard: state.settings.mainGuard,
      globalEnabled: state.settings.globalEnabled,
      hasKey: state.hasApiKey,
      mode: state.hasApiKey ? "jev" : "fallback",
      tabEnabled: state.tabEnabled,
      customRules: state.customSelectors.length,
      allowlist: state.allowlist.size,
    });
  }

  function startObserver() {
    function invalidateJudgedAncestor(node) {
      let el = node && node.nodeType === 1 ? node : node && node.parentElement;
      while (el && el !== document.body) {
        if (state.judged.delete(el)) {
          state.addedRoots.add(el);
          return;
        }
        el = el.parentElement;
      }
    }

    const observer = new MutationObserver((mutations) => {
      if (!ctx.pipeline.isEnabled()) {
        // 停用期间 restorePage 的写入也需消化后清空，避免残留误过滤。
        state.selfTouched.clear();
        return;
      }
      for (const m of mutations) {
        if (m.type === "attributes") {
          // 本插件 hide/restore 的 class 写变动：跳过，防自触发重扫循环。
          if (state.selfTouched.has(m.target)) continue;
          invalidateJudgedAncestor(m.target);
          state.addedRoots.add(m.target);
          continue;
        }
        invalidateJudgedAncestor(m.target);
        if (m.type === "characterData") {
          const el = m.target.parentElement;
          if (el) state.addedRoots.add(el);
          continue;
        }
        for (const node of m.addedNodes) {
          if (node.nodeType === 1) state.addedRoots.add(node);
        }
      }
      // 本批 mutation 已消化，self 标记失效；后续写入会重新标记。
      state.selfTouched.clear();
      if (state.addedRoots.size > 0) ctx.pipeline.scheduleScan();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        "class",
        "id",
        "data-ad",
        "data-ad-targeting",
        "data-ad-feature",
        "data-tu",
        "data-adsite",
        "href",
        "src",
        "title",
        "aria-label",
      ],
    });
  }

  function startSweep() {
    setInterval(() => {
      if (!ctx.pipeline.isEnabled() || document.hidden) return;
      ctx.hide.reapplyHidden();
    }, JevAd.constants.SWEEP_MS);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    let rebuild = false;
    if (changes.adThreshold) {
      state.settings.adThreshold = changes.adThreshold.newValue;
      rebuild = true;
    }
    if (changes.mainGuard) {
      state.settings.mainGuard = changes.mainGuard.newValue;
      rebuild = true;
    }
    if (changes.globalEnabled) {
      state.settings.globalEnabled = changes.globalEnabled.newValue;
      ctx.log("global_enabled_change", { value: state.settings.globalEnabled });
      rebuild = true;
    }
    if (changes.apiKey) {
      state.hasApiKey = Boolean(changes.apiKey.newValue);
      state.disposed = false;
      ctx.log("api_key_change", {
        hasKey: state.hasApiKey,
        mode: state.hasApiKey ? "jev" : "fallback",
      });
      rebuild = true;
    }
    if (changes.customSelectors) {
      const val = changes.customSelectors.newValue;
      state.customSelectors = Array.isArray(val)
        ? val
        : typeof val === "string"
          ? val.split("\n").map((s) => s.trim()).filter(Boolean)
          : [];
      rebuild = true;
    }
    if (changes.allowlist) {
      state.allowlist = new Set(Array.isArray(changes.allowlist.newValue) ? changes.allowlist.newValue : []);
      rebuild = true;
    }
    if (rebuild) {
      ctx.hide.restorePage();
      if (ctx.pipeline.isEnabled()) {
        ctx.pipeline.processSubtree(document.body);
        ctx.pipeline.flush();
      }
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === "GET_STATS") {
      sendResponse({
        hidden: state.hidden.size,
        deterministic: state.stats.deterministic,
        semantic: state.stats.semantic,
        uncertain: state.stats.uncertain,
        enabled: state.tabEnabled,
        active: ctx.pipeline.isEnabled(),
        globalEnabled: state.settings.globalEnabled,
        tabEnabled: state.tabEnabled,
        queued: state.pending.length,
        stopped: state.disposed,
        mode: state.hasApiKey ? "jev" : "fallback",
        site: state.site && state.site.name,
      });
      return;
    }
    if (msg.type === "SET_ENABLED") {
      (async () => {
        const enabled = Boolean(msg.enabled);
        try {
          const result = await chrome.runtime.sendMessage({
            type: "SET_TAB_ENABLED",
            enabled,
          });
          if (result && result.ok === false) throw new Error(result.message || "网络规则更新失败");
        } catch (err) {
          ctx.log("tab_network_toggle_error", { message: String(err && err.message) });
          sendResponse({ ok: false, enabled: ctx.pipeline.isEnabled(), message: String(err && err.message) });
          return;
        }
        state.tabEnabled = enabled;
        ctx.log("tab_enabled", { value: state.tabEnabled });
        if (!enabled) ctx.hide.restorePage();
        if (ctx.pipeline.isEnabled()) {
          state.disposed = false;
          ctx.pipeline.processSubtree(document.body);
          ctx.pipeline.flush();
        }
        sendResponse({ ok: true, enabled: state.tabEnabled, scanned: ctx.pipeline.isEnabled() });
      })();
      return true;
    }
    if (msg.type === "RESTORE") {
      (async () => {
        try {
          const result = await chrome.runtime.sendMessage({ type: "SET_TAB_ENABLED", enabled: false });
          if (result && result.ok === false) throw new Error(result.message || "网络规则更新失败");
        } catch (err) {
          ctx.log("tab_network_toggle_error", { message: String(err && err.message) });
          sendResponse({ ok: false, message: String(err && err.message) });
          return;
        }
        state.tabEnabled = false;
        ctx.hide.restorePage();
        sendResponse({ ok: true });
      })();
      return true;
    }
    if (msg.type === "RESCAN") {
      (async () => {
        try {
          const result = await chrome.runtime.sendMessage({ type: "SET_TAB_ENABLED", enabled: true });
          if (result && result.ok === false) throw new Error(result.message || "网络规则更新失败");
        } catch (err) {
          sendResponse({ ok: false, enabled: ctx.pipeline.isEnabled(), message: String(err && err.message) });
          return;
        }
        state.tabEnabled = true;
        state.disposed = false;
        resolveSite();
        ctx.hide.restorePage();
        ctx.log("manual_rescan", { mode: state.hasApiKey ? "jev" : "fallback" });
        if (ctx.pipeline.isEnabled()) {
          ctx.pipeline.processSubtree(document.body);
          ctx.pipeline.flush();
        }
        sendResponse({ ok: true, enabled: state.tabEnabled, scanned: ctx.pipeline.isEnabled() });
      })();
      return true;
    }
    return;
  });

  async function init() {
    resolveSite();
    await loadSettings();
    if (document.body) ctx.pipeline.processSubtree(document.body);
    startObserver();
    startSweep();
    ctx.hide.notifyBadge();
  }

  init();
})();
