const $ = (id) => document.getElementById(id);

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendToTab(msg) {
  const tab = await activeTab();
  if (!tab || !tab.id || !/^https?:/.test(tab.url || "")) {
    throw new Error("当前页面不支持");
  }
  return chrome.tabs.sendMessage(tab.id, msg);
}

async function refresh() {
  const { apiKey } = await chrome.storage.local.get("apiKey");
  $("keyWarn").hidden = Boolean(apiKey);
  try {
    const stats = await sendToTab({ type: "GET_STATS" });
    $("hiddenCount").textContent = stats.hidden;
    $("detCount").textContent = stats.deterministic;
    $("semCount").textContent = stats.semantic;
    $("uncertainCount").textContent = stats.uncertain;
    $("enabled").checked = stats.tabEnabled;
    if (!stats.globalEnabled) {
      $("msg").textContent = "全局暂停中";
    } else if (!stats.tabEnabled) {
      $("msg").textContent = "本页已暂停";
    } else if (stats.stopped) {
      $("msg").textContent = "Jev 已暂停（检查 API key 或点重新扫描）";
    } else if (!apiKey) {
      $("msg").textContent = "规则兜底模式";
    } else if (stats.queued > 0) {
      $("msg").textContent = `Jev 待判断 ${stats.queued}`;
    } else {
      $("msg").textContent = "Jev 主判";
    }
  } catch {
    $("hiddenCount").textContent = "–";
    $("detCount").textContent = "–";
    $("semCount").textContent = "–";
    $("uncertainCount").textContent = "–";
    $("msg").textContent = "无法连接此页面";
  }
}

$("enabled").addEventListener("change", async () => {
  try {
    const res = await sendToTab({ type: "SET_ENABLED", enabled: $("enabled").checked });
    if (res && res.ok === false) throw new Error(res.message || "设置失败");
    await refresh();
  } catch (err) {
    $("msg").textContent = String(err.message || err);
  }
});

$("restoreBtn").addEventListener("click", async () => {
  try {
    const res = await sendToTab({ type: "RESTORE" });
    if (res && res.ok === false) throw new Error(res.message || "恢复失败");
    await refresh();
  } catch (err) {
    $("msg").textContent = String(err.message || err);
  }
});

$("rescanBtn").addEventListener("click", async () => {
  try {
    const res = await sendToTab({ type: "RESCAN" });
    if (res && res.ok === false) throw new Error(res.message || "重新扫描失败");
    $("msg").textContent = res && res.scanned === false ? "本页已启用；全局暂停中" : "已重新扫描";
    setTimeout(refresh, 1200);
  } catch (err) {
    $("msg").textContent = String(err.message || err);
  }
});

$("openOptions").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

function fmtTime(ts) {
  return typeof jevFmtTime === "function" ? jevFmtTime(ts) : String(ts);
}

function formatLog(e) {
  return typeof jevFormatLog === "function" ? jevFormatLog(e) : JSON.stringify(e.data || {});
}

async function refreshLogs() {
  try {
    const tab = await activeTab();
    const res = await chrome.runtime.sendMessage({
      type: "GET_LOGS",
      tabId: tab && tab.id != null ? tab.id : null,
    });
    const logs = (res && res.logs) || [];
    $("logCount").textContent = logs.length ? ` (${logs.length})` : "";
    if (!logs.length) {
      $("logView").textContent = "（暂无日志）";
      return;
    }
    $("logView").textContent = logs
      .slice(-100)
      .map((e) => {
        const line = formatLog(e);
        return line ? `${fmtTime(e.ts)} ${line}` : "";
      })
      .filter(Boolean)
      .join("\n");
    $("logView").scrollTop = $("logView").scrollHeight;
  } catch (err) {
    $("logView").textContent = "读取日志失败: " + String(err.message || err);
  }
}

$("refreshLogBtn").addEventListener("click", refreshLogs);
$("clearLogBtn").addEventListener("click", async () => {
  const tab = await activeTab();
  await chrome.runtime.sendMessage({
    type: "CLEAR_LOGS",
    tabId: tab && tab.id != null ? tab.id : null,
  });
  await refreshLogs();
});

refresh();
refreshLogs();
setInterval(() => {
  if (!document.hidden) {
    refresh();
    refreshLogs();
  }
}, 2000);
