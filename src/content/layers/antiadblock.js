(globalThis.JevAd ??= {});

JevAd.createAntiAdblockLayer = function createAntiAdblockLayer(ctx) {
  const { ANTI_ADBLOCK_NOUN, ANTI_ADBLOCK_VERB, describeEl } = JevAd.text;
  const { HIDDEN_CLASS, MAX_HIDE_H, MAX_HIDE_W } = JevAd.constants;

  // 反广告拦截墙走确定性路径，不经 Jev。用 jev-1.13.0 实测表明：
  //
  //   纯墙（"请关闭广告拦截后继续浏览"）：blocks 0.99 / promo 0.25 /
  //   necessary 0.30 / main 0.04 → **判 keep**。原因是 shouldHideOverlay 的
  //   三个隐藏分支（edgeCase / coverCase / strong）**全部要求 promo ≥ 0.5**，
  //   而墙的文案不是推广内容，promo 上不去。注意不是 necessary 拦住的：
  //   0.30 远低于 0.55 那道闸门——所以这堵墙确实需要一个确定性出口。
  //
  //   带"付费去广告"推销的墙：promo 0.82 → coverCase|strong 命中，Jev 自己
  //   就能隐藏。所以本层的增量价值在**纯墙**这一类；推销型墙交给 Jev 即可。
  //   两层并存不冲突：本层先跑且不消耗 API 配额，也避免了"先乐观隐藏、
  //   Jev 判 keep 后又把墙恢复出来"那条路径。
  //
  // 识别采用「名词 ∧ 动词」双条件：单看名词会命中讲广告拦截的教程正文，
  // 单看动词会命中页面上一切带"关闭"的按钮。再叠加形态判据（悬浮 / 大覆盖）
  // 作为第二道闸。
  const MAX_TEXT_NODES = 3000; // 单次扫描的文本节点上限，防病态页面
  const MAX_WALLS_PER_SCAN = 5;
  const WALK_MAX = 12; // 从文本节点向上收敛的最大层数
  // 容器文本超过这个长度说明已经爬出墙的范围（到了文章 / 页面级容器）。
  const CONTAINER_TEXT_MAX = 5000;
  // 拆词补判的父容器上限：墙的文案容器很小，页面级容器不该做全文匹配。
  const SPLIT_PARENT_CHILDS = 20;
  const SPLIT_PARENT_TEXT = 200;

  function normalize(raw) {
    return String(raw || "").replace(/\s+/g, " ").trim();
  }

  function hasBothSignals(text) {
    if (!text) return false;
    ANTI_ADBLOCK_NOUN.lastIndex = 0;
    ANTI_ADBLOCK_VERB.lastIndex = 0;
    return ANTI_ADBLOCK_NOUN.test(text) && ANTI_ADBLOCK_VERB.test(text);
  }

  // 墙的形态：吸附 / 悬浮在视口上，或覆盖大面积的居中弹窗。
  // 普通正文段落两者都不满足（这是区分"墙"与"讲墙的文章"的关键）。
  function looksLikeWall(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el === document.body || el === document.documentElement) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 200 || r.height < 80) return false;
    if (r.height > MAX_HIDE_H || r.width > MAX_HIDE_W) return false;
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    const area = vw && vh ? (r.width * r.height) / (vw * vh) : 0;
    const cs = getComputedStyle(el);
    const floating =
      cs.position === "fixed" || cs.position === "sticky" || cs.position === "absolute";
    const z = Number.parseInt(cs.zIndex, 10) || 0;
    const interactive = Boolean(
      el.querySelector(
        "button,[role='button'],a[href],input[type='button'],input[type='submit']"
      )
    );
    if (floating && z >= 10 && interactive) return true;
    if (area >= 0.25 && interactive && r.height >= 150) return true;
    return false;
  }

  // 正文里的反广告讨论（教程 / 新闻）不该被隐藏；悬浮层例外——
  // 有些站点把墙塞进 article 当 overlay。
  function insideReadingContent(el) {
    try {
      const host = el.closest(
        "article,[role='article'],main,[role='main'],.post,.article,.entry-content"
      );
      if (!host) return false;
      const cs = getComputedStyle(el);
      return !(cs.position === "fixed" || cs.position === "sticky");
    } catch {
      return false;
    }
  }

  // 从命中名词的元素向上收敛到"承载整段墙文案、且形态像墙"的最外层容器。
  //
  // 全程用 textContent（不触发布局）；getBoundingClientRect 只在文本闸门
  // 通过后才调，即每次触发最多 WALK_MAX 次、且触发本身很罕见。
  // 早期版本每层都读 innerText，那会在长祖先链上反复强制重排。
  function findWallContainer(start, walls) {
    let el = start;
    let best = null;
    for (let i = 0; i < WALK_MAX && el && el !== document.body; i++) {
      if (el.nodeType === 1) {
        if (el.closest && el.closest("." + HIDDEN_CLASS)) return best;
        for (const w of walls) {
          if (w === el || (w.contains && w.contains(el))) return best || w;
        }
        const raw = String(el.textContent || "");
        if (raw.length > CONTAINER_TEXT_MAX) {
          if (best) break;
          return null;
        }
        const text = normalize(raw);
        if (hasBothSignals(text)) {
          if (looksLikeWall(el)) best = el;
        } else if (best) {
          break;
        }
      }
      el = el.parentElement;
    }
    return best;
  }

  // 用 TreeWalker 扫文本节点（与 labels.js 同一开销模型），
  // 而不是对整页 div 逐个读 innerText——后者会对上千个元素触发布局。
  function collect(root, out) {
    if (!root || (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11)) return;
    const scope = root.nodeType === 1 ? root : document.body;
    if (!scope || !document.createTreeWalker) return;
    let walker;
    try {
      walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    } catch {
      return;
    }
    const walls = [];
    let node;
    let scanned = 0;
    while ((node = walker.nextNode()) && walls.length < MAX_WALLS_PER_SCAN) {
      if (++scanned > MAX_TEXT_NODES) break;
      const t = node.nodeValue;
      if (!t || t.length < 4 || t.length > 300) continue;
      const parent = node.parentElement;
      if (!parent) continue;

      // 触发条件：节点自身含名词；或含动词且**父容器很小**并含名词
      // （覆盖「广告」与「拦截」被拆进不同文本节点 / 子元素的情况）。
      // 父容器上限是为了让这次补判保持 O(小常数)，不会在页面级容器上
      // 做全文匹配——那才是真正的性能陷阱。
      let triggered = ANTI_ADBLOCK_NOUN.test(t);
      if (!triggered && ANTI_ADBLOCK_VERB.test(t) && t.length <= 40) {
        const p = parent;
        if (p.childElementCount <= SPLIT_PARENT_CHILDS) {
          const pt = String(p.textContent || "");
          if (pt.length <= SPLIT_PARENT_TEXT && ANTI_ADBLOCK_NOUN.test(pt)) triggered = true;
        }
      }
      if (!triggered) continue;

      const wall = findWallContainer(parent, walls);
      if (!wall) continue;
      if (ctx.state.judged.has(wall)) continue;
      if (insideReadingContent(wall)) continue;
      walls.push(wall);
    }
    for (const wall of walls) out.push(wall);
  }

  // 墙常同时锁滚动（body / html 内联 overflow:hidden），隐藏了墙却不解锁，
  // 页面仍是滚不动的。只动**内联**值，不碰站点样式表；改动记录到 state，
  // 由「恢复本页」还原。
  function unlockScroll() {
    const records = ctx.state.scrollUnlocks || (ctx.state.scrollUnlocks = []);
    for (const el of [document.documentElement, document.body]) {
      if (!el || !el.style || !el.style.getPropertyValue) continue;
      for (const prop of ["overflow", "overflow-y"]) {
        const v = el.style.getPropertyValue(prop);
        if (!v || !/hidden|clip/i.test(v)) continue;
        if (!records.some((r) => r.el === el && r.prop === prop)) {
          records.push({ el, prop, value: v, priority: el.style.getPropertyPriority(prop) });
        }
        el.style.removeProperty(prop);
      }
    }
  }

  function restoreScroll() {
    const records = ctx.state.scrollUnlocks;
    if (!records || !records.length) return;
    for (const { el, prop, value, priority } of records) {
      try {
        el.style.setProperty(prop, value, priority || "");
      } catch {}
    }
    records.length = 0;
  }

  function apply(root) {
    const walls = [];
    collect(root, walls);
    if (!walls.length) return 0;
    let hidden = 0;
    for (const el of walls) {
      if (ctx.state.judged.has(el)) continue;
      ctx.state.judged.add(el);
      // 确定性路径：命中即隐藏，不进 Jev 候选队列。
      if (ctx.hide.hideEl(el, "anti-adblock")) hidden += 1;
      ctx.log("anti_adblock_hit", { el: describeEl(el), hidden });
    }
    if (hidden > 0) unlockScroll();
    return hidden;
  }

  return { apply, collect, hasBothSignals, looksLikeWall, restoreScroll };
};
