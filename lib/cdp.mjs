#!/usr/bin/env node
/**
 * 零依赖 Chrome DevTools Protocol 客户端（Node >= 22，使用内置 fetch + WebSocket）。
 *
 * 用途：连接「用户自己启动的、带 --remote-debugging-port 的 Chrome」，读取页面真实状态、
 * 执行任意页面 JS、跨 iframe 探测 DOM。它不启动浏览器，也不碰账号密码。
 *
 * 作为库使用：import { listTargets, connectSession, evaluate, buildAdvanceExpr } from "./cdp.mjs"
 * 作为命令行使用：见 printUsage()。
 */
import { readFile } from "node:fs/promises";

export const DEFAULT_PORT = Number(process.env.CDP_PORT || 9222);

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ 目标发现 */

export async function listTargets(port = DEFAULT_PORT, { timeoutMs = 5000 } = {}) {
  const url = `http://127.0.0.1:${port}/json/list`;
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new Error(
      `连不上 ${url}（${error.message}）。` +
        `请确认：1) 已双击 bin/start-chrome-debug.cmd 启动带调试端口的 Chrome；` +
        `2) 端口确实是 ${port}；3) 那个 Chrome 窗口还开着。`,
    );
  }
  if (!response.ok) throw new Error(`${url} 返回 HTTP ${response.status}`);
  const raw = await response.json();
  return raw
    .filter((target) => typeof target.webSocketDebuggerUrl === "string")
    .map((target) => ({
      id: target.id,
      type: target.type,
      title: target.title,
      url: target.url,
      webSocketDebuggerUrl: target.webSocketDebuggerUrl,
    }));
}

/* --------------------------------------------------------------- CDP 会话层 */

class Session {
  #socket;
  #seq = 0;
  #pending = new Map();
  #listeners = new Map();
  closed = false;

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => this.#onMessage(event));
    socket.addEventListener("close", () => this.#failAll(new Error("CDP 连接已关闭")));
    socket.addEventListener("error", () => this.#failAll(new Error("CDP 连接出错")));
  }

  #onMessage(event) {
    let message;
    try {
      message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${message.error.message} (code ${message.error.code})`));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    if (typeof message.method === "string") {
      for (const listener of this.#listeners.get(message.method) ?? []) {
        try {
          listener(message.params ?? {});
        } catch {
          /* 监听器异常不能影响 CDP 主循环 */
        }
      }
    }
  }

  #failAll(error) {
    this.closed = true;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  on(method, listener) {
    const list = this.#listeners.get(method) ?? [];
    list.push(listener);
    this.#listeners.set(method, list);
    return () => {
      const current = this.#listeners.get(method) ?? [];
      this.#listeners.set(
        method,
        current.filter((entry) => entry !== listener),
      );
    };
  }

  send(method, params = {}, { timeoutMs = 20000 } = {}) {
    if (this.closed) return Promise.reject(new Error("CDP 连接已关闭"));
    const id = ++this.#seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP 调用超时：${method}`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.closed = true;
    try {
      this.#socket.close();
    } catch {
      /* 已断开 */
    }
  }
}

export async function connectSession(wsUrl, { timeoutMs = 10000 } = {}) {
  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`WebSocket 握手超时：${wsUrl}`)), timeoutMs);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error(`WebSocket 握手失败：${wsUrl}`));
      },
      { once: true },
    );
  });
  return new Session(socket);
}

/* ------------------------------------------------- 目标会话：维护 execution context */

/**
 * 一个调试目标的会话，持续跟踪其中的 execution context（含同进程 iframe）。
 */
export class TargetSession {
  constructor(target, session) {
    this.target = target;
    this.session = session;
    this.contexts = new Map();
    this.ready = false;
  }

  static async open(target, { settleMs = 500 } = {}) {
    const session = await connectSession(target.webSocketDebuggerUrl);
    const targetSession = new TargetSession(target, session);
    session.on("Runtime.executionContextCreated", (params) => {
      if (params?.context?.id !== undefined) targetSession.contexts.set(params.context.id, params.context);
    });
    session.on("Runtime.executionContextDestroyed", (params) => {
      if (params?.executionContextId !== undefined) targetSession.contexts.delete(params.executionContextId);
    });
    session.on("Runtime.executionContextsCleared", () => targetSession.contexts.clear());
    await session.send("Runtime.enable");
    // 让已有 context 的 created 事件先到达
    await sleep(settleMs);
    targetSession.ready = true;
    return targetSession;
  }

