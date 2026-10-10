(globalThis.JevAd ??= {});
(JevAd.siteModules ??= []).push({
  name: "bilibili",
  hosts: ["bilibili.com", "www.bilibili.com", "m.bilibili.com"],
  detectors: [
    ".ad-report",
    "[class*='ad-report' i]",
    "[class*='slide-ads' i]",
    "iframe[src*='cm.bilibili.com']",
    "iframe[src*='commercial.bilibili.com']",
  ],
  labelContainers: [".ad-report", "[class*='ad-report' i]"],
  adAncestors: [".ad-report", "[class*='ad-report' i]"],
  exclude: [],
  scoreBoost() {
    return 0;
  },
});
