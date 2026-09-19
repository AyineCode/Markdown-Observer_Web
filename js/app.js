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

  /**
   * 读一个 CSS 变量当像素值用。
   * 缩进这类数值既要在 styles/tuning.css 里可调、JS 渲染时又要用，
   * 所以统一从那里读，避免 CSS 与 JS 各写一份数字、改了一处忘了另一处。
   * @param {string} name 变量名（如 '--toc-indent'）
   * @param {number} fallback 读不到时的兜底值
   * @returns {number} 像素数
   */
  function tuningPx(name, fallback) {
    try {
      const raw = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      const value = Number.parseFloat(raw);
      return Number.isFinite(value) ? value : fallback;
    } catch {
      return fallback;
    }
  }

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

  // ─────────────────────────── 2. 设置与持久化 ───────────────────────────

  /*
     持久化分工（这是有意的边界）：
       localStorage —— 设置、视图状态、每篇文档的阅读位置。都很小，同步读写。
       IndexedDB    —— 背景图片。图很大（几百 KB 到 1MB），localStorage 那 5MB 装不下几张。
     不保存的东西：打开过的文件、最近文件列表。阅读器只负责"怎么渲染"，不负责"你读过什么"。
  */

  const SETTINGS_KEY = 'md-reader:settings:v4'
  // 老键只在读取时兜底：搬过来之后下次保存就写到 v4，它们自然作废
  const LEGACY_SETTINGS_KEYS = ['md-reader:settings:v3', 'md-reader:settings:v2', 'md-reader:settings:v1']
  const LEGACY_IMAGE_KEY = 'md-reader:bg-image:v1'
  const MAX_RECENTS = 5

  /*
     下面这些是"阅读偏好"的出厂默认值——改这里等于改所有新访客的初始状态
     （已经用过的浏览器里，localStorage 存着的那份会盖住这里的值；想让它生效，
      点设置面板里的"恢复默认"，或者清掉 md-reader:settings:v4）。

     尺码类的东西（侧栏宽度、行高、圆角、玻璃模糊……）不在这里，在 styles/tuning.css。
  */
  const DEFAULTS = {
    theme: 'system',      // system | light | dark
    serif: false,         // 正文是否用衬线字体
    scale: 1,             // 字号倍数（1 = dsh 原样 16px/28px）
    leading: 1,           // 行距倍数
    width: 748,           // 阅读栏宽（748 = dsh 聊天正文宽度）
    wrapCode: true,       // 代码块是否自动换行（dsh 默认换行）
    sidebar: true,        // 侧栏展开/收起（视图状态，但记住更省事）
    bgMode: 'none',       // none（极简的黑白渐变）| preset（内置渐变）| image（自己的图）
    bgPreset: 'aurora',   // 选 preset 时才用得上：见下面 PRESETS 的第一项
    bgImageKey: null,     // 当前自定义背景在 IndexedDB 里的键
    bgBlur: 22,
    bgDim: 0.3,
    glassAlpha: 0.5,      // 面板不透明度（越透，背景的颜色越能透到按钮上）
    recents: [],          // 最近用过的背景：[{ kind: 'preset', id } | { kind: 'image', key }]
  }

  let settings = Object.assign({}, DEFAULTS)
  let bgImage = null;   // 当前背景图的 dataURL（从 IndexedDB 取出来缓存在内存里）

  /*
     默认值改过的地方集中在这里：只搬"恰好等于老默认值"的那些，自己调过的人原样保留，不去猜他的意图。
       v2 → v3：默认背景从"极光"改成"无背景"。
       v3 → v4：面板默认不透明度从 72% 改成 50%（面板越透，背景的颜色越能透到按钮上）。
  */
  function migrateSettings(value) {
    if (value === null || typeof value !== 'object') return value
    if (value.bgMode === 'preset' && value.bgPreset === 'aurora') value.bgMode = 'none'
    if (value.glassAlpha === 0.72) value.glassAlpha = 0.5
    return value
  }

  /** 读取顺序 v4 → v3 → v2 → v1；读到老键时顺手迁移一次。 */
  function readStoredSettings() {
    try {
      const current = localStorage.getItem(SETTINGS_KEY)
      if (current !== null) return JSON.parse(current)
      for (const oldKey of LEGACY_SETTINGS_KEYS) {
        const old = localStorage.getItem(oldKey)
        if (old === null) continue
        return migrateSettings(JSON.parse(old))
      }
    } catch {
      // 隐私模式或 file:// 下 localStorage 可能不可用：用默认值继续，不打断阅读
    }
    return {}
  }
  Object.assign(settings, readStoredSettings());
  if (!Array.isArray(settings.recents)) settings.recents = [];

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
    } catch {
      // 配额满或被禁用：设置本次仍然生效，只是记不住
    }
  }

  /*
     一个极简的 IndexedDB 封装（只用到一个对象仓库，键是字符串）。
     为什么不用 localStorage：5MB 配额装不下几张背景图，而且图片是二进制，
     IndexedDB 天生适合存大块数据，配额通常几百 MB。
  */
  const ImageStore = (() => {
    const DB_NAME = 'md-reader'
    const STORE = 'backgrounds'
    let opening = null

    function open() {
      if (opening !== null) return opening;
      opening = new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') { reject(new Error('no indexedDB')); return }
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return opening;
    }

    function run(mode, work) {
      return open().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const store = tx.objectStore(STORE);
        const request = work(store);
        tx.oncomplete = () => resolve(request === undefined ? undefined : request.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }));
    }

    return {
      put: (key, value) => run('readwrite', (store) => store.put(value, key)),
      get: (key) => run('readonly', (store) => store.get(key)),
      del: (key) => run('readwrite', (store) => store.delete(key)),
      keys: () => run('readonly', (store) => store.getAllKeys()),
    };
  })();

  /** 记住一个背景（预设或图片），最近用过的排最前，只留 MAX_RECENTS 个。 */
  function rememberBackground(entry) {
    const rest = settings.recents.filter((item) => !(item.kind === entry.kind && (entry.kind === 'preset' ? item.id === entry.id : item.key === entry.key)));
    settings.recents = [entry, ...rest].slice(0, MAX_RECENTS);
    saveSettings();
    // 就地重画那一行：不然刚换的背景要等下次打开面板才出现在"最近使用"里
    renderRecents();
    void collectGarbage();
  }

  /** 清理不再被引用的背景图（当前用的 + 最近列表里的都留着）。 */
  async function collectGarbage() {
    try {
      const keep = new Set();
      if (typeof settings.bgImageKey === 'string') keep.add(settings.bgImageKey);
      for (const item of settings.recents) if (item.kind === 'image') keep.add(item.key);
      const keys = await ImageStore.keys();
      for (const key of keys) if (!keep.has(key)) await ImageStore.del(key);
    } catch {
      // IndexedDB 不可用（隐私模式等）：不清理也不影响阅读
    }
  }

  /** 把 v1 版本存在 localStorage 里的那张图迁移到 IndexedDB（只做一次）。 */
  async function migrateLegacyImage() {
    try {
      const legacy = localStorage.getItem(LEGACY_IMAGE_KEY);
      if (legacy === null) return;
      const key = 'img-legacy';
      await ImageStore.put(key, legacy);
      settings.bgImageKey = key;
      settings.bgMode = 'image';
      settings.recents = [{ kind: 'image', key }, ...settings.recents].slice(0, MAX_RECENTS);
      saveSettings();
      localStorage.removeItem(LEGACY_IMAGE_KEY);
    } catch {
      // 迁移失败就当没有旧数据
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
    // 写在 body 上而不是 html 上：样式表里 body[data-ds-dark-theme] 也定义了这个变量，
    // 而"最近的祖先"说了算——写在 html 上会被 body 那条规则盖掉，深色主题下滑杆就成了摆设。
    document.body.style.setProperty('--glass-alpha', String(settings.glassAlpha));

    // "无背景"模式下模糊/遮罩没有作用对象：把这两行灰掉并在脚下说明，免得以为滑杆坏了
    const plain = mode === 'none';
    for (const name of ['field-blur', 'field-dim']) {
      const field = $(name);
      field.dataset.off = String(plain);
      for (const input of field.querySelectorAll('input')) input.disabled = plain;
    }
    $('bg-note').textContent = plain
      ? '「无背景」是一层极淡的黑白渐变（跟随深浅色）；模糊与遮罩只对渐变 / 图片背景生效。'
      : '深色模式下遮罩会自动加强，保证正文对比度。';

    renderSwatches();
    renderRecents();
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
      b.addEventListener('click', () => {
        settings.bgMode = 'preset';
        settings.bgPreset = preset.id;
        rememberBackground({ kind: 'preset', id: preset.id });   // 先记，再应用："最近使用"才会立刻带上它
        applyBackground();
      })
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
   * 设定背景图：等比缩小 → 转 dataURL → 存进 IndexedDB → 记入"最近使用"。
   * 缩小是必须的：原图动辄几 MB，发到浏览器里做模糊既慢又占内存。
   * @param {File} file 用户选的图片
   */
  async function setBackgroundImage(file) {
    if (!file.type.startsWith('image/')) { toast('请选择图片文件'); return }
    try {
      bgImage = await downscale(file, 2400, 0.82);
    } catch {
      toast('这张图读不出来');
      return;
    }
    const key = 'img-' + Date.now().toString(36);
    settings.bgMode = 'image';
    settings.bgImageKey = key;
    // 顺序有讲究：界面先动，落库最后，而且不等它。
    //   · "最近使用"的缩略图对"当前这张图"直接取内存里的 bgImage（见 renderRecents），
    //     所以不必等 IndexedDB 写进去再读回来；
    //   · 背景本身更不能等——库慢或不可用时，图也得立刻铺上去。
    rememberBackground({ kind: 'image', key });
    applyBackground();
    try {
      await ImageStore.put(key, bgImage);
    } catch {
      // IndexedDB 不可用（隐私模式）：本次仍然生效，只是下次打开找不回来
      toast('背景已生效，但这个浏览器不让保存图片');
    }
  }

  /** 启动时把当前背景图从 IndexedDB 取回内存（异步，取到后会重画一次）。 */
  async function loadStoredBackground() {
    if (typeof settings.bgImageKey !== 'string') return;
    try {
      const dataUrl = await ImageStore.get(settings.bgImageKey);
      if (typeof dataUrl === 'string') {
        bgImage = dataUrl;
        applyBackground();
      }
    } catch {
      // 读不到就退回纯色，不打断阅读
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
          event.preventDefault();
          if (!scrollToAnchor(href.slice(1), true)) toast('找不到这一节：' + href);
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

    // ⑦ 标题锚点：用标题文字生成可读 id（支持中文），供目录、文内跳转和分享链接使用。
    //    dsh 本身没有标题锚点，这是阅读器为"跳转到第 xxx 节"加的能力。
    const used = new Set();
    $$('.markdown h1, .markdown h2, .markdown h3, .markdown h4, .markdown h5, .markdown h6', content)
      .forEach((h, index) => {
        const base = slugify(h.textContent || '') || ('section-' + (index + 1));
        let id = base;
        let n = 2;
        while (used.has(id)) { id = base + '-' + n; n += 1 }
        used.add(id);
        h.id = id;
      });
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

  /** 目录树节点：{ id, head, level, children, parent }。 */
  let tocTree = [];
  /** 目录里当前可见的行（顺序 = 文档顺序），用于高亮与滚动跟随。 */
  let tocFlat = [];
  /** 全部标题（含被折叠隐藏的），用于判断"读到哪一节"。 */
  let tocAll = [];
  /** 当前高亮的那一节。 */
  let activeTocId = '';
  /** 每篇文档的折叠状态：docKey → Set(被折叠的标题 id)。只在内存里，不写盘。 */
  const tocCollapsed = new Map();

  /** 取当前文档的折叠集合；第一次见到这篇文档时，默认只展开到二级。 */
  function tocCollapsedSet() {
    const key = currentDoc === null ? 'none' : currentDoc.key;
    let set = tocCollapsed.get(key);
    if (set === undefined) {
      set = new Set();
      for (const node of tocAll) {
        // 折叠"还有下一级的节点"：效果是默认只展开到二级（h3 及以下收起来）。
        // 注意折叠某个 id 隐藏的是它的子节点，所以这里要折叠的是父节点而不是孙节点。
        if (node.children.length > 0 && node.level >= 2) set.add(node.id);
      }
      tocCollapsed.set(key, set);
    }
    return set;
  }

  /**
   * 从正文标题生成目录：按标题层级折成一棵树。
   * 用"层级栈"而不是固定深度：文档可能从 h2 开头，中间也可能跳级。
   */
  function buildToc() {
    const heads = $$('.markdown h1, .markdown h2, .markdown h3, .markdown h4', content);
    tocTree = [];
    tocAll = [];
    const stack = [];
    for (const head of heads) {
      const level = Number(head.tagName.charAt(1));
      const node = { id: head.id, head, level, children: [], parent: null };
      while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
      const parent = stack.length === 0 ? null : stack[stack.length - 1];
      node.parent = parent;
      if (parent === null) tocTree.push(node);
      else parent.children.push(node);
      stack.push(node);
      tocAll.push(node);
    }
    renderToc();
  }

  /** 重画目录（折叠状态变了、或当前节变了都会调用）。 */
  function renderToc() {
    const box = $('toc');
    box.textContent = '';
    tocFlat = [];
    if (tocTree.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sidebar-empty';
      empty.textContent = '这篇文档没有标题';
      box.appendChild(empty);
      return;
    }
    renderTocLevel(tocTree, box, 0, tocCollapsedSet());
  }

  /** 递归渲染一层目录：三角管折叠，标题文字管跳转。 */
  function renderTocLevel(nodes, box, depth, collapsed) {
    for (const node of nodes) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'row toc-row level-' + node.level + (node.id === activeTocId ? ' active' : '');
      row.dataset.target = node.id;
      row.style.paddingLeft = (tuningPx('--row-pad-x', 8) + depth * tuningPx('--toc-indent', 14)) + 'px';

      const twisty = document.createElement('span');
      twisty.className = 'twisty';
      if (node.children.length === 0) {
        twisty.classList.add('spacer');
        twisty.textContent = '';
      } else {
        const isCollapsed = collapsed.has(node.id);
        twisty.textContent = isCollapsed ? '▸' : '▾';
        twisty.title = isCollapsed ? '展开' : '折叠';
        twisty.addEventListener('click', (event) => {
          event.stopPropagation();   // 点三角只折叠，不跳转
          if (collapsed.has(node.id)) collapsed.delete(node.id);
          else collapsed.add(node.id);
          renderToc();
        });
      }
      row.appendChild(twisty);

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = node.head.textContent;
      name.title = node.head.textContent;
      row.appendChild(name);
      row.addEventListener('click', () => scrollToHeading(node.head));
      box.appendChild(row);
      tocFlat.push({ node, row });

      if (node.children.length > 0 && !collapsed.has(node.id)) {
        renderTocLevel(node.children, box, depth + 1, collapsed);
      }
    }
  }

  /** 滚到某个标题：减去顶栏高度，并走平滑滚动。 */
  function scrollToHeading(node) {
    const top = Math.max(0, node.getBoundingClientRect().top + stage.scrollTop - 78);
    if (typeof stage.scrollTo === 'function') stage.scrollTo({ top, behavior: 'smooth' });
    else stage.scrollTop = top;
  }

  /**
   * 更新"当前读到哪一节"：高亮它，并自动展开它所在的分支（像文件树展开到当前文件）。
   */
  function updateActiveHeading() {
    if (tocAll.length === 0) return;
    let active = tocAll[0];
    for (const node of tocAll) {
      if (node.head.getBoundingClientRect().top <= 110) active = node;
      else break;
    }

    // 自动展开祖先：折叠着的话先展开，再重画一次
    const collapsed = tocCollapsedSet();
    let changed = false;
    for (let parent = active.parent; parent !== null; parent = parent.parent) {
      if (collapsed.has(parent.id)) { collapsed.delete(parent.id); changed = true; }
    }
    if (changed) renderToc();

    if (active.id !== activeTocId) {
      activeTocId = active.id;
      for (const entry of tocFlat) entry.row.classList.toggle('active', entry.node.id === activeTocId);
      // 让当前这一行在侧栏里露出来（side 栏自己滚，不影响正文）
      const row = tocFlat.find((entry) => entry.node.id === activeTocId);
      if (row !== undefined && typeof row.row.scrollIntoView === 'function') {
        row.row.scrollIntoView({ block: 'nearest' });
      }
    }
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

  // ── 多文档：打开的文档（侧栏里像 dsh 的会话列表） ──
  const docs = [];
  let activeDocId = null;
  let docSeq = 0;

  /** 当前激活的文档对象。 */
  function activeDoc() {
    return docs.find((doc) => doc.id === activeDocId) || null;
  }

  /**
   * 打开一份文档（已在列表里就切过去，不会开两份）。
   * @param {string} text markdown 原文
   * @param {{ key: string, name: string, size?: number, path?: string, source?: string }} meta 文档元信息
   */
  function openDoc(text, meta) {
    const existing = docs.find((doc) => doc.key === meta.key);
    if (existing !== undefined) {
      // 同一份文件可能被重新打开（内容变过），刷新正文再切过去
      existing.text = text;
      existing.name = meta.name;
      existing.size = meta.size || 0;
      existing.path = meta.path;
      activateDoc(existing.id);
      return;
    }
    docSeq += 1;
    const doc = Object.assign({ id: 'doc-' + docSeq, text, size: 0, source: 'file' }, meta);
    docs.push(doc);
    activateDoc(doc.id);
  }

  /** 切到某份文档：先记住当前这篇读到哪，再渲染目标那篇。 */
  function activateDoc(id) {
    const next = docs.find((doc) => doc.id === id);
    if (next === undefined) return;
    const previous = activeDoc();
    if (previous !== null && previous.id !== next.id) previous.scroll = stage.scrollTop;

    activeDocId = next.id;
    currentDoc = next;
    renderMarkdown(next.text);
    document.body.dataset.reading = 'true';

    $('doc-title').textContent = next.name;
    const bits = [];
    if (next.path !== undefined) bits.push(next.path);
    if (next.size > 0) bits.push(formatSize(next.size));
    bits.push(countWords(next.text) + ' 字');
    $('doc-meta').textContent = bits.join(' · ');
    $('foot-left').textContent = next.name;
    $('foot-right').textContent = docs.length > 1
      ? (docs.length + ' 个文档 · Ctrl+Tab 切换')
      : '按 / 搜索 · T 换深浅色 · \\ 收起侧栏';
    document.title = next.name + ' · Markdown Observer';

    buildToc();
    stage.scrollTop = typeof next.scroll === 'number' ? next.scroll : 0;
    onScroll();
    if (typeof next.scroll !== 'number') restorePosition();
    renderDocList();
    markActiveFile(next.path);
    closeSearch();
    void resolveLocalImages();
  }

  /** 关掉一份文档；关的是当前这篇就顺位切到邻居。 */
  function closeDoc(id) {
    const index = docs.findIndex((doc) => doc.id === id);
    if (index === -1) return;
    const wasActive = docs[index].id === activeDocId;
    docs.splice(index, 1);
    if (!wasActive) { renderDocList(); return }
    const neighbor = docs[index] || docs[index - 1] || null;
    if (neighbor === null) { showEmptyState(); return }
    activateDoc(neighbor.id);
  }

  /** Ctrl+Tab / Ctrl+Shift+Tab 在打开的文档之间循环。 */
  function cycleDoc(delta) {
    if (docs.length < 2) return;
    const index = docs.findIndex((doc) => doc.id === activeDocId);
    const next = (index + delta + docs.length) % docs.length;
    activateDoc(docs[next].id);
  }

  /** 一份文档都没有时的界面（空状态 + 清掉标题栏）。 */
  function showEmptyState() {
    activeDocId = null;
    currentDoc = null;
    content.textContent = '';
    document.body.dataset.reading = 'false';
    $('doc-title').textContent = '还没有打开文档';
    $('doc-meta').textContent = '拖入 .md 文件，或按 Ctrl/Cmd+O 选择';
    $('foot-left').textContent = '';
    $('foot-right').textContent = '';
    $('progress-bar').style.width = '0%';
    document.title = 'Markdown Observer';
    buildToc();
    renderDocList();
    markActiveFile(undefined);
  }

  /** 渲染侧栏里的“打开的文档”列表（当前项高亮，右侧 × 关闭）。 */
  function renderDocList() {
    const list = $('doc-list');
    list.textContent = '';
    for (const doc of docs) {
      const row = document.createElement('div');
      row.className = 'row doc-row' + (doc.id === activeDocId ? ' active' : '');

      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'doc-open';
      open.title = doc.path !== undefined ? doc.path : doc.name;
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = doc.name;
      open.appendChild(name);
      open.addEventListener('click', () => activateDoc(doc.id));
      row.appendChild(open);

      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'doc-close';
      close.textContent = '×';
      close.title = '关闭（Ctrl+W）';
      close.setAttribute('aria-label', '关闭 ' + doc.name);
      close.addEventListener('click', (event) => { event.stopPropagation(); closeDoc(doc.id) });
      row.appendChild(close);
      // 鼠标中键关闭，和浏览器标签一致
      row.addEventListener('auxclick', (event) => {
        if (event.button === 1) { event.preventDefault(); closeDoc(doc.id) }
      });
      list.appendChild(row);
    }
    $('docs-empty').hidden = docs.length > 0;
    $('open-docs-label').hidden = docs.length === 0;
  }


  /** 打开本地文件（拖放或选择器）。 */
  async function openLocalFile(file) {
    if (!/\.(md|markdown|mdown|mkd|txt)$/i.test(file.name)) {
      if (file.type.startsWith('image/')) { void setBackgroundImage(file); return }
      toast('只认 .md / .markdown / .txt 文件');
      return;
    }
    const text = await file.text();
    openDoc(text, { key: 'file:' + file.name + ':' + file.size, name: file.name, size: file.size, source: 'file' });
  }

  /** 服务模式下按路径打开文档。 */
  /**
   * 按路径打开文档。两种来源共用这一条路径：
   *   服务模式 → HTTP 接口；文件夹模式 → 浏览器给的目录句柄。
   * @param {string} path 相对根目录的路径
   * @param {boolean} [updateHash] 是否把当前文档写进地址栏
   */
  async function openServerPath(path, updateHash) {
    try {
      let text;
      let name;
      let size = 0;
      if (serverRoot !== null) {
        const res = await fetch('api/file?path=' + encodeURIComponent(path));
        const data = await res.json();
        if (!res.ok || data.error !== undefined) { toast(data.error || '打不开这个文件'); return }
        text = data.text;
        name = data.name;
        size = data.size;
      } else if (folderFiles.has(path)) {
        const file = await folderFiles.get(path).getFile();
        text = await file.text();
        name = file.name;
        size = file.size;
      } else {
        toast('这个文件已经不在了（可能被移动或删除）');
        return;
      }
      if (updateHash !== false) setLocation(path);
      openDoc(text, { key: 'path:' + path, name, size, path, source: serverRoot === null ? 'folder' : 'server' });
    } catch {
      toast('读取失败');
    }
  }

  // ── 侧栏文件树（可折叠，像 Unity 的层级面板） ──
  /** 树的根节点：{ name, full, dirs: Map, files: [] }。 */
  let treeRoot = null;
  /** 已展开的目录（存完整路径）。只活在本次会话里，不写进设置——它属于"正在看的目录"，不属于偏好。 */
  const expandedDirs = new Set();
  /** 当前文档在树里的路径，用于高亮。 */
  let activePath;

  /** 把"相对路径列表"折成一棵目录树。 */
  function buildTree(paths) {
    const root = { name: '', full: '', dirs: new Map(), files: [] };
    for (const path of paths) {
      const parts = path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const name = parts[i];
        if (!node.dirs.has(name)) {
          node.dirs.set(name, {
            name,
            full: node.full === '' ? name : node.full + '/' + name,
            dirs: new Map(),
            files: [],
          });
        }
        node = node.dirs.get(name);
      }
      node.files.push({ name: parts[parts.length - 1], path });
    }
    return root;
  }

  /** 换一棵树（服务模式读目录、或浏览器原生文件夹模式）。 */
  function setTree(paths) {
    treeRoot = buildTree(paths);
    const empty = treeRoot.dirs.size === 0 && treeRoot.files.length === 0;
    $('files-label').hidden = empty;
    $('docs-empty').hidden = empty || docs.length > 0;
    renderFileTree();
  }

  /** 重画整棵树（目录展开状态变了就整体重画，树很小，没必要增量）。 */
  function renderFileTree() {
    const box = $('file-tree');
    box.textContent = '';
    if (treeRoot === null) return;
    renderTreeLevel(treeRoot, box, 0);
  }

  /** 递归渲染一层：先目录（带展开三角），再文件。 */
  function renderTreeLevel(node, box, depth) {
    for (const dir of node.dirs.values()) {
      const open = expandedDirs.has(dir.full);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'row tree-row dir' + (open ? ' open' : '');
      row.style.paddingLeft = (tuningPx('--row-pad-x', 8) + depth * tuningPx('--tree-indent', 14)) + 'px';
      const twisty = document.createElement('span');
      twisty.className = 'twisty';
      twisty.textContent = open ? '▾' : '▸';
      const label = document.createElement('span');
      label.className = 'name';
      label.textContent = dir.name;
      row.append(twisty, label);
      row.title = dir.full;
      row.addEventListener('click', () => {
        if (open) expandedDirs.delete(dir.full);
        else expandedDirs.add(dir.full);
        renderFileTree();
      });
      box.appendChild(row);
      if (open) renderTreeLevel(dir, box, depth + 1);
    }
    for (const file of node.files) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'row tree-row file' + (file.path === activePath ? ' active' : '');
      row.dataset.path = file.path;
      row.style.paddingLeft = (tuningPx('--row-pad-x', 8) + depth * tuningPx('--tree-indent', 14) + tuningPx('--twisty-w', 16)) + 'px';
      const label = document.createElement('span');
      label.className = 'name';
      label.textContent = file.name;
      row.appendChild(label);
      row.title = file.path;
      row.addEventListener('click', () => { void openServerPath(file.path) });
      box.appendChild(row);
    }
  }

  /** 高亮当前文档，并自动展开它所在的目录链（Unity 里选中对象也是这个行为）。 */
  function markActiveFile(path) {
    activePath = path;
    if (path !== undefined && treeRoot !== null) {
      const parts = path.split('/');
      let changed = false;
      for (let i = 1; i < parts.length; i += 1) {
        const dir = parts.slice(0, i).join('/');
        if (!expandedDirs.has(dir)) { expandedDirs.add(dir); changed = true; }
      }
      if (changed) renderFileTree();
    }
    $$('#file-tree .tree-row.file').forEach((row) => {
      row.classList.toggle('active', path !== undefined && row.dataset.path === path);
    });
  }


  // ── 文内锚点与深链接 ──

  /**
   * 标题 → 锚点 id：保留中英文与数字，空白折成连字符，去掉标点。
   * 「三、背景与玻璃」→「三背景与玻璃」，「Why is it so?」→「why-is-it-so」。
   * @param {string} text 标题文字
   * @returns {string} 锚点 id
   */
  function slugify(text) {
    const cleaned = text
      .trim()
      .toLowerCase()
      .replace(/[\s\u3000]+/g, '-')
      .replace(/[^\p{Letter}\p{Number}-]+/gu, '')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '');
    return cleaned;
  }

  /**
   * 找一个锚点对应的标题。先精确匹配，再退一步做"宽松匹配"：
   * 这样从别处（GitHub、编辑器预览）复制来的链接也能跳到。
   * @param {string} anchor 锚点（不带 #）
   * @returns {HTMLElement | null} 命中的标题元素
   */
  function findHeading(anchor) {
    const wanted = decodeURIComponent(anchor).replace(/^#/, '');
    if (wanted === '') return null;
    const exact = document.getElementById(wanted);
    if (exact !== null) return exact;
    const loose = slugify(wanted).replace(/-/g, '');
    if (loose === '') return null;
    const heads = $$('.markdown h1, .markdown h2, .markdown h3, .markdown h4, .markdown h5, .markdown h6', content);
    const hits = heads.filter((h) => {
      const id = h.id.replace(/-/g, '');
      const text = slugify(h.textContent || '').replace(/-/g, '');
      return id === loose || text === loose || id.endsWith(loose) || text.endsWith(loose);
    });
    return hits.length === 1 ? hits[0] : null;
  }

  /** 目标标题闪一下：视觉上告诉眼睛"就是这里"。 */
  function flashTarget(node) {
    node.classList.remove('flashed');
    // 强制重排，让动画能重复触发
    void node.offsetWidth;
    node.classList.add('flashed');
    window.setTimeout(() => node.classList.remove('flashed'), 1600);
  }

  /**
   * 跳到某个锚点。
   * @param {string} anchor 锚点（不带 #）
   * @param {boolean} [updateHash] 是否同时改写地址栏（默认改，方便分享）
   * @returns {boolean} 是否找到并跳转
   */
  function scrollToAnchor(anchor, updateHash) {
    const target = findHeading(anchor);
    if (target === null) return false;
    const from = stage.scrollTop;
    scrollToHeading(target);
    flashTarget(target);
    showJumpChip(target.textContent || '', from);
    if (updateHash !== false) {
      const slug = target.id;
      if (location.hash.slice(1) !== slug) {
        hashSelfUpdate = true;   // 这个 hash 是我们自己写的，别再触发一次滚动
        location.hash = slug;
      }
    }
    return true;
  }

  /** 跳转后的小提示条：显示跳到哪一节，并提供"回到原处"。 */
  let jumpTimer = 0;
  function showJumpChip(title, returnTop) {
    const chip = $('jump-chip');
    $('jump-title').textContent = title;
    chip.hidden = false;
    chip.classList.add('show');
    $('jump-back').onclick = () => {
      if (typeof stage.scrollTo === 'function') stage.scrollTo({ top: returnTop, behavior: 'smooth' });
      else stage.scrollTop = returnTop;
      hideJumpChip();
    };
    clearTimeout(jumpTimer);
    jumpTimer = window.setTimeout(hideJumpChip, 6000);
  }

  function hideJumpChip() {
    const chip = $('jump-chip');
    chip.classList.remove('show');
    window.setTimeout(() => { chip.hidden = true; }, 200);
  }

  /** 把当前文档写进地址栏（服务模式）：?file=路径#锚点。 */
  function setLocation(path, anchor) {
    if (serverRoot === null) return;
    const query = path === undefined ? '' : '?file=' + encodeURIComponent(path);
    const hash = anchor === undefined || anchor === '' ? '' : '#' + anchor;
    try {
      history.replaceState(null, '', location.pathname + query + hash);
    } catch {
      // file:// 下个别浏览器不允许改地址：忽略，不影响阅读
    }
  }

  /** 从地址栏读出要打开什么：?file=路径（旧格式 #路径 也认）与 #锚点。 */
  function readLocation() {
    const params = new URLSearchParams(location.search);
    const fromQuery = params.get('file');
    const rawHash = decodeURIComponent(location.hash.slice(1));
    let path = fromQuery === null ? null : fromQuery;
    let anchor = rawHash === '' ? null : rawHash;
    // 旧链接形如 #docs/a.md：把文件路径从 hash 里认出来，锚点留空
    if (path === null && anchor !== null && /\.(md|markdown|mdown|mkd|txt)$/i.test(anchor) && findHeading(anchor) === null) {
      path = anchor;
      anchor = null;
    }
    return { path, anchor };
  }

  /** 自己改写地址栏时的防重入标记（否则会重复滚动、并把"返回原处"的起点记错）。 */
  let hashSelfUpdate = false;

  /** hash 变化（点锚点、前进后退）时：该跳就跳，该换文档就换。 */
  function onHashChange() {
    if (hashSelfUpdate) { hashSelfUpdate = false; return }
    const raw = decodeURIComponent(location.hash.slice(1));
    if (raw === '') return;
    if (findHeading(raw) !== null) { scrollToAnchor(raw, false); return }
    if (serverRoot !== null && /\.(md|markdown|mdown|mkd|txt)$/i.test(raw)) { void openServerPath(raw, false) }
  }
  // ── 浏览器原生文件夹模式（File System Access API） ──
  /*
     为什么需要它：服务模式要 Node，而单文件 HTML 版是发给"没装任何东西"的朋友的。
     Chromium 系浏览器允许网页读取用户主动选择的文件夹，于是没有服务器也能有文件树；
     Firefox / Safari 没有这个能力，按钮会给出提示，其余功能照常。
  */
  /** 用户在文件夹模式里选中的目录句柄。 */
  let folderHandle = null;
  /** 路径 → 文件句柄（文件夹模式下用它读文件）。 */
  const folderFiles = new Map();
  /** 遍历时跳过的目录名。 */
  const SKIP_DIR_NAMES = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'vendor', 'venv', '.venv', '__pycache__']);
  /** 文件夹模式下生成的图片 blob URL，切换文档时要回收。 */
  let localImageUrls = [];

  /** 让用户选一个文件夹（仅 Chromium 系支持）。 */
  async function openDirectory() {
    if (serverRoot !== null) { toast('服务模式已经指定了根目录'); return }
    if (typeof window.showDirectoryPicker !== 'function') {
      toast('这个浏览器不能读文件夹。把文件拖进来，或用服务模式打开');
      return;
    }
    let handle;
    try {
      handle = await window.showDirectoryPicker({ mode: 'read' });
    } catch {
      return;   // 用户取消（AbortError），不需要报错
    }
    folderHandle = handle;
    folderFiles.clear();
    const paths = [];
    await walkDirectory(handle, '', paths, 0);
    paths.sort((a, b) => a.localeCompare(b, 'zh'));
    $('root-name').textContent = handle.name;
    $('root-line').hidden = false;
    setTree(paths);
    setSidebar(true);
    applyEmptyState();
    toast(paths.length === 0 ? '这个文件夹里没有 markdown 文件' : ('找到 ' + paths.length + ' 个 markdown 文件'));
  }

  /** 递归遍历目录，收集 markdown 文件的相对路径与句柄。 */
  async function walkDirectory(dirHandle, prefix, out, depth) {
    if (depth > 8) return;
    for await (const entry of dirHandle.values()) {
      if (entry.name.startsWith('.') || SKIP_DIR_NAMES.has(entry.name)) continue;
      const path = prefix === '' ? entry.name : prefix + '/' + entry.name;
      if (entry.kind === 'directory') {
        await walkDirectory(entry, path, out, depth + 1);
      } else if (/\.(md|markdown|mdown|mkd|txt)$/i.test(entry.name)) {
        folderFiles.set(path, entry);
        out.push(path);
      }
    }
  }

  /**
   * 文件夹模式下，把正文里的相对图片换成 blob URL（本地文件没有服务器可读）。
   * 渲染是同步的，所以这里在渲染之后异步补一遍。
   */
  async function resolveLocalImages() {
    for (const url of localImageUrls) URL.revokeObjectURL(url);
    localImageUrls = [];
    if (folderFiles.size === 0 || currentDoc === null || currentDoc.path === undefined) return;
    const base = currentDoc.path.split('/').slice(0, -1);
    for (const img of $$('.markdown img', content)) {
      const raw = img.getAttribute('src');
      if (raw === null || /^(https?:|data:|blob:)/i.test(raw)) continue;
      const parts = base.slice();
      for (const seg of raw.split('/')) {
        if (seg === '' || seg === '.') continue;
        if (seg === '..') parts.pop();
        else parts.push(seg);
      }
      const handle = folderFiles.get(parts.join('/'));
      if (handle === undefined) continue;
      try {
        const url = URL.createObjectURL(await handle.getFile());
        localImageUrls.push(url);
        img.src = url;
      } catch {
        // 读不到就保持原样（显示为破图）
      }
    }
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

  /*
     数值项的统一定义：一个滑杆（拖得快）+ 一个数字框（填得准）。
     两者读写同一个设置键，所以"拖"和"填"永远一致。
     toUi/fromUi 负责单位换算：内部存小数（0.3），界面显示百分比（30）。
  */
  const FIELDS = [
    { key: 'scale', range: 'r-scale', num: 'n-scale', min: 85, max: 140, toUi: (v) => Math.round(v * 100), fromUi: (v) => v / 100, apply: () => applyReading() },
    { key: 'leading', range: 'r-leading', num: 'n-leading', min: 80, max: 150, toUi: (v) => Math.round(v * 100), fromUi: (v) => v / 100, apply: () => applyReading() },
    { key: 'width', range: 'r-width', num: 'n-width', min: 560, max: 1000, toUi: (v) => Math.round(v), fromUi: (v) => v, apply: () => applyReading() },
    { key: 'bgBlur', range: 'r-blur', num: 'n-blur', min: 0, max: 48, toUi: (v) => Math.round(v), fromUi: (v) => v, apply: () => applyBackground() },
    { key: 'bgDim', range: 'r-dim', num: 'n-dim', min: 0, max: 70, toUi: (v) => Math.round(v * 100), fromUi: (v) => v / 100, apply: () => applyBackground() },
    { key: 'glassAlpha', range: 'r-glass', num: 'n-glass', min: 20, max: 95, toUi: (v) => Math.round(v * 100), fromUi: (v) => v / 100, apply: () => applyBackground() },
  ];

  /** 把一个字段的界面控件（滑杆 + 数字框）与设置同步。 */
  function bindField(field) {
    const range = $(field.range);
    const num = $(field.num);

    range.addEventListener('input', () => {
      settings[field.key] = Number(range.value);
      num.value = String(field.toUi(settings[field.key]));
      field.apply();
      saveSettings();
    });

    const commit = () => {
      const raw = Number(num.value);
      if (!Number.isFinite(raw)) { num.value = String(field.toUi(settings[field.key])); return }
      const clamped = clamp(raw, field.min, field.max);
      num.value = String(Math.round(clamped));
      settings[field.key] = field.fromUi(clamped);
      range.value = String(settings[field.key]);
      field.apply();
      saveSettings();
    };
    num.addEventListener('change', commit);
    num.addEventListener('blur', commit);
    num.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); commit(); num.blur() }
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
    for (const field of FIELDS) {
      $(field.range).value = String(settings[field.key]);
      $(field.num).value = String(field.toUi(settings[field.key]));
    }
    $('sw-serif').setAttribute('aria-pressed', String(settings.serif));
    $('sw-wrap').setAttribute('aria-pressed', String(settings.wrapCode));
    renderRecents();
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

  /** 设置面板的三段（外观 / 排版 / 背景）。 */
  function setSettingsTab(tab) {
    const name = tab === 'bg' ? 'bg' : 'type';
    $('pop-type').hidden = name !== 'type';
    $('pop-bg').hidden = name !== 'bg';
    $$('[data-ptab]').forEach((btn) => btn.setAttribute('aria-pressed', String(btn.dataset.ptab === name)));
  }

  /**
   * 空状态里的卡片按当前环境显隐：
   *   · 左侧已经有文档列表（服务模式，或已经选过文件夹）→ 显示"从左侧选择"，藏掉"打开文件夹";
   *   · 浏览器不支持读取文件夹（Firefox / Safari）→ 也藏掉"打开文件夹"。
   */
  function applyEmptyState() {
    const hasListing = serverRoot !== null || folderFiles.size > 0;
    $('card-browse').hidden = !hasListing;
    $('card-folder').hidden = hasListing || typeof window.showDirectoryPicker !== 'function';
  }

  /** 画"最近使用"的背景（最多 5 个，含自定义图片；空格子也画出来，网格才稳）。 */
  function renderRecents() {
    const box = $('recents');
    box.textContent = '';
    const items = settings.recents.slice(0, MAX_RECENTS);
    for (const item of items) {
      if (item.kind === 'preset' && PRESETS.every((preset) => preset.id !== item.id)) continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'recent';
      const current = (item.kind === 'preset' && settings.bgMode === 'preset' && settings.bgPreset === item.id)
        || (item.kind === 'image' && settings.bgMode === 'image' && settings.bgImageKey === item.key);
      if (current) btn.classList.add('active');
      if (item.kind === 'preset') {
        const preset = PRESETS.find((entry) => entry.id === item.id);
        btn.style.backgroundImage = preset.css;
        btn.title = preset.name;
        btn.setAttribute('aria-label', preset.name);
      } else if (item.key === settings.bgImageKey && typeof bgImage === 'string') {
        // 当前用的这张图就在内存里：直接画，不用等一次 IndexedDB 往返（刚设完的背景必须立刻有缩略图）
        btn.title = '自定义图片';
        btn.setAttribute('aria-label', '自定义图片');
        btn.style.backgroundImage = 'url(' + JSON.stringify(bgImage) + ')';
      } else {
        btn.title = '自定义图片';
        btn.setAttribute('aria-label', '自定义图片');
        btn.classList.add('pending');
        void ImageStore.get(item.key).then((dataUrl) => {
          if (typeof dataUrl === 'string') {
            btn.style.backgroundImage = 'url(' + JSON.stringify(dataUrl) + ')';
            btn.classList.remove('pending');
          }
        }).catch(() => { btn.classList.add('missing') });
      }
      btn.addEventListener('click', () => { void applyRecent(item) });
      box.appendChild(btn);
    }
    for (let i = items.length; i < MAX_RECENTS; i += 1) {
      const slot = document.createElement('div');
      // 类名不能叫 empty：.empty 是"空状态面板"那个大面板的类名（max-width / margin / padding / 圆角都在那上面），
      // 撞上去占位格子会被撑开、被推下一行。这里叫 slot，就是指"一个空格子"。
      slot.className = 'recent slot';
      box.appendChild(slot);
    }
  }

  /** 用"最近使用"里的某一项（预设或图片）当背景。 */
  async function applyRecent(item) {
    if (item.kind === 'preset') {
      settings.bgMode = 'preset';
      settings.bgPreset = item.id;
      saveSettings();
      applyBackground();
      return;
    }
    try {
      const dataUrl = await ImageStore.get(item.key);
      if (typeof dataUrl !== 'string') { toast('这张背景图已经不在了'); return }
      bgImage = dataUrl;
      settings.bgMode = 'image';
      settings.bgImageKey = item.key;
      saveSettings();
      applyBackground();
      rememberBackground(item);
    } catch {
      toast('读不到这张背景图');
    }
  }
  /**
   * 打开设置面板，并把它摆在入口旁边：默认在按钮下方、左边缘对齐；
   * 下方放不下就翻到按钮上方（入口在左下角，所以这条分支是常态）。
   */
  function openPopover() {
    const pop = $('popover');
    pop.hidden = false;
    const rect = $('btn-settings').getBoundingClientRect();
    const width = pop.offsetWidth;
    const height = pop.offsetHeight;
    const below = rect.bottom + 8;
    const top = below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 8) : below;
    pop.style.top = Math.round(top) + 'px';
    pop.style.left = Math.round(Math.max(12, Math.min(window.innerWidth - width - 12, rect.left))) + 'px';
  }

  function openSample() {
    const md = window.__SAMPLE_MD__;
    if (typeof md !== 'string') { toast('示例文档没找到（sample.js 缺失？）'); return }
    openDoc(md, { key: 'sample', name: 'sample.md', size: md.length, source: 'sample' });
  }

  function resetSettings() {
    settings = Object.assign({}, DEFAULTS);
    bgImage = null;
    try {
      localStorage.removeItem(SETTINGS_KEY);
      for (const oldKey of LEGACY_SETTINGS_KEYS) localStorage.removeItem(oldKey);
      localStorage.removeItem(LEGACY_IMAGE_KEY);
    } catch {
      // 清不掉也无所谓
    }
    // 背景图存在 IndexedDB 里，也一并清掉
    void ImageStore.keys().then((keys) => Promise.all(keys.map((key) => ImageStore.del(key)))).catch(() => {});
    saveSettings();
    applyTheme();
    applyReading();
    applyBackground();
    syncControls();
    toast('已恢复默认设置');
  }

  function bindControls() {
    bindSwitch('sw-serif', 'serif', applyReading);
    bindSwitch('sw-wrap', 'wrapCode', applyReading);

    $$('[data-theme]').forEach((btn) => btn.addEventListener('click', () => setTheme(btn.dataset.theme)));
    $$('[data-theme-opt]').forEach((btn) => btn.addEventListener('click', () => setTheme(btn.dataset.themeOpt)));

    // 侧栏：收起 / 展开 / 分段切换（收起按钮在侧栏自己头上，顶栏那个是"展开"入口）
    $('btn-collapse').addEventListener('click', () => setSidebar(false));
    $('btn-sidebar').addEventListener('click', () => setSidebar(!settings.sidebar));
    $('scrim').addEventListener('click', () => setSidebar(false));

    $('btn-search').addEventListener('click', openSearch);
    $('btn-settings').addEventListener('click', (event) => {
      event.stopPropagation();
      const pop = $('popover');
      if (pop.hidden) openPopover(); else pop.hidden = true;
    });
    $('btn-print').addEventListener('click', () => window.print());
    $('btn-open-file').addEventListener('click', () => $('file-input').click());
    // 空状态里的三张卡
    $('card-open').addEventListener('click', () => $('file-input').click());
    $('card-folder').addEventListener('click', () => { void openDirectory(); });
    $('card-browse').addEventListener('click', () => setSidebar(true));
    $('btn-sample').addEventListener('click', openSample);
    $('btn-reset').addEventListener('click', resetSettings);
    $('btn-open-folder').addEventListener('click', () => { void openDirectory(); });

    // 设置面板的三个分段
    $$('[data-ptab]').forEach((btn) => btn.addEventListener('click', () => setSettingsTab(btn.dataset.ptab)));

    // 数值项：滑杆 + 数字框
    for (const field of FIELDS) bindField(field);

    $('file-input').addEventListener('change', (event) => {
      const files = event.target.files === null ? [] : Array.from(event.target.files);
      for (const file of files) void openLocalFile(file);
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
      // 事件路径在派发时就固定了，所以即使这次点击把被点的元素重建掉（换背景会重画色板），
      // 也能认出"这一点发生在面板里"——只靠 contains() 会误判成点在面板外，把面板关掉。
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      if (path.includes(pop) || pop.contains(event.target)) return;
      if (event.target !== null && event.target.isConnected === false) return;   // 兜底：已脱离文档的节点同样不算"外面"
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
      // 文档切换：Ctrl+Tab / Ctrl+W / Ctrl+1..9 都被浏览器占了（标签页切换、关标签），
      // 所以这里用 Alt 组合键，它们在网页里是空闲的。
      if (event.altKey && /^[1-9]$/.test(event.key)) {
        const index = Number(event.key) - 1;
        if (docs[index] !== undefined) { event.preventDefault(); activateDoc(docs[index].id) }
        return;
      }
      if (event.altKey && (event.key === 'w' || event.key === 'W')) {
        event.preventDefault();
        if (activeDocId !== null) closeDoc(activeDocId);
        return;
      }
      if (event.altKey && event.key === '[') { event.preventDefault(); cycleDoc(-1); return }
      if (event.altKey && event.key === ']') { event.preventDefault(); cycleDoc(1); return }
      if (mod && event.key === 'Tab') { event.preventDefault(); cycleDoc(event.shiftKey ? -1 : 1); return }

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
    renderDocList();

    // 锚点跳转与浏览器前进后退都靠 hashchange
    window.addEventListener('hashchange', onHashChange);

    // 背景图存在 IndexedDB 里，取回来是异步的（取到后会自己重画）
    await migrateLegacyImage();
    await loadStoredBackground();

    const info = await detectServer();
    if (info !== null) {
      // 服务模式：根目录由启动参数决定，文件列表走 HTTP 接口
      serverRoot = info.root;
      $('root-name').textContent = info.name;
      $('root-line').hidden = false;
      $('btn-open-folder').hidden = true;   // 已经有根目录了，不再需要选文件夹
      try {
        const res = await fetch('api/tree');
        const data = await res.json();
        setTree(Array.isArray(data.files) ? data.files : []);
      } catch {
        toast('读不到文件列表');
      }
    } else if (typeof window.showDirectoryPicker !== 'function') {
      // 静态模式且浏览器不支持读文件夹：把"打开文件夹"按钮收起来，避免点了没反应
      $('btn-open-folder').hidden = true;
    }

    applyEmptyState();

    // 地址栏里可能带着要打开的文档与小节（可分享的深链接）
    const initial = readLocation();
    if (initial.path !== null && serverRoot !== null) {
      await openServerPath(initial.path, false);
      if (initial.anchor !== null) scrollToAnchor(initial.anchor, false);
    } else if (initial.anchor !== null && docs.length > 0) {
      scrollToAnchor(initial.anchor, false);
    }
  }

  boot();
})();