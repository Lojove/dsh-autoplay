#!/usr/bin/env node
/**
 * 雨课堂 / 学堂在线 课程视频：监控播放进度，播完自动翻到下一节。
 *
 * 它只做两件事：读页面上 <video> 的真实进度；播完后在页面里点「下一节」。
 * 不伪造学习进度、不调用任何上报接口、不接管账号登录。
 *
 * 用法：
 *   node watch.mjs status [--port 9222]              一次性打印当前播放状态
 *   node watch.mjs run    [--port 9222] [--max-lessons 60] [--poll 5000]
 *
 * 作为后台任务跑时，stdout 是逐行 JSON 状态，便于上层读取。
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT, PLAY_EXPR, TargetSession, VIDEO_EXPR, buildAdvanceExpr, listTargets, sleep } from "./cdp.mjs";

// 数据目录由宿主插件注入：插件装在 profile 下，不能假设包目录本身可写。
let dataDir = null;
/** 设置状态/日志/启动地址的落盘目录。 */
export function setDataDir(dir) {
  dataDir = dir;
  return dataDir;
}
function stateDirOf() {
  if (dataDir === null) throw new Error("dsh-autoplay: dataDir 尚未设置");
  return dataDir;
}

/**
 * 各站点的页面形态。同一个技能要跑多个平台，而每个平台的播放器 / 课程目录结构都不一样，
 * 所以站点相关的选择器放这里，按「当前视频地址的域名」匹配；匹配不到就只用通用策略
 * （文案「下一节」、链接列表）。
 */
const DEFAULT_SITES = [
  {
    id: "buaa-yuketang",
    name: "北航雨课堂",
    match: ["buaa.yuketang.cn"],
    advance: {
      // 播放器右上角自带的「下一单元」箭头（向右那个）
      nextUnit: ".unit-arrow.arrow-reverse",
      // 雨课堂的课程目录是纯 div 列表（无 <a href>、无 data-node-id）：
      // 正在学的那节带 is-active，每节用 .leaf-item-tag 标类型。
      navItem: {
        item: ".leaf-item",
        activeClass: "is-active",
        tag: ".leaf-item-tag",
        title: ".leaf-item-title",
        videoTagText: "视频",
        progress: ".status-pie",
      },
    },
  },
  {
    id: "graduate-xuetangx",
    name: "学堂在线研究生院",
    match: ["graduate.xuetangx.com"],
    advance: {
      // 这个平台的目录项带 id="unit-item-<视频id>"，而折叠章节里的项是 display:none
      // （每个叶子外面套了一层自己的 .menu-content，只有当前项那层是 display:block）。
      // 点隐藏元素能不能触发是没保证的，所以优先「从 id 推出下一个视频地址直接跳过去」。
      navItem: {
        item: ".menu-content-item",
        activeClass: "is-active",
        idPattern: "^unit-item-(\\d+)$",
        hrefFromId: true,
        tag: ".item-type",
        title: ".item-name",
        videoTagText: "视频",
        progress: null,
      },
    },
  },
];

const DEFAULTS = {
  port: DEFAULT_PORT,
  startUrl: null,
  open: false,
  pollMs: 5000,
  logEveryMs: 30000,
  endThresholdSec: 2,
  minDurationSec: 10,
  resumeIfPaused: true,
  resumeAfterTicks: 2,
  // 点完翻页控件后，最多等多久让新视频出现；等不到就算这个策略失败，换下一个
  afterAdvanceWaitMs: 25000,
  advanceAttempts: 3,
  maxLessons: 60,
  // 还没开始播之前，等用户把课程页打开的耐心
  noVideoTimeoutMs: 900000,
  // 已经在播了却突然找不到视频：等这么久就尝试自救
  lostVideoTimeoutMs: 120000,
  maxRecoveries: 2,
  // 连不上调试端口（浏览器被关了）时等多久。用户可能只是手滑关窗，等他把窗口开回来。
  browserDownTimeoutMs: 1800000,
  stopWhenBlocked: true,
  // 通用兜底：任何站点都能用文案匹配和链接列表
  advance: { selector: null, js: null, nextUnit: null, navItem: null },
  sites: DEFAULT_SITES,
};

