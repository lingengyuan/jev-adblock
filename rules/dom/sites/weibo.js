(globalThis.JevAd ??= {});
(JevAd.siteModules ??= []).push({
  name: "weibo",
  hosts: ["weibo.com", "www.weibo.com", "m.weibo.cn"],
  detectors: ["[class*='ad_' i]", "[class*='Ad_' i]", "[id*='ad_' i]", "[data-ad]"],
  labelContainers: ["[class*='feed' i]", "[action-type='feed_list_item']"],
  adAncestors: ["[class*='ad_' i]", "[data-ad]"],
  exclude: [],
  scoreBoost() {
    return 0;
  },
});
