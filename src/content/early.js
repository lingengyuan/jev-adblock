// 社区定向 cosmetic 早期注入：document_start 读取当前 hostname 的规则桶，
// 以 <style> 原生 CSS 隐藏，消灭 document_idle + debounce 的闪现窗口。
// 语义与 cosmetic.css 一致：不可经「恢复本页」还原，刷新页面恢复。
// globalEnabled / allowlist 经 storage 异步判定，注入仅延迟数毫秒，
// 仍远早于首帧绘制；storage 异常时兜底注入（本地规则兜底哲学）。
(() => {
  const rules = globalThis.JevAd && globalThis.JevAd.communityRules;
  if (!rules || !rules.byDomain) return;
  const host = location.hostname;
  if (!host) return;

  const list = [];
  for (const domain in rules.byDomain) {
    if (host === domain || host.endsWith("." + domain)) {
      list.push(...rules.byDomain[domain]);
    }
  }
  if (!list.length) return;

  function inject() {
    const style = document.createElement("style");
    style.id = "jev-community-css";
    style.textContent = list.join(",") + "{display:none!important}";
    (document.head || document.documentElement).appendChild(style);
  }

  chrome.storage.local
    .get(["globalEnabled", "allowlist"])
    .then((stored) => {
      if (stored && stored.globalEnabled === false) return;
      const allowlist = Array.isArray(stored && stored.allowlist) ? stored.allowlist : [];
      for (const d of allowlist) {
        const domain = String(d || "").toLowerCase();
        if (domain && (host === domain || host.endsWith("." + domain))) return;
      }
      inject();
    })
    .catch(inject);
})();
