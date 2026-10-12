(globalThis.JevAd ??= {});

JevAd.createScore = function createScore(ctx) {
  const text = JevAd.text;
  const { regionOf, AD_CLASS, PROMO_SIGNAL } = text;
  const protect = JevAd.protect;
  const { MAX_CARD_H, MAX_CARD_W, SCAN_SELECTOR } = JevAd.constants;

  // 尺寸闸门要拦住的是"大到不该被当成广告卡片"的容器（整页包裹层、
  // 主内容区外壳），而不是所有超宽元素。旧实现 `width > MAX_CARD_W` 一刀切，
  // 连带拒掉了横幅广告——728×90、970×90、全宽 1200+ 正是最标准的广告形态，
  // 它们在繁体漫画站、门户首页上全都进不了候选。
  // 判据改为"宽 **且** 高"：宽而扁是横幅，宽而高才是容器。
  const TALL_FOR_WIDTH = 320; // 超过 MAX_CARD_W 的元素，高度低于此值视为横幅

  function oversizedForCard(rect) {
    if (rect.height > MAX_CARD_H) return true;
    if (rect.width > MAX_CARD_W && rect.height > TALL_FOR_WIDTH) return true;
    return false;
  }

  function scoreCandidate(el, opts) {
    const aggressive = Boolean(opts && opts.aggressive);
    const rect = el.getBoundingClientRect();
    if (oversizedForCard(rect)) return 0;
    if (rect.height < 40 || rect.width < 80) return 0;
    if (protect.hasProtectedContent(el, ctx.state.site)) return 0;

    let score = 0;
    const cls = String(el.getAttribute("class") || "");
    const adCls = AD_CLASS.test(cls);
    if (adCls) score += 2;
    const id = String(el.getAttribute("id") || "");
    const adId = Boolean(id) && AD_CLASS.test(id);
    if (adId) score += 2;
    if (
      el.hasAttribute("data-ad") ||
      el.hasAttribute("data-ad-targeting") ||
      el.hasAttribute("data-ad-feature") ||
      el.hasAttribute("data-tu") ||
      el.hasAttribute("data-adsite")
    ) {
      score += 3;
    }
    if (el.tagName === "IFRAME" && !el.getAttribute("title") && !el.getAttribute("name")) {
      try {
        if (new URL(el.src, location.href).hostname !== location.hostname) score += 2;
      } catch {
        score += 1;
      }
    }

    const own = text.extractText(el, 200);
    const promoHit = PROMO_SIGNAL.test(own);
    if (promoHit) score += 2;
    if (score > 0 && el.querySelector("a,button,[role='button']")) score += 1;

    const siteBoost = ctx.state.site && ctx.state.site.scoreBoost
      ? ctx.state.site.scoreBoost(el)
      : 0;
    score += siteBoost;

    if (score > 0) {
      const kids = el.querySelectorAll(SCAN_SELECTOR);
      if (kids.length >= 4 && rect.height >= 500) score = 0;
    }
    if (score === 0) {
      const region = regionOf(el);
      const promo = promoHit || siteBoost > 0;
      if (promo && rect.width >= 160 && rect.height >= 120) {
        if (region === "sidebar" || region === "footer" || region === "header") {
          score += 2;
        }
      }
      if (
        aggressive &&
        score === 0 &&
        region !== "content" &&
        rect.width >= 120 &&
        rect.height >= 60 &&
        rect.height <= 700 &&
        // 只认真正的广告位痕迹：广告 <ins> 单元 / 站外 iframe / promo 文案。
        // 旧条件把 `a,button` 和 `own.length >= 20` 也算进来，等于给
        // "非正文区凡带链接或够长的块"一律 score 1——侧栏导航、页脚链接群
        // 全被送进 Jev，既耗调用又必然产生这类误判（#qq-sidebar 案例）。
        // promoHit 在此处可达：上方 kids>=4 && 高>=500 的降级会把已得分的
        // 元素重置为 0，那条路径仍需靠 promo 文案重新捞回。
        (el.querySelector("iframe,ins") || promoHit)
      ) {
        score = 1;
      }
      if (
        aggressive &&
        score === 0 &&
        region === "content" &&
        rect.width >= 160 &&
        rect.height >= 80 &&
        rect.height <= 500 &&
        (adCls || adId || promoHit)
      ) {
        score = 1;
      }
    }
    return score;
  }

  return { scoreCandidate };
};
