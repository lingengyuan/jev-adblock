(function (g) {
  function jevFmtTime(ts) {
    const d = new Date(ts);
    return d.toTimeString().slice(0, 8);
  }

  function shortEl(el) {
    if (!el) return "";
    return String(el)
      .replace(/\.jev-ad-hidden\b/g, "")
      .slice(0, 48);
  }

  function num(v, digits) {
    if (typeof v !== "number" || Number.isNaN(v)) return "";
    return Number(v.toFixed(digits == null ? 2 : digits)).toString();
  }

    const REASON_ZH = {
      rule: "规则",
      labeled: "标签",
      overlay: "浮层",
      jev: "Jev",
      "jev-detector": "Jev·规则",
      "labeled+jev": "标签+Jev",
      oversized: "超尺寸",
      protected: "受保护",
    };

  const ACTION_ZH = {
    hide: "隐藏",
    keep: "保留",
    uncertain: "存疑",
  };

  const SKIP_EVENTS = {
    bg_judge: true,
    judge_usage: true,
    mutation_scan: true,
  };

  function formatLog(e) {
    if (!e) return "";
    if (SKIP_EVENTS[e.event]) return "";
    const d = e.data || {};
    const ev = e.event;
    const el = shortEl(d.el || d.container || d.label || d.fallback);

    switch (ev) {
      case "site":
        return `站点 ${d.name || d.host || ""}`;
      case "init":
        return `初始化 · ${d.site || ""} · ${d.mode === "fallback" ? "规则兜底" : "Jev 主判"} · 阈值 ${num(d.adThreshold)} / ${num(d.mainGuard)}${
          d.hasKey ? "" : " · 无 key"
        }`;
      case "enqueue":
        return `入队 ${d.kind === "overlay" ? "浮层" : "候选"} ${el}${
          d.source ? ` · ${d.source}` : ""
        }${d.score != null ? ` · 分 ${num(d.score, 0)}` : ""}${
          d.disclosesAd ? " · 标称广告" : ""
        }${d.text ? ` · ${String(d.text).slice(0, 36)}` : ""}`;
      case "label_found":
        return `标签「${d.text || ""}」→ ${shortEl(d.container)}`;
      case "label_no_container":
        return `标签「${d.text || ""}」无容器 · 回退 ${
          shortEl(d.fallback) || shortEl(d.label) || "自身"
        }`;
      case "label_skip_protected":
        return `标签跳过（受保护）${el}`;
      case "detector_hits":
        return `规则命中 ${d.count || 0} 处${d.mode ? ` · ${d.mode === "jev" ? "交 Jev" : "兜底"}` : ""}`;
      case "hide":
        return `隐藏 ${el} · ${REASON_ZH[d.reason] || d.reason || ""}`;
      case "hide_skip":
        return `跳过 ${el} · ${REASON_ZH[d.reason] || d.reason || ""}`;
      case "overlay_skip":
        return `浮层跳过 ${el} · ${d.reason === "main_content" ? "主内容" : d.reason || ""}`;
      case "judge_request":
        return `请求 Jev 判断 ${d.count || 0} 项`;
      case "judge_result": {
        const act = ACTION_ZH[d.action] || d.action || "";
        if (d.kind === "overlay" || d.blocks != null) {
          return `浮层 ${act} ${el} · 遮挡 ${num(d.blocks)} · 推广 ${num(d.promo)} · 正文 ${num(d.main)}`;
        }
        const thr =
          d.thr != null && d.thr !== d.adThr ? ` · 门槛 ${num(d.thr)}` : "";
        const src = d.source ? ` · ${d.source}` : "";
        return `Jev ${act} ${el}${src} · 广告 ${num(d.ad)} · 正文 ${num(d.main)}${thr}`;
      }
      case "judge_error":
        return `判断失败 ${d.code || ""}${d.message ? ` · ${d.message}` : ""}`;
      case "judge_exception":
        return `判断异常 ${d.message || ""}`;
      case "reapply_hidden":
        return `重应用隐藏 ${d.count || 0} 项`;
      case "restore":
        return `已恢复 ${d.count || 0} 项`;
      case "global_enabled_change":
        return `总开关 ${d.value ? "开" : "关"}`;
      case "tab_enabled":
        return `本页开关 ${d.value ? "开" : "关"}`;
      case "api_key_change":
        return `API key ${d.hasKey ? "已配置 · Jev 主判" : "已清除 · 规则兜底"}`;
      case "manual_rescan":
        return `手动重新扫描${d.mode ? ` · ${d.mode === "fallback" ? "规则兜底" : "Jev"}` : ""}`;
      default: {
        const keys = Object.keys(d);
        if (!keys.length) return ev;
        const brief = keys
          .slice(0, 4)
          .map((k) => `${k}=${typeof d[k] === "object" ? "…" : d[k]}`)
          .join(" ");
        return `${ev} ${brief}`.slice(0, 120);
      }
    }
  }

  g.jevFmtTime = jevFmtTime;
  g.jevFormatLog = formatLog;
})(globalThis);
