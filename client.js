/**
 * 刷课连播 · 界面半边。
 *
 * 注册为**左侧栏的一个入口**：侧栏多一个图标，点开就是中央面板——在里面填课程地址、
 * 启动监控、看实时进度，并管理站点翻页规则。
 * 与宿主半边的通信走 /dsh-autoplay 路由（见 index.js 的说明）。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-autoplay',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    const STATUS_URL = '/dsh-autoplay/status';
    /** 侧栏图标的 id，同时也是中央面板的 key——两者必须一致。 */
    const PANEL_ID = 'autoplay';
    const PANEL_LABEL = '刷课连播';

    async function call(path, init) {
      const response = await fetch(path, init);
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (payload === null) return { ok: false, error: 'HTTP ' + response.status };
      return payload;
    }

    const postJson = (path, body) =>
      call(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      }).catch((error) => ({ ok: false, error: String(error) }));

    function percentOf(latest) {
      if (latest === null || typeof latest !== 'object') return null;
      if (typeof latest.percent === 'number') return latest.percent;
      if (typeof latest.currentTime === 'number' && typeof latest.duration === 'number' && latest.duration > 0) {
        return Math.round((latest.currentTime / latest.duration) * 1000) / 10;
      }
      return null;
    }

    function describe(record) {
      if (record === null || typeof record !== 'object') return '';
      switch (record.event) {
        case 'start':
          return '已启动，等待课程页面就绪…';
        case 'tick':
          return `播放中 ${record.percent ?? ''}%（${Math.round(record.currentTime ?? 0)}s / ${Math.round(record.duration ?? 0)}s）`;
        case 'resume':
          return '检测到暂停，已自动续播';
        case 'lesson-finished':
          return '本节播完，正在翻下一页…';
        case 'advanced':
          return `已翻到下一节（第 ${record.lessonNumber} 次，策略 ${record.how ?? '?'}）：${record.detail ?? ''}`;
        case 'browser-down':
          return `连不上调试端口 ${record.downSec}s（浏览器被关掉了？）`;
        case 'browser-back':
          return '浏览器回来了，继续监控';
        case 'recover':
          return '页面失去视频，正在退回上一节重建目录';
        case 'recovered':
          return '自救成功，继续监控';
        case 'finished':
          return `连播结束：${record.detail ?? record.reason ?? ''}`;
        case 'blocked':
          return `需要处理：${record.detail ?? record.reason ?? ''}`;
        case 'stopped':
          return '已停止';
        case 'fatal':
          return `出错：${record.error ?? ''}`;
        default:
          return record.event ?? '';
      }
    }

    function matchText(match) {
      if (typeof match === 'string') return match;
      if (Array.isArray(match)) return match.join('  ,  ');
      return '(未声明 match)';
    }

    /** 把探测结果压成一段人能读的摘要，避免整包 DOM 塞进界面。 */
    function summarizeProbe(payload) {
      if (!payload.ok) return payload.error ?? '探测失败';
      const lines = [];
      for (const frame of payload.frames) {
        lines.push(`── ${frame.url}`);
        lines.push(`  <video> 数量: ${Array.isArray(frame.videos) ? frame.videos.length : 0}`);
        const links = Array.isArray(frame.lessonLinks) ? frame.lessonLinks : [];
        lines.push(`  课程链接候选 (lessonLinks): ${links.length} 条`);
        for (const link of links.slice(0, 6)) {
          lines.push(`    - [${link.tag}] "${link.text}" href=${link.href ?? ''} node=${link.node ?? ''} cls=${link.cls ?? ''}`);
        }
        const nexts = Array.isArray(frame.nextCandidates) ? frame.nextCandidates : [];
        lines.push(`  「下一节」按钮候选 (nextCandidates): ${nexts.length} 条`);
        for (const next of nexts.slice(0, 6)) {
          lines.push(`    - [${next.tag}] "${next.text}" cls=${next.cls ?? ''} visible=${next.visible} disabled=${next.disabled}`);
        }
        const ids = Array.isArray(frame.idSamples) ? frame.idSamples : [];
        lines.push(`  带 id 的元素 (idSamples): ${ids.length} 条 —— 目录项常在这里`);
        for (const sample of ids.slice(0, 10)) {
          lines.push(`    - [${sample.tag}] id=${sample.id} cls=${sample.cls ?? ''} "${sample.text ?? ''}"`);
        }
      }
      return lines.join('\n');
    }

    function Panel(props) {
      const t = props.t;
      const [state, setState] = useState(null);
      const [url, setUrl] = useState('');
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState(null);
      const [ruleText, setRuleText] = useState('');
      const [ruleNotice, setRuleNotice] = useState(null);
      const [probeText, setProbeText] = useState(null);
      const [specText, setSpecText] = useState(null);
      const urlEdited = useRef(false);

      const refresh = useCallback(async () => {
        const next = await call(STATUS_URL).catch(() => null);
        if (next === null) return;
        setState(next);
        if (!urlEdited.current && typeof next.url === 'string' && next.url.length > 0) setUrl(next.url);
      }, []);

      useEffect(() => {
        let alive = true;
        refresh();
        const timer = setInterval(() => {
          if (alive) refresh();
        }, 2000);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [refresh]);

      const onStart = useCallback(async () => {
        setBusy(true);
        setNotice(null);
        const result = await postJson('/dsh-autoplay/start', { url });
        setNotice(
          result.ok
            ? { kind: 'ok', text: `已启动（生效规则 ${result.rules ?? 0} 条）。Chrome 正在打开课程页，首次使用请在那个窗口里登录。` }
            : { kind: 'error', text: result.error ?? '启动失败' },
        );
        setBusy(false);
        refresh();
      }, [url, refresh]);

      const onStop = useCallback(async () => {
        setBusy(true);
        setNotice(null);
        const result = await postJson('/dsh-autoplay/stop');
        setNotice(result.ok ? { kind: 'ok', text: '已停止监控。' } : { kind: 'error', text: result.error ?? '停止失败' });
        setBusy(false);
        refresh();
      }, [refresh]);

      const onSaveRule = useCallback(async () => {
        setRuleNotice(null);
        const result = await postJson('/dsh-autoplay/rules', { rule: ruleText });
        if (result.ok) {
          setRuleNotice({ kind: 'ok', text: `已保存规则 ${result.id}（当前共 ${result.count} 条）。下次启动生效。` });
          setRuleText('');
        } else {
          setRuleNotice({ kind: 'error', text: (result.errors ?? [result.error ?? '保存失败']).join('；') });
        }
        refresh();
      }, [ruleText, refresh]);

      const onDeleteRule = useCallback(
        async (id) => {
          setRuleNotice(null);
          const result = await postJson('/dsh-autoplay/rules/delete', { id });
          setRuleNotice(result.ok ? { kind: 'ok', text: `已删除规则 ${id}。` } : { kind: 'error', text: result.error ?? '删除失败' });
          refresh();
        },
        [refresh],
      );

      const onProbe = useCallback(async () => {
        setProbeText('探测中…');
        const result = await postJson('/dsh-autoplay/probe');
        setProbeText(summarizeProbe(result));
      }, []);

      const onSpec = useCallback(async () => {
        if (specText !== null) {
          setSpecText(null);
          return;
        }
        const result = await call('/dsh-autoplay/spec').catch(() => null);
        setSpecText(result?.text ? result.text : '读取规范失败。');
      }, [specText]);

      const onCopyTemplate = useCallback(() => {
        setRuleText(
          JSON.stringify(
            {
              id: 'my-platform',
              name: '某网课平台',
              version: 1,
              match: ['learn.example.com'],
              advance: {
                nextUnit: null,
                selector: null,
                js: null,
                navItem: {
                  item: '.lesson-item',
                  activeClass: 'is-active',
                  idPattern: null,
                  hrefFromId: false,
                  tag: '.item-type',
                  title: '.item-name',
                  videoTagText: '视频',
                  progress: null,
                },
              },
            },
            null,
            2,
          ),
        );
        setRuleNotice({ kind: 'ok', text: '已填入模板：把 match / 选择器改成你探测到的真实值，再保存。' });
      }, []);

      if (state === null) {
        return h('div', { className: 'cw-root' }, h(Style), h('div', { className: 'cw-hint' }, '正在连接宿主插件…'));
      }

      const running = state.running === true;
      const latest = state.latest ?? null;
      const percent = percentOf(latest);
      // 宿主一次给 60 条，这里全用上（原来只取 10 条，一次连播几小时也只看得到几分钟）
      const events = Array.isArray(state.log) ? state.log.slice(-30).reverse() : [];
      const rules = Array.isArray(state.rules) ? state.rules : [];

      return h(
        'div',
        { className: 'cw-root' },
        h(Style),
        h(
          'div',
          { className: 'cw-head' },
          h('div', { className: 'cw-title' }, '刷课连播'),
          h('span', { className: 'cw-pill ' + (running ? 'is-on' : 'is-off') }, running ? '监控中' : state.starting ? '启动中' : '已停止'),
        ),
        h('div', { className: 'cw-desc' }, '自动播放课程视频，本节播完自动翻到下一节，并跳过习题。启动后会打开一个带调试端口的独立 Chrome。'),

        h(
          'div',
          { className: 'cw-row' },
          h('input', {
            className: 'cw-input',
            type: 'text',
            spellCheck: false,
            placeholder: '课程视频页地址，例如 https://…/video/12345',
            value: url,
            disabled: running || busy,
            onChange: (event) => {
              urlEdited.current = true;
              setUrl(event.target.value);
            },
          }),
          h('button', { className: 'cw-btn is-primary', type: 'button', disabled: running || busy, onClick: onStart }, running ? '监控中' : '启动并监控'),
          h('button', { className: 'cw-btn', type: 'button', disabled: !running || busy, onClick: onStop }, '停止'),
        ),

        notice !== null ? h('div', { className: 'cw-notice is-' + notice.kind }, notice.text) : null,
        state.error ? h('div', { className: 'cw-notice is-error' }, String(state.error)) : null,
        state.browserFound === false ? h('div', { className: 'cw-notice is-error' }, '没找到 Chrome 或 Edge，无法启动浏览器。') : null,

        h(
          'div',
          { className: 'cw-grid' },
          h(Metric, { label: '当前进度', value: percent === null ? '—' : percent + '%' }),
          h(Metric, { label: '本次已连播', value: String(state.lessonsAdvanced ?? 0) + ' 节' }),
          h(Metric, { label: '生效规则', value: String(rules.filter((r) => r.usable).length) + ' 条' }),
          h(Metric, { label: '调试端口', value: String(state.port ?? '') }),
        ),

        h('div', { className: 'cw-sub' }, '最近动态'),
        h(
          'div',
          { className: 'cw-log' },
          events.length === 0
            ? h('div', { className: 'cw-hint' }, '还没有动态。点上面的按钮开始。')
            : events.map((record, index) =>
                h(
                  'div',
                  { className: 'cw-logline', key: String(index) + (record.ts ?? '') },
                  h('span', { className: 'cw-logtime' }, String(record.ts ?? '').slice(11, 19)),
                  h('span', { className: 'cw-logtext' }, describe(record)),
                ),
              ),
        ),

        h('div', { className: 'cw-sub' }, '翻页规则'),
        h(
          'div',
          { className: 'cw-hint' },
          '内置两条规则（雨课堂、学堂在线研究生院）。规则按域名匹配：不带 * 按包含匹配，带 * 按通配符匹配。用户规则目录：',
          h('code', { className: 'cw-code' }, state.rulesDir ?? ''),
        ),
        h(
          'div',
          { className: 'cw-rules' },
          rules.length === 0
            ? h('div', { className: 'cw-hint' }, '没有加载到任何规则。')
            : rules.map((rule) =>
                h(
                  'div',
                  { className: 'cw-rule', key: rule.id, title: rule.note ?? undefined },
                  h(
                    'div',
                    { className: 'cw-rule-main' },
                    h('span', { className: 'cw-rule-name' }, rule.name || rule.id),
                    h('span', { className: 'cw-badge ' + (rule.source === 'user' ? 'is-user' : 'is-builtin') }, rule.source === 'user' ? '用户' : '内置'),
                    h('span', { className: 'cw-rule-match' }, matchText(rule.match)),
                  ),
                  rule.usable ? null : h('div', { className: 'cw-rule-note is-error' }, '这条规则不可用：' + rule.errors.join('；')),
                  rule.source === 'user'
                    ? h('button', { className: 'cw-btn is-tiny', type: 'button', onClick: () => onDeleteRule(rule.id) }, '删除')
                    : null,
                ),
              ),
        ),
        h(
          'div',
          { className: 'cw-row' },
          h('button', { className: 'cw-btn is-tiny', type: 'button', onClick: onCopyTemplate }, '填入规则模板'),
          h('button', { className: 'cw-btn is-tiny', type: 'button', onClick: onProbe }, '探测当前页面'),
          h('button', { className: 'cw-btn is-tiny', type: 'button', onClick: onSpec }, specText === null ? '查看适配规范' : '收起规范'),
        ),
        h('textarea', {
          className: 'cw-textarea',
          spellCheck: false,
          placeholder: '把一条规则 JSON 粘到这里，然后点「保存规则」。',
          value: ruleText,
          onChange: (event) => setRuleText(event.target.value),
        }),
        h('div', { className: 'cw-row' }, h('button', { className: 'cw-btn is-primary is-tiny', type: 'button', disabled: ruleText.trim().length === 0, onClick: onSaveRule }, '保存规则')),
        ruleNotice !== null ? h('div', { className: 'cw-notice is-' + ruleNotice.kind }, ruleNotice.text) : null,
        h('div', { className: 'cw-hint' }, '探测结果里 `lessonLinks` 为空，通常说明课程目录不是链接（纯 div + 事件），那就按 `navItem` 写；`idSamples` 里常能直接看到目录项的 id 规律。若 `videos=0`，等页面完全加载后再探一次。'),
        probeText !== null ? h('pre', { className: 'cw-pre' }, probeText) : null,
        specText !== null ? h('pre', { className: 'cw-pre is-spec' }, specText) : null,

        h('div', { className: 'cw-hint' }, '提示：第一次使用需要在那个人工打开的 Chrome 窗口里登录课程平台，登录态会保存在独立配置目录里（与插件自己的 profile 绑定，和日常 Chrome 不共享）。'),
      );
    }

    function Metric(props) {
      return h(
        'div',
        { className: 'cw-metric' },
        h('div', { className: 'cw-metric-label' }, props.label),
        h('div', { className: 'cw-metric-value' }, props.value),
      );
    }

    function Style() {
      return h(
        'style',
        null,
        `
/* 中央面板要自己滚：主面板容器不替内容滚动，所以这里占满高度并向内滚动。
   否则内容一高就被裁掉、页面又滑不动——原来在设置页时有外层滚动容器，搬过来才暴露。 */
.cw-root { display: flex; flex-direction: column; gap: 12px; height: 100%; box-sizing: border-box; overflow-y: auto; overscroll-behavior: contain; padding: 20px 24px 32px; color: var(--dsw-alias-label-primary, #1f2328); font-size: 13px; }
/* 滚动条留在列边缘，内容限宽以便阅读 */
.cw-root > * { max-width: 860px; }
/* 面板内一律 border-box。否则带 padding/border 的盒子在 max-width 下会按内容盒计算，
   比邻居宽出 padding+border——实测「最近动态」比其它框宽 22px（20 padding + 2 border）。
   表单控件天然就是 border-box，所以只有这种 div 会歪。 */
.cw-root, .cw-root * { box-sizing: border-box; }
/* 品牌色底上的前景色必须用页面底色（bg-base）而不是写死 #fff：
   深色模式下 brand-primary 是浅色，写死白字会变成「白底白字」看不见。
   brand-primary 按定义要与 bg-base 形成对比，所以 bg-base 就是它的反色。 */
.cw-head { display: flex; align-items: center; gap: 10px; }
.cw-title { font-size: 15px; font-weight: 600; }
.cw-pill { padding: 2px 10px; border-radius: 999px; font-size: 12px; border: 1px solid var(--dsw-alias-border-l2, #d0d7de); color: var(--dsw-alias-label-secondary, #57606a); }
.cw-pill.is-on { color: var(--dsw-alias-state-success-primary, #1a7f37); border-color: currentColor; }
.cw-pill.is-off { color: var(--dsw-alias-state-idle-primary, #8c959f); }
.cw-desc, .cw-hint { color: var(--dsw-alias-label-secondary, #57606a); line-height: 1.6; }
.cw-hint { font-size: 12px; }
.cw-code { background: var(--dsw-alias-bg-layer-2, #f6f8fa); padding: 1px 5px; border-radius: 4px; }
.cw-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.cw-input, .cw-textarea { padding: 7px 10px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2, #d0d7de); background: var(--dsw-alias-bg-layer-1, #fff); color: inherit; font-size: 13px; font-family: inherit; }
.cw-input { flex: 1 1 320px; min-width: 240px; }
.cw-textarea { width: 100%; min-height: 150px; box-sizing: border-box; font-family: ui-monospace, Consolas, monospace; font-size: 12px; line-height: 1.5; }
.cw-input:focus, .cw-textarea:focus { outline: 2px solid var(--dsw-alias-brand-primary, #0969da); outline-offset: -1px; }
.cw-input:disabled { opacity: .6; }
.cw-btn { padding: 7px 14px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2, #d0d7de); background: var(--dsw-alias-bg-layer-1, #fff); color: inherit; font-size: 13px; font-family: inherit; cursor: pointer; }
.cw-btn:hover:not(:disabled) { border-color: var(--dsw-alias-border-l1, #afb8c1); }
.cw-btn:disabled { opacity: .5; cursor: default; }
.cw-btn.is-primary { background: var(--dsw-alias-brand-primary, #0969da); border-color: transparent; color: var(--dsw-alias-bg-base, #fff); }
.cw-btn.is-tiny { padding: 4px 10px; font-size: 12px; }
.cw-notice { padding: 8px 10px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2, #d0d7de); background: var(--dsw-alias-bg-layer-2, #f6f8fa); }
.cw-notice.is-ok { color: var(--dsw-alias-state-success-primary, #1a7f37); }
.cw-notice.is-error { color: var(--dsw-alias-state-error-primary, #cf222e); }
.cw-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
.cw-metric { padding: 10px 12px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1, #d8dee4); background: var(--dsw-alias-bg-layer-1, #fff); }
.cw-metric-label { color: var(--dsw-alias-label-secondary, #57606a); font-size: 12px; margin-bottom: 4px; }
.cw-metric-value { font-size: 16px; font-weight: 600; }
.cw-sub { font-weight: 600; margin-top: 4px; }
/* 高度随窗口走。关键是**同时给 min-height**：只写 max-height 的话它只封顶、不撑高，
   事件少的时候框会缩成两三行高（看起来就是「框不够高」）。 */
.cw-log { display: flex; flex-direction: column; gap: 4px; min-height: clamp(200px, 34vh, 460px); max-height: clamp(300px, 52vh, 760px); overflow-y: auto; overflow-x: hidden; padding: 8px 10px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1, #d8dee4); background: var(--dsw-alias-bg-layer-2, #f6f8fa); }
.cw-logline { display: flex; gap: 8px; line-height: 1.5; }
.cw-logtime { color: var(--dsw-alias-label-secondary, #57606a); font-variant-numeric: tabular-nums; flex: 0 0 auto; }
/* min-width:0 是关键：flex 子项默认 min-width:auto，会拒绝收缩到内容宽度以下，
   于是播报里那条长 URL 会撑宽整行、被横向裁掉（看着像"这一栏太窄"）。
   overflow-wrap:anywhere 让没有空格的长串也能断行。 */
.cw-logtext { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.cw-rules { display: flex; flex-direction: column; gap: 6px; }
.cw-rule { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1, #d8dee4); background: var(--dsw-alias-bg-layer-1, #fff); }
.cw-rule-main { display: flex; align-items: center; gap: 8px; flex: 1 1 auto; flex-wrap: wrap; }
.cw-rule-name { font-weight: 600; }
.cw-rule-match { color: var(--dsw-alias-label-secondary, #57606a); font-family: ui-monospace, Consolas, monospace; font-size: 11px; min-width: 0; overflow-wrap: anywhere; }
.cw-badge { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid currentColor; }
.cw-badge.is-user { color: var(--dsw-alias-brand-primary, #0969da); }
.cw-badge.is-builtin { color: var(--dsw-alias-state-idle-primary, #8c959f); }
.cw-rule-note { flex: 1 1 100%; min-width: 0; overflow-wrap: anywhere; font-size: 12px; color: var(--dsw-alias-label-secondary, #57606a); }
.cw-rule-note.is-warn { color: var(--dsw-alias-state-warn-primary, #9a6700); }
.cw-rule-note.is-error { color: var(--dsw-alias-state-error-primary, #cf222e); }
.cw-pre { margin: 0; max-height: 320px; overflow: auto; padding: 10px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1, #d8dee4); background: var(--dsw-alias-bg-layer-2, #f6f8fa); font-family: ui-monospace, Consolas, monospace; font-size: 11px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.cw-pre.is-spec { max-height: 460px; }
`,
      );
    }

    /**
     * 侧栏图标。用 currentColor 着色，随侧栏行的未选中/选中状态走，
     * 不写死颜色（写死会在深色模式下变成看不见）。
     */
    function PanelIcon(props) {
      const size = props?.size ?? 20;
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true, style: { display: 'block' } },
        h('rect', { x: 2.5, y: 4.5, width: 14, height: 11, rx: 2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }),
        h('path', { d: 'M7 8.2l4.2 2.6L7 13.4z', fill: 'currentColor' }),
        h('path', {
          d: 'M16.6 8.2l3 3-3 3',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 侧栏图标与主面板**必须成对注册**：panellist 的 id 就是 main 的 key，
        // 侧栏靠这个 id 选中主面板；只注册图标的话，点它会因为找不到 main 条目而抛错。
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => PANEL_LABEL }, PanelIcon),
        );
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID }, () => h(Panel, { t: null })),
        );
      },
    };
  },
});
