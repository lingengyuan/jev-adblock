export const MAX_LOGS = 500;

const logsByTab = new Map();
let hydratePromise = null;
let persistTimer = 0;

export function hydrateLogs() {
  if (!hydratePromise) {
    hydratePromise = (async () => {
      try {
        const { logsByTab: stored } = await chrome.storage.session.get("logsByTab");
        if (stored && typeof stored === "object") {
          for (const [k, v] of Object.entries(stored)) {
            if (Array.isArray(v)) logsByTab.set(Number(k), v);
          }
        }
      } catch {}
    })();
  }
  return hydratePromise;
}

export async function persistLogs() {
  try {
    const obj = {};
    for (const [k, v] of logsByTab) obj[String(k)] = v;
    await chrome.storage.session.set({ logsByTab: obj });
  } catch {}
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = 0;
    persistLogs();
  }, 300);
}

export async function appendLogs(tabId, entries) {
  await hydrateLogs();
  if (!Array.isArray(entries) || entries.length === 0) return;
  const tabKey = tabId == null ? 0 : tabId;
  let arr = logsByTab.get(tabKey);
  if (!arr) {
    arr = [];
    logsByTab.set(tabKey, arr);
  }
  for (const entry of entries) {
    if (entry) arr.push({ ...entry, tabId: tabKey });
  }
  if (arr.length > MAX_LOGS) arr.splice(0, arr.length - MAX_LOGS);
  schedulePersist();
}

export async function appendLog(tabId, entry) {
  return appendLogs(tabId, [entry]);
}

export function getLogsResponse(msg, sender) {
  const senderTab = sender.tab && sender.tab.id;
  const reqTab = msg.tabId != null ? msg.tabId : senderTab;
  const key = msg.all ? null : reqTab == null ? 0 : reqTab;
  if (key == null) {
    const merged = [];
    for (const arr of logsByTab.values()) merged.push(...arr);
    merged.sort((a, b) => a.ts - b.ts);
    return { logs: merged.slice(-MAX_LOGS) };
  }
  return { logs: logsByTab.get(key) || [] };
}

export function clearLogs(msg, sender) {
  const senderTab = sender.tab && sender.tab.id;
  const reqTab = msg.tabId != null ? msg.tabId : senderTab;
  if (msg.all) logsByTab.clear();
  else logsByTab.delete(reqTab == null ? 0 : reqTab);
  schedulePersist();
  return { ok: true };
}
