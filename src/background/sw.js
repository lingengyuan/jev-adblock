import { handleJudge, handleTestKey, clearTabUsage } from "./judge.js";
import {
  appendLog,
  appendLogs,
  hydrateLogs,
  getLogsResponse,
  clearLogs,
} from "./logs.js";

const RULESET_IDS = ["ad_networks", "community"];
const TAB_ALLOW_RULE_BASE = 100000;
const ALLOWLIST_RULE_BASE = 200000;

// DNR 优先级梯度（高者胜）：
//   1 普通阻断 | 2 列表例外 | 4 $important 阻断（convert-filters 生成）
//   5 用户白名单 | 6 本页暂停 —— 用户意图永远高于社区规则。
function tabAllowRule(tabId) {
  return {
    id: TAB_ALLOW_RULE_BASE + tabId,
    priority: 6,
    action: { type: "allow" },
    condition: { tabIds: [tabId] },
  };
}

async function syncGlobalNetworkRules() {
  const { globalEnabled = true } = await chrome.storage.local.get("globalEnabled");
  const enabled = await chrome.declarativeNetRequest.getEnabledRulesets();
  const enableRulesetIds = RULESET_IDS.filter((id) => globalEnabled && !enabled.includes(id));
  const disableRulesetIds = RULESET_IDS.filter((id) => !globalEnabled && enabled.includes(id));
  if (enableRulesetIds.length || disableRulesetIds.length) {
    await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds, disableRulesetIds });
  }
}

let globalRulesSync = Promise.resolve();

function queueGlobalNetworkRulesSync() {
  globalRulesSync = globalRulesSync.then(syncGlobalNetworkRules).catch((err) => {
    console.warn("[jev-ad] DNR global sync failed", err);
  });
}

async function setTabNetworkEnabled(tabId, enabled) {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [TAB_ALLOW_RULE_BASE + tabId],
    addRules: enabled ? [] : [tabAllowRule(tabId)],
  });
  return { ok: true, enabled };
}

// 用户白名单域名：DOM 隐藏之外，网络层也放行（该域名下发起的所有请求），
// 与社区规则集的激进程度对齐。initiatorDomains 自动匹配子域。
function allowlistRuleId(domain) {
  let h = 0;
  for (let i = 0; i < domain.length; i++) h = (h * 31 + domain.charCodeAt(i)) % 1000000;
  return ALLOWLIST_RULE_BASE + h;
}

async function syncAllowlistNetworkRules() {
  const { allowlist } = await chrome.storage.local.get("allowlist");
  const domains = Array.isArray(allowlist)
    ? allowlist.map((d) => String(d || "").trim().toLowerCase()).filter(Boolean)
    : [];
  const existing = (await chrome.declarativeNetRequest.getDynamicRules()).filter(
    (r) => r.id >= ALLOWLIST_RULE_BASE,
  );
  const existingMap = new Map(existing.map((r) => [r.id, r]));
  const targetIds = new Set(domains.map((d) => allowlistRuleId(d)));
  const removeRuleIds = [...existingMap.keys()].filter((id) => !targetIds.has(id));
  const addRules = domains
    .filter((d) => !existingMap.has(allowlistRuleId(d)))
    .map((domain) => ({
      id: allowlistRuleId(domain),
      priority: 5,
      action: { type: "allow" },
      condition: { initiatorDomains: [domain] },
    }));
  if (removeRuleIds.length || addRules.length) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  }
}

let allowlistSync = syncAllowlistNetworkRules().catch((err) => {
  console.warn("[jev-ad] allowlist DNR sync failed", err);
});

function queueAllowlistSync() {
  allowlistSync = allowlistSync
    .then(syncAllowlistNetworkRules)
    .catch((err) => {
      console.warn("[jev-ad] allowlist DNR sync failed", err);
    });
}

queueGlobalNetworkRulesSync();

if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener((command) => {
    if (command !== "toggle-global") return;
    chrome.storage.local.get("globalEnabled", (stored) => {
      const next = !(stored && stored.globalEnabled);
      chrome.storage.local.set({ globalEnabled: next });
    });
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.globalEnabled) {
    queueGlobalNetworkRulesSync();
  }
  if (changes.allowlist) {
    queueAllowlistSync();
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  clearTabUsage(tabId);
  try {
    await setTabNetworkEnabled(tabId, true);
  } catch (err) {
    console.warn("[jev-ad] DNR tab cleanup failed", err);
  }
});