const SKIP_TARGET_TYPES = new Set(["browser", "service_worker", "shared_worker", "worker"]);

/* ------------------------------------------------------------------ 基础设施 */

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** 取出一条规则声明的匹配模式；`match` 允许是字符串或数组。 */
function matchPatterns(rule) {
  const raw = rule?.match;
  if (typeof raw === "string") return raw.length > 0 ? [raw] : [];
  if (Array.isArray(raw)) return raw.filter((value) => typeof value === "string" && value.length > 0);
  return [];
}

/**
 * 判断一条站点规则是否匹配某个域名。
 * 不带 `*` 的模式按「包含」匹配（和旧写法兼容）；带 `*` 的按通配符整串匹配。
 */
export function matchesHost(rule, host) {
  if (host === null || host === undefined) return false;
  return matchPatterns(rule).some((pattern) => {
    if (!pattern.includes("*")) return host.includes(pattern);
    const source = pattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    return new RegExp("^" + source + "$", "i").test(host);
  });
}

/**
 * 合并站点规则：内置打底，外部（规则仓库文件）按 `id` 覆盖或追加。
 * 想改内置平台的规则时，用同一个 `id` 导入即可覆盖，不必改代码。
 */
export function mergeSites(fromConfig) {
  const byId = new Map();
  for (const rule of DEFAULT_SITES) byId.set(rule.id, rule);
  for (const rule of fromConfig ?? []) {
    if (rule === null || typeof rule !== "object") continue;
    const id = typeof rule.id === "string" && rule.id.length > 0 ? rule.id : JSON.stringify(rule.match ?? null);
    byId.set(id, { ...(byId.get(id) ?? {}), ...rule });
  }
  return [...byId.values()];
}

/** 按当前视频地址挑出该站点的翻页设置，缺项回落到通用设置。 */
export function advanceFor(config, url) {
  const host = hostOf(url) ?? hostOf(config?.startUrl);
  const site = (config?.sites ?? []).find((rule) => matchesHost(rule, host));
  const siteAdvance = site?.advance ?? {};
  // config.advance 缺失时不能让整条链路崩掉：用空对象兜底。
  const generic = config?.advance ?? {};
  const pick = (key) => (siteAdvance[key] !== undefined ? siteAdvance[key] : generic[key]);
  return {
    selector: pick("selector") ?? null,
    js: pick("js") ?? null,
    nextUnit: pick("nextUnit") ?? null,
    navItem: pick("navItem") ?? null,
    matchedSite: site?.id ?? null,
  };
}

export async function loadConfig(overrides = {}) {
  return {
    ...DEFAULTS,
    ...overrides,
    advance: { ...DEFAULTS.advance, ...(overrides.advance ?? {}) },
    sites: mergeSites(overrides.sites),
  };
}

