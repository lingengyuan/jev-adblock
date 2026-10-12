(globalThis.JevAd ??= {});

JevAd.text = {
  ZERO_WIDTH_RE: /[\u200B-\u200D\uFEFF\u00A0]+/g,
  // 中文关键词必须同时覆盖简体与繁体，否则繁体站点（台/港）整体失效：
  // 「廣告」「贊助」与简体形不共享码点，正则匹配不到，这类站点上
  // 广告标签、推广文案全部漏杀（实测：繁体漫画站的赞助横幅无人识别）。
  // 日文「広告」、韩文「광고」只进精确匹配表——它们是独立语言，放进
  // PROMO_SIGNAL 这种模糊信号会带来无法评估的误报面。
  AD_LABEL_RE:
    /^(广告|廣告|advertisement|advertisements|ad|sponsored|sponsored post|promoted|promoted content|paid partnership|赞助|贊助|赞助商|贊助商|推广|推廣|推广内容|推廣內容|内容推广|內容推廣|商业推广|商業推廣|贊助內容|広告|광고)$/i,
  AD_LABEL_SUB:
    /(?:^|[\s·•|/])(广告|廣告|advertisement|advertisements|sponsored|promoted|赞助|贊助|推广|推廣)(?:$|[\s·•|/])/i,
  AD_CLASS:
    /(^|[-_\s])(ad|ads|adsense|adslot|ad-slot|ad-unit|ad-banner|advert|advertisement|adsbanner|sponsor|sponsored|promo|promotion|native-?ad|partner-content|taboola|outbrain|feedad|feed-ad|adcard|ad-card|adlist|ad-list|commercial|advertorial|unionad|union-ad|fallback-ad|cpc|cpm)([-_\s]|$)|feedad|adcard|adscontainer|data-tu/i,
  PROMO_SIGNAL:
    /sponsored|advertisement|advertisements|promoted|paid partnership|广告|廣告|赞助|贊助|推广|推廣|入驻|入駐|打开App|開啟App|打開App|下载App|下載App|限时|限時|优惠券|優惠券/i,

  // 反广告拦截墙的文案识别（见 layers/antiadblock.js）。
  // 名词与动词必须**同时**出现：只看名词会命中"讲广告拦截的文章"，
  // 只看动词会命中一切带"关闭"字样的按钮。
  ANTI_ADBLOCK_NOUN:
    /广告拦截|廣告攔截|广告屏蔽|廣告屏蔽|广告阻挡|广告阻擋|廣告阻擋|广告过滤|廣告過濾|adblock(?:er)?s?|ad[ -]?block(?:er)?s?|ublock/i,
  ANTI_ADBLOCK_VERB:
    /关闭|關閉|关掉|關掉|禁用|停用|检测到|檢測到|偵測到|偵測|移除|卸载|卸載|白名单|白名單|disable[ds]?|turn\s+(?:it\s+)?off|whitelist(?:ed)?|detected/i,

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