// 顶层导航即重置该标签页的预算：否则在同一标签页里连续浏览几个广告重的
// 页面后，会因上一个页面的消耗被限流。tabs.onUpdated 只对主框架触发
// （子框架导航不产生该事件），无需额外申请 webNavigation 权限。
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") clearTabUsage(tabId);
});

function contentFiles() {
  return chrome.runtime
    .getManifest()
    .content_scripts.flatMap((cs) => cs.js || []);
}

function mapJudgeLog(results) {
  if (!results) return undefined;
  return results.map((r) =>
    r.kind === "overlay"
      ? {
          key: r.key,
          kind: "overlay",
          blocks: Number(r.blocks.toFixed(3)),
          promo: Number(r.promo.toFixed(3)),
          necessary: Number(r.necessary.toFixed(3)),
          main: Number((r.main || 0).toFixed(3)),
        }
      : {
          key: r.key,
          ad: Number(r.ad.toFixed(3)),
          main: Number(r.main.toFixed(3)),
          disclose: r.disclosesAd,
        }
  );
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "GET_TAB_ENABLED") {
    const tabId = sender.tab && sender.tab.id;
    (async () => {
      try {
        const rules = await chrome.declarativeNetRequest.getSessionRules();
        sendResponse({
          enabled: tabId == null || !rules.some((rule) => rule.id === TAB_ALLOW_RULE_BASE + tabId),
        });
      } catch (err) {
        sendResponse({ ok: false, message: String(err && err.message) });
      }
    })();
    return true;
  }
  if (msg && msg.type === "SET_TAB_ENABLED") {
    const tabId = sender.tab && sender.tab.id;
    if (tabId == null) return false;
    (async () => {
      try {
        sendResponse(await setTabNetworkEnabled(tabId, Boolean(msg.enabled)));
      } catch (err) {
        sendResponse({ ok: false, message: String(err && err.message) });
      }
    })();
    return true;
  }
  if (msg && msg.type === "JUDGE") {
    const tabId = sender.tab && sender.tab.id;
    let host = "";
    try {
      host = sender && sender.url ? new URL(sender.url).hostname : "";
    } catch {
      host = "";
    }
    (async () => {
      let res;
      try {
        res = await handleJudge(msg.candidates, host, tabId);
      } catch (err) {
        sendResponse({
          ok: false,
          code: (err && err.code) || "API",
          message: (err && err.message) || "判断失败",
        });
        return;
      }
      try {
        appendLog(tabId, {
          ts: Date.now(),
          event: "bg_judge",
          data: {
            ok: res.ok,
            code: res.code,
            count: Array.isArray(msg.candidates) ? msg.candidates.length : 0,
            cached: res.ok ? res.cached || 0 : undefined,
            usage: res.usage,
            results: res.ok ? mapJudgeLog(res.results) : undefined,
          },
        });
      } catch (err) {
        console.warn("[jev-ad] judge log failed", err);
      }
      sendResponse(res);
    })();
    return true;
  }
  if (msg && msg.type === "TEST_KEY") {
    handleTestKey(msg.apiKey).then(sendResponse);
    return true;
  }
  if (msg && msg.type === "BADGE") {
    const tabId = sender.tab && sender.tab.id;
    if (tabId != null) {
      const text = msg.count > 0 ? String(Math.min(msg.count, 999)) : "";
      chrome.action.setBadgeText({ tabId, text });
      chrome.action.setBadgeBackgroundColor({ tabId, color: "#E551BA" });
    }
    sendResponse({ ok: true });
    return;
  }
  if (msg && msg.type === "LOG") {
    const tabId = sender.tab && sender.tab.id;
    appendLog(tabId, msg.entry);
    sendResponse({ ok: true });
    return;
  }
  if (msg && msg.type === "LOG_BATCH") {
    const tabId = sender.tab && sender.tab.id;
    appendLogs(tabId, msg.entries).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg && msg.type === "GET_LOGS") {
    hydrateLogs().then(() => sendResponse(getLogsResponse(msg, sender)));
    return true;
  }
  if (msg && msg.type === "CLEAR_LOGS") {
    hydrateLogs().then(() => sendResponse(clearLogs(msg, sender)));
    return true;
  }
  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (tab.id != null && tab.url && /^https?:/.test(tab.url)) {
        chrome.scripting
          .executeScript({
            target: { tabId: tab.id },
            files: contentFiles(),
          })
          .catch(() => {});
      }
    }
  });
});
