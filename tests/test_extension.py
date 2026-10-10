#!/usr/bin/env python3
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
EXT_PATH = str(ROOT / "dist")
API_KEY = os.environ.get("TYPESAFE_API_KEY", "")
PORT = int(os.environ.get("JEV_FIXTURE_PORT", "8765"))
BASE = Path(tempfile.gettempdir()) / "jev-adblock-e2e"
USER_DATA = str(BASE / "jev-ext-profile")
SCREENSHOT = str(BASE / "jev-fixture.png")


def wait_for(condition, timeout=30.0, interval=0.25):
    end = time.time() + timeout
    while time.time() < end:
        if condition():
            return True
        time.sleep(interval)
    return False


def main():
    if not API_KEY:
        print("TYPESAFE_API_KEY missing", file=sys.stderr)
        return 2

    shutil.rmtree(USER_DATA, ignore_errors=True)
    Path(BASE).mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            user_data_dir=USER_DATA,
            headless=False,
            args=[
                f"--disable-extensions-except={EXT_PATH}",
                f"--load-extension={EXT_PATH}",
                "--host-resolver-rules=MAP www.zhihu.com 127.0.0.1, MAP zhihu.com 127.0.0.1",
                "--no-first-run",
                "--no-default-browser-check",
            ],
            viewport={"width": 1280, "height": 900},
        )

        page = context.new_page()
        console = []
        page.on("console", lambda m: console.append(f"{m.type}: {m.text}"))
        page.on("pageerror", lambda e: console.append(f"pageerror: {e}"))
        page.goto(
            f"http://www.zhihu.com:{PORT}/fixture.html",
            wait_until="domcontentloaded",
        )

        sw = None
        if wait_for(lambda: bool(context.service_workers), timeout=15.0):
            sw = context.service_workers[0]
        if sw is None:
            print("FAIL: no extension service worker", file=sys.stderr)
            print("console:", console[-20:], file=sys.stderr)
            context.close()
            return 1

        sw.evaluate(
            """async (key) => {
              await chrome.storage.local.set({
                apiKey: key,
                globalEnabled: true,
                // 自定义选择器是强制语义（命中即隐藏，不交 Jev）：
                // .force-target   命中 #force-hidden-slot（刻意做成非广告），
                //                 用来证明隐藏来自用户选择器而非碰巧判对。
                // .sponsored-box  命中 #stubborn-ad-slot(广告)，被测试按需剥掉
                //                 class，用于验证重扫/兜底能重新隐藏且不残留抖动。
                // 注意：误报恢复路径（乐观隐藏→判非广告→恢复）改由
                // #neutral-announcement 的 advert-* class 命中站点 detector 驱动，
                // 不能再依赖自定义选择器——它已经不走那条路了。
                customSelectors: ['.force-target', '.sponsored-box'],
              });
            }""",
            API_KEY,
        )
        page.wait_for_timeout(500)

        def hidden(sel):
            return page.evaluate(
                """(sel) => {
                  const el = document.querySelector(sel);
                  if (!el) return false;
                  return el.classList.contains('jev-ad-hidden') || getComputedStyle(el).display === 'none';
                }""",
                sel,
            )

        def present_visible(sel):
            return page.evaluate(
                """(sel) => {
                  const el = document.querySelector(sel);
                  if (!el) return false;
                  const st = getComputedStyle(el);
                  return !el.classList.contains('jev-ad-hidden') && st.display !== 'none';
                }""",
                sel,
            )

        def stats():
            return sw.evaluate(
                """async () => {
                  const tabs = await chrome.tabs.query({ url: '*://www.zhihu.com/*' });
                  if (!tabs.length) return { error: 'no tab' };
                  try {
                    return await chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_STATS' });
                  } catch (e) {
                    return { error: String(e) };
                  }
                }"""
            )

        def logs():
            return sw.evaluate(
                """async () => {
                  const { logsByTab } = await chrome.storage.session.get('logsByTab');
                  const merged = [];
                  if (logsByTab) {
                    for (const arr of Object.values(logsByTab)) {
                      if (Array.isArray(arr)) merged.push(...arr);
                    }
                  }
                  merged.sort((a, b) => (a.ts || 0) - (b.ts || 0));
                  return merged;
                }"""
            )

        deterministic_ok = wait_for(
            lambda: hidden("#common-ad-slot")
            and hidden("#labeled-post")
            and hidden("#zhihu-feed-ad"),
            timeout=45.0,
        )
        jv_ok = wait_for(
            lambda: hidden("#ambiguous-promo") and hidden("#sticky-download"),
            timeout=45.0,
        )
        protect_ok = wait_for(
            lambda: present_visible("#recommend-section")
            and present_visible("#sidebar-recommend")
            and present_visible("#qq-mail-list")
            and present_visible("#qq-sidebar"),
            timeout=45.0,
        )
        sidebar_ok = wait_for(
            lambda: hidden("#sidebar-yanyan") and hidden("#sidebar-zsxuetang"),
            timeout=45.0,
        )

        def jev_ad_attr(sel):
            return page.evaluate(
                """(sel) => {
                  const el = document.querySelector(sel);
                  return el ? el.getAttribute('data-jev-ad') : null;
                }""",
                sel,
            )

        # 自定义选择器 = 强制语义：命中即隐藏且标记 reason='force'。
        # 该元素内容刻意做成非广告，若隐藏来自 Jev 判决，attr 会是 'jev*' 且
        # 迟早被恢复；只有 'force' 能证明走的是用户选择器这条确定性路径。
        force_ok = wait_for(
            lambda: jev_ad_attr("#force-hidden-slot") == "force",
            timeout=45.0,
        )

        # ---- 闪烁（自触发扫描循环）检测 ----
        # 症状：页面每 1-2s（循环）或每 4s（sweep 与站点抢写 display）闪一次。
        # 只比对最终状态是抓不到的——循环在两相之间交替，采样到哪一相就判哪个结果。
        #
        # 注意：轮询采样不可靠。实测循环里元素每个周期只被隐藏约 100ms
        # （7 次循环 / 6s，其中可见相位占约 90%），100ms 轮询会整周期漏掉。
        # 因此这里改用两路精确计数，都不依赖采样时机：
        #   ① 属性抖动：页面内 MutationObserver 精确记录每个目标的 class/style 变更次数；
        #   ② 空闲期自活动：页面 idle 时不应继续产生 hide/restore/judge 事件。
        FLASH_TARGETS = [
            # 应保持隐藏
            "#common-ad-slot", "#labeled-post", "#zhihu-feed-ad",
            "#ambiguous-promo", "#sticky-download",
            "#sidebar-yanyan", "#sidebar-zsxuetang",
            "#force-hidden-slot",
            # 应保持可见（受保护内容 / 判定为非广告 / 乐观隐藏后恢复）
            "#main-article", "#recommend-section", "#qq-mail-list", "#qq-sidebar",
            "#neutral-announcement",
        ]
        FLASH_WINDOW_MS = 6000

        def event_counts_snapshot():
            counts = {}
            for e in logs():
                ev = e.get("event")
                counts[ev] = counts.get(ev, 0) + 1
            return counts

        # 启动期收尾事件先结算：连续两次快照无新增（间隔 > 日志 300ms 持久化 debounce）。
        # 循环存在时这里会跑满 40 轮，属预期。
        for _ in range(40):
            snap_a = event_counts_snapshot()
            page.wait_for_timeout(800)
            if snap_a == event_counts_snapshot():
                break

        page.wait_for_timeout(600)  # 等日志持久化（300ms debounce）落盘
        before = event_counts_snapshot()

        # ① 属性抖动：精确到每一次写入，不受采样率影响
        page.evaluate(
            """(sels) => {
              window.__jevAttrs = {};
              const obs = new MutationObserver((muts) => {
                for (const m of muts) {
                  const id = m.target.id || m.target.className;
                  window.__jevAttrs[id] = (window.__jevAttrs[id] || 0) + 1;
                }
              });
              for (const s of sels) {
                const el = document.querySelector(s);
                if (el) obs.observe(el, { attributes: true, attributeFilter: ['class', 'style'] });
              }
              window.__jevAttrObserver = obs;
            }""",
            FLASH_TARGETS,
        )
        page.wait_for_timeout(FLASH_WINDOW_MS)
        attrs_after = page.evaluate(
            """() => {
              if (window.__jevAttrObserver) window.__jevAttrObserver.disconnect();
              return window.__jevAttrs;
            }"""
        )
        page.wait_for_timeout(600)
        after = event_counts_snapshot()

        churn = {k: v for k, v in (attrs_after or {}).items() if v}
        idle_events = {
            k: after.get(k, 0) - before.get(k, 0)
            for k in after
            if after.get(k, 0) - before.get(k, 0) > 0
        }
        # 只对"循环特征"事件断言：一次性的收尾事件不算闪烁，
        # 但 hide/restore/judge 反复出现就是自触发循环。
        # 注意 reapply_hidden 不在此列：站点脚本夺回显示时 sweep 兜底重写是
        # 设计行为，它归下面的 sweep 专项断言管，混进来会把预期行为误判成循环。
        LOOP_EVENTS = (
            "hide", "restore_el", "restore",
            "enqueue", "judge_request", "judge_result",
        )
        loop_events = {k: v for k, v in idle_events.items() if k in LOOP_EVENTS}

        print(f"flash window: {FLASH_WINDOW_MS}ms")
        print("attribute churn (class/style writes):", churn or "none")
        print("idle-window events:", idle_events or "none")
        print("idle-window loop events:", loop_events or "none")

        # ---- 反广告对抗：站点剥掉插件的 class ----
        # 内联 display 覆盖是无效的（hide.css 的 .jev-ad-hidden{display:none!important}
        # 是样式表规则，压过站点内联写入）。站点要夺回显示必须连 class 一起去掉，
        # 这正是反广告脚本的常规做法——也是本项要覆盖的真实路径。
        #
        # 对抗由测试按需驱动而非页面常驻脚本：常驻脚本会让页面永不静默，
        # 就无法把"页面引发的重扫"与"插件自触发"区分开。这里分两段验证：
        #   ① 夺回后插件必须能重新隐藏（含量化恢复耗时）；
        #   ② 恢复写入后页面必须重新静默——自身的 hide 写入不得触发重扫，
        #      否则又是一条周期性闪烁路径。
        is_stubborn_hidden = """() => document.getElementById('stubborn-ad-slot')
                                          .classList.contains('jev-ad-hidden')"""
        strip_class = """() => {
          const el = document.getElementById('stubborn-ad-slot');
          el.classList.remove('jev-ad-hidden');
          el.style.removeProperty('display');
        }"""
        STRIP_ROUNDS = 3
        recover_ms = []
        for _ in range(STRIP_ROUNDS):
            page.evaluate(strip_class)
            t0 = time.time()
            back = wait_for(lambda: page.evaluate(is_stubborn_hidden), timeout=15.0, interval=0.1)
            recover_ms.append(round((time.time() - t0) * 1000) if back else None)
        stubborn_recovered = page.evaluate(is_stubborn_hidden)

        # 静默期：等 >1 个 sweep 周期（4s），再确认恢复写入没有留下持续活动
        page.wait_for_timeout(5000)
        before_quiet = event_counts_snapshot()
        page.evaluate(
            """() => {
              window.__jevQuiet = {};
              const el = document.getElementById('stubborn-ad-slot');
              const obs = new MutationObserver((muts) => {
                for (const m of muts) {
                  window.__jevQuiet[m.attributeName] =
                    (window.__jevQuiet[m.attributeName] || 0) + 1;
                }
              });
              obs.observe(el, { attributes: true, attributeFilter: ['class', 'style'] });
              window.__jevQuietObserver = obs;
            }"""
        )
        page.wait_for_timeout(FLASH_WINDOW_MS)
        stubborn_churn = page.evaluate(
            """() => {
              window.__jevQuietObserver.disconnect();
              return window.__jevQuiet;
            }"""
        )
        page.wait_for_timeout(600)
        after_quiet = event_counts_snapshot()

        quiet_delta = {
            k: after_quiet.get(k, 0) - before_quiet.get(k, 0)
            for k in after_quiet
            if after_quiet.get(k, 0) - before_quiet.get(k, 0) > 0
        }
        quiet_retrigger = {k: v for k, v in quiet_delta.items() if k in LOOP_EVENTS}

        print(f"anti-adblock: 恢复用时(ms) {recover_ms}, 最终已恢复 {stubborn_recovered}")
        print("quiet-window events:", quiet_delta or "none")
        print("自触发重扫:", quiet_retrigger or "none")
        print("stubborn 元素属性抖动:", stubborn_churn or "none")

        page.screenshot(path=SCREENSHOT, full_page=True)
        st = stats()
        lg = logs()
        events = [e.get("event") for e in lg]
        event_counts = {}
        for ev in events:
            event_counts[ev] = event_counts.get(ev, 0) + 1
        enqueue_text = [
            e.get("data", {}).get("text", "")
            for e in lg
            if e.get("event") == "enqueue"
        ]
        hide_skips = [e.get("data") for e in lg if e.get("event") == "hide_skip"]
        judge_results = [e.get("data") for e in lg if e.get("event") == "judge_result"]

        # 不截断：之前 [:8] 恰好把第 9 条（#qq-sidebar）挡在视野外，
        # 让"受保护内容被误判"看起来像时序问题。
        print("judge_results all:")
        for r in judge_results:
            print("   ", {k: r.get(k) for k in ("key", "el", "source", "score", "ad", "main", "action")})
        print("DIAG state:", page.evaluate("""() => {
          const sels = ["#recommend-section","#sidebar-recommend","#qq-mail-list",
                        "#qq-sidebar","#main-article","#neutral-announcement",
                        "#stubborn-ad-slot","#force-hidden-slot"];
          const out = {};
          for (const s of sels) {
            const el = document.querySelector(s);
            if (!el) { out[s] = "missing"; continue; }
            const r = el.getBoundingClientRect();
            out[s] = {
              jevHidden: el.classList.contains("jev-ad-hidden"),
              attrs: el.getAttribute("data-jev-ad"),
              display: getComputedStyle(el).display,
              rect: [Math.round(r.top), Math.round(r.bottom), Math.round(r.width)],
              vh: window.innerHeight,
            };
          }
          return out;
        }"""))


        checks = {
            "jev hides detector/label": deterministic_ok,
            "protect recommend visible": protect_ok,
            "qqmail containers visible": present_visible("#qq-mail-list")
            and present_visible("#qq-sidebar"),
            "jev ambiguous+overlay": jv_ok,
            "zhihu sidebar promos": sidebar_ok,
            # 自定义选择器为强制语义：误判也不该被 Jev 恢复
            "custom selector force-hides": force_ok and hidden("#force-hidden-slot"),
            "site=zhihu": any(
                e.get("event") == "site"
                and (e.get("data") or {}).get("name") == "zhihu"
                for e in lg
            ),
            "enqueue includes sidebar promo text": any(
                "盐言" in t or "付费咨询" in t or "知乎知学堂" in t
                for t in enqueue_text
            ),
            "stats site=zhihu": (st or {}).get("site") == "zhihu",
            "stats hidden>0": (st or {}).get("hidden", 0) > 0,
            "no attribute churn": not churn,
            "no idle self-trigger": not loop_events,
            # 反广告对抗：class 被剥掉后须重新隐藏；且恢复写入不得留下自触发
            "recovers stripped ad slot": stubborn_recovered and all(recover_ms),
            "no self-trigger after recovery": not quiet_retrigger and not stubborn_churn,
            # 误报不应被永久隐藏：乐观隐藏后须恢复
            "false positive restored": present_visible("#neutral-announcement"),
        }

        print("stats:", st)
        print("event_counts:", event_counts)
        print("enqueue_text sample:", enqueue_text[:8])
        print("hide_skips:", hide_skips)
        print("checks:", checks)
        print("console tail:", console[-8:])
        print("screenshot:", SCREENSHOT)

        failed = [k for k, v in checks.items() if not v]
        context.close()
        if failed:
            print("FAIL:", ", ".join(failed), file=sys.stderr)
            return 1
        print("PASS")
        return 0


if __name__ == "__main__":
    sys.exit(main())