  list() {
    return [...this.contexts.values()].map((context) => ({
      contextId: context.id,
      origin: context.origin ?? "",
      name: context.name ?? "",
      frameId: context.auxData?.frameId ?? null,
      isDefault: context.auxData?.isDefault === true,
      isIframe: context.auxData?.isDefault !== true,
    }));
  }

  mainContext() {
    const all = this.list();
    // 主 frame 的 frameId 等于 target id；同进程 iframe 的 frameId 不是。
    // 不能只靠 isDefault 判断——同进程 iframe 的 context 也是 isDefault，
    // 那会把探针送进随便一个 iframe（例如页面上挂的 AI 客服）。
    return (
      all.find((entry) => entry.frameId === this.target.id) ??
      all.find((entry) => entry.isDefault) ??
      all[0] ??
      null
    );
  }

  async evaluate(expression, { contextId, awaitPromise = true, userGesture = true, timeoutMs = 30000 } = {}) {
    const params = { expression, returnByValue: true, awaitPromise, userGesture };
    if (contextId !== undefined && contextId !== null) params.contextId = contextId;
    const result = await this.session.send("Runtime.evaluate", params, { timeoutMs: timeoutMs + 5000 });
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      throw new Error(`页面抛异常：${details.exception?.description ?? details.text ?? "未知"}`);
    }
    return result.result?.value ?? null;
  }

  /** 在该目标的每一个 execution context 里执行表达式，返回结果数组。 */
  async evaluateEverywhere(expression, options = {}) {
    const results = [];
    for (const context of this.list()) {
      try {
        results.push({
          contextId: context.contextId,
          origin: context.origin,
          isDefault: context.isDefault,
          value: await this.evaluate(expression, { ...options, contextId: context.contextId }),
          error: null,
        });
      } catch (error) {
        results.push({
          contextId: context.contextId,
          origin: context.origin,
          isDefault: context.isDefault,
          value: null,
          error: String(error.message ?? error),
        });
      }
    }
    return results;
  }

  async navigate(url) {
    await this.session.send("Page.navigate", { url }, { timeoutMs: 15000 });
  }

  close() {
    this.session.close();
  }
}

/* ----------------------------------------------------------------- 页面表达式 */

/** 体检表达式：视频状态 + 课程列表候选 + 「下一节」候选。 */
export const PROBE_EXPR = `(() => {
  const vis = (el) => { try { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0'; } catch (e) { return false; } };
  const txt = (el, n) => ((el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim()).slice(0, n || 40);
  const cls = (el) => (typeof el.className === 'string' ? el.className : '').split(/\\s+/).filter(Boolean).slice(0, 3).join('.');
  const videos = [...document.querySelectorAll('video')].map((v, i) => ({
    i, src: String(v.currentSrc || v.src || '').slice(0, 100),
    currentTime: Number(v.currentTime.toFixed(2)),
    duration: Number.isFinite(v.duration) ? Number(v.duration.toFixed(2)) : null,
    paused: v.paused, ended: v.ended, readyState: v.readyState, rate: v.playbackRate, muted: v.muted,
    w: v.videoWidth, h: v.videoHeight, visible: vis(v)
  }));
  const looksLesson = (el) => {
    const href = String(el.getAttribute('href') || '');
    return href.indexOf('/video/') >= 0 || href.indexOf('node_id=') >= 0 || el.hasAttribute('data-node-id') || el.hasAttribute('data-lesson-id');
  };
  const lessonLinks = [...document.querySelectorAll('a[href], [data-node-id], [data-lesson-id]')]
    .filter(looksLesson).slice(0, 120)
    .map((el) => ({ tag: el.tagName.toLowerCase(), text: txt(el, 40), href: String(el.getAttribute('href') || '').slice(0, 160), node: el.getAttribute('data-node-id') || el.getAttribute('data-lesson-id') || null, cls: cls(el), visible: vis(el) }));
  const nextCandidates = [...document.querySelectorAll('button, a, [role="button"], [class*="next" i], [class*="prev" i]')]
    .filter((el) => /下一|下节|next/i.test(txt(el, 40) + ' ' + cls(el) + ' ' + String(el.getAttribute('aria-label') || '')))
    .slice(0, 40)
    .map((el) => ({ tag: el.tagName.toLowerCase(), text: txt(el, 40), cls: cls(el), visible: vis(el), disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true' }));
  // 给写规则的人看：页面上哪些元素带 id。目录项常常是纯 div + id（例如 unit-item-85936697），
  // 这类项既不会出现在 lessonLinks（没有 href），也不会出现在 nextCandidates（文案不含「下一节」）。
  const idSamples = [...document.querySelectorAll('[id]')]
    .filter((el) => {
      // 排除 SVG 精灵图（<symbol id="icon-..."> 动辄几十个）和脚本类元素：
      // 它们会把真正有用的 id 挤出列表，让写规则的人看不到目录项。
      if (typeof SVGElement !== 'undefined' && el instanceof SVGElement) return false;
      const tag = el.tagName.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'link' || tag === 'meta') return false;
      return el.id.length > 0 && el.id !== 'MathJax_Message';
    })
    .slice(0, 30)
    .map((el) => ({ tag: el.tagName.toLowerCase(), id: el.id, cls: cls(el), text: txt(el, 30), visible: vis(el) }));
  return {
    url: location.href, title: document.title, frames: window.frames.length,
    videos, lessonLinks, nextCandidates, idSamples,
    bodyText: document.body ? document.body.innerText.replace(/\\s+/g, ' ').slice(0, 300) : ''
  };
})()`;

