const $ = (id) => document.getElementById(id);

const DEFAULTS = JevAd.constants.DEFAULTS;

async function load() {
  const stored = await chrome.storage.local.get([
    "apiKey",
    "adThreshold",
    "mainGuard",
    "globalEnabled",
    "hourlyBudget",
    "customSelectors",
    "allowlist",
  ]);
  $("apiKey").value = stored.apiKey || "";
  $("adThreshold").value =
    typeof stored.adThreshold === "number" ? stored.adThreshold : DEFAULTS.adThreshold;
  $("mainGuard").value =
    typeof stored.mainGuard === "number" ? stored.mainGuard : DEFAULTS.mainGuard;
  $("globalEnabled").checked =
    typeof stored.globalEnabled === "boolean"
      ? stored.globalEnabled
      : DEFAULTS.globalEnabled;
  $("hourlyBudget").value =
    typeof stored.hourlyBudget === "number" ? stored.hourlyBudget : JevAd.constants.DEFAULT_HOURLY_BUDGET;
  $("customSelectors").value =
    typeof stored.customSelectors === "string"
      ? stored.customSelectors
      : Array.isArray(stored.customSelectors)
        ? stored.customSelectors.join("\n")
        : "";
  $("allowlist").value = Array.isArray(stored.allowlist)
    ? stored.allowlist.join("\n")
    : "";
}

function parseLines(raw) {
  return String(raw || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function setStatus(el, text, ok) {
  el.textContent = text;
  el.className = "status " + (ok ? "ok" : "err");
}

async function save() {
  const adThreshold = Math.min(0.99, Math.max(0.5, Number($("adThreshold").value) || DEFAULTS.adThreshold));
  const mainGuard = Math.min(0.9, Math.max(0, Number($("mainGuard").value) || 0));
  const hourlyBudget = Math.min(100000, Math.max(0, Number($("hourlyBudget").value) || JevAd.constants.DEFAULT_HOURLY_BUDGET));
  await chrome.storage.local.set({
    apiKey: $("apiKey").value.trim(),
    adThreshold,
    mainGuard: Number.isFinite(mainGuard) ? mainGuard : DEFAULTS.mainGuard,
    globalEnabled: $("globalEnabled").checked,
    hourlyBudget,
    customSelectors: $("customSelectors").value,
    allowlist: parseLines($("allowlist").value),
  });
  setStatus($("saveStatus"), "已保存", true);
  setTimeout(() => {
    $("saveStatus").textContent = "";
  }, 2000);
}

async function testKey() {
  const btn = $("testBtn");
  btn.disabled = true;
  setStatus($("testStatus"), "测试中…", true);
  try {
    const res = await chrome.runtime.sendMessage({
      type: "TEST_KEY",
      apiKey: $("apiKey").value.trim(),
    });
    if (res && res.ok) {
      setStatus($("testStatus"), "连接成功", true);
    } else {
      setStatus($("testStatus"), (res && res.message) || "连接失败", false);
    }
  } catch (err) {
    setStatus($("testStatus"), "通信失败", false);
  } finally {
    btn.disabled = false;
  }
}

$("saveBtn").addEventListener("click", save);
$("testBtn").addEventListener("click", testKey);

function fmtTime(ts) {
  return typeof jevFmtTime === "function" ? jevFmtTime(ts) : String(ts);
}

function formatLog(e) {
  return typeof jevFormatLog === "function" ? jevFormatLog(e) : JSON.stringify(e.data || {});
}

async function refreshLogs() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_LOGS", all: true });
    const logs = (res && res.logs) || [];
    if (!logs.length) {
      $("logView").textContent = "（暂无日志。打开任意网页后点击刷新）";
      return;
    }
    $("logView").textContent = logs
      .slice(-200)
      .map((e) => {
        const line = formatLog(e);
        return line ? `${fmtTime(e.ts)} tab:${e.tabId} ${line}` : "";
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
  await chrome.runtime.sendMessage({ type: "CLEAR_LOGS", all: true });
  await refreshLogs();
});

load();
refreshLogs();
setInterval(() => {
  if (!document.hidden) refreshLogs();
}, 3000);
