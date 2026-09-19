# 第三方依赖（全部本地化，运行时不联网）

这个目录里的文件是从 npm 下载后原样放在这里的，浏览器用经典 `<script>` / `<link>` 直接加载。
之所以不写 CDN 地址：静态模式是 `file://` 打开的，而断网、离线、跨域都不该影响读文档。

| 文件 | 包 | 版本 | 许可证 | 用途 |
|---|---|---|---|---|
| `marked.min.js` | [`marked`](https://github.com/markedjs/marked) | 18.0.13 | MIT | Markdown → HTML（GFM：表格、任务列表、删除线） |
| `highlight.min.js` | [`@highlightjs/cdn-assets`](https://github.com/highlightjs/highlight.js) | 11.12.0 | BSD-3-Clause | 代码高亮（含常用语言）；配色映射见 `../styles/highlight-dsh.css` |
| `purify.min.js` | [`dompurify`](https://github.com/cure53/DOMPurify) | 3.4.15 | Apache-2.0 / MPL-2.0 | 渲染前的 HTML 消毒 |
| `katex.min.js` + `katex.min.css` + `fonts/` | [`katex`](https://github.com/KaTeX/KaTeX) | 0.18.7 | MIT | 数学公式（dsh 用的也是 KaTeX） |

许可证原文分别是 `marked.LICENSE`、`highlight.LICENSE`、`purify.LICENSE`、`katex.LICENSE`（都在这个目录里）。
版本号记录在 `versions.json`。

## 与 dsh 的关系

`../styles/` 下的五张 token 表（`base.css`、`design-platform.css`、`scrollbar.css`、
`gradient-shadow-text.css`、`shiki.css`）以及 `markdown.css` 的规则，都来自 DeepSeek Harness
（`packages/client/ui-theme/src/styles/` 与 `packages/client/ui-primitives/src/markdown/`），
同样是 MIT 许可（© 2026 DeepSeek）。**MIT 要求随分发保留版权声明**，所以这份许可证原文也在本目录：`deepseek-harness.LICENSE`。搬运范围与校验方式写在 `../DEVELOPING.md`。
