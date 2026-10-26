# 宝可梦水银 HOME（独立版）

把 [Sum-Light/azoth-wiki](https://github.com/Sum-Light/azoth-wiki) 里的「水银 HOME」单独拿出来部署，
并在其上加一层宝可梦编辑器。

- 站点地址：<https://klx1204.github.io/azoth-home/>
- 上游来源：`docs/home`（`app.html` 是官方维护源），以及它引用的
  `pokemon/icons`、`pokemon/sprites`、`stylesheets/standalone.css`、
  `stylesheets/pixel-images.css`、`javascripts/pixel-images.js`、
  `play/native-save.js`。

## 目录

```
upstream/       上游镜像，由脚本写入，禁止手改
src/
  bridge.js     注入上游 IIFE 的 30 行桥（唯一进入上游作用域的本地代码）
  extras/
    mon-codec.js      58 字节个体字段编解码
    home-editor.js    detail 面板里的编辑器
    home-editor.css
scripts/
  sync_upstream.py   拉取上游子集
  build.py           upstream + 注入 → dist/
  smoke.py           构建产物静态检查
tests/
  codec.test.mjs     编解码往返测试
  browser.mjs        真实浏览器冒烟（渲染 + 编辑回写）
dist/           构建产物（不提交）
```

## 构建

```bash
python scripts/sync_upstream.py --from-local ../azoth-wiki   # 首次或更新上游
python scripts/build.py
python scripts/smoke.py
node --test tests/codec.test.mjs
node tests/browser.mjs          # 本地默认用系统 Edge，CI 里 PW_CHANNEL=none
```

本地预览：

```bash
python -m http.server 8000 --directory dist
# http://127.0.0.1:8000/home/app.html
```

> 不能双击打开 `app.html`：`fetch()` 读 JSON 和 `isSecureContext` 都需要 http(s)。

## 注入原理

`upstream/home/app.html` 永远保持上游原样。`scripts/build.py` 只在三个锚点插入内容：

| 锚点 | 注入内容 |
|---|---|
| `</head>` | `../extras/home-editor.css` |
| `</body>` | `../extras/mon-codec.js`、`../extras/home-editor.js` |
| `})().catch(` | `src/bridge.js`（在上游 IIFE 内部，因此能访问 `homeBoxes` 等闭包变量） |

任一锚点消失，构建直接失败，不会产出坏页面。`scripts/smoke.py` 再校验注入位置、
上游 DOM id 和所有本地资源引用。

## 编辑器能力

- **箱子个体**：物种、等级、携带道具、4 个招式、个体值、努力值、昵称、梦特槽。
- **队伍个体**（仅水银 FC）：读取 SaveBlock1 的 6 个队伍槽并显示在页面顶部；可改招式、
  携带道具、昵称、梦特槽。物种 / 等级 / 个体值 / 努力值在队伍里锁定，因为队伍的
  等级和 HP／能力值是存档里的权威数据，改动后需要重算战斗数据（见
  `tests/party-layout.md`）。
- 只读：性格、性别、闪光（由 PID / OTID 决定，改动需要重算 PID，暂不提供）。
- 编辑 HOME 个体：立即写入浏览器 localStorage。
- 编辑 SAV 箱子／队伍：在内存中修改，需要再点顶部「保存 HOME 和 SAV」才写回存档。
- 新版对战塔个体（61 字节）暂不支持编辑，需要先移入 HOME。

## 测试

```bash
python scripts/build.py
python scripts/smoke.py
node --test tests/codec.test.mjs
node tests/browser.mjs                                   # 用系统 Edge
AZOTH_TEST_SAV=/path/to/save.sav node tests/party.mjs     # 队伍读写闭环
```

`tests/party-layout.md` 记录了逆向出来的队伍偏移和验证方法。

## 上游同步

`upstream.lock.json` 记录当前镜像的 commit。`sync_upstream.py` 发现上游未变时会直接退出。
后续会由 GitHub Actions 定时检查上游、重建、跑测试并开 PR。

## 说明

- 本仓库只新增 `src/`、`scripts/`、`tests/`，上游代码与数据保持原样，仅作只读同步。
- 上游仓库没有 LICENSE，此处的二次部署仅用于个人使用；如有版权问题请联系删除。
- 浏览器存档（IndexedDB / localStorage）按 origin 隔离，本站在新域名下不会自动继承
  百科站的网页存档。SAV 文件导入导出不受影响，HOME 备份 JSON 可直接在两边导入。