function parseArgv(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags[key] = true;
    else {
      flags[key] = next;
      i++;
    }
  }
  return flags;
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBool(value, fallback) {
  if (value === undefined) return fallback;
  if (value === true) return true;
  if (value === false) return false;
  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

/** 逐行 JSON 输出：插件里转成实时状态回调，CLI 里打到 stdout，两边都追写日志文件。 */
let logSink = null;
/** 设置实时事件回调；插件宿主用它把连播进度推给界面。 */
export function setLogSink(sink) {
  logSink = sink;
  return logSink;
}
function makeLogger() {
  let logPath = null;
  return {
    setLogPath(path) {
      logPath = path;
    },
    write(event) {
      const record = { ts: new Date().toISOString(), ...event };
      const line = JSON.stringify(record);
      if (logSink !== null) {
        try {
          logSink(record);
        } catch {
          /* 状态回调不能拖垮连播 */
        }
      } else {
        process.stdout.write(line + "\n");
      }
      if (logPath !== null) appendFile(logPath, line + "\n").catch(() => {});
    },
  };
}

const log = makeLogger();

/* ---------------------------------------------------------------- 浏览器封装 */

export class Browser {
  constructor(port) {
    this.port = port;
    this.sessions = new Map();
  }
  async refresh() {
    const targets = await listTargets(this.port);
    const alive = new Set(targets.map((target) => target.id));
    for (const [id, targetSession] of this.sessions) {
      if (!alive.has(id) || targetSession.session.closed) {
        targetSession.close();
        this.sessions.delete(id);
      }
    }
    for (const target of targets) {
      const existing = this.sessions.get(target.id);
      if (existing !== undefined) {
        // 同一个 target 会跨 SPA 跳转存活：不刷新的话 target.url 会一直是打开时的旧地址，
        // 日志和诊断就会说谎。
        existing.target = target;
        continue;
      }
      if (SKIP_TARGET_TYPES.has(target.type)) continue;
      try {
        this.sessions.set(target.id, await TargetSession.open(target, { settleMs: 300 }));
      } catch {
        /* 目标可能在打开过程中消失（弹窗、预渲染页），下一轮再说 */
      }
    }
    return targets;
  }

  list() {
    return [...this.sessions.values()];
  }

  /**
   * 刷新目标列表；浏览器整个不可达时返回 null 而不是抛异常，并丢弃已经死掉的会话。
   * 看护进程要能熬过「用户手滑关掉了浏览器窗口」这种事，而不是当场崩掉。
   */
  async refreshOrNull() {
    try {
      return await this.refresh();
    } catch {
      this.closeAll();
      return null;
    }
  }

  closeAll() {
    for (const targetSession of this.sessions.values()) targetSession.close();
    this.sessions.clear();
  }
}

/**
 * 一门课的标识：去掉地址最后一段（通常是视频/页 id），剩下的部分。
 * 同一个课程下不同节的地址只有最后一段不同，所以它拿来做「这是同一门课」的判断。
 */
export function coursePrefixOf(url) {
  if (typeof url !== "string" || url.length === 0) return null;
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter((part) => part.length > 0);
    parts.pop();
    return `${parsed.host}/${parts.join("/")}`.toLowerCase();
  } catch {
    return null;
  }
}

/** 在所有 frame 里找面积最大的 <video>，返回它所在的 context。 */
async function findVideo(browser, preferUrl = null) {
  const hits = [];
  for (const targetSession of browser.list()) {
    for (const context of targetSession.list()) {
      try {
        const value = await targetSession.evaluate(VIDEO_EXPR, {
          contextId: context.contextId,
          awaitPromise: false,
          timeoutMs: 8000,
        });
        if (value) hits.push({ targetSession, context, value });
      } catch {
        /* context 在执行期间被销毁（页面跳转），忽略 */
      }
    }
  }
  if (hits.length === 0) return null;
  const preferred = coursePrefixOf(preferUrl);
  hits.sort((a, b) => {
    // 先按「是不是我们要的那门课」：浏览器里可能同时开着别的课程标签页，
    // 只按面积挑会挑到隔壁那门课上去，然后对着别人的课翻页。
    const aMatch = preferred !== null && coursePrefixOf(a.value.url) === preferred ? 1 : 0;
    const bMatch = preferred !== null && coursePrefixOf(b.value.url) === preferred ? 1 : 0;
    if (aMatch !== bMatch) return bMatch - aMatch;
    return (b.value.area ?? 0) - (a.value.area ?? 0) || (b.value.duration ?? 0) - (a.value.duration ?? 0);
  });
  return hits[0];
}

function videoIdOf(url) {
  const byPath = String(url ?? "").match(/\/video\/(\d+)/);
  if (byPath) return byPath[1];
  const byNode = String(url ?? "").match(/[?&]node_id=(\d+)/);
  return byNode ? byNode[1] : null;
}

function signatureOf(value) {
  return {
    url: value?.url ?? null,
    duration: value?.duration ?? null,
  };
}

