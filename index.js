/**
 * 刷课连播 · 宿主半边。
 *
 * 职责：启动带调试端口的 Chrome，驱动播放监控与自动翻页引擎，并管理站点规则仓库。
 * 界面半边（client.js）通过 `/dsh-autoplay` 这条 HTTP 路由与本文件通信——
 * 手写插件无法自建 Typert Remote（那需要编译器产物），而 webServer 路由是
 * 公开的 Service 方法，足够承担这条本地控制通道。
 *
 * 路由用「处理器型」（handler）而不是「资源型」（resource）：资源型只接受
 * GET/HEAD，其它方法在匹配之前就被框架回 405，而控制通道需要 POST。
 */
import { access, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROBE_EXPR, TargetSession, listTargets } from "./lib/cdp.mjs";
import { findBrowser, launchChrome, profileDir } from "./lib/chrome.mjs";
import { readState, runWatch, setDataDir, setLogSink } from "./lib/watch.mjs";

export const name = "autoplay";
/** webServer 是硬依赖：没有它就没有控制通道。 */
export const inject = ["webServer"];

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));
const BUILTIN_RULES_DIR = join(PACKAGE_DIR, "rules");
const DEFAULT_PORT = 9222;
const DEFAULT_URL = "https://buaa.yuketang.cn/";
const LOG_LIMIT = 150;
const ADVANCE_KEYS = new Set(["selector", "js", "nextUnit", "navItem"]);

const DATA_DIR_NAME = "dsh-autoplay";
/** 改项目名前叫 course-watch。数据目录跟着改名时必须迁移，
 *  否则用户的设置和自建规则会看起来"凭空消失"。 */
const LEGACY_DATA_DIR_NAME = "course-watch";

function resolveDataDir() {
  const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  return join(home, DATA_DIR_NAME);
}

/** 旧数据目录整体改名；新目录已存在就不动，避免覆盖。 */
async function migrateLegacyDataDir() {
  const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  const legacy = join(home, LEGACY_DATA_DIR_NAME);
  const current = join(home, DATA_DIR_NAME);
  try {
    await access(legacy);
  } catch {
    return null;
  }
  try {
    await access(current);
    return null;
  } catch {
    /* 目标还不存在，可以搬 */
  }
  try {
    await rename(legacy, current);
    return { from: legacy, to: current };
  } catch {
    return null;
  }
}

/** 一条规则是否合法；返回错误说明数组，空数组表示通过。 */
function validateRule(rule) {
  if (rule === null || typeof rule !== "object" || Array.isArray(rule)) return ["规则必须是一个 JSON 对象"];
  const errors = [];
  if (typeof rule.id !== "string" || !/^[A-Za-z0-9._-]+$/.test(rule.id)) {
    errors.push("id 必填，只能用字母、数字、点、下划线、连字符");
  }
  const patterns = Array.isArray(rule.match) ? rule.match : typeof rule.match === "string" ? [rule.match] : [];
  if (patterns.length === 0 || patterns.some((value) => typeof value !== "string" || value.length === 0)) {
    errors.push("match 必填：一个字符串，或非空字符串数组");
  }
  const advance = rule.advance;
  if (advance === null || typeof advance !== "object" || Array.isArray(advance)) {
    errors.push("advance 必填，且必须是对象");
    return errors;
  }
  for (const key of Object.keys(advance)) {
    if (!ADVANCE_KEYS.has(key)) errors.push(`advance 里不认识的键：${key}（可用：selector / js / nextUnit / navItem）`);
  }
  if (typeof advance.selector === "string" && advance.selector.length === 0) errors.push("advance.selector 不能是空字符串（不用就写 null）");
  if (typeof advance.nextUnit === "string" && advance.nextUnit.length === 0) errors.push("advance.nextUnit 不能是空字符串（不用就写 null）");
  if (typeof advance.js === "string") {
    try {
      new Function(advance.js);
    } catch (error) {
      errors.push(`advance.js 不是合法表达式：${String(error?.message ?? error)}`);
    }
  }
  const navItem = advance.navItem;
  if (navItem !== null && navItem !== undefined) {
    if (typeof navItem !== "object" || Array.isArray(navItem)) {
      errors.push("advance.navItem 必须是对象或 null");
    } else {
      if (typeof navItem.item !== "string" || navItem.item.length === 0) {
        errors.push("advance.navItem.item 必填：课程条目的选择器");
      }
      if (navItem.idPattern !== undefined && navItem.idPattern !== null) {
        try {
          new RegExp(navItem.idPattern);
        } catch {
          errors.push("advance.navItem.idPattern 不是合法正则");
        }
      }
      if (navItem.hrefFromId === true && typeof navItem.idPattern !== "string") {
        errors.push("advance.navItem.hrefFromId 需要同时给出 idPattern");
      }
    }
  }
  return errors;
}

