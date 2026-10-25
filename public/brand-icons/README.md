# Official client icons

These are original product assets, retained without recoloring, tracing, or replacing the product mark with a text symbol. Verified on 2026-10-24. File hashes and exact provenance are recorded in `manifest.json`.

| Product | Recommended file | Original source |
| --- | --- | --- |
| Codex | `codex.png` | The installed official `OpenAI.Codex` Windows Store package, version `26.1021.3705.0`, asset `assets/Square44x44Logo.targetsize-256_altform-unplated.png`. Product: [OpenAI Codex](https://openai.com/codex/). |
| Claude | `claude.png` | [Claude homepage](https://claude.com/) favicon, [original PNG](https://assets.claude.com/95a868946ac8a31e5ff832e2899f294aa368b836.png). |
| CodeBuddy | `codebuddy.png` | Installed official CodeBuddy CN application asset `resources/app/resources/win32/code_150x150.png`. Product: [CodeBuddy IDE](https://www.codebuddy.cn/ide/). |
| WorkBuddy | `workbuddy.webp` | [WorkBuddy homepage](https://www.codebuddy.cn/work/), [original app icon](https://download.codebuddy.cn/web/website/7bc2216f75dd7246caa4b03e8a7504bf8fef8d68/assets/app_icon-9ltaIE5a.webp), referenced by that website's `constants-C77qCxTb.js` bundle. |
| Cursor | `cursor.svg` | [Official Cursor brand page](https://cursor.com/brand), [original SVG favicon](https://cursor.com/marketing-static/favicon.svg). |

`codebuddy.svg` is also an original official website favicon. The recommended `codebuddy.png` is the purple cat-face desktop application icon; WorkBuddy uses the distinct green cat-face app icon. The WorkBuddy website shares CodeBuddy's browser favicon, so its generic favicon is not used to identify the WorkBuddy application.

The Codex PNG is the installed official package's white knot on a transparent background. It represents this verified package's default icon. It is not an invented terminal glyph or a claim that every Codex app version uses the same icon.

Both SVG files were parsed and checked for scripts, event handlers, `foreignObject`, executable URLs, embedded images, and external references. Only internal SVG references are present. Raster files were decoded and their dimensions checked. The files require no external image request once served by Bifröst.

Run `node scripts/sync-brand-icons.mjs` after an intentional, verified asset update to refresh the copies embedded in the management and customer HTML. The script verifies each original file against the manifest. It scopes SVG IDs without changing paths or colors, and embeds original raster bytes for browser Canvas decoding. This preserves the existing `default-src 'self'` policy without adding an external image host or restarting an older gateway to register asset routes.