function isFinished(value, config) {
  if (value.ended === true) return true;
  const duration = value.duration;
  if (typeof duration !== "number" || duration < config.minDurationSec) return false;
  return value.currentTime >= duration - config.endThresholdSec;
}

/* -------------------------------------------------------------- 翻页与主循环 */

/**
 * 点完翻页控件后，一直等到**真的出现一个新视频**才算成功。
 *
 * 只判断「URL 变了」是不够的：翻页箭头会把我们送进习题页——那里页面确实变了，
 * 但既没有 <video> 也没有课程目录树，进去就出不来。所以必须等视频。
 */
async function waitForNewVideo(browser, config, before) {
  const deadline = Date.now() + config.afterAdvanceWaitMs;
  while (Date.now() < deadline) {
    await sleep(2000);
    await browser.refresh();
    const front = await findVideo(browser, config.startUrl);
    if (front === null) continue;
    const signature = signatureOf(front.value);
    const movedOn =
      signature.url !== before.url ||
      front.value.currentTime < before.currentTime - 5 ||
      (signature.duration !== before.duration && front.value.currentTime < before.currentTime);
    if (movedOn) return { landed: true, front };
  }
  return { landed: false, front: null };
}

/** 依次尝试各策略翻到下一节；返回 {changed, attempts}。 */
async function advance(browser, front, config) {
  const videoId = videoIdOf(front.value.url);
  const before = {
    url: front.value.url,
    duration: front.value.duration,
    currentTime: front.value.currentTime ?? 0,
  };
  const attempts = [];
  const skip = [];
  let exhausted = false;
  const site = advanceFor(config, front.value.url);

  for (let attempt = 0; attempt < config.advanceAttempts; attempt++) {
    const expression = buildAdvanceExpr({
      videoId,
      selector: site.selector,
      js: site.js,
      nextUnit: site.nextUnit,
      navItem: site.navItem,
      skip,
    });

    const clicked = [];
    for (const targetSession of browser.list()) {
      for (const result of await targetSession.evaluateEverywhere(expression, { awaitPromise: false })) {
        if (result.value?.exhausted === true) exhausted = true;
        if (result.value?.ok) {
          clicked.push({ frame: result.origin || result.contextId, how: result.value.how, detail: result.value.detail });
        }
      }
    }
    if (clicked.length === 0) {
      attempts.push({ attempt, clicked: [], note: "没有任何策略找到可点的目标" });
      break;
    }
    attempts.push({ attempt, clicked, landed: false });

    const outcome = await waitForNewVideo(browser, config, before);
    if (outcome.landed) {
      attempts.at(-1).landed = true;
      return { changed: true, attempts, videoId, afterFront: outcome.front, clickedAnything: true };
    }

    // 点了但没等到新视频：把刚用过的策略拉黑，换下一个策略再试
    attempts.at(-1).note = "点了但没等到新视频，换下一个策略";
    for (const entry of clicked) if (entry.how) skip.push(String(entry.how).replace("config.", ""));
  }

  // clickedAnything=false 说明「根本没东西可点」，那是课程到头了，不是故障；
  // exhausted=true 是更权威的信号：目录树里确实没有下一个视频项了。
  return {
    changed: false,
    attempts,
    videoId,
    afterFront: null,
    exhausted,
    clickedAnything: attempts.some((attempt) => (attempt.clicked?.length ?? 0) > 0),
  };
}

/**
 * 把当前正在播的地址写进 state/launch-url.txt。
 * start-chrome-debug.cmd 会读这个文件，所以用户重新双击启动器时会落在**当前这一节**，
 * 而不是课程开头。注意不要加结尾换行：.cmd 用 `set /p` 读，多一个 CR 会混进 URL。
 */
async function writeLaunchUrl(url) {
  try {
    await mkdir(stateDirOf(), { recursive: true });
    await writeFile(join(stateDirOf(), "launch-url.txt"), url, "utf8");
  } catch {
    /* 写不进去也不影响连播 */
  }
}

export async function readState() {
  try {
    return JSON.parse(await readFile(join(stateDirOf(), "watch-state.json"), "utf8"));
  } catch {
    return null;
  }
}

