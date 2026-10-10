(globalThis.JevAd ??= {});
(JevAd.siteModules ??= []).push({
  name: "qqmail",
  hosts: ["mail.qq.com", "wx.mail.qq.com", "exmail.qq.com"],
  detectors: [],
  labelContainers: [],
  adAncestors: [],
  exclude: [
    "[class*='float-scroll' i]",
    "[class*='ui-float-scroll' i]",
    "[class*='xmail-ui-float' i]",
    "[class*='sidebar-menus' i]",
    "[class*='xmail-sidebar' i]",
    "[id*='mainFrame' i]",
    ".xmail-ui-float-scroll",
    ".ui-float-scroll-body",
    "#sidebar-menus",
    "#mainFrame",
    "[class*='qm-body' i]",
    "[class*='xmail-ui' i]",
  ],
  scoreBoost() {
    return 0;
  },
});
