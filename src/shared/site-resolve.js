(globalThis.JevAd ??= {});

JevAd.resolveSite = function resolveSite(hostname) {
  const common = JevAd.commonRules || {
    detectors: [],
    labelContainers: [],
    adAncestors: [],
    overlaySelectors: [],
    exclude: [],
    forceDetectors: [],
    scoreBoost: () => 0,
  };
  const modules = JevAd.siteModules || [];
  const hit = modules.find((m) =>
    (m.hosts || []).some((h) => hostname === h || hostname.endsWith("." + h))
  );
  if (!hit) return { ...common, name: "common", matched: null };

  const merge = (a = [], b = []) => [...new Set([...a, ...b])];
  return {
    name: hit.name || "site",
    matched: hit,
    detectors: merge(common.detectors, hit.detectors),
    labelContainers: merge(common.labelContainers, hit.labelContainers),
    adAncestors: merge(common.adAncestors, hit.adAncestors),
    overlaySelectors: merge(common.overlaySelectors, hit.overlaySelectors),
    exclude: merge(common.exclude, hit.exclude || []),
    forceDetectors: merge(common.forceDetectors, hit.forceDetectors || []),
    protectText: hit.protectText || null,
    scoreBoost(el) {
      const base = common.scoreBoost ? common.scoreBoost(el) : 0;
      const extra = hit.scoreBoost ? hit.scoreBoost(el) : 0;
      return Math.max(base, extra);
    },
  };
};