/** 轻量表达式：只回报主视频状态。 */
export const VIDEO_EXPR = `(() => {
  const vs = [...document.querySelectorAll('video')];
  if (vs.length === 0) return null;
  const ranked = vs
    .map((v) => { const r = v.getBoundingClientRect(); return { v, area: Math.round(r.width * r.height) }; })
    .sort((a, b) => b.area - a.area);
  const pick = ranked[0];
  return {
    url: location.href, title: document.title,
    currentTime: Number(pick.v.currentTime.toFixed(2)),
    duration: Number.isFinite(pick.v.duration) ? Number(pick.v.duration.toFixed(2)) : null,
    paused: pick.v.paused, ended: pick.v.ended, readyState: pick.v.readyState,
    area: pick.area, width: pick.v.videoWidth, height: pick.v.videoHeight,
    videoCount: vs.length
  };
})()`;

/** 让视频继续播放。 */
export const PLAY_EXPR = `(() => {
  const vs = [...document.querySelectorAll('video')];
  if (vs.length === 0) return { played: false, reason: 'no-video' };
  const v = vs.map((el) => { const r = el.getBoundingClientRect(); return { el, area: r.width * r.height }; }).sort((a, b) => b.area - a.area)[0].el;
  if (!v.paused) return { played: false, reason: 'already-playing' };
  v.muted = false;
  const p = v.play();
  if (p && typeof p.catch === 'function') p.catch(() => {});
  return { played: true, at: Number(v.currentTime.toFixed(2)) };
})()`;

/**
 * 构造页面内的「翻到下一节」表达式。
 * 按 自定义 → 课程目录树 → 播放器箭头 → 文案匹配 → 链接列表 依次尝试。
 *
 * 目录树排在箭头前面是有意的：目录树能表达「下一个**视频**」（跳过习题页），
 * 而箭头只会盲翻到「下一个条目」，翻进习题页就找不到 <video> 也找不到目录树了。
 *
 * @param {object} options
 * @param {string|null} options.videoId 当前视频 id（用于在链接列表里定位当前条目）
 * @param {string|null} options.selector config.json 里配置的选择器
 * @param {string|null} options.js config.json 里配置的自定义表达式
 * @param {string|null} options.nextUnit 播放器右上角「下一单元」箭头选择器
 * @param {object|null} options.navItem 目录树策略的形态（雨课堂用 .leaf-item 这类纯 div 目录）
 * @param {string[]} options.skip 本轮跳过的策略名：js|selector|leaf-deep|leaf-self|unit-arrow|text|outline
 * @param {boolean} options.dryRun 只报告「会点哪个」，不真的点。翻页不可逆，先演习再动手。
 */
