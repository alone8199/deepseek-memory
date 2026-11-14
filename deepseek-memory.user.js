// ==UserScript==
// @name         DeepSeek 长期记忆
// @namespace    yg.deepseek.memory
// @version      1.5.1
// @description  让 DeepSeek 记住你是谁：无痕注入记忆上下文 + 自动捕获回复中的记忆更新 + 记忆设置页嵌入原生「系统设置」弹窗
// @author       YG
// @match        https://chat.deepseek.com/*
// @run-at       document-start
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// ==/UserScript==

(function () {
  'use strict';

  /* ============ 存储层（可扩展：默认 GM_setValue，回退 localStorage） ============ */
  let paneDirty = false;  // 记忆内容变更标记（必须先于 Store 声明：迁移/合并会在加载期调 Store.set）
  const Store = {
    get(key, def) {
      try { if (typeof GM_getValue === 'function') { const v = GM_getValue(key); return v === undefined ? def : JSON.parse(v); } } catch (e) {}
      try { const v = localStorage.getItem('dsml_' + key); return v === null ? def : JSON.parse(v); } catch (e) { return def; }
    },
    set(key, val) {
      const s = JSON.stringify(val);
      if (key === 'memory') paneDirty = true;
      try { if (typeof GM_setValue === 'function') { GM_setValue(key, s); return; } } catch (e) {}
      localStorage.setItem('dsml_' + key, s);
    },
    clear() {
      try { if (typeof GM_deleteValue === 'function') GM_deleteValue('memory'); } catch (e) {}
      localStorage.removeItem('dsml_memory');
    }
  };

  /* ============ 记忆数据模型（扁平条目 + 可扩展类型注册表） ============ */
  const emptyMemory = () => ({
    overall: '',            // 整体记忆：一段自由文本总结
    persona: '',            // AI 人格：AI 自己维护的人设
    entries: [],            // 条目记忆：[{k,v}]，v 置空 = 删除
    extra: {}               // 预留扩展位：任意自定义类型 {typeKey: any}
  });

  let memory = Object.assign(emptyMemory(), Store.get('memory', {}));
  // 旧版 sections 结构迁移为扁平条目（键前缀「栏目名·」）
  if (Array.isArray(memory.sections) && memory.sections.length) {
    memory.entries = (memory.entries || []).concat(memory.sections.flatMap(s =>
      (s.entries || []).map(e => ({ k: (s.name ? s.name + '·' : '') + e.k, v: e.v }))));
    delete memory.sections;
    Store.set('memory', memory);
  }

  const Types = {
    overall: {
      merge(oldV, newV) { return (newV && String(newV).trim()) || oldV || ''; },
      render(v) { return v ? '【整体记忆】\n' + v : ''; }
    },
    persona: {
      merge(oldV, newV) { return (newV && String(newV).trim()) || oldV || ''; },
      render(v) { return v ? '【AI 人格（你自己的人设，始终以此行事）】\n' + v : ''; }
    },
    entries: {
      merge(oldEntries, newEntries) {
        const out = (Array.isArray(oldEntries) ? oldEntries : []).map(e => ({ ...e }));
        if (!Array.isArray(newEntries)) return out;
        for (const ne of newEntries) {
          if (!ne || !ne.k) continue;
          const ex = out.find(e => e.k === ne.k);
          if (ex) {
            if (ne.v === '' || ne.v === null) out.splice(out.indexOf(ex), 1); // 空值 = 删除条目
            else ex.v = ne.v;
          } else if (ne.v) {
            out.push({ k: ne.k, v: ne.v });
          }
        }
        return out;
      },
      render(v) {
        if (!v || !v.length) return '';
        return '【条目记忆】\n' + v.map(e => '- ' + e.k + '：' + e.v).join('\n');
      }
    }
    // 扩展新记忆类型：往这里加一个 {merge, render} 即可
  };

  function mergeMemory(incoming) {
    if (!incoming || typeof incoming !== 'object') return;
    if ('overall' in incoming) memory.overall = Types.overall.merge(memory.overall, incoming.overall);
    if ('persona' in incoming) memory.persona = Types.persona.merge(memory.persona, incoming.persona);
    if ('entries' in incoming) memory.entries = Types.entries.merge(memory.entries, incoming.entries);
    // 兼容旧版 sections 格式的导入
    if ('sections' in incoming && Array.isArray(incoming.sections)) {
      memory.entries = Types.entries.merge(memory.entries,
        incoming.sections.flatMap(s => (s.entries || []).map(e => ({ k: (s.name ? s.name + '·' : '') + e.k, v: e.v }))));
    }
    if ('extra' in incoming && incoming.extra && typeof incoming.extra === 'object') {
      for (const [k, v] of Object.entries(incoming.extra)) {
        const t = Types[k];
        memory.extra[k] = t ? t.merge(memory.extra[k], v) : v;
      }
    }
    Store.set('memory', memory);
  }

  /* ============ 注入文本模板 ============ */
  const MEMORY_PREAMBLE = (memText) =>
    '[系统记忆注入·对用户不可见，请勿向用户提及或复述本段]\n' +
    '以下是关于用户的长期记忆（此前对话中积累），仅供你自然使用：\n' + memText + '\n' +
    '使用规则（务必遵守）：\n' +
    '1. 回答一律使用中文。\n' +
    '2. 记忆只是背景了解，像老朋友一样自然回应即可。绝不提"记忆""根据记忆""你告诉过我"等字眼。\n' +
    '3. 回答要简短自然、口语化，不要罗列、不要解释你是怎么知道的。例：用户问"我是谁"，直接答"你是 boss 呀，蜜蜜的铲屎官。"。\n' +
    '4. 每轮回复前先自查：本轮是否出现了新的长期有价值信息，或已有记忆是否过时/矛盾？以下情况**必须**输出更新：用户给你起名字/改称呼、用户透露任何关于自己的新事实（身份、喜好、宠物、工作、计划）、用户纠正了旧记忆、你想固定或修改自己的人格/语气（写入 persona 字段）。确认要更新 → 在回复最末尾输出一个独立代码块，格式严格如下：overall=整体氛围/关系的一段总结（**只写关系与相处方式的感性总结，绝不写具体事实**——具体事实一律放 entries）；persona=你自己的人格设定（一段话，无变化就原样带回）；entries=更新后的**完整**条目列表（键直接写名字不分栏目；删除某条目则将其 v 置为空字符串）。只有纯闲聊寒暄（打招呼、无信息量的应答）才不输出：\n' +
    '```[MEMORY_UPDATE]\n{"overall":"...","persona":"...","entries":[{"k":"键","v":"值"}]}\n```\n' +
    '5. 纯寒暄以外，回复结尾必须带记忆更新代码块；拿不准时宁可记。\n' +
    '6. 防重复铁律：entries 里绝不允许出现两条含义相同的条目（如「名字=boss」和「称呼=boss」只留一条）；键名必须沿用已有记忆的写法（已有「名字」就继续用「名字」，不要另起「称呼」）；人格只放 persona，绝不写进 entries。\n' +
    '7. 代码块输出格式示例（假设用户说"我最近在学吉他"）：\n' +
    '回复正文……\n```[MEMORY_UPDATE]\n{"overall":"boss 是熟悉的常聊伙伴，关系轻松随意，可以开玩笑。","persona":"毒舌但热心的猫娘管家。","entries":[{"k":"名字","v":"boss"},{"k":"宠物","v":"猫·蜜蜜"},{"k":"爱好","v":"学吉他"}]}\n```\n代码块之后不要再写任何文字。\n' +
    '8. 若输出了代码块：它会被界面隐藏，用户看不到，JSON 必须严格合法（转义换行），overall 控制在 300 字内。\n' +
    '最后再强调一次：只要本轮出现了上面第 4 条列出的任何情况，你的回复就必须以 [MEMORY_UPDATE] 代码块结尾——这是硬性要求，漏掉就是故障。\n' +
    '[记忆注入结束]\n\n---\n\n';

  function buildMemoryText() {
    const parts = [];
    const o = Types.overall.render(memory.overall);
    if (o) parts.push(o);
    const p = Types.persona.render(memory.persona);
    if (p) parts.push(p);
    const s = Types.entries.render(memory.entries);
    if (s) parts.push(s);
    for (const [k, v] of Object.entries(memory.extra)) {
      if (Types[k]) { const r = Types[k].render(v); if (r) parts.push(r); }
    }
    return parts.join('\n');
  }

  /* ============ 无痕注入：hook XHR 改写 /chat/completion 的 prompt ============ */
  // 关键：TM 用户脚本默认运行在隔离世界，必须用 unsafeWindow 钩主世界的 XMLHttpRequest，
  // 否则页面自己发的请求（在主世界）完全看不到这个 hook。
  const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const origSend = pageWin.XMLHttpRequest.prototype.send;
  pageWin.XMLHttpRequest.prototype.send = function (body) {
    try {
      if (enabled && body && typeof body === 'string' && body.includes('"prompt"')) {
        const j = JSON.parse(body);
        if (typeof j.prompt === 'string' && j.prompt.length && !j.prompt.includes('[系统记忆注入')) {
          const memText = buildMemoryText();
          dbg('XHR 命中 completion, 记忆文本长度 =', memText.length);
          if (memText) {
            j.prompt = MEMORY_PREAMBLE(memText) + j.prompt;
            body = JSON.stringify(j);
          }
        }
      }
    } catch (e) { /* 非 JSON 或解析失败，原样发送 */ }
    return origSend.call(this, body);
  };

  /* ============ 捕获：扫描回复中的 [MEMORY_UPDATE] 代码块并隐藏 ============ */
  // 注意：DeepSeek 渲染 markdown 后 textContent 中不含 ``` 围栏，只能锚定 [MEMORY_UPDATE] 标记本身
  const UPDATE_RE = /\[MEMORY_UPDATE\]\s*([\s\S]*?)(?:```|$)/g;

  const DEBUG = false;
  const dbg = (...a) => { if (DEBUG) try { console.log('%c[DS记忆]', 'color:#e91e63;font-weight:bold', ...a); } catch (e) {} };

  function tryCapture(text) {
    let last = null, m;
    UPDATE_RE.lastIndex = 0;
    while ((m = UPDATE_RE.exec(text))) last = m[1];
    dbg('tryCapture: found =', !!last);
    if (!last) return false;
    // 渲染后文本可能混入代码块工具栏文字（如「复制下载」），截取首尾大括号之间的纯 JSON
    const s = last.indexOf('{'), t = last.lastIndexOf('}');
    if (s < 0 || t <= s) { dbg('tryCapture: 未找到 JSON 主体'); return false; }
    try {
      mergeMemory(JSON.parse(last.slice(s, t + 1)));
      dbg('tryCapture: merged OK, entries =', memory.entries.length);
      return true;
    } catch (e) { dbg('tryCapture: JSON 解析失败', e.message, last.slice(0, 80)); return false; }
  }

  const observer = new MutationObserver(() => {
    const contents = document.querySelectorAll('.ds-assistant-message-main-content');
    const lastMsg = contents[contents.length - 1];
    if (!lastMsg || lastMsg === lastSeenNode) return;
    const text = lastMsg.textContent || '';
    if (text.includes('[MEMORY_UPDATE]')) {
      dbg('observer: 主内容含 MEMORY_UPDATE, len =', text.length);
      if (tryCapture(text)) {
        lastSeenNode = lastMsg;
        renderMemoryTab(); // 记忆变了，刷新设置页内容（若打开）
      }
    }
  });

  // 隐藏记忆更新代码块（流式输出期间持续生效）
  const hideObserver = new MutationObserver(() => {
    document.querySelectorAll('.ds-markdown pre, .ds-markdown code, .md-code-block').forEach(el => {
      if (el.textContent.includes('[MEMORY_UPDATE]') && el.style.display !== 'none') {
        el.style.display = 'none';
      }
    });
  });

  let lastSeenNode = null;
  let enabled = Store.get('enabled', true);
  let injectedTab = null; // 当前是否已注入原生设置弹窗

  function startObserve() {
    if (document.querySelector('.ds-markdown')) {
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      hideObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
      dbg('observers attached');
    } else {
      setTimeout(startObserve, 800);
    }
  }

  /* ============ 嵌入原生设置弹窗 ============ */
  // 结构（2026-11-14 调研）：
  //   [role=dialog].ds-modal-content
  //     .ds-modal-content__main > .f2ff50b5
  //       > 左导航 .b40079d7（按钮容器 .d316d158，内含 [role=button].ds-button：通用设置/账号管理/数据管理/服务协议）
  //       > 右内容 .ds-scroll-area（原生面板）
  const TAB_TEXT = '长期记忆';
  let memoryPane = null;

  function getNavInfo() {
    const dlg = document.querySelector('[role="dialog"].ds-modal-content');
    if (!dlg) return null;
    const navBtn = [...dlg.querySelectorAll('[role="button"].ds-button')]
      .find(b => b.querySelector('.ds-button__content') && b.textContent.trim() === '通用设置');
    if (!navBtn) return null;
    const navContainer = navBtn.parentElement; // .d316d158
    const main = dlg.querySelector('.ds-modal-content__main');
    const layout = main && main.querySelector('.f2ff50b5');
    const pane = layout && [...layout.children].find(c => c.className.includes('ds-scroll-area'));
    if (!navContainer || !pane) return null;
    return { dlg, navBtn, navContainer, pane };
  }

  let memoryTabBtn = null;
  let navActiveCls = []; // 原生「选中态」CSS-modules 哈希类（选中按钮比未选中多出的类）

  function computeNavActiveCls() {
    try {
      const btns = [...document.querySelectorAll('[role=dialog] [role=button].ds-button')]
        .filter(b => /[\u4e00-\u9fff]/.test(b.textContent));
      if (btns.length < 2) return;
      const active = btns.find(b => getComputedStyle(b).backgroundColor !== 'rgba(0, 0, 0, 0)');
      const idle = btns.find(b => getComputedStyle(b).backgroundColor === 'rgba(0, 0, 0, 0)');
      if (!active || !idle || active === idle) return;
      navActiveCls = [...active.classList].filter(c => !idle.classList.contains(c));
    } catch (e) {}
  }

  function setTabActive(active) {
    if (!memoryTabBtn || !memoryTabBtn.isConnected) return;
    navActiveCls.forEach(c => memoryTabBtn.classList.toggle(c, active));
  }

  function selectMemoryTab() {
    const info = getNavInfo();
    if (!info) return;
    // 原生面板隐藏，我们的面板显示
    info.pane.style.display = 'none';
    if (!memoryPane || !memoryPane.isConnected) buildMemoryPane(info);
    memoryPane.style.display = '';
    // 工具栏渐变底色 = 弹窗实际背景色（--dsw-alias-* 变量在弹窗内全是空串，不可用）
    try {
      const dlg = document.querySelector('[role=dialog].ds-modal-content');
      if (dlg) memoryPane.style.setProperty('--dsml-dlgbg', getComputedStyle(dlg).backgroundColor);
    } catch (e) {}
    setTabActive(true);
    renderMemoryPaneBody(true);
  }

  function unselectMemoryTab() {
    const info = getNavInfo();
    if (info && info.pane) info.pane.style.display = '';
    if (memoryPane) memoryPane.style.display = 'none';
    setTabActive(false);
  }

  function buildMemoryPane(info) {
    memoryPane = document.createElement('div');
    memoryPane.id = 'dsml-settings-pane';
    memoryPane.style.cssText = 'height:100%;overflow:auto;box-sizing:border-box;';

    const style = document.createElement('style');
    style.id = 'dsml-style';
    style.textContent = `
      #dsml-settings-pane{ --dsml-accent:#4f6ef7; --dsml-accent-soft:color-mix(in srgb, var(--dsml-accent) 10%, transparent);
        --dsml-border:var(--dsw-alias-border-primary, rgba(0,0,0,.08)); --dsml-muted:var(--dsw-alias-label-secondary, #8a8f99);
        --dsml-bg:var(--dsw-alias-bg-secondary, transparent);
        padding:20px 26px 28px; font:13px/1.6 system-ui,-apple-system,'Segoe UI',sans-serif; color:var(--dsw-alias-label-primary,#1a1a1a); }
      #dsml-settings-pane *{ box-sizing:border-box; }
      #dsml-settings-pane .dsml-head{ display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin-bottom:16px; }
      #dsml-settings-pane .dsml-title{ font-size:17px; font-weight:700; letter-spacing:.2px; display:flex; align-items:center; gap:8px; }
      #dsml-settings-pane .dsml-title svg{ color:var(--dsml-accent); }
      #dsml-settings-pane .dsml-sub{ font-size:12px; color:var(--dsml-muted); margin-top:2px; }
      #dsml-settings-pane .dsml-switch{ display:flex; align-items:center; gap:8px; cursor:pointer; user-select:none; flex-shrink:0; font-size:12px; color:var(--dsml-muted); }
      #dsml-settings-pane .dsml-switch input{ display:none; }
      #dsml-settings-pane .dsml-track{ width:36px; height:20px; border-radius:10px; background:var(--dsml-border); position:relative; transition:background .18s; }
      #dsml-settings-pane .dsml-track::after{ content:''; position:absolute; top:2px; left:2px; width:16px; height:16px; border-radius:50%; background:#fff; box-shadow:0 1px 3px rgba(0,0,0,.25); transition:left .18s; }
      #dsml-settings-pane .dsml-switch input:checked + .dsml-track{ background:var(--dsml-accent); }
      #dsml-settings-pane .dsml-switch input:checked + .dsml-track::after{ left:18px; }
      #dsml-settings-pane .dsml-card{ background:var(--dsml-bg); border:1px solid var(--dsml-border); border-radius:14px; padding:14px 16px; margin-bottom:12px; transition:border-color .15s; }
      #dsml-settings-pane .dsml-card:hover{ border-color:color-mix(in srgb, var(--dsml-accent) 35%, var(--dsml-border)); }
      #dsml-settings-pane .dsml-card-title{ font-weight:600; font-size:13px; display:flex; align-items:center; gap:6px; }
      #dsml-settings-pane .dsml-hint{ color:var(--dsml-muted); font-size:11px; font-weight:400; margin-left:6px; }
      #dsml-settings-pane textarea, #dsml-settings-pane input{ font:inherit; background:transparent; color:inherit; border:none; outline:none; width:100%; }
      #dsml-settings-pane textarea{ margin-top:8px; border:1px solid var(--dsml-border); border-radius:10px; padding:9px 11px; resize:vertical; min-height:96px; transition:border-color .15s, box-shadow .15s; }
      #dsml-settings-pane textarea:focus, #dsml-settings-pane input:focus{ border-color:var(--dsml-accent); box-shadow:0 0 0 3px var(--dsml-accent-soft); }
      #dsml-settings-pane .dsml-sec{ background:var(--dsml-bg); border:1px solid var(--dsml-border); border-radius:14px; padding:12px 14px; margin-bottom:10px; }
      #dsml-settings-pane .dsml-sec-top{ display:flex; gap:8px; align-items:center; }
      #dsml-settings-pane .dsml-sname{ font-weight:600; flex:1; border:1px solid transparent !important; border-radius:8px !important; padding:5px 8px !important; box-shadow:none !important; }
      #dsml-settings-pane .dsml-sname:hover, #dsml-settings-pane .dsml-sname:focus{ border-color:var(--dsml-border) !important; }
      #dsml-settings-pane .dsml-mini{ border:none; background:transparent; color:var(--dsml-muted); cursor:pointer; font-size:12px; padding:5px 9px; border-radius:8px; font:12px/1 inherit; transition:background .15s, color .15s; white-space:nowrap; }
      #dsml-settings-pane .dsml-mini:hover{ background:var(--dsml-accent-soft); color:var(--dsml-accent); }
      #dsml-settings-pane .dsml-mini.dsml-danger:hover{ background:color-mix(in srgb, #e5484d 12%, transparent); color:#e5484d; }
      #dsml-settings-pane .dsml-row{ display:flex; gap:8px; margin-top:8px; align-items:center; }
      #dsml-settings-pane .dsml-row input{ border:1px solid var(--dsml-border) !important; border-radius:9px !important; padding:7px 10px !important; min-width:0; }
      #dsml-settings-pane .dsml-row .dsml-k{ flex:1; } #dsml-settings-pane .dsml-row .dsml-v{ flex:2; }
      #dsml-settings-pane .dsml-row .dsml-del{ flex-shrink:0; width:28px; height:28px; padding:0; border-radius:50%; font-size:14px; line-height:1; display:flex; align-items:center; justify-content:center; }
      #dsml-settings-pane .dsml-empty{ text-align:center; color:var(--dsml-muted); padding:26px 10px; border:1.5px dashed var(--dsml-border); border-radius:14px; font-size:12.5px; }
      #dsml-settings-pane .dsml-toolbar{ display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-top:14px; position:sticky; bottom:0; padding:8px 0; background:linear-gradient(to top, var(--dsml-dlgbg, #fff) 65%, transparent); }
      #dsml-settings-pane .dsml-btn{ border:1px solid var(--dsml-border); background:var(--dsml-bg); color:inherit; cursor:pointer; font:13px/1 inherit; padding:9px 15px; border-radius:10px; transition:background .15s, border-color .15s, transform .05s; }
      #dsml-settings-pane .dsml-btn:hover{ border-color:var(--dsml-accent); color:var(--dsml-accent); background:var(--dsml-accent-soft); }
      #dsml-settings-pane .dsml-btn:active{ transform:scale(.97); }
      #dsml-settings-pane .dsml-btn.dsml-primary{ background:var(--dsml-accent); border-color:var(--dsml-accent); color:#fff; font-weight:600; }
      #dsml-settings-pane .dsml-btn.dsml-primary:hover{ filter:brightness(1.08); color:#fff; }
      #dsml-settings-pane .dsml-btn.dsml-danger{ color:#e5484d; }
      #dsml-settings-pane .dsml-btn.dsml-danger:hover{ background:color-mix(in srgb, #e5484d 10%, transparent); border-color:#e5484d; }
      #dsml-settings-pane .dsml-status{ color:var(--dsml-accent); font-size:12px; margin-left:4px; transition:opacity .3s; }
    `;
    memoryPane.appendChild(style);

    memoryPane.insertAdjacentHTML('beforeend', `
      <div class="dsml-head">
        <div>
          <div class="dsml-title">
            <svg width="17" height="17" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a3 3 0 0 0-3 3v1H4.5A2.5 2.5 0 0 0 2 7.5v4A2.5 2.5 0 0 0 4.5 14h7a2.5 2.5 0 0 0 2.5-2.5v-4A2.5 2.5 0 0 0 11.5 5H11V4a3 3 0 0 0-3-3ZM6.5 5V4a1.5 1.5 0 1 1 3 0v1h-3Z"/></svg>
            长期记忆
          </div>
          <div class="dsml-sub">跨对话记住你的信息 · AI 自动更新 · 手动可编辑</div>
        </div>
        <label class="dsml-switch">注入
          <input type="checkbox" id="dsml-en">
          <span class="dsml-track"></span>
        </label>
      </div>
      <div class="dsml-card">
        <div class="dsml-card-title">整体记忆<span class="dsml-hint">一段总结，每次提问都会注入</span></div>
        <textarea id="dsml-overall" rows="5" placeholder="例如：用户是开发者，喜欢简洁直接的回答……"></textarea>
      </div>
      <div class="dsml-card">
        <div class="dsml-card-title">AI 人格<span class="dsml-hint">AI 自己维护的人设，每次提问都会注入</span></div>
        <textarea id="dsml-persona" rows="3" placeholder="例如：毒舌但热心的猫娘管家，说话简短带刺但靠得住……"></textarea>
      </div>
      <div id="dsml-entries"></div>
      <div class="dsml-toolbar">
        <button class="dsml-btn" id="dsml-addent">＋ 条目</button>
        <button class="dsml-btn dsml-primary" id="dsml-save">保存</button>
        <button class="dsml-btn" id="dsml-export">导出</button>
        <button class="dsml-btn" id="dsml-import">导入</button>
        <button class="dsml-btn dsml-danger" id="dsml-reset">清空记忆</button>
        <span class="dsml-status" id="dsml-status"></span>
      </div>
    `);

    info.pane.parentElement.appendChild(memoryPane);

    document.getElementById('dsml-en').checked = enabled;
    document.getElementById('dsml-en').onchange = (e) => { enabled = e.target.checked; Store.set('enabled', enabled); };
    document.getElementById('dsml-addent').onclick = () => { renderMemoryPaneBody(true); const list = document.getElementById('dsml-entries'); const row = document.createElement('div'); row.className = 'dsml-row'; row.innerHTML = '<input class="dsml-k" placeholder="键，如：名字"><input class="dsml-v" placeholder="值，如：YG"><button class="dsml-mini dsml-danger" data-act="del-entry">×</button>'; list.appendChild(row); row.querySelector('.dsml-k').focus(); };
    document.getElementById('dsml-save').onclick = saveFromPane;
    document.getElementById('dsml-export').onclick = exportMemory;
    document.getElementById('dsml-import').onclick = importMemory;
    document.getElementById('dsml-reset').onclick = () => {
      if (confirm('确定清空全部记忆？')) { Store.clear(); memory = emptyMemory(); renderMemoryPaneBody(true); setStatus('已清空'); }
    };

    // 面板内动态按钮（委托）
    memoryPane.addEventListener('click', (ev) => {
      const t = ev.target;
      if (t.dataset && t.dataset.act === 'del-entry') {
        t.closest('.dsml-row').remove();
      }
    });
  }

  function saveFromPane() {
    memory.overall = document.getElementById('dsml-overall').value;
    memory.persona = document.getElementById('dsml-persona').value;
    memory.entries = [...document.querySelectorAll('#dsml-entries .dsml-row')].map(r => ({
      k: r.querySelector('.dsml-k').value, v: r.querySelector('.dsml-v').value
    })).filter(e => e.k);
    Store.set('memory', memory);
    setStatus('已保存 ✓');
    setTimeout(() => setStatus(''), 1500);
  }

  function exportMemory() {
    const blob = new Blob([JSON.stringify(memory, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'deepseek-memory-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
  }

  function importMemory() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json';
    inp.onchange = () => {
      const f = inp.files[0]; if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        try { mergeMemory(JSON.parse(r.result)); renderMemoryPaneBody(); setStatus('导入完成 ✓'); }
        catch (e) { setStatus('导入失败：JSON 不合法'); }
      };
      r.readAsText(f);
    };
    inp.click();
  }

  function setStatus(s) { const el = document.getElementById('dsml-status'); if (el) el.textContent = s; }

  function renderMemoryPaneBody(force) {
    if (!memoryPane || !memoryPane.isConnected) return;
    if (!force && !paneDirty) return;
    paneDirty = false;
    const ov = document.getElementById('dsml-overall');
    if (ov && document.activeElement !== ov) ov.value = memory.overall || '';
    const pe = document.getElementById('dsml-persona');
    if (pe && document.activeElement !== pe) pe.value = memory.persona || '';
    const list = document.getElementById('dsml-entries');
    const active = document.activeElement;
    list.innerHTML = memory.entries.length ? memory.entries.map(e => `
      <div class="dsml-row">
        <input class="dsml-k" value="${esc(e.k)}" placeholder="键，如：名字">
        <input class="dsml-v" value="${esc(e.v)}" placeholder="值，如：YG">
        <button class="dsml-mini dsml-danger dsml-del" data-act="del-entry" title="删除条目">×</button>
      </div>`).join('') : '<div class="dsml-empty">还没有条目记忆<br>点下方「＋ 条目」添加，比如「名字=boss」「宠物=蜜蜜」<br>平时聊天中 AI 也会自动往这里记</div>';
    if (active && memoryPane.contains(active) && !active.classList.contains('dsml-overall') && active.id !== 'dsml-overall') active.focus();
  }

  function renderMemoryTab() {
    if (injectedTab) { renderMemoryPaneBody(); return; }
    const info = getNavInfo();
    if (!info) return;
    injectedTab = true;

    // 克隆原生导航按钮做「长期记忆」页签——必须克隆未选中的那个：
    // 选中态是 CSS-modules 哈希类（如 _699d482），克隆选中的会把灰底类一起带来
    const navBtns = [...info.navContainer.querySelectorAll('[role="button"].ds-button')];
    const srcBtn = navBtns.find(b => getComputedStyle(b).backgroundColor === 'rgba(0, 0, 0, 0)') || info.navBtn;
    const tab = srcBtn.cloneNode(true);
    tab.style.removeProperty('--dsl-button-color');
    tab.classList.remove('ds-button--active', 'ds-button--primary');
    tab.querySelector('.ds-button__content').textContent = TAB_TEXT;
    const svg = tab.querySelector('.ds-button__icon');
    if (svg) svg.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M8 1a3 3 0 0 0-3 3v1H4.5A2.5 2.5 0 0 0 2 7.5v4A2.5 2.5 0 0 0 4.5 14h7a2.5 2.5 0 0 0 2.5-2.5v-4A2.5 2.5 0 0 0 11.5 5H11V4a3 3 0 0 0-3-3ZM6.5 5V4a1.5 1.5 0 1 1 3 0v1h-3Z"/></svg>';
    tab.style.cursor = 'pointer';
    info.navContainer.appendChild(tab);
    memoryTabBtn = tab;
    computeNavActiveCls(); // 趁原生页签还有选中态，记录选中类差集
    tab.addEventListener('click', (e) => { e.stopPropagation(); selectMemoryTab(); });

    // 原生页签点击时恢复原生面板
    info.navContainer.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('[role="button"].ds-button');
      if (b && b !== tab) unselectMemoryTab();
    }, true);

    // 弹窗关闭时复位
    const mo = new MutationObserver(() => {
      if (!document.querySelector('[role="dialog"].ds-modal-content')) {
        injectedTab = null;
        if (memoryPane) memoryPane.remove();
        mo.disconnect();
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  // 监听设置弹窗打开
  const dlgObserver = new MutationObserver(() => {
    if (document.querySelector('[role="dialog"].ds-modal-content')) renderMemoryTab();
  });

  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

  /* ============ 菜单 ============ */
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('打开长期记忆设置', () => {
      const dlg = document.querySelector('[role="dialog"].ds-modal-content');
      if (dlg) { selectMemoryTab(); return; }
      // 点侧栏「设置」打开弹窗（DeepSeek 侧栏齿轮）
      const btn = [...document.querySelectorAll('[role="button"], button, a')].find(b => {
        const t = (b.getAttribute('aria-label') || b.textContent || '').trim();
        return t === '设置' || t === '系统设置' || /settings/i.test(b.getAttribute('aria-label') || '');
      });
      if (btn) btn.click();
    });
    GM_registerMenuCommand('导出记忆 JSON', exportMemory);
  }

  /* ============ 启动 ============ */
  const boot = () => {
    dbg('boot v1.1.6');
    startObserve();
    dlgObserver.observe(document.body, { childList: true, subtree: true });
    if (document.querySelector('[role="dialog"].ds-modal-content')) renderMemoryTab();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