async function writeState(patch) {
  const next = { ...(await readState()), ...patch, updatedAt: new Date().toISOString() };
  // 不做增量合并清理的话，上一次故障留下的 reason/error 会一直挂在文件里，
  // 让「running: true」旁边写着上次的连接错误，读的人会以为现在出问题了。
  if (!("reason" in patch)) delete next.reason;
  if (!("error" in patch)) delete next.error;
  await mkdir(stateDirOf(), { recursive: true });
  await writeFile(join(stateDirOf(), "watch-state.json"), JSON.stringify(next, null, 2), "utf8");
  return next;
}

async function runStatus(config) {
  const browser = new Browser(config.port);
  try {
    await browser.refresh();
    const front = await findVideo(browser, config.startUrl);
    const result = {
      event: "status",
      port: config.port,
      targets: browser.list().map((targetSession) => ({
        id: targetSession.target.id,
        url: targetSession.target.url,
        frames: targetSession.list().length,
      })),
      video: front
        ? {
            url: front.value.url,
            title: front.value.title,
            videoId: videoIdOf(front.value.url),
            currentTime: front.value.currentTime,
            duration: front.value.duration,
            paused: front.value.paused,
            ended: front.value.ended,
            finished: isFinished(front.value, config),
            raw: front.value,
          }
        : null,
    };
    log.write(result);
    if (front === null) return 2;
    return 0;
  } finally {
    browser.closeAll();
  }
}

/**
 * 演习：现在就跑一遍翻页判定，但一个都不点，只报告会点谁。
 * 翻页不可逆，正式连播前先跑这个。
 */
async function runDryRun(config) {
  const browser = new Browser(config.port);
  try {
    await browser.refresh();
    const front = await findVideo(browser, config.startUrl);
    const videoId = front === null ? null : videoIdOf(front.value.url);
    const site = advanceFor(config, front?.value?.url);
    const expression = buildAdvanceExpr({
      videoId,
      selector: site.selector,
      js: site.js,
      nextUnit: site.nextUnit,
      navItem: site.navItem,
      dryRun: true,
    });

    const hits = [];
    for (const targetSession of browser.list()) {
      for (const result of await targetSession.evaluateEverywhere(expression, { awaitPromise: false })) {
        if (result.value) {
          hits.push({
            frame: String(result.origin || result.contextId).slice(0, 80),
            ok: result.value.ok === true,
            how: result.value.how ?? null,
            detail: result.value.detail ?? null,
            target: result.value.fired?.[0]?.target ?? null,
            error: result.error ?? null,
          });
        }
      }
    }

    const winner = hits.find((hit) => hit.ok) ?? null;
    log.write({
      event: "dryrun",
      port: config.port,
      videoId,
      matchedSite: site.matchedSite,
      currentTime: front?.value?.currentTime ?? null,
      duration: front?.value?.duration ?? null,
      wouldClick: winner,
      allFrames: hits,
    });
    if (winner === null) {
      log.write({
        event: "dryrun-empty",
        nextStep: "没有策略能定位「下一节」。跑 `node cdp.mjs probe` 看页面结构，再把规则写进 config.json 的 advance。",
      });
      return 5;
    }
    return 0;
  } finally {
    browser.closeAll();
  }
}

/** 把「上次播放视频的那个标签页」导航到指定 URL；没有就退化成同域名的第一个 page。 */
async function navigateToCoursePage(browser, url, preferredTargetId) {
  const pages = browser.list().filter((targetSession) => targetSession.target.type === "page");
  if (pages.length === 0) return null;
  const preferred =
    preferredTargetId === null || preferredTargetId === undefined
      ? undefined
      : pages.find((targetSession) => targetSession.target.id === preferredTargetId);
  let host = "";
  try {
    host = new URL(url).host;
  } catch {
    /* 非法 URL 就退化成第一个标签页 */
  }
  const page = preferred ?? pages.find((targetSession) => host !== "" && targetSession.target.url.includes(host)) ?? pages[0];
  await page.navigate(url);
  return page.target.url;
}

