/**
 * 在 DSH 宿主进程里启动一个带调试端口的 Chrome。
 *
 * 插件跑在宿主进程内（不是沙箱 shell），所以这里可以正常 spawn 浏览器；
 * 而 CLI 脚本在沙箱里是启动不了 Chrome 的（crashpad OpenProcess: Access denied）。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 依次尝试这些位置；Chrome 优先于 Edge。 */
function browserCandidates() {
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return [
    join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
    join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
    join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
    join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
    join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
  ];
}

/** @returns 可执行文件绝对路径，找不到时返回 null。 */
export function findBrowser() {
  for (const candidate of browserCandidates()) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * 独立配置目录：与用户日常 Chrome 互不干扰，登录态也只存在这里。
 *
 * 目录名保留了旧项目名（course-watch），这是**有意不改**的：里面装的是用户在那个
 * 浏览器里的登录态，为了命名好看而改目录名，等于把人静默登出，还会把上百 MB 的
 * profile 留在磁盘上当垃圾。
 */
export function profileDir() {
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return join(localAppData, "dsh-course-watch-chrome");
}

/**
 * 启动浏览器并打开课程页。
 * `detached` + `unref` 让它独立于插件生命周期：插件卸载不该把用户正在看的窗口关掉。
 *
 * @param {{url: string, port: number, profile?: string}} options
 * @returns {{executable: string, pid: number|undefined, profile: string, port: number, url: string}}
 */
export function launchChrome({ url, port, profile }) {
  const executable = findBrowser();
  if (executable === null) {
    throw new Error("没找到 Chrome 或 Edge，无法启动带调试端口的浏览器。");
  }
  const resolvedProfile = profile ?? profileDir();
  const args = [
    `--remote-debugging-port=${port}`,
    // 非浏览器客户端（Node 的 WebSocket）要能连上调试端口
    "--remote-allow-origins=*",
    `--user-data-dir=${resolvedProfile}`,
    "--no-first-run",
    "--no-default-browser-check",
    url,
  ];
  const child = spawn(executable, args, { detached: true, stdio: "ignore", windowsHide: false });
  child.unref();
  return { executable, pid: child.pid, profile: resolvedProfile, port, url };
}