export function apply(ctx, config = {}) {
  const dataDir = resolveDataDir();
  const userRulesDir = join(dataDir, "rules");
  const settingsPath = join(dataDir, "settings.json");
  setDataDir(dataDir);

  const runtime = {
    running: false,
    starting: false,
    url: null,
    port: config.port ?? DEFAULT_PORT,
    startedAt: null,
    exitCode: null,
    error: null,
    browser: null,
    latest: null,
    log: [],
    lessonsAdvanced: 0,
  };
  let controller = null;
  let settings = { url: DEFAULT_URL, port: runtime.port };
  let ruleEntries = [];

  setLogSink((record) => {
    runtime.latest = record;
    runtime.log.push(record);
    if (runtime.log.length > LOG_LIMIT) runtime.log.splice(0, runtime.log.length - LOG_LIMIT);
    if (record.event === "advanced") runtime.lessonsAdvanced = record.lessonNumber ?? runtime.lessonsAdvanced;
  });

  const sendJson = (res, value, status = 200) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(value));
  };

  /* ------------------------------------------------------------ 规则仓库 */

  async function readRuleDir(dir, source) {
    let names;
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const entries = [];
    for (const fileName of names) {
      if (!fileName.endsWith(".json")) continue;
      const full = join(dir, fileName);
      try {
        const parsed = JSON.parse(await readFile(full, "utf8"));
        entries.push({ fileName, source, rule: parsed, errors: validateRule(parsed) });
      } catch (error) {
        entries.push({ fileName, source, rule: null, errors: [`不是合法 JSON：${String(error?.message ?? error)}`] });
      }
    }
    return entries;
  }

  async function reloadRules() {
    const builtin = await readRuleDir(BUILTIN_RULES_DIR, "builtin");
    const user = await readRuleDir(userRulesDir, "user");
    // 按 id 合并：同 id 的用户规则覆盖内置规则。
    const byId = new Map();
    for (const entry of builtin) if (entry.rule?.id) byId.set(entry.rule.id, entry);
    for (const entry of user) {
      const id = entry.rule?.id ?? entry.fileName;
      byId.set(id, entry);
    }
    ruleEntries = [...byId.values()];
    return ruleEntries;
  }

  /** 交给引擎的规则：只取合法、且带 id 的。 */
  function activeRules() {
    return ruleEntries.filter((entry) => entry.errors.length === 0 && entry.rule?.id).map((entry) => entry.rule);
  }

  function ruleSummary() {
    return ruleEntries.map((entry) => ({
      id: entry.rule?.id ?? entry.fileName,
      name: entry.rule?.name ?? entry.fileName,
      match: entry.rule?.match ?? null,
      note: entry.rule?.note ?? null,
      source: entry.source,
      fileName: entry.fileName,
      usable: entry.errors.length === 0,
      errors: entry.errors,
    }));
  }

  async function saveRule(raw) {
    let rule = raw;
    if (typeof raw === "string") {
      try {
        rule = JSON.parse(raw);
      } catch (error) {
        return { ok: false, errors: [`不是合法 JSON：${String(error?.message ?? error)}`] };
      }
    }
    const errors = validateRule(rule);
    if (errors.length > 0) return { ok: false, errors };
    await mkdir(userRulesDir, { recursive: true });
    await writeFile(join(userRulesDir, `${rule.id}.json`), JSON.stringify(rule, null, 2), "utf8");
    await reloadRules();
    return { ok: true, id: rule.id, count: ruleEntries.length };
  }

  async function deleteRule(id) {
    if (typeof id !== "string" || id.length === 0) return { ok: false, error: "缺少 id" };
    try {
      await unlink(join(userRulesDir, `${id}.json`));
    } catch {
      return { ok: false, error: "没有这条用户规则。内置规则不能删除；想改它就用同一个 id 导入一条覆盖。" };
    }
    await reloadRules();
    return { ok: true, id };
  }

  /* ------------------------------------------------------------ 控制通道 */

  async function persistSettings() {
    await mkdir(dataDir, { recursive: true });
    await writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");
  }

  async function loadSettings() {
    try {
      const parsed = JSON.parse(await readFile(settingsPath, "utf8"));
      settings = {
        url: typeof parsed.url === "string" ? parsed.url : DEFAULT_URL,
        port: Number(parsed.port) || DEFAULT_PORT,
      };
    } catch {
      /* 首次运行：用默认值 */
    }
    runtime.url = settings.url;
    runtime.port = settings.port;
  }

  function normalizeUrl(raw) {
    const value = String(raw ?? "").trim();
    if (value.length === 0) throw new Error("请填写课程网页地址。");
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error("地址格式不对，需要以 http:// 或 https:// 开头。");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("只支持 http / https 地址。");
    return parsed.href;
  }

  async function start(rawUrl) {
    if (runtime.running || runtime.starting) return { ok: false, error: "已经在监控中，请先停止。" };
    let url;
    try {
      url = normalizeUrl(rawUrl ?? settings.url);
    } catch (error) {
      return { ok: false, error: String(error.message ?? error) };
    }
    if (findBrowser() === null) return { ok: false, error: "没找到 Chrome 或 Edge，无法启动浏览器。" };

    runtime.starting = true;
    runtime.error = null;
    runtime.exitCode = null;
    try {
      const port = settings.port;
      runtime.browser = launchChrome({ url, port });
      settings = { url, port };
      await persistSettings();
      await reloadRules();

      runtime.running = true;
      runtime.url = url;
      runtime.startedAt = new Date().toISOString();
      runtime.lessonsAdvanced = 0;

      controller = new AbortController();
      const signal = controller.signal;
      // open:false —— 地址已经交给 Chrome 命令行打开；再用 CDP 导航会抢在端口就绪之前失败。
      runWatch({ port, startUrl: url, open: false, sites: activeRules() }, { signal })
        .then((code) => {
          runtime.exitCode = code;
        })
        .catch((error) => {
          runtime.error = String(error?.message ?? error);
        })
        .finally(() => {
          runtime.running = false;
          controller = null;
        });

      return { ok: true, url, port, browser: runtime.browser.executable, profile: runtime.browser.profile, rules: activeRules().length };
    } finally {
      runtime.starting = false;
    }
  }

  async function stop(reason = "用户在界面上点了停止") {
    if (controller === null) return { ok: true, note: "当前没有在监控。" };
    controller.abort(reason);
    return { ok: true };
  }

  /** 探测当前打开的课程页：给写规则的人看真实 DOM 长什么样。 */
  async function probePage() {
    let targets;
    try {
      targets = await listTargets(runtime.port);
    } catch (error) {
      return { ok: false, error: `连不上调试端口 ${runtime.port}。请先启动，并让那个 Chrome 打开课程页。（${String(error?.message ?? error)}）` };
    }
    const frames = [];
    for (const target of targets) {
      if (target.type !== "page" && target.type !== "iframe") continue;
      let session = null;
      try {
        session = await TargetSession.open(target, { settleMs: 250 });
        for (const result of await session.evaluateEverywhere(PROBE_EXPR, { awaitPromise: false })) {
          if (result.value !== null && result.value !== undefined) {
            frames.push({ target: String(target.url).slice(0, 140), ...result.value });
          }
        }
      } catch {
        /* 探测不了的目标跳过 */
      } finally {
        session?.close();
      }
    }
    if (frames.length === 0) return { ok: false, error: "所有 frame 都没探到内容，确认课程页已经打开。" };
    return { ok: true, frames };
  }

  async function status() {
    let persisted = null;
    try {
      persisted = await readState();
    } catch {
      /* 状态文件还没生成 */
    }
    return {
      running: runtime.running,
      starting: runtime.starting,
      url: runtime.url,
      port: runtime.port,
      startedAt: runtime.startedAt,
      lessonsAdvanced: runtime.lessonsAdvanced ?? 0,
      exitCode: runtime.exitCode,
      error: runtime.error,
      browser: runtime.browser?.executable ?? null,
      browserFound: findBrowser() !== null,
      profile: profileDir(),
      latest: runtime.latest,
      log: runtime.log.slice(-40),
      persisted,
      rules: ruleSummary(),
      rulesDir: userRulesDir,
    };
  }

  const handler = async (req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const readJson = async () => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      if (chunks.length === 0) return {};
      try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return {};
      }
    };
    try {
      if (req.method === "GET" && path === "/dsh-autoplay/status") return sendJson(res, await status());
      if (req.method === "GET" && path === "/dsh-autoplay/spec") {
        const text = await readFile(join(PACKAGE_DIR, "RULES.md"), "utf8").catch(() => "");
        return sendJson(res, { ok: text.length > 0, text });
      }
      if (req.method === "POST" && path === "/dsh-autoplay/start") {
        const body = await readJson();
        return sendJson(res, await start(body?.url));
      }
      if (req.method === "POST" && path === "/dsh-autoplay/stop") return sendJson(res, await stop());
      if (req.method === "POST" && path === "/dsh-autoplay/probe") return sendJson(res, await probePage());
      if (req.method === "POST" && path === "/dsh-autoplay/rules") {
        const body = await readJson();
        return sendJson(res, await saveRule(body?.rule ?? body));
      }
      if (req.method === "POST" && path === "/dsh-autoplay/rules/delete") {
        const body = await readJson();
        return sendJson(res, await deleteRule(body?.id));
      }
      return sendJson(res, { ok: false, error: `unknown route ${req.method} ${path}` }, 404);
    } catch (error) {
      return sendJson(res, { ok: false, error: String(error?.message ?? error) }, 500);
    }
  };

  ctx.effect(() => {
    let disposeRoute = null;
    const ready = (async () => {
      const migrated = await migrateLegacyDataDir();
      if (migrated !== null) {
        ctx.logger?.info?.(`dsh-autoplay: 数据目录已迁移 ${migrated.from} -> ${migrated.to}`);
      }
      await mkdir(userRulesDir, { recursive: true });
      await loadSettings();
      await reloadRules();
      disposeRoute = ctx.webServer.register({ kind: "prefix", path: "/dsh-autoplay", handler });
    })();
    ctx.logger?.info?.("dsh-autoplay: 已注册 /dsh-autoplay 控制通道");
    return async () => {
      controller?.abort("插件正在卸载");
      await ready.catch(() => {});
      disposeRoute?.();
      setLogSink(null);
    };
  }, "dsh-autoplay routes");
}