export function buildAdvanceExpr({
  videoId = null,
  selector = null,
  js = null,
  nextUnit = null,
  navItem = null,
  skip = [],
  dryRun = false,
} = {}) {
  return `(() => {
  const skip = ${JSON.stringify(skip)};
  const dry = ${JSON.stringify(dryRun === true)};
  const fired = [];
  // 目录树是「这门课还有没有下一个视频」的权威来源。它说没有了，就是课程到头，
  // 而不是故障——两者要分清楚，否则报错会让读的人跑去查根本不存在的问题。
  let navExhausted = false;
  const vis = (el) => { try { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none'; } catch (e) { return false; } };
  const dis = (el) => el.disabled === true || el.getAttribute('aria-disabled') === 'true' || /disabled/i.test(typeof el.className === 'string' ? el.className : '');
  const label = (el) => ((el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim()).slice(0, 60);
  const describe = (el) => ({
    tag: el.tagName.toLowerCase(),
    // 保留足够多的 class：截太短会把 arrow-reverse 这类关键标识截掉，日志就没法复核
    cls: (typeof el.className === 'string' ? el.className : '').split(/\\s+/).filter(Boolean).slice(0, 8).join('.'),
    text: label(el)
  });
  // 所有策略都走这里：dry 时只记录不点击
  const shot = (how, detail, el) => {
    fired.push({ how, detail, target: el ? describe(el) : null });
    if (el && !dry) {
      try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
      el.click();
    }
    return { ok: true, how, detail, dryRun: dry, exhausted: navExhausted, notes: failed.slice(), fired };
  };
  const cur = ${JSON.stringify(videoId)};
  const failed = [];

  const customJs = ${JSON.stringify(js)};
  if (customJs && skip.indexOf('js') < 0) {
    try { const r = (0, eval)(customJs); return { ok: true, how: 'config.js', detail: r === undefined ? null : String(r).slice(0, 200), dryRun: dry, fired }; }
    catch (e) { failed.push('config.js: ' + e.message); }
  }

  const customSelector = ${JSON.stringify(selector)};
  if (customSelector && skip.indexOf('selector') < 0) {
    const el = [...document.querySelectorAll(customSelector)].find((node) => !dis(node) && vis(node));
    if (el) return shot('config.selector', label(el), el);
    failed.push('config.selector 没有可用元素: ' + customSelector);
  }

  // 课程目录树。它排在「下一节按钮」和「下一单元箭头」之前是有意的：
  // 只有目录树能表达「下一个**视频**」，从而跳过习题页；进到习题页会既没有播放器也没有目录树。
  //   - 雨课堂：纯 div + is-active 标记「正在学的那节」
  //   - 学堂在线研究生院：每项带 id="unit-item-<视频id>"，且折叠章节里的项是 display:none
  const nav = ${JSON.stringify(navItem)};
  const wantHref = skip.indexOf('leaf-href') < 0;
  const wantDeep = skip.indexOf('leaf-deep') < 0;
  const wantSelf = skip.indexOf('leaf-self') < 0;
  if (nav && (wantHref || wantDeep || wantSelf)) {
    const items = [...document.querySelectorAll(nav.item)];
    let activeIndex = -1;
    if (nav.activeClass) {
      activeIndex = items.findIndex((el) => el.classList && el.classList.contains(nav.activeClass));
    }
    if (activeIndex < 0 && nav.progress) {
      // 没有 is-active 时退一步：正在看的那个通常带进度环
      activeIndex = items.findIndex((el) => el.querySelector(nav.progress));
    }
    if (activeIndex < 0 && nav.idPattern && cur) {
      // 或者：项 id 里就带着当前视频 id
      const re = new RegExp(nav.idPattern);
      activeIndex = items.findIndex((el) => re.test(String(el.id || '')));
    }
    if (activeIndex >= 0) {
      let nextIndex = -1;
      for (let i = activeIndex + 1; i < items.length; i++) {
        const tagEl = items[i].querySelector(nav.tag);
        const tagText = tagEl ? (tagEl.innerText || tagEl.textContent || '').trim() : '';
        if (tagText !== '' && nav.videoTagText !== '' && tagText.indexOf(nav.videoTagText) < 0) {
          failed.push('跳过非视频项：' + label(items[i]));
          continue;
        }
        nextIndex = i;
        break;
      }
      if (nextIndex >= 0) {
        const nextEl = items[nextIndex];
        const detail = '第 ' + activeIndex + ' 项 → 第 ' + nextIndex + ' 项: ' + label(nextEl);
        // (1) 直接改地址。折叠章节里的项是 display:none，点它能不能触发是没保证的；
        //     而项 id 里带着视频 id，把当前地址的 /video/<id> 换掉最确定。
        //     用 setTimeout 让求值先返回，否则导航会拆掉执行上下文、拿不到结果。
        if (wantHref && nav.hrefFromId && nav.idPattern) {
          const idMatch = String(nextEl.id || '').match(new RegExp(nav.idPattern));
          const urlMatch = String(location.href).match(/^(.*\\/video\\/)\\d+(\\/?(?:[?#].*)?)$/);
          if (idMatch && urlMatch) {
            const url = urlMatch[1] + idMatch[1] + urlMatch[2];
            fired.push({ how: 'leaf-href', detail, target: { tag: 'url', cls: '', text: url } });
            if (!dry) setTimeout(function () { location.href = url; }, 50);
            return { ok: true, how: 'leaf-href', detail: detail + ' → ' + url, dryRun: dry, exhausted: false, notes: failed.slice(), fired };
          }
          failed.push('无法从 ' + nextEl.id + ' 推出下一个视频地址');
        }
        // (2) 点最深处的元素：click 会向上冒泡，能同时覆盖挂在任意祖先上的处理器
        if (wantDeep) return shot('leaf-deep', detail, nextEl.querySelector(nav.title) || nextEl);
        // (3) 退化成点整行
        if (wantSelf) return shot('leaf-self', detail, nextEl);
      } else {
        // 找到了正在播放的项，但后面再没有视频项了 → 课程的视频部分到此结束
        navExhausted = true;
        failed.push('课程目录里已经是最后一个视频项');
      }
    } else {
      failed.push('课程目录里没找到正在播放的项（共 ' + items.length + ' 个）');
    }
  }

  if (skip.indexOf('text') < 0) {
    const NEXT = /^(下一(节|课|讲|章|个)?|下节|next(\\s+(lesson|video|section))?)\\s*[>》»]?$/i;
    for (const el of document.querySelectorAll('button, a, [role="button"], [class*="next" i]')) {
      const text = ((el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim());
      if (text.length === 0 || text.length > 12 || !NEXT.test(text)) continue;
      if (dis(el) || !vis(el)) continue;
      return shot('text', text, el);
    }
    failed.push('没有找到「下一节」按钮');
  }

  if (skip.indexOf('outline') < 0 && cur) {
    const anchors = [...document.querySelectorAll('a[href], [data-node-id], [data-lesson-id]')];
    const idx = anchors.findIndex((el) => {
      const href = String(el.getAttribute('href') || '');
      const node = String(el.getAttribute('data-node-id') || el.getAttribute('data-lesson-id') || '');
      return href.indexOf('/video/' + cur) >= 0 || (node !== '' && node === cur);
    });
    if (idx >= 0) {
      for (let i = idx + 1; i < anchors.length; i++) {
        const el = anchors[i];
        const href = String(el.getAttribute('href') || '');
        if (href.indexOf('/video/') < 0 && !el.hasAttribute('data-node-id') && !el.hasAttribute('data-lesson-id')) continue;
        if (dis(el)) continue;
        return shot('outline', '第 ' + idx + ' 项 → 第 ' + i + ' 项: ' + label(el), el);
      }
      failed.push('当前视频已是课程列表最后一项（第 ' + idx + ' 项）');
    } else {
      failed.push('课程列表里没找到当前视频 ' + cur + '（共 ' + anchors.length + ' 个链接）');
    }
  }

  // 播放器自带的「下一单元」箭头。它翻的是课程里的「下一个条目」，可能是习题页——
  // 而习题页既没有 <video> 也没有课程目录树，进去就出不来了。
  // 所以它排在目录树之后：目录树能表达「下一个视频」，箭头只会盲翻。
  const nextUnit = ${JSON.stringify(nextUnit)};
  if (nextUnit && skip.indexOf('unit-arrow') < 0) {
    const el = [...document.querySelectorAll(nextUnit)].find((node) => !dis(node) && vis(node));
    if (el) return shot('unit-arrow', '播放器下一单元箭头: ' + nextUnit, el);
    failed.push('没有找到可点的「下一单元」箭头: ' + nextUnit);
  }

  return { ok: false, how: null, detail: failed.join('；') || '没有任何可用策略', dryRun: dry, exhausted: navExhausted, fired };
})()`;
}

