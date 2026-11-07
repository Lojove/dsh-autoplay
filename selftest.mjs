#!/usr/bin/env node
/**
 * 插件自测：只测不依赖浏览器的部分（配置归一化、规则匹配、表达式生成）。
 *
 *   node selftest.mjs
 *
 * 存在的理由：曾经因为插件宿主调用 runWatch 时没有经过 loadConfig 补齐默认值，
 * 导致 config.advance 为 undefined，翻页那一刻抛
 * "Cannot read properties of undefined (reading 'selector')"。
 * 下面的第 1、3 条就是钉住这件事。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAdvanceExpr, PROBE_EXPR } from './lib/cdp.mjs';
import { advanceFor, coursePrefixOf, loadConfig, matchesHost, mergeSites } from './lib/watch.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const cases = [];
function check(name, actual, expected) {
  const snapshot = JSON.parse(JSON.stringify(actual ?? null));
  const pass = JSON.stringify(snapshot) === JSON.stringify(expected);
  cases.push({ name, pass, actual: snapshot, expected });
}

// 1. 只给部分字段也必须补齐默认值（这条就是那次线上报错的根因）
const bare = await loadConfig({ port: 9222, startUrl: 'https://a.example.com/video/1', open: false, sites: [] });
check('loadConfig 补出 advance 对象', typeof bare.advance === 'object' && bare.advance !== null, true);
check('loadConfig 保留传入的 port', bare.port, 9222);
check('loadConfig 保留传入的 startUrl', bare.startUrl, 'https://a.example.com/video/1');
check('loadConfig 默认 pollMs', bare.pollMs, 5000);
check('loadConfig 默认 afterAdvanceWaitMs', bare.afterAdvanceWaitMs, 25000);
check('loadConfig 默认 browserDownTimeoutMs', bare.browserDownTimeoutMs, 1800000);
check('loadConfig 内置两条站点规则', bare.sites.length, 2);

// 2. 外部规则按 id 覆盖内置、追加新规则
const merged = mergeSites([
  { id: 'buaa-yuketang', match: ['buaa.yuketang.cn'], advance: { nextUnit: '.overridden' } },
  { id: 'moe', match: ['*.moe.edu.cn'], advance: { nextUnit: '.moe' } },
]);
check('规则数：内置 2 + 新增 1（覆盖不增量）', merged.length, 3);
check('同 id 覆盖生效', merged.find((r) => r.id === 'buaa-yuketang').advance.nextUnit, '.overridden');

// 3. 配置里没有 advance 时也不能崩（防御性）
let threw = null;
let result = null;
try {
  result = advanceFor({ sites: [] }, 'https://x.example.com/video/1');
} catch (error) {
  threw = String(error?.message ?? error);
}
check('缺 advance 不抛错', threw, null);
check('缺 advance 时返回 null 而不是 undefined 之外的怪值', result, {
  selector: null,
  js: null,
  nextUnit: null,
  navItem: null,
  matchedSite: null,
});

// 4. 域名匹配
check('包含匹配', matchesHost({ match: 'buaa.yuketang.cn' }, 'buaa.yuketang.cn'), true);
check('数组匹配', matchesHost({ match: ['a.com', 'b.com'] }, 'x.b.com.y'), true);
check('通配符匹配', matchesHost({ match: '*.moe.edu.cn' }, 'learn.moe.edu.cn'), true);
check('通配符不越界', matchesHost({ match: '*.moe.edu.cn' }, 'moe.edu.cn.evil.com'), false);
check('未声明的域名不匹配', matchesHost({ match: ['buaa.yuketang.cn'] }, 'other.yuketang.cn'), false);

// 5. 按域名挑出正确站点（其他租户不能被套上北航的选择器）
check('北航命中内置规则', advanceFor(bare, 'https://buaa.yuketang.cn/ai-workspace/lms-graph/1/video/2').matchedSite, 'buaa-yuketang');
check('北航拿到箭头选择器', advanceFor(bare, 'https://buaa.yuketang.cn/x').nextUnit, '.unit-arrow.arrow-reverse');
check('同学堂在线命中内置规则', advanceFor(bare, 'https://graduate.xuetangx.com/learn/space/a/b/1/video/2').matchedSite, 'graduate-xuetangx');
check('其他租户不命中', advanceFor(bare, 'https://other.yuketang.cn/x').matchedSite, null);
check('无 URL 时不炸', advanceFor(bare, null).matchedSite, null);

// 6. 「这是哪门课」的判断：浏览器里同时开着别的课程标签页时，靠它挑对视频
const XT = 'https://graduate.xuetangx.com/learn/space/a/b/31387066/video/85936697';
const XT_NEXT = 'https://graduate.xuetangx.com/learn/space/a/b/31387066/video/85936703';
const YT = 'https://buaa.yuketang.cn/ai-workspace/lms-graph/33311241/video/89072601';
check('同学堂在线不同节 -> 同一个课程前缀', coursePrefixOf(XT) === coursePrefixOf(XT_NEXT), true);
check('雨课堂 vs 学堂在线 -> 不同课程前缀', coursePrefixOf(YT) === coursePrefixOf(XT), false);
check('非法地址 -> null', coursePrefixOf('not a url'), null);
check('空值 -> null', coursePrefixOf(null), null);

// 7. 生成的两段页面表达式必须是合法 JS
let exprOk = true;
try {
  new Function(buildAdvanceExpr({ videoId: '1' }));
  new Function(PROBE_EXPR);
} catch {
  exprOk = false;
}
check('buildAdvanceExpr / PROBE_EXPR 可解析', exprOk, true);
check('PROBE_EXPR 带 idSamples 一栏', PROBE_EXPR.includes('idSamples'), true);

// 8. 界面样式守卫：品牌色底上不能写死前景色。
//    深色模式下 --dsw-alias-brand-primary 是浅色，写死 color:#fff 会变成
//    「白底白字」——这正是用户报的那个 bug。
const clientSource = readFileSync(join(HERE, 'client.js'), 'utf8');
const primaryRule = (clientSource.match(/\.cw-btn\.is-primary\s*\{[^}]*\}/) ?? [''])[0];
check('找得到主按钮样式规则', primaryRule.length > 0, true);
check('主按钮背景用品牌 token', /background:\s*var\(--dsw-alias-brand-primary/.test(primaryRule), true);
check('主按钮前景用 token 而非字面量', /color:\s*var\(/.test(primaryRule), true);
check('主按钮前景没有写死颜色', /color:\s*#/.test(primaryRule), false);

// 9. 中央面板必须自己是滚动容器。
//    主面板容器不替内容滚动；漏了这两条，内容一高就被裁掉且页面滑不动。
const rootRule = (clientSource.match(/\.cw-root\s*\{[^}]*\}/) ?? [''])[0];
check('找得到面板根样式规则', rootRule.length > 0, true);
check('面板根占满高度', /height:\s*100%/.test(rootRule), true);
check('面板根纵向可滚动', /overflow-y:\s*auto/.test(rootRule), true);

// 10. 动态日志的文字必须能换行并且能被压缩。
//     flex 子项默认 min-width:auto，长 URL 会撑宽整行、被横向裁掉
//     （用户看到的就是「这一栏太窄、显示不全」）。
const logTextRule = (clientSource.match(/\.cw-logtext\s*\{[^}]*\}/) ?? [''])[0];
check('找得到动态日志文本样式规则', logTextRule.length > 0, true);
check('日志文本可收缩（min-width:0）', /min-width:\s*0/.test(logTextRule), true);
check('日志文本允许长串断行', /overflow-wrap:\s*anywhere/.test(logTextRule), true);

// 11. 动态日志的高度必须够看、且随窗口变化。
//     写死成小固定值（曾经是 260px）只能看到三四条，换窗口大小也不变。
const logRule = (clientSource.match(/\.cw-log\s*\{[^}]*\}/) ?? [''])[0];
check('找得到动态日志容器样式规则', logRule.length > 0, true);
check('动态日志高度用 clamp 自适应', /max-height:\s*clamp\(/.test(logRule), true);
check('动态日志高度随视口变化', /\d+vh/.test(logRule), true);
// 只写 max-height 的话它只封顶、不撑高：事件少时框会缩成两三行高。
check('动态日志有最小高度（事件少时也不塌）', /min-height:\s*clamp\(/.test(logRule), true);
// 面板内必须统一 border-box，否则带 padding/border 的盒子会比邻居宽出 padding+border
// （实测「最近动态」宽 22px）。
check('面板内统一 border-box', /\.cw-root,\s*\.cw-root \*\s*\{[^}]*box-sizing:\s*border-box/.test(clientSource), true);

// 12. 探测结果框必须和「最近动态」框同样高。
//     只写 max-height 的话它只封顶不撑高；这里直接比对两者的取值是否一致，
//     而不是写死像素——以后再调数值也不会误报。
const preRule = (clientSource.match(/\.cw-pre\s*\{[^}]*\}/) ?? [''])[0];
const heightPair = (rule) => ({
  min: ((rule.match(/min-height:\s*([^;]+)/) ?? [])[1] ?? '').trim() || null,
  max: ((rule.match(/max-height:\s*([^;]+)/) ?? [])[1] ?? '').trim() || null,
});
const logHeight = heightPair(logRule);
const preHeight = heightPair(preRule);
check('找得到探测结果框样式规则', preRule.length > 0, true);
check('探测结果框有最小高度', preHeight.min !== null, true);
check('探测结果框与动态框同高', JSON.stringify(preHeight), JSON.stringify(logHeight));

const failed = cases.filter((entry) => !entry.pass);
for (const entry of cases) {
  const suffix = entry.pass ? '' : `\n      expected ${JSON.stringify(entry.expected)}\n      actual   ${JSON.stringify(entry.actual)}`;
  process.stdout.write(`${entry.pass ? 'PASS' : 'FAIL'}  ${entry.name}${suffix}\n`);
}
process.stdout.write(`\n${cases.length - failed.length}/${cases.length} passed\n`);
process.exitCode = failed.length === 0 ? 0 : 1;
