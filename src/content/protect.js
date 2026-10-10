(globalThis.JevAd ??= {});

JevAd.protect = {
  // 站点语义词保护已下沉到各 site 模块的 protectText 字段，
  // 避免全局词表在其他站点造成漏杀（如"读书"）。
  _protectedCache: new WeakMap(),
  _bodyTextLen: -1,

  beginScan() {
    this._protectedCache = new WeakMap();
    this._bodyTextLen = -1;
  },

  invalidateBodyLen() {
    this._bodyTextLen = -1;
  },

  hasProtectedContent(el, site) {
    if (!el) return false;
    const cached = this._protectedCache.get(el);
    if (cached !== undefined) return cached;
    const result = this._computeProtected(el, site);
    this._protectedCache.set(el, result);
    return result;
  },

  _computeProtected(el, site) {
    const excludes = (site && site.exclude) || [];
    for (const sel of excludes) {
      try {
        if (el.matches(sel) || (el.closest && el.closest(sel))) return true;
      } catch {}
    }
    const re = site && site.protectText;
    if (re) {
      const text = (el.innerText || "").slice(0, 2500);
      if (re.test(text)) return true;
      const head = el.querySelector("h1,h2,h3,h4,[class*='title' i],[class*='Title']");
      const headText = head ? String(head.innerText || "").slice(0, 80) : "";
      if (re.test(headText)) return true;
    }
    return false;
  },

  looksOversized(el) {
    const { MAX_HIDE_H, MAX_HIDE_W } = JevAd.constants;
    const r = el.getBoundingClientRect();
    return r.height > MAX_HIDE_H || r.width > MAX_HIDE_W;
  },

  looksLikeMainContent(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    const cls = String(el.getAttribute("class") || "");
    const id = String(el.getAttribute("id") || "");
    if (
      el.hasAttribute("data-tu") ||
      el.hasAttribute("data-adsite") ||
      /float-ad|topbar-ad|unionad|fallback-ad|lefttip|topbe|bottom-banner|navrecommend|elevator-ad|rightTip|game-box|mingzhan|puzzle|siye|js-site-slot|coolsitead|ad-icon|feed-ad|hot-goods|ecommerce-box|gameyixing|qipao|fullpage-pop/i.test(
        `${id} ${cls}`
      )
    ) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    if (vw <= 0 || vh <= 0) return false;
    const areaRatio = (rect.width * rect.height) / (vw * vh);
    if (this._bodyTextLen < 0) {
      this._bodyTextLen = String((document.body && document.body.innerText) || "").length;
    }
    const bodyLen = this._bodyTextLen;
    const text = String(el.innerText || "");
    if (text.length >= 400 && bodyLen >= 400 && text.length / bodyLen >= 0.5) {
      return true;
    }
    const cs = getComputedStyle(el);
    const isPanel =
      cs.position === "fixed" || cs.position === "sticky" || cs.position === "absolute";
    if (isPanel && areaRatio >= 0.18 && text.length >= 120) {
      const controls = el.querySelectorAll(
        "a,button,input,select,textarea,[role='button'],[role='tab'],[role='link'],[role='menuitem']"
      ).length;
      if (controls >= 8) return true;
    }
    return false;
  },

  cardTooLarge(el) {
    const { MAX_CARD_H, MAX_CARD_W } = JevAd.constants;
    const r = el.getBoundingClientRect();
    return r.height > MAX_CARD_H || r.width > MAX_CARD_W;
  },
};
