/**
 * md-reader —— 阅读器前端逻辑（零构建：直接用经典 <script> 加载）。
 *
 * 文件结构（从上到下）：
 *   1. 小工具与状态
 *   2. 设置（localStorage 持久化）
 *   3. 主题（跟随系统 / 浅色 / 深色）
 *   4. 背景（预设 / 自定义图片 + 模糊 + 遮罩 + 玻璃）
 *   5. markdown 渲染管线（公式 → markdown → 消毒 → 后处理 → 高亮）
 *   6. 目录、滚动进度、位置记忆、搜索
 *   7. 打开文档（拖放 / 选择 / 服务模式）
 *   8. 控件绑定、快捷键、启动
 */
(() => {
  'use strict'

  // ─────────────────────────── 1. 小工具与状态 ───────────────────────────

  const $ = (id) => document.getElementById(id)
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel))
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi)

  /** 正文容器与滚动容器：其余函数几乎都围着这两个转。 */
  const content = $('content')
  const stage = $('stage')

  /** 当前文档的元信息：{ key, name, size, path? }。 */
  let currentDoc = null

  /** 轻提示（复制成功、背景没记住之类）。 */
  let toastTimer = 0
  function toast(text) {
    const node = $('toast')
    node.textContent = text
    node.classList.add('show')
    clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => node.classList.remove('show'), 1800)
  }

  /** 复制文本：优先用异步剪贴板，file:// 下不可用时退回 textarea 方案。 */
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext !== false) {
        await navigator.clipboard.writeText(text)
        return true
      }
    } catch {
      // 剪贴板权限被拒（或 file:// 下不可用）→ 走下面的兜底方案
    }
    try {
      const box = document.createElement('textarea')
      box.value = text
      box.setAttribute('readonly', '')
      box.style.position = 'fixed'
      box.style.top = '-1000px'
      document.body.appendChild(box)
      box.select()
      const ok = document.execCommand('copy')
      box.remove()
      return ok
    } catch {
      return false
    }
  }

  // ─────────────────────────── 2. 设置 ───────────────────────────

  const SETTINGS_KEY = 'md-reader:settings:v1'
  const IMAGE_KEY = 'md-reader:bg-image:v1'

  const DEFAULTS = {
    theme: 'system',      // system | light | dark
    serif: false,         // 正文是否用衬线字体
    scale: 1,             // 字号倍数（1 = dsh 原样 16px/28px）
    leading: 1,           // 行距倍数
    width: 748,           // 阅读栏宽（748 = dsh 聊天正文宽度）
    wrapCode: true,       // 代码块是否自动换行（dsh 默认换行）
    sidebar: true,
    bgMode: 'preset',     // preset | image | none
    bgPreset: 'aurora',
    bgBlur: 22,
    bgDim: 0.3,
    glassAlpha: 0.72,
  }

  let settings = Object.assign({}, DEFAULTS)
  let bgImage = null

  try {
    Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'))
    bgImage = localStorage.getItem(IMAGE_KEY)
  } catch {
    // 隐私模式或 file:// 下 localStorage 可能不可用：用默认值继续，不打断阅读
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
    } catch {
      // 配额满或被禁用：设置本次仍然生效，只是记不住
    }
  }

  // ─────────────────────────── 3. 主题 ───────────────────────────

  const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null

  /** 当前应该是深色吗（把 system 解析成具体值——这步在 dsh 里也是 JS 做的）。 */
  function isDark() {
    if (settings.theme === 'dark') return true
    if (settings.theme === 'light') return false
    return media !== null && media.matches === true
  }

  function applyTheme() {
    const dark = isDark()
    // dsh 的机制：暗色 = body 上的 data-ds-dark-theme 属性
    document.body.toggleAttribute('data-ds-dark-theme', dark)
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
    $$('[data-theme]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.theme === settings.theme)))
    $$('[data-theme-opt]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themeOpt === settings.theme)))
  }

  if (media !== null) {
    const onChange = () => { if (settings.theme === 'system') { applyTheme(); applyBackground() } }
    if (typeof media.addEventListener === 'function') media.addEventListener('change', onChange)
    else if (typeof media.addListener === 'function') media.addListener(onChange)
  }

  // ─────────────────────────── 4. 背景 ───────────────────────────

  /** 内置背景预设：都是纯 CSS 渐变，不依赖任何图片文件。 */
  const PRESETS = [
    { id: 'aurora', name: '极光', css: 'linear-gradient(135deg, #6a8dff 0%, #a06bff 45%, #ff8bc4 100%)' },
    { id: 'mist', name: '晨雾', css: 'linear-gradient(160deg, #eef3fa 0%, #d3dded 45%, #bcc9db 100%)' },
    { id: 'ocean', name: '海盐', css: 'linear-gradient(150deg, #a6dcec 0%, #6aa9d8 42%, #3d6ba6 100%)' },
    { id: 'sunset', name: '日落', css: 'linear-gradient(150deg, #ffd8a8 0%, #fd9a8b 45%, #c76b98 100%)' },
    { id: 'forest', name: '林间', css: 'linear-gradient(150deg, #bfe6cd 0%, #74a892 52%, #2f5d50 100%)' },
    { id: 'paper', name: '纸', css: 'linear-gradient(150deg, #fdfcf8 0%, #f4f1e8 55%, #e6e0d2 100%)' },
    { id: 'ink', name: '墨', css: 'linear-gradient(150deg, #4b5563 0%, #2f3542 52%, #1b1f27 100%)' },
    { id: 'graphite', name: '石墨', css: 'linear-gradient(160deg, #2c2e33 0%, #1c1d20 60%, #0f1012 100%)' },
  ]

  /** 把所有与背景相关的设置写进 CSS 变量。 */
  function applyBackground() {
    const root = document.documentElement.style
    let mode = settings.bgMode
    let image = 'none'

    if (mode === 'image' && bgImage !== null) {
      image = 'url(' + JSON.stringify(bgImage) + ')';
    } else if (mode === 'preset') {
      const preset = PRESETS.find((item) => item.id === settings.bgPreset) || PRESETS[0];
      image = preset.css;
    } else {
      mode = 'none';
    }

    document.body.dataset.bgMode = mode;
    if (image === 'none') root.removeProperty('--bg-image')
    else root.setProperty('--bg-image', image);

    root.setProperty('--bg-blur', settings.bgBlur + 'px');
    // 主题自适应：同样的滑杆位置，深色下遮罩更重（深色背景更容易吃对比度）
    const dim = clamp(settings.bgDim * (isDark() ? 1.2 : 0.85), 0, 0.85);
    root.setProperty('--bg-dim', String(dim));
    root.setProperty('--glass-alpha', String(settings.glassAlpha));

    renderSwatches();
  }

  /** 画背景预设色板（含"无背景"和"自定义图片"两块）。 */
  function renderSwatches() {
    const box = $('swatches')
    box.textContent = ''

    const none = document.createElement('button')
    none.type = 'button'
    none.className = 'swatch plain'
    none.textContent = '无背景'
    none.setAttribute('aria-pressed', String(settings.bgMode === 'none'))
    none.addEventListener('click', () => { settings.bgMode = 'none'; saveSettings(); applyBackground() })
    box.appendChild(none)

    for (const preset of PRESETS) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'swatch'
      b.style.backgroundImage = preset.css;
      b.title = preset.name;
      b.setAttribute('aria-label', preset.name);
      b.setAttribute('aria-pressed', String(settings.bgMode === 'preset' && settings.bgPreset === preset.id));
      b.addEventListener('click', () => { settings.bgMode = 'preset'; settings.bgPreset = preset.id; saveSettings(); applyBackground() })
      box.appendChild(b)
    }

    const custom = document.createElement('button')
    custom.type = 'button'
    custom.className = 'swatch plain'
    custom.textContent = bgImage === null ? '选图片' : '换图片'
    custom.setAttribute('aria-pressed', String(settings.bgMode === 'image'));
    custom.addEventListener('click', pickBackgroundImage)
    box.appendChild(custom)
  }

  /** 让用户选一张本地图片当背景。 */
  function pickBackgroundImage() {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.addEventListener('change', () => {
      const file = input.files && input.files[0]
      if (file) void setBackgroundImage(file)
    })
    input.click()
  }

  /**
   * 设定背景图：先等比缩小再转成 dataURL 存起来。
   * 缩小是必须的——原图动辄几 MB，localStorage 装不下（配额通常 5MB）。
   */
  async function setBackgroundImage(file) {
    if (!file.type.startsWith('image/')) { toast('请选择图片文件'); return }
    try {
      bgImage = await downscale(file, 2400, 0.82);
    } catch {
      toast('这张图读不出来');
      return;
    }
    settings.bgMode = 'image';
    saveSettings();
    applyBackground();
    try {
      localStorage.setItem(IMAGE_KEY, bgImage);
      toast('背景已保存');
    } catch {
      toast('背景已生效，但图片太大没能记住');
    }
  }

  /** 等比缩小并编码成 dataURL。 */
  function downscale(file, maxWidth, quality) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file)
      const img = new Image()
      img.onload = () => {
        const scale = Math.min(1, maxWidth / Math.max(1, img.naturalWidth));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/webp', quality));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode failed')) };
      img.src = url;
    });
  }

  /** 把与阅读排版有关的设置写进 CSS 变量。 */
  function applyReading() {
    const root = document.documentElement.style
    root.setProperty('--read-scale', String(settings.scale));
    root.setProperty('--read-leading', String(settings.leading));
    root.setProperty('--read-width', settings.width + 'px');
    root.setProperty('--reader-font', settings.serif
      ? '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", serif'
      : 'var(--dsw-font-family)');
    document.body.dataset.codeWrap = settings.wrapCode ? 'on' : 'off';
    document.body.dataset.sidebar = settings.sidebar ? 'open' : 'closed';
    $('sw-sidebar').setAttribute('aria-pressed', String(settings.sidebar));
  }

  // ─────────────────────────── 5. markdown 渲染管线 ───────────────────────────

  marked.use({ gfm: true, breaks: false, pedantic: false });

  /** 消毒配置：允许常见排版标签与属性，挡掉脚本/事件/嵌入类。 */
  const PURIFY_CONFIG = {
    USE_PROFILES: { html: true, svg: true },
    ADD_ATTR: ['target', 'rel', 'align', 'colspan', 'rowspan', 'start', 'checked', 'disabled', 'type', 'loading', 'decoding', 'referrerpolicy'],
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'base', 'link', 'meta'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'srcdoc'],
  };

  /**
   * 只对"代码之外"的文本做替换。
   * 公式、脚注这些语法必须跳过代码围栏与行内代码，否则代码里的 $ 和 [^ 会被误伤。
   * @param {string} text 原文
   * @param {(chunk: string) => string} fn 对非代码片段做的变换
   * @returns {string} 变换后的文本
   */
  function transformOutsideCode(text, fn) {
    // 先按 ``` / ~~~ 围栏切分：捕获组让 split 结果保留围栏本身，位于奇数下标
    const blocks = text.split(/(^```[\s\S]*?^```|^~~~[\s\S]*?^~~~)/m);
    return blocks
      .map((block, i) => {
        if (i % 2 === 1) return block;
        // 再按行内代码切分
        return block
          .split(/(`[^`\n]*`)/)
          .map((seg, j) => (j % 2 === 1 ? seg : fn(seg)))
          .join('');
      })
      .join('');
  }

  const MATH_MARK = '@@MDMATH';

  /** 把 TeX 公式抽成占位符，避免被 markdown 解析器改写（例如 $a_i$ 里的下划线）。 */
  function extractMath(text) {
    const store = [];
    const token = (tex, display) => {
      store.push({ tex, display });
      return MATH_MARK + (store.length - 1) + '@@';
    };
    const out = transformOutsideCode(text, (chunk) => chunk
      .replace(/\$\$([\s\S]+?)\$\$/g, (m, tex) => token(tex.trim(), true))
      .replace(/\\\[([\s\S]+?)\\\]/g, (m, tex) => token(tex.trim(), true))
      .replace(/\\\(([\s\S]+?)\\\)/g, (m, tex) => token(tex.trim(), false))
      .replace(/(^|[^\\$])\$([^\n$]+?)\$/g, (m, pre, tex) => pre + token(tex.trim(), false)));
    return { text: out, store };
  }

  /** 把占位符换回 KaTeX 渲染出的元素（放在消毒之后做，避免 MathML 被过滤）。 */
  function restoreMath(store) {
    if (store.length === 0) return;
    const pattern = new RegExp(MATH_MARK + '(\\d+)@@');
    const targets = [];
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.nodeValue !== null && pattern.test(node.nodeValue)) targets.push(node);
    }
    for (const node of targets) {
      const parts = node.nodeValue.split(new RegExp('(' + MATH_MARK + '\\d+@@)'));
      const frag = document.createDocumentFragment();
      for (const part of parts) {
        const hit = new RegExp('^' + MATH_MARK + '(\\d+)@@$').exec(part);
        if (hit === null) {
          if (part !== '') frag.appendChild(document.createTextNode(part));
          continue;
        }
        const item = store[Number(hit[1])];
        const holder = document.createElement('span');
        try {
          holder.innerHTML = katex.renderToString(item.tex, {
            displayMode: item.display,
            throwOnError: false,
            strict: 'ignore',
            trust: false,
          });
        } catch {
          // 公式写错时 KaTeX 也可能抛：退化成原文，不让整篇文档挂掉
          holder.textContent = (item.display ? '$$' : '$') + item.tex + (item.display ? '$$' : '$');
        }
        while (holder.firstChild !== null) frag.appendChild(holder.firstChild);
      }
      node.parentNode.replaceChild(frag, node);
    }
  }

  /** 抽出脚注定义（形如 [^id]: 内容），返回去掉定义后的正文与定义表。 */
  function extractFootnotes(text) {
    const defs = new Map();
    const body = transformOutsideCode(text, (chunk) => chunk.replace(
      /^\[\^([^\]]+)\]:[ \t]*([\s\S]*?)(?=\n\[[^\]]+\]:|\n{2,}|$)/gm,
      (m, id, def) => { defs.set(id.trim(), def.trim()); return '' },
    ));
    return { body, defs };
  }

  /** 把 [^id] 引用换成上标编号（dsh 的脚注只做编号、不做跳转链接）。 */
  function renderFootnoteRefs(text, defs) {
    const order = new Map();
    const counts = new Map();
    const out = text.replace(/\[\^([^\]]+)\](?!:)/g, (m, id) => {
      const key = id.trim();
      if (!defs.has(key)) return m;
      if (!order.has(key)) order.set(key, order.size + 1);
      counts.set(key, (counts.get(key) || 0) + 1);
      return '<sup>' + order.get(key) + '</sup>';
    });
    return { text: out, order, counts };
  }

  /** 生成文末脚注区块（结构与 dsh 一致：section.footnotes > ol > li）。 */
  function footnoteSection(defs, order, counts) {
    if (order.size === 0) return '';
    const items = [];
    for (const [id, index] of order) {
      const def = defs.get(id);
      if (def === undefined) continue;
      let html = marked.parse(def);
      const marks = ' ↩' + (counts.get(id) > 1 ? '<sup>' + counts.get(id) + '</sup>' : '');
      // 反向标记接进最后一段（与 dsh 相同）；没有段落时直接追加
      const at = html.lastIndexOf('</p>');
      html = at === -1 ? html + marks : html.slice(0, at) + marks + html.slice(at);
      const safe = id.replace(/[^A-Za-z0-9_-]/g, '-');
      items.push('<li id="user-content-fn-' + safe + '">' + html + '</li>');
    }
    if (items.length === 0) return '';
    return '<section data-footnotes class="footnotes"><h2 id="footnote-label" class="sr-only">Footnotes</h2>'
      + '<ol>' + items.join('') + '</ol></section>';
  }

  /** 渲染一份 markdown 文本到 #content。 */
  function renderMarkdown(text) {
    const footnotes = extractFootnotes(text);
    const refs = renderFootnoteRefs(footnotes.body, footnotes.defs);
    const math = extractMath(refs.text);

    let html = marked.parse(math.text);
    html += footnoteSection(footnotes.defs, refs.order, refs.counts);
    content.innerHTML = DOMPurify.sanitize(html, PURIFY_CONFIG);

    restoreMath(math.store);
    postProcess();
  }

  /** 渲染之后的统一加工：代码块外壳、表格容器、任务列表、图片、链接、标题 id。 */
  function postProcess() {
    // ① 代码块：套上 dsh 的横幅 + 复制按钮，并做语法高亮
    $$('.markdown pre', content).forEach(decorateCodeBlock);

    // ② 表格：外面套一层横向滚动容器（dsh 的做法）
    $$('.markdown table', content).forEach((table) => {
      const wrap = document.createElement('div');
      wrap.className = 'tableScroll';
      table.replaceWith(wrap);
      wrap.appendChild(table);
    });

    // ③ 任务列表：补上 dsh 用的两个类名
    $$('.markdown input[type=checkbox]', content).forEach((box) => {
      box.disabled = true;
      const li = box.closest('li');
      if (li !== null) li.classList.add('task-list-item');
      const list = box.closest('ul, ol');
      if (list !== null) list.classList.add('contains-task-list');
    });

    // ④ 图片：懒加载 + 可点开大图；服务模式下把相对路径改写到 /api/raw
    $$('.markdown img', content).forEach((img) => {
      img.classList.add('image', 'clickable');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      rewriteRelativeSrc(img);
      img.addEventListener('click', () => openLightbox(img.src));
    });

    // ⑤ 链接：外链新窗口；站内锚点走平滑滚动
    $$('.markdown a', content).forEach((a) => {
      const href = a.getAttribute('href') || '';
      if (/^https?:/i.test(href)) {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      } else if (href.startsWith('#')) {
        a.addEventListener('click', (event) => {
          const target = document.getElementById(href.slice(1));
          if (target !== null) { event.preventDefault(); scrollToHeading(target) }
        });
      }
    });

    // ⑥ 行内代码若整个就是 URL，套一层链接（dsh 有这个行为）
    $$('.markdown :not(pre) > code', content).forEach((code) => {
      const text = code.textContent || '';
      if (/^https?:\/\/\S+$/.test(text)) {
        const a = document.createElement('a');
        a.href = text;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = text;
        code.textContent = '';
        code.appendChild(a);
      }
    });

    // ⑦ 标题 id：目录与锚点都要用（dsh 没有标题锚点，这是为阅读器加的）
    $$('.markdown h1, .markdown h2, .markdown h3, .markdown h4, .markdown h5, .markdown h6', content)
      .forEach((h, index) => { if (h.id === '') h.id = 'h-' + (index + 1) });
  }

  /** 给一个 <pre> 套上 dsh 的代码块外壳，并做语法高亮。 */
  function decorateCodeBlock(pre) {
    if (pre.closest('.md-code-block') !== null) return;
    const code = pre.querySelector('code');
    if (code === null) return;

    // marked 把语言写在 class="language-xxx" 上
    const langClass = Array.from(code.classList).find((c) => c.startsWith('language-'));
    const lang = langClass === undefined ? '' : langClass.slice('language-'.length);
    const raw = code.textContent.replace(/\n$/, '');
    if (lang !== '' && hljs.getLanguage(lang) !== undefined) {
      code.innerHTML = hljs.highlight(raw, { language: lang, ignoreIllegals: true }).value;
      code.classList.add('hljs');
    }

    // 空代码块：dsh 不显示横幅，保持一致
    if (raw === '') return;

    const block = document.createElement('div');
    block.className = 'md-code-block';

    const bannerWrap = document.createElement('div');
    bannerWrap.className = 'bannerWrap';
    const banner = document.createElement('div');
    banner.className = 'banner';
    const info = document.createElement('div');
    info.className = 'infostring';
    info.textContent = lang;
    const action = document.createElement('div');
    action.className = 'action';

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'copyButton';
    copy.textContent = '复制';
    copy.addEventListener('click', () => {
      void copyText(raw).then((ok) => {
        if (!ok) { toast('复制失败，请手动选中'); return }
        copy.textContent = '复制成功';
        window.setTimeout(() => { copy.textContent = '复制' }, 1000);
      });
    });

    action.appendChild(copy);
    banner.append(info, action);
    bannerWrap.appendChild(banner);
    pre.replaceWith(block);
    block.append(bannerWrap, pre);
    pre.classList.add('code-pre');
  }

  /**
   * 服务模式下把文档里的相对图片路径改写到 /api/raw，这样同目录的图片能显示。
   * 静态模式（file://）没有服务器，相对图片无法解析——保留原样，显示为破图。
   */
  function rewriteRelativeSrc(img) {
    if (serverRoot === null || currentDoc === null || currentDoc.path === undefined) return;
    const value = img.getAttribute('src');
    if (value === null || value === '' || /^(https?:|data:|blob:|\/)/i.test(value)) return;
    const base = currentDoc.path.split('/').slice(0, -1).join('/');
    const joined = base === '' ? value : base + '/' + value;
    const parts = [];
    for (const seg of joined.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    img.setAttribute('src', '/api/raw?path=' + encodeURIComponent(parts.join('/')));
  }

  // ─────────────────────────── 6. 目录 / 进度 / 位置记忆 / 搜索 ───────────────────────────

  let tocRows = [];

  /** 从正文标题生成目录。 */
  function buildToc() {
    const toc = $('toc');
    toc.textContent = '';
    tocRows = [];
    const heads = $$('.markdown h1, .markdown h2, .markdown h3, .markdown h4', content);
    if (heads.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sidebar-empty';
      empty.textContent = '这篇文档没有标题';
      toc.appendChild(empty);
      return;
    }
    for (const head of heads) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'row toc-row level-' + head.tagName.charAt(1);
      row.dataset.target = head.id;
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = head.textContent;
      row.appendChild(name);
      row.addEventListener('click', () => scrollToHeading(head));
      toc.appendChild(row);
      tocRows.push({ row, head });
    }
  }

  /** 滚到某个标题：减去顶栏高度，并走平滑滚动。 */
  function scrollToHeading(node) {
    const top = Math.max(0, node.getBoundingClientRect().top + stage.scrollTop - 78);
    if (typeof stage.scrollTo === 'function') stage.scrollTo({ top, behavior: 'smooth' });
    else stage.scrollTop = top;
  }

  /** 让目录里当前所在的一节高亮。 */
  function updateActiveHeading() {
    if (tocRows.length === 0) return;
    let active = tocRows[0];
    for (const entry of tocRows) {
      if (entry.head.getBoundingClientRect().top <= 110) active = entry;
      else break;
    }
    for (const entry of tocRows) entry.row.classList.toggle('active', entry === active);
  }

  /** 位置记忆的存储键：每篇文档各自记住读到哪。 */
  function positionKey() {
    return currentDoc === null ? null : 'md-reader:pos:' + currentDoc.key;
  }

  let savePositionTimer = 0;
  function scheduleSavePosition() {
    if (positionKey() === null) return;
    clearTimeout(savePositionTimer);
    savePositionTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(positionKey(), String(Math.round(stage.scrollTop)));
      } catch {
        // 存不下就算了，不影响阅读
      }
    }, 400);
  }

  function restorePosition() {
    const key = positionKey();
    if (key === null) return;
    let saved = null;
    try { saved = localStorage.getItem(key) } catch { saved = null }
    if (saved === null) return;
    const top = Number(saved);
    if (!Number.isFinite(top) || top <= 0) return;
    // 等一帧：图片/公式可能还没撑开高度，直接设会被截断
    requestAnimationFrame(() => { stage.scrollTop = clamp(top, 0, stage.scrollHeight) });
  }

  /** 滚动时：更新进度条、目录高亮，并（防抖）记住位置。 */
  function onScroll() {
    const max = stage.scrollHeight - stage.clientHeight;
    const ratio = max > 0 ? clamp(stage.scrollTop / max, 0, 1) : 0;
    $('progress-bar').style.width = (ratio * 100).toFixed(2) + '%';
    updateActiveHeading();
    scheduleSavePosition();
  }

  let scrollQueued = false;
  stage.addEventListener('scroll', () => {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => { scrollQueued = false; onScroll() });
  }, { passive: true });

  // ── 文内搜索 ──
  let hits = [];
  let hitIndex = -1;

  function updateSearchCount() {
    const box = $('search-count');
    const query = $('search-input').value.trim();
    if (hits.length === 0) {
      box.textContent = query === '' ? '' : '0';
      return;
    }
    box.textContent = (hitIndex + 1) + '/' + hits.length;
  }

  /**
   * 清掉上一轮的高亮。
   * 必须替换回文本节点再 normalize：否则每搜一次 DOM 都会更碎（一个 mark 就把文本切成三段）。
   */
  function clearHits() {
    for (const mark of hits) {
      const parent = mark.parentNode;
      if (parent === null) continue;
      parent.replaceChild(document.createTextNode(mark.textContent || ''), mark);
      parent.normalize();
    }
    hits = [];
    hitIndex = -1;
  }

  /** 全文搜索：先用 TreeWalker 收集文本节点，再逐个切开插入 mark。 */
  function runSearch(query) {
    clearHits();
    const needle = query.trim().toLowerCase();
    if (needle === '') { updateSearchCount(); return; }

    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeValue === null || node.nodeValue.trim() === '') return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (parent === null) return NodeFilter.FILTER_REJECT;
        if (parent.closest('mark.hit') !== null) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    for (const node of nodes) {
      const text = node.nodeValue;
      const lower = text.toLowerCase();
      let at = lower.indexOf(needle);
      if (at === -1) continue;
      const frag = document.createDocumentFragment();
      let cursor = 0;
      while (at !== -1) {
        if (at > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, at)));
        const mark = document.createElement('mark');
        mark.className = 'hit';
        mark.textContent = text.slice(at, at + needle.length);
        frag.appendChild(mark);
        hits.push(mark);
        cursor = at + needle.length;
        at = lower.indexOf(needle, cursor);
      }
      if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
      node.parentNode.replaceChild(frag, node);
    }
    hitIndex = hits.length > 0 ? 0 : -1;
    focusHit(0);
  }

  /** 跳到第 delta 个命中（会环绕）。 */
  function focusHit(delta) {
    if (hits.length === 0) { updateSearchCount(); return; }
    hitIndex = (hitIndex + delta + hits.length) % hits.length;
    hits.forEach((mark, i) => mark.classList.toggle('current', i === hitIndex));
    const target = hits[hitIndex];
    if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    updateSearchCount();
  }

  function openSearch() {
    $('searchbar').hidden = false;
    const input = $('search-input');
    input.focus();
    input.select();
  }

  function closeSearch() {
    const bar = $('searchbar');
    if (bar.hidden) return;
    bar.hidden = true;
    $('search-input').value = '';
    clearHits();
    updateSearchCount();
  }

  // ─────────────────────────── 7. 打开文档 ───────────────────────────

  /** 服务模式下是文档根目录；静态模式（file://）为 null。 */
  let serverRoot = null;

  /** 探测是否跑在服务模式下（同一套界面，两种用法）。 */
  async function detectServer() {
    if (location.protocol === 'file:') return null;
    try {
      const res = await fetch('api/info', { headers: { accept: 'application/json' } });
      if (!res.ok) return null;
      const info = await res.json();
      return info !== null && info.mode === 'server' ? info : null;
    } catch {
      return null;
    }
  }

  /** 字节数变人话。 */
  function formatSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  /** 粗略字数：中日韩字符按字算，其余按词算。 */
  function countWords(text) {
    const cjk = (text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
    const words = (text.match(/[A-Za-z0-9_'-]+/g) || []).length;
    return cjk + words;
  }

  /** 打开一份 markdown 文本：渲染 + 目录 + 位置恢复 + 标题栏。 */
  function openText(text, meta) {
    currentDoc = meta;
    renderMarkdown(text);
    document.body.dataset.reading = 'true';
    $('doc-title').textContent = meta.name;
    const bits = [];
    if (meta.path !== undefined) bits.push(meta.path);
    if (meta.size > 0) bits.push(formatSize(meta.size));
    bits.push(countWords(text) + ' 字');
    $('doc-meta').textContent = bits.join(' · ');
    $('foot-left').textContent = meta.name;
    $('foot-right').textContent = countWords(text) + ' 字 · 按 / 搜索 · T 换深浅色';
    buildToc();
    stage.scrollTop = 0;
    onScroll();
    restorePosition();
    markActiveFile(meta.path);
    document.title = meta.name + ' · Markdown 阅读器';
  }

  /** 打开本地文件（拖放或选择器）。 */
  async function openLocalFile(file) {
    if (!/\.(md|markdown|mdown|mkd|txt)$/i.test(file.name)) {
      if (file.type.startsWith('image/')) { void setBackgroundImage(file); return }
      toast('只认 .md / .markdown / .txt 文件');
      return;
    }
    const text = await file.text();
    openText(text, { key: 'file:' + file.name + ':' + file.size, name: file.name, size: file.size });
  }

  /** 服务模式下按路径打开文档。 */
  async function openServerPath(path, updateHash) {
    try {
      const res = await fetch('api/file?path=' + encodeURIComponent(path));
      const data = await res.json();
      if (!res.ok || data.error !== undefined) { toast(data.error || '打不开这个文件'); return }
      if (updateHash !== false) location.hash = encodeURIComponent(path);
      openText(data.text, { key: 'path:' + path, name: data.name, size: data.size, path });
    } catch {
      toast('读取失败');
    }
  }

  /** 渲染左侧文件列表（目录名作为浅色前缀显示在文件名前面）。 */
  function buildFileList(files) {
    const list = $('file-list');
    list.textContent = '';
    if (files.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sidebar-empty';
      empty.textContent = '这个目录里没有 markdown 文件';
      list.appendChild(empty);
      return;
    }
    for (const path of files) {
      const slash = path.lastIndexOf('/');
      const dir = slash === -1 ? '' : path.slice(0, slash + 1);
      const name = slash === -1 ? path : path.slice(slash + 1);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'row file-row';
      row.dataset.path = path;
      const nameEl = document.createElement('span');
      nameEl.className = 'name';
      nameEl.textContent = name;
      if (dir !== '') {
        const dirEl = document.createElement('span');
        dirEl.className = 'dir';
        dirEl.textContent = dir;
        row.appendChild(dirEl);
      }
      row.appendChild(nameEl);
      row.addEventListener('click', () => { void openServerPath(path) });
      list.appendChild(row);
    }
  }

  /** 让当前文档在文件列表里高亮。 */
  function markActiveFile(path) {
    $$('#file-list .row').forEach((row) => {
      row.classList.toggle('active', path !== undefined && row.dataset.path === path);
    });
  }

  /** 图片灯箱：点开大图 / 关闭。 */
  function openLightbox(src) {
    $('lightbox-img').src = src;
    $('lightbox').hidden = false;
  }

  function closeLightbox() {
    const box = $('lightbox');
    if (box.hidden) return;
    box.hidden = true;
    $('lightbox-img').removeAttribute('src');
  }

  // ─────────────────────────── 8. 控件、快捷键、启动 ───────────────────────────

  /** 绑定一个滑杆：初值来自设置，拖动时写回设置并立刻生效。 */
  function bindRange(id, outId, key, apply, format) {
    const input = $(id);
    const out = $(outId);
    input.value = String(settings[key]);
    out.textContent = format(settings[key]);
    input.addEventListener('input', () => {
      settings[key] = Number(input.value);
      out.textContent = format(settings[key]);
      apply();
      saveSettings();
    });
  }

  /** 绑定一个开关（用 aria-pressed 表达状态，键盘也能操作）。 */
  function bindSwitch(id, key, apply) {
    const btn = $(id);
    btn.setAttribute('aria-pressed', String(settings[key]));
    btn.addEventListener('click', () => {
      settings[key] = !settings[key];
      btn.setAttribute('aria-pressed', String(settings[key]));
      apply();
      saveSettings();
    });
  }

  /** 把设置回填到所有控件（重置后要用）。 */
  function syncControls() {
    const ranges = [
      ['r-scale', 'v-scale', 'scale', (v) => Math.round(v * 100) + '%'],
      ['r-leading', 'v-leading', 'leading', (v) => v.toFixed(2) + 'x'],
      ['r-width', 'v-width', 'width', (v) => Math.round(v) + 'px'],
      ['r-blur', 'v-blur', 'bgBlur', (v) => Math.round(v) + 'px'],
      ['r-dim', 'v-dim', 'bgDim', (v) => Math.round(v * 100) + '%'],
      ['r-glass', 'v-glass', 'glassAlpha', (v) => Math.round(v * 100) + '%'],
    ];
    for (const entry of ranges) {
      $(entry[0]).value = String(settings[entry[2]]);
      $(entry[1]).textContent = entry[3](settings[entry[2]]);
    }
    $('sw-serif').setAttribute('aria-pressed', String(settings.serif));
    $('sw-wrap').setAttribute('aria-pressed', String(settings.wrapCode));
    $('sw-sidebar').setAttribute('aria-pressed', String(settings.sidebar));
  }

  function setTheme(theme) {
    settings.theme = theme;
    saveSettings();
    applyTheme();
    applyBackground();   // 遮罩强度随主题变化
  }

  function themeLabel(theme) {
    if (theme === 'light') return '浅色';
    if (theme === 'dark') return '深色';
    return '跟随系统';
  }

  function cycleTheme() {
    const next = settings.theme === 'system' ? 'light' : (settings.theme === 'light' ? 'dark' : 'system');
    setTheme(next);
    toast('外观：' + themeLabel(next));
  }

  function setSidebar(on) {
    settings.sidebar = on;
    saveSettings();
    applyReading();
  }

  function openPopover() {
    const pop = $('popover');
    pop.hidden = false;
    const rect = $('btn-settings').getBoundingClientRect();
    const width = pop.offsetWidth;
    pop.style.top = Math.round(rect.bottom + 8) + 'px';
    pop.style.left = Math.round(Math.max(12, Math.min(window.innerWidth - width - 12, rect.right - width))) + 'px';
  }

  function openSample() {
    const md = window.__SAMPLE_MD__;
    if (typeof md !== 'string') { toast('示例文档没找到（sample.js 缺失？）'); return }
    openText(md, { key: 'sample', name: '示例文档.md', size: md.length });
  }

  function resetSettings() {
    settings = Object.assign({}, DEFAULTS);
    bgImage = null;
    try {
      localStorage.removeItem(SETTINGS_KEY);
      localStorage.removeItem(IMAGE_KEY);
    } catch {
      // 清不掉也无所谓
    }
    saveSettings();
    applyTheme();
    applyReading();
    applyBackground();
    syncControls();
    toast('已恢复默认设置');
  }

  function bindControls() {
    bindRange('r-scale', 'v-scale', 'scale', applyReading, (v) => Math.round(v * 100) + '%');
    bindRange('r-leading', 'v-leading', 'leading', applyReading, (v) => v.toFixed(2) + 'x');
    bindRange('r-width', 'v-width', 'width', applyReading, (v) => Math.round(v) + 'px');
    bindRange('r-blur', 'v-blur', 'bgBlur', applyBackground, (v) => Math.round(v) + 'px');
    bindRange('r-dim', 'v-dim', 'bgDim', applyBackground, (v) => Math.round(v * 100) + '%');
    bindRange('r-glass', 'v-glass', 'glassAlpha', applyBackground, (v) => Math.round(v * 100) + '%');

    bindSwitch('sw-serif', 'serif', applyReading);
    bindSwitch('sw-wrap', 'wrapCode', applyReading);
    bindSwitch('sw-sidebar', 'sidebar', applyReading);

    $$('[data-theme]').forEach((btn) => btn.addEventListener('click', () => setTheme(btn.dataset.theme)));
    $$('[data-theme-opt]').forEach((btn) => btn.addEventListener('click', () => setTheme(btn.dataset.themeOpt)));

    $('btn-sidebar').addEventListener('click', () => setSidebar(!settings.sidebar));
    $('btn-search').addEventListener('click', openSearch);
    $('btn-settings').addEventListener('click', (event) => {
      event.stopPropagation();
      const pop = $('popover');
      if (pop.hidden) openPopover(); else pop.hidden = true;
    });
    $('btn-print').addEventListener('click', () => window.print());
    $('btn-open').addEventListener('click', () => $('file-input').click());
    $('btn-open-2').addEventListener('click', () => $('file-input').click());
    $('btn-sample').addEventListener('click', openSample);
    $('btn-reset').addEventListener('click', resetSettings);

    $('file-input').addEventListener('change', (event) => {
      const file = event.target.files && event.target.files[0];
      if (file) void openLocalFile(file);
      event.target.value = '';
    });

    const input = $('search-input');
    let searchTimer = 0;
    input.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => runSearch(input.value), 120);
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        focusHit(event.shiftKey ? -1 : 1);
      }
    });
    $('search-next').addEventListener('click', () => focusHit(1));
    $('search-prev').addEventListener('click', () => focusHit(-1));
    $('search-close').addEventListener('click', closeSearch);

    $('lightbox').addEventListener('click', closeLightbox);
    $('scrim').addEventListener('click', () => setSidebar(false));

    // 点击面板之外收起设置面板
    document.addEventListener('click', (event) => {
      const pop = $('popover');
      if (pop.hidden) return;
      if (pop.contains(event.target)) return;
      pop.hidden = true;
    });
  }

  /** 快捷键。输入框里打字时不抢按键，但 Esc / Cmd+F 仍然可用。 */
  function bindKeys() {
    document.addEventListener('keydown', (event) => {
      const target = event.target;
      const tag = target !== null && target.tagName !== undefined ? target.tagName : '';
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || (target !== null && target.isContentEditable === true);
      const mod = event.metaKey || event.ctrlKey;

      if (mod && event.key.toLowerCase() === 'o') { event.preventDefault(); $('file-input').click(); return }
      if (mod && event.key.toLowerCase() === 'f') { event.preventDefault(); openSearch(); return }
      if (event.key === 'Escape') {
        if ($('lightbox').hidden === false) { closeLightbox(); return }
        if ($('searchbar').hidden === false) { closeSearch(); return }
        if ($('popover').hidden === false) { $('popover').hidden = true; return }
        return;
      }
      if (typing) return;
      if (event.key === '/') { event.preventDefault(); openSearch(); return }
      if (event.key === '\\') { setSidebar(!settings.sidebar); return }
      if (event.key === 't' || event.key === 'T') { cycleTheme(); return }
    });
  }

  /** 拖放：.md 打开，图片设为背景。 */
  function bindDnd() {
    let depth = 0;
    window.addEventListener('dragenter', (event) => {
      event.preventDefault();
      depth += 1;
      document.body.classList.add('dropping');
    });
    window.addEventListener('dragover', (event) => { event.preventDefault() });
    window.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) document.body.classList.remove('dropping');
    });
    window.addEventListener('drop', (event) => {
      event.preventDefault();
      depth = 0;
      document.body.classList.remove('dropping');
      const files = event.dataTransfer === null ? null : event.dataTransfer.files;
      if (files !== null && files.length > 0) void openLocalFile(files[0]);
    });
  }

  /** 启动：应用设置 → 绑事件 → 探测服务模式 → 按 hash 打开文档。 */
  async function boot() {
    applyTheme();
    applyReading();
    applyBackground();
    syncControls();
    bindControls();
    bindKeys();
    bindDnd();

    window.addEventListener('hashchange', () => {
      const path = decodeURIComponent(location.hash.slice(1));
      if (serverRoot !== null && path !== '') void openServerPath(path, false);
    });

    const info = await detectServer();
    if (info !== null) {
      serverRoot = info.root;
      $('root-name').textContent = '/ ' + info.name;
      $('files-section').hidden = false;
      $('files-divider').hidden = false;
      try {
        const res = await fetch('api/tree');
        const data = await res.json();
        buildFileList(Array.isArray(data.files) ? data.files : []);
      } catch {
        toast('读不到文件列表');
      }
      const hash = decodeURIComponent(location.hash.slice(1));
      if (hash !== '') await openServerPath(hash, false);
    }
  }

  boot();
})();