export async function runWatch(config, options = {}) {
  const signal = options.signal;
  // 调用方（插件宿主）只给部分字段是正常的：必须先补齐默认值。
  // 少了这一步，config.advance 是 undefined（advanceFor 里读 .selector 直接抛错），
  // 而且 pollMs / afterAdvanceWaitMs / browserDownTimeoutMs 等也全是 undefined。
  config = await loadConfig(config ?? {});
  await mkdir(stateDirOf(), { recursive: true });
  log.setLogPath(join(stateDirOf(), "watch.log"));

  const browser = new Browser(config.port);
  let lessonsAdvanced = 0;
  let pausedTicks = 0;
  let noVideoSince = Date.now();
  let lastLogAt = 0;
  let lastSignature = null;
  let seenVideo = false;
  let lastVideoUrl = null;
  let lastVideoTargetId = null;
  let recoveries = 0;
  let browserDownSince = null;

  log.write({ event: "start", port: config.port, maxLessons: config.maxLessons, pollMs: config.pollMs });
  await writeState({ running: true, startedAt: new Date().toISOString(), lessonsAdvanced, lastEvent: "start" });

  if (config.open && config.startUrl) {
    await browser.refresh();
    const navigated = await navigateToCoursePage(browser, config.startUrl, null);
    if (navigated === null) {
      log.write({ event: "navigate-skipped", reason: "没有可用的 page 目标", startUrl: config.startUrl });
    } else {
      log.write({ event: "navigated", url: config.startUrl, target: navigated });
      await sleep(3000);
    }
  }

  try {
    for (;;) {
      if (signal?.aborted === true) {
        log.write({ event: "stopped", lessonsAdvanced, detail: "收到停止请求，连播结束。" });
        await writeState({ running: false, lastEvent: "stopped", lessonsAdvanced });
        return 0;
      }
      const targets = await browser.refreshOrNull();
      if (targets === null) {
        // 浏览器被关掉了。用户可能只是手滑，等他把窗口开回来，别当场崩掉。
        browserDownSince ??= Date.now();
        const downMs = Date.now() - browserDownSince;
        if (downMs > config.browserDownTimeoutMs) {
          log.write({
            event: "blocked",
            reason: "no-browser",
            detail: `已经 ${Math.round(downMs / 1000)} 秒连不上调试端口 ${config.port}——那个带调试端口的 Chrome 被关掉了。重新运行 bin/start-chrome-debug.cmd（它会打开 state/launch-url.txt 里的当前课程），再重启 watch 就能接着刷。`,
          });
          await writeState({ running: false, lastEvent: "blocked", reason: "no-browser", lessonsAdvanced });
          return 3;
        }
        if (Date.now() - lastLogAt > config.logEveryMs) {
          lastLogAt = Date.now();
          log.write({
            event: "browser-down",
            downSec: Math.round(downMs / 1000),
            budgetSec: Math.round(config.browserDownTimeoutMs / 1000),
            port: config.port,
          });
        }
        await sleep(config.pollMs);
        continue;
      }
      if (browserDownSince !== null) {
        log.write({ event: "browser-back", downSec: Math.round((Date.now() - browserDownSince) / 1000) });
        browserDownSince = null;
        noVideoSince = Date.now();
      }

      const front = await findVideo(browser, config.startUrl);

      if (front === null) {
        const idleMs = Date.now() - noVideoSince;
        // 还没开始播 → 是在等用户打开课程页；已经在播却突然没了 → 是出问题了
        const budget = seenVideo ? config.lostVideoTimeoutMs : config.noVideoTimeoutMs;
        if (idleMs > budget) {
          if (seenVideo && lastVideoUrl !== null && recoveries < config.maxRecoveries) {
            recoveries++;
            const navigated = await navigateToCoursePage(browser, lastVideoUrl, lastVideoTargetId);
            log.write({
              event: "recover",
              attempt: recoveries,
              navigateTo: lastVideoUrl,
              target: navigated,
              detail: `已经 ${Math.round(idleMs / 1000)} 秒没有视频（多半被翻进了没有播放器的习题页）。退回上一个视频页重建课程目录，再继续找下一节。`,
            });
            await sleep(8000);
            noVideoSince = Date.now();
            continue;
          }
          log.write({
            event: "blocked",
            reason: "no-video",
            detail: seenVideo
              ? `已经 ${Math.round(idleMs / 1000)} 秒找不到 <video>，自救也没成功。当前页面多半停在习题页或其他没有播放器的页面上。`
              : `已经 ${Math.round(idleMs / 1000)} 秒没在任何 frame 里找到 <video>。请确认那个 Chrome 已经登录并打开了课程页。`,
            liveTargets: browser.list().map((targetSession) => targetSession.target.url.slice(0, 160)),
          });
          await writeState({ running: false, lastEvent: "blocked", reason: "no-video" });
          return 3;
        }
        if (Date.now() - lastLogAt > config.logEveryMs) {
          lastLogAt = Date.now();
          log.write({
            event: "waiting-video",
            idleSec: Math.round(idleMs / 1000),
            budgetSec: Math.round(budget / 1000),
            liveTargets: browser.list().map((targetSession) => targetSession.target.url.slice(0, 160)),
          });
        }
        await sleep(config.pollMs);
        continue;
      }

      noVideoSince = Date.now();
      seenVideo = true;
      if (front.value.url !== lastVideoUrl) {
        // 让「重新双击启动器」落在当前这一节
        await writeLaunchUrl(front.value.url);
      }
      lastVideoUrl = front.value.url;
      lastVideoTargetId = front.targetSession.target.id;
      if (recoveries > 0) {
        // 自救成功就把计数清零：只要自救还有效，就该允许它继续救
        log.write({ event: "recovered", attempts: recoveries, url: front.value.url });
        recoveries = 0;
      }
      const value = front.value;
      const signature = signatureOf(value);
      const finished = isFinished(value, config);
      const percent = typeof value.duration === "number" && value.duration > 0
        ? Number(((value.currentTime / value.duration) * 100).toFixed(1))
        : null;

      if (finished) {
        log.write({
          event: "lesson-finished",
          index: lessonsAdvanced + 1,
          videoId: videoIdOf(value.url),
          url: value.url,
          currentTime: value.currentTime,
          duration: value.duration,
        });
        const outcome = await advance(browser, front, config);
        if (!outcome.changed) {
          // 区分三种收尾：课到头了（正常）、点了有反应但没结果（要介入）、压根没东西可点（也是到头）
          if (outcome.exhausted || !outcome.clickedAnything) {
            log.write({
              event: "finished",
              reason: "no-next-lesson",
              lessonsAdvanced,
              exhaustedByNavTree: outcome.exhausted,
              detail: outcome.exhausted
                ? "课程目录里已经没有下一个视频项，翻页控件也没能带来新视频——这门课的视频部分到此结束。"
                : "本节已播完，但页面里找不到任何可用的「下一单元/下一节」控件或下一个视频项——课程到此结束。",
              attempts: outcome.attempts,
            });
            await writeState({ running: false, lastEvent: "finished", reason: "no-next-lesson", lessonsAdvanced });
            return 0;
          }
          log.write({
            event: "blocked",
            reason: "cannot-advance",
            detail: "视频已播完，点了翻页控件但页面没有变化。",
            attempts: outcome.attempts,
            videoId: outcome.videoId,
            nextStep: "运行 `node cdp.mjs probe` 看清页面结构，把可用选择器写进 config.json 的 advance.selector，或把自定义 JS 写进 advance.js，然后重启 watch。",
          });
          await writeState({ running: false, lastEvent: "blocked", reason: "cannot-advance" });
          if (config.stopWhenBlocked) return 4;
          await sleep(config.pollMs * 4);
          continue;
        }

        lessonsAdvanced++;
        pausedTicks = 0;
        lastSignature = null;
        const toVideoId = videoIdOf(outcome.afterFront?.value?.url);
        const successful = outcome.attempts.at(-1)?.clicked ?? [];
        log.write({
          event: "advanced",
          lessonNumber: lessonsAdvanced,
          from: outcome.videoId,
          to: toVideoId,
          how: successful.map((entry) => entry.how).join(",") || null,
          detail: successful[0]?.detail ?? null,
        });
        await writeState({
          running: true,
          lessonsAdvanced,
          lastEvent: "advanced",
          lastFrom: outcome.videoId,
          lastTo: toVideoId,
        });

        if (lessonsAdvanced >= config.maxLessons) {
          log.write({
            event: "finished",
            reason: "max-lessons",
            lessonsAdvanced,
            detail: `已达到 --max-lessons=${config.maxLessons} 上限，停在这里。需要继续就把上限调大再跑一次。`,
          });
          await writeState({ running: false, lastEvent: "finished", reason: "max-lessons", lessonsAdvanced });
          return 0;
        }
        await sleep(config.pollMs);
        continue;
      }

      // 没播完：必要时把暂停的视频重新播起来
      if (value.paused) {
        pausedTicks++;
        if (config.resumeIfPaused && pausedTicks >= config.resumeAfterTicks) {
          try {
            const resume = await front.targetSession.evaluate(PLAY_EXPR, {
              contextId: front.context.contextId,
              awaitPromise: false,
            });
            log.write({ event: "resume", result: resume, at: value.currentTime });
          } catch (error) {
            log.write({ event: "resume-failed", error: String(error.message ?? error) });
          }
          pausedTicks = 0;
        }
      } else {
        pausedTicks = 0;
      }

      const signatureKey = JSON.stringify(signature);
      const changed = lastSignature !== null && signatureKey !== lastSignature;
      if (changed || Date.now() - lastLogAt > config.logEveryMs) {
        lastLogAt = Date.now();
        log.write({
          event: "tick",
          videoId: videoIdOf(value.url),
          currentTime: value.currentTime,
          duration: value.duration,
          percent,
          paused: value.paused,
          lessonsAdvanced,
        });
      }
      lastSignature = signatureKey;
      await sleep(config.pollMs);
    }
  } finally {
    browser.closeAll();
  }
}