/* --------------------------------------------------------------------- CLI */

function parseArgs(argv) {
  const options = { port: DEFAULT_PORT, target: null, frame: "main", file: null, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port") options.port = Number(argv[++i]);
    else if (arg === "--target") options.target = argv[++i];
    else if (arg === "--frame") options.frame = argv[++i];
    else if (arg === "--file") options.file = argv[++i];
    else if (arg.startsWith("--")) throw new Error(`未知参数：${arg}`);
    else options.positional.push(arg);
  }
  return options;
}

function pickTarget(targets, wanted) {
  if (targets.length === 0) throw new Error("没有发现任何可调试目标");
  if (!wanted) {
    return targets.find((target) => target.type === "page") ?? targets[0];
  }
  const exact = targets.find((target) => target.id === wanted);
  if (exact) return exact;
  const matched = targets.find((target) => target.url.includes(wanted) || (target.title ?? "").includes(wanted));
  if (matched) return matched;
  throw new Error(`没有匹配 --target ${wanted} 的目标；当前有：${targets.map((t) => `${t.type}:${t.url}`).join(" | ")}`);
}

async function withTarget(options, callback) {
  const targets = await listTargets(options.port);
  const target = pickTarget(targets, options.target);
  const session = await TargetSession.open(target);
  try {
    return await callback(session, targets);
  } finally {
    session.close();
  }
}

