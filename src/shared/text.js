(globalThis.JevAd ??= {});

JevAd.text = {
  ZERO_WIDTH_RE: /[\u200B-\u200D\uFEFF\u00A0]+/g,
  AD_LABEL_RE:
    /^(广告|advertisement|advertisements|ad|sponsored|sponsored post|promoted|promoted content|paid partnership|赞助|赞助商|推广|推广内容|内容推广|商业推广)$/i,
  AD_LABEL_SUB:
    /(?:^|[\s·•|/])(广告|advertisement|advertisements|sponsored|promoted|赞助|推广)(?:$|[\s·•|/])/i,
  AD_CLASS:
    /(^|[-_\s])(ad|ads|adsense|adslot|ad-slot|ad-unit|ad-banner|advert|advertisement|adsbanner|sponsor|sponsored|promo|promotion|native-?ad|partner-content|taboola|outbrain|feedad|feed-ad|adcard|ad-card|adlist|ad-list|commercial|advertorial|unionad|union-ad|fallback-ad|cpc|cpm)([-_\s]|$)|feedad|adcard|adscontainer|data-tu/i,
  PROMO_SIGNAL:
    /sponsored|advertisement|advertisements|promoted|paid partnership|广告|赞助|推广|入驻|打开App|下载App|限时|优惠券/i,

  normalizeLabelText(raw) {
    return String(raw || "").replace(JevAd.text.ZERO_WIDTH_RE, " ").trim();
  },

  extractText(el, max = 400) {
    const raw = el.innerText || "";
    return raw.replace(/\s+/g, " ").trim().slice(0, max);
  },

  extractHrefs(el) {
    const hrefs = [];
    const anchors = el.tagName === "A" ? [el] : el.querySelectorAll("a[href]");
    for (const a of anchors) {
      if (hrefs.length >= 3) break;
      try {
        const url = new URL(a.getAttribute("href") || "", location.href);
        if (url.protocol === "http:" || url.protocol === "https:") {
          hrefs.push(url.origin === location.origin ? "same-site" : url.hostname);
        }
      } catch {}
    }
    return hrefs;
  },

  extractIframeSrc(el) {
    const frame = el.tagName === "IFRAME" ? el : el.querySelector("iframe[src]");
    if (!frame) return "";
    try {
      const url = new URL(frame.getAttribute("src") || "", location.href);
      if (url.protocol !== "http:" && url.protocol !== "https:") return "";
      return url.origin === location.origin ? "same-site" : url.hostname;
    } catch {
      return "";
    }
  },

  describeEl(el) {
    if (!el) return null;
    const cls = String(el.className || "").slice(0, 80);
    return `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${cls ? "." + cls.split(/\s+/).slice(0, 3).join(".") : ""}`;
  },

  regionOf(el) {
    if (el.closest("header,[role='banner']")) return "header";
    if (el.closest("footer,[role='contentinfo']")) return "footer";
    if (el.closest("nav,[role='navigation']")) return "nav";
    if (el.closest("aside,[role='complementary']")) return "sidebar";
    return "content";
  },
};