/* ---------------------------------------------------------------------- 入口 */

let currentCommand = null;

async function main() {
  const [, , command, ...rest] = process.argv;
  currentCommand = command ?? "run";
  const flags = parseArgv(rest);
  const config = await loadConfig();

  config.port = toNumber(flags.port, config.port);
  config.pollMs = toNumber(flags.poll, config.pollMs);
  config.maxLessons = toNumber(flags.maxLessons, config.maxLessons);
  config.resumeIfPaused = toBool(flags.resumePaused, config.resumeIfPaused);
  config.open = toBool(flags.open, config.open);
  config.logEveryMs = toNumber(flags.logEvery, config.logEveryMs);

  if (command === "status") {
    process.exitCode = await runStatus(config);
    return;
  }
  if (command === "dryrun") {
    process.exitCode = await runDryRun(config);
    return;
  }
  if (command === "run" || command === undefined) {
    process.exitCode = await runWatch(config);
    return;
  }
  if (command === "state") {
    log.write({ event: "state", state: await readState() });
    return;
  }
  throw new Error(`未知命令：${command}（可用：status | dryrun | run | state）`);
}

// 仅在被直接执行时跑 CLI；被 selftest.mjs import 时保持安静（好让 advanceFor 可单测）。
const entry = process.argv[1] ?? "";
const invokedDirectly = entry !== "" && import.meta.url === new URL(`file://${entry.replace(/\\/g, "/")}`).href;
if (invokedDirectly) {
  main().catch(async (error) => {
    const message = String(error?.message ?? error);
    log.write({ event: "fatal", error: message });
    // 只有真正在连播时才落盘状态；一次 status/探测失败不该污染看板。
    if (currentCommand === "run") {
      await writeState({ running: false, lastEvent: "fatal", error: message }).catch(() => {});
    }
    process.exitCode = 1;
  });
}
