(globalThis.JevAd ??= {});

JevAd.createLabelsLayer = function createLabelsLayer(ctx) {
  const { normalizeLabelText, describeEl } = JevAd.text;
  const { AD_LABEL_RE, AD_LABEL_SUB } = JevAd.text;
  const protect = JevAd.protect;
  const {
    HIDDEN_CLASS,
    MAX_CARD_H,
    MAX_CARD_W,
    MAX_HIDE_H,
    MAX_HIDE_W,
    LABEL_CONTAINER_SELECTOR,
  } = JevAd.constants;
  const { AD_CLASS } = JevAd.text;

  function looksLikeCard(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 150 || r.height < 60 || r.height > MAX_CARD_H || r.width > MAX_CARD_W) {
      return false;
    }
    if (protect.hasProtectedContent(el, ctx.state.site)) return false;
    return true;
  }

  function siteSelector(parts) {
    const site = ctx.state.site;
    const extras = [];
    if (site && site.labelContainers) extras.push(...site.labelContainers);
    if (site && site.adAncestors) extras.push(...site.adAncestors);
    return [...new Set([...parts, ...extras])].join(",");
  }

  function findLabelContainer(label) {
    const semanticSel = siteSelector((LABEL_CONTAINER_SELECTOR || "").split(","));
    try {
      const semantic = label.closest(semanticSel);
      if (semantic && semantic !== document.body && semantic !== document.documentElement) {
        if (!protect.hasProtectedContent(semantic, ctx.state.site)) {
          const r = semantic.getBoundingClientRect();
          if (r.height <= MAX_CARD_H && r.width <= MAX_CARD_W) return semantic;
        }
      }
    } catch {}

    const adSel = siteSelector((ctx.state.site && ctx.state.site.adAncestors) || []);
    try {
      const adAncestor = adSel ? label.closest(adSel) : null;
      if (
        adAncestor &&
        adAncestor !== document.body &&
        adAncestor !== document.documentElement &&
        !protect.hasProtectedContent(adAncestor, ctx.state.site)
      ) {
        const ar = adAncestor.getBoundingClientRect();
        if (ar.height <= MAX_HIDE_H && ar.width <= MAX_HIDE_W) return adAncestor;
      }
    } catch {}

    let p = label;
    for (let i = 0; i < 10 && p.parentElement; i++) {
      p = p.parentElement;
      if (p === document.body || p === document.documentElement) return null;
      if (protect.hasProtectedContent(p, ctx.state.site)) return null;
      if (looksLikeCard(p)) return p;
      const r = p.getBoundingClientRect();
      if (r.height > MAX_CARD_H || r.width > MAX_CARD_W) return null;
      if (
        r.height >= 100 &&
        r.width >= 200 &&
        (p.querySelector("img") || p.querySelector("picture") || p.querySelector("video"))
      ) {
        return p;
      }
      if (r.height >= 80 && r.width >= 160 && AD_CLASS.test(String(p.getAttribute("class") || ""))) {
        return p;
      }
    }
    return null;
  }

  function findFallbackTarget(label) {
    let p = label;
    for (let i = 0; i < 8 && p.parentElement; i++) {
      p = p.parentElement;
      if (p === document.body || p === document.documentElement) return null;
      if (protect.hasProtectedContent(p, ctx.state.site)) return null;
      const r = p.getBoundingClientRect();
      if (r.height > MAX_CARD_H || r.width > MAX_CARD_W) return null;
      if (r.width >= 140 && r.height >= 70) return p;
      if (r.width >= 120 && r.height >= 50 && (p.querySelector("img") || p.querySelector("video"))) {
        return p;
      }
    }
    return null;
  }

  function labelFromEl(el) {
    if (!el || el.nodeType !== 1) return "";
    const direct = normalizeLabelText(el.textContent);
    if (direct && direct.length <= 12 && AD_LABEL_RE.test(direct)) return direct;
    if (direct && direct.length <= 40 && AD_LABEL_SUB.test(direct)) {
      const m = direct.match(AD_LABEL_SUB);
      if (m) return normalizeLabelText(m[1] || m[0]);
    }
    for (const attr of ["title", "aria-label", "alt"]) {
      const v = normalizeLabelText(el.getAttribute && el.getAttribute(attr));
      if (v && v.length <= 24 && (AD_LABEL_RE.test(v) || AD_LABEL_SUB.test(v))) return v;
    }
    const img = el.querySelector && el.querySelector("img[alt]");
    if (img) {
      const alt = normalizeLabelText(img.getAttribute("alt"));
      if (alt && alt.length <= 24 && (AD_LABEL_RE.test(alt) || AD_LABEL_SUB.test(alt))) return alt;
    }
    return "";
  }

  function registerLabel(label, text, containers, labels, orphans) {
    if (label.closest("." + HIDDEN_CLASS)) return;
    if (labels.has(label)) return;
    if (ctx.state.judged.has(label)) return;
    const container = findLabelContainer(label);
    if (container) {
      if (ctx.state.hidden.has(container) || container.closest("." + HIDDEN_CLASS)) return;
      labels.add(label);
      containers.add(container);
      ctx.log("label_found", {
        text,
        label: describeEl(label),
        container: describeEl(container),
      });
      return;
    }
    const fallback = findFallbackTarget(label);
    ctx.log("label_no_container", {
      text,
      label: describeEl(label),
      html: String(label.outerHTML || "").slice(0, 180),
      fallback: describeEl(fallback),
    });
    if (fallback && !ctx.state.judged.has(fallback)) {
      labels.add(label);
      orphans.add(fallback);
    } else if (!ctx.state.judged.has(label)) {
      labels.add(label);
      orphans.add(label);
    }
  }

  function collect(root, containers, labels, orphans) {
    if (!root || (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11)) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const seen = new Set();
    let node;
    while ((node = walker.nextNode())) {
      const t = normalizeLabelText(node.nodeValue);
      if (!t || t.length > 12) continue;
      const label = node.parentElement;
      if (!label || seen.has(label)) continue;
      const full = normalizeLabelText(label.textContent);
      const matched =
        AD_LABEL_RE.test(t) ||
        AD_LABEL_RE.test(full) ||
        (full.length <= 40 && AD_LABEL_SUB.test(full));
      if (!matched) continue;
      seen.add(label);
      registerLabel(label, t || full, containers, labels, orphans);
    }
    for (const el of root.querySelectorAll("span,div,b,strong,em,small,a,i,mark")) {
      if (seen.has(el) || el.childElementCount > 3) continue;
      const t = labelFromEl(el);
      if (!t) continue;
      seen.add(el);
      registerLabel(el, t, containers, labels, orphans);
    }
  }

  function useJev() {
    return Boolean(ctx.state.hasApiKey) && !ctx.state.disposed;
  }

  function apply(root) {
    const containers = new Set();
    const labels = new Set();
    const orphans = new Set();
    collect(root, containers, labels, orphans);
    const jev = useJev();
    for (const container of containers) {
      if (protect.hasProtectedContent(container, ctx.state.site)) {
        ctx.log("label_skip_protected", { container: describeEl(container) });
        continue;
      }
      if (
        ctx.state.judged.has(container) ||
        ctx.state.queued.has(container)
      ) {
        continue;
      }
      if (jev) {
        ctx.pipeline.enqueue(container, {
          disclosesAd: true,
          score: 9,
          kind: "inline",
          source: "label",
          optimistic: true,
        });
        continue;
      }
      ctx.state.judged.add(container);
      if (ctx.hide.hideEl(container, "labeled")) ctx.state.stats.deterministic += 1;
    }
    for (const label of labels) ctx.state.judged.add(label);
    return orphans;
  }

  return { apply };
};