function printUsage() {
  process.stdout.write(
    [
      "用法：node cdp.mjs <命令> [选项]",
      "",
      "命令：",
      "  list                列出可调试目标（页面 / iframe / 新标签页）",
      "  frames              列出某目标内的 frame / execution context",
      "  probe               探测页面结构：video、课程列表、下一节候选",
      "  eval <expr>         在页面里执行 JS，返回 JSON（--file 从文件读取表达式）",
      "  nav <url>           让目标页面跳转到指定 URL",
      "",
      "选项：",
      "  --port <n>          调试端口，默认 9222（env CDP_PORT）",
      "  --target <id|子串>  指定目标，默认第一个 page（可用 id、URL 或标题子串）",
      "  --frame <all|id>    eval 的作用域：main（默认）或 all（所有 frame）或具体 contextId",
      "  --file <path>       eval 的表达式从文件读取，避免 shell 引号地狱",
      "",
    ].join("\n"),
  );
}

async function main() {
  const [, , command, ...rest] = process.argv;
  if (!command || command === "help" || command === "--help") {
    printUsage();
    return;
  }
  const options = parseArgs(rest);

  if (command === "list") {
    const targets = await listTargets(options.port);
    process.stdout.write(JSON.stringify({ ok: true, port: options.port, count: targets.length, targets }, null, 2) + "\n");
    return;
  }

  if (command === "frames") {
    await withTarget(options, async (session) => {
      process.stdout.write(JSON.stringify({ ok: true, target: session.target, contexts: session.list() }, null, 2) + "\n");
    });
    return;
  }

  if (command === "probe") {
    await withTarget(options, async (session) => {
      const results = await session.evaluateEverywhere(PROBE_EXPR, { awaitPromise: false });
      const frames = results.map((entry) => ({ ...entry, value: entry.value }));
      process.stdout.write(JSON.stringify({ ok: true, target: session.target, frames }, null, 2) + "\n");
    });
    return;
  }

  if (command === "eval") {
    const expression = options.file ? await readFile(options.file, "utf8") : options.positional[0];
    if (!expression) throw new Error("eval 需要一个表达式，或用 --file <path> 指定文件");
    await withTarget(options, async (session) => {
      if (options.frame === "all") {
        const results = await session.evaluateEverywhere(expression);
        process.stdout.write(JSON.stringify({ ok: true, results }, null, 2) + "\n");
        return;
      }
      const contextId = options.frame === "main" ? session.mainContext()?.contextId : Number(options.frame);
      const value = await session.evaluate(expression, { contextId });
      process.stdout.write(JSON.stringify({ ok: true, value }, null, 2) + "\n");
    });
    return;
  }

  if (command === "nav") {
    const url = options.positional[0];
    if (!url) throw new Error("nav 需要一个 URL");
    await withTarget(options, async (session) => {
      await session.navigate(url);
      await sleep(1500);
      process.stdout.write(JSON.stringify({ ok: true, navigated: url, contexts: session.list() }, null, 2) + "\n");
    });
    return;
  }

  throw new Error(`未知命令：${command}`);
}

// 仅在被直接执行时跑 CLI；被 watch.mjs import 时保持安静。
const entry = process.argv[1] ?? "";
const invokedDirectly = entry !== "" && import.meta.url === new URL(`file://${entry.replace(/\\/g, "/")}`).href;
if (invokedDirectly) {
  main().catch((error) => {
    process.stdout.write(JSON.stringify({ ok: false, error: String(error?.message ?? error) }, null, 2) + "\n");
    process.exitCode = 1;
  });
}
