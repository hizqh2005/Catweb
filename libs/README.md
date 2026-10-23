# /libs —— 本地化的第三方库（**默认源**）

本目录存放四个依赖的发行文件，`index.html` 的 importmap **默认就指向这里**：
运行时不请求任何 CDN，整个目录扔到任意静态服务器 / 内网 / 离线环境都能跑。

重新下载或升级版本：

```bash
node tools/vendor-libs.mjs           # 下载全部文件（多源 fallback：npmmirror → jsdelivr → unpkg）
node tools/vendor-libs.mjs --check   # 不联网，只校验已有文件完整性
```

升级版本 = 改 `tools/vendor-libs.mjs` 顶部的 `VERSIONS` 表 + `index.html` importmap 里的版本号，两处同步。

## 文件清单

| 标识符 | 目录结构 | 来源（版本 pin） |
| --- | --- | --- |
| `three` | `libs/three/build/three.module.js`<br>`libs/three/examples/jsm/controls/TransformControls.js`<br>`libs/three/LICENSE` | npm 包 `three@0.170.0` |
| `gsap` | `libs/gsap/index.js` + `gsap-core.js` + `CSSPlugin.js`（三件套必须同级，index.js 只引这两个兄弟） | npm 包 `gsap@3.12.5` |
| `cannon-es` | `libs/cannon-es/dist/cannon-es.js`（自包含 ESM）<br>`libs/cannon-es/LICENSE` | npm 包 `cannon-es@0.20.0` |
| `howler` | `libs/howler/dist/howler.js`（UMD，走动态 import）<br>`libs/howler/LICENSE.md` | npm 包 `howler@2.2.4` |

- 引擎只用到 `three/addons/` 里的 **TransformControls.js 一个文件**（r170 它只 `import ... from 'three'`，零子依赖），所以 examples/jsm 整棵树不需要。
- gsap 包内不带 license 文件（package.json 声明 Standard 'no charge' license，见 <https://gsap.com/standard-license>）。
- cannon-es 在 npmmirror 的 unpkg-files 白名单外（403），脚本会自动改走 unpkg/jsdelivr。

## 手动下载（不想用 node 脚本时的备用方案）

```bash
V3=0.170.0 VG=3.12.5 VC=0.20.0 VH=2.2.4
M=https://registry.npmmirror.com
mkdir -p libs/three/build libs/three/examples/jsm/controls libs/gsap libs/cannon-es/dist libs/howler/dist

curl -o libs/three/build/three.module.js "$M/three/$V3/files/build/three.module.js"
curl -o libs/three/examples/jsm/controls/TransformControls.js "$M/three/$V3/files/examples/jsm/controls/TransformControls.js"
curl -o libs/three/LICENSE "$M/three/$V3/files/LICENSE"

curl -o libs/gsap/index.js     "$M/gsap/$VG/files/index.js"
curl -o libs/gsap/gsap-core.js "$M/gsap/$VG/files/gsap-core.js"
curl -o libs/gsap/CSSPlugin.js "$M/gsap/$VG/files/CSSPlugin.js"

# cannon-es 在 npmmirror 白名单外（403），从 unpkg 取
curl -o libs/cannon-es/dist/cannon-es.js https://unpkg.com/cannon-es@$VC/dist/cannon-es.js
curl -o libs/cannon-es/LICENSE            https://unpkg.com/cannon-es@$VC/LICENSE

curl -o libs/howler/dist/howler.js "$M/howler/$VH/files/dist/howler.js"
curl -o libs/howler/LICENSE.md     "$M/howler/$VH/files/LICENSE.md"
```

下载后跑 `node tools/vendor-libs.mjs --check` 校验一遍（脚本按最小体积 + 内容头判断，能抓出 HTML 错误页/截断文件）。

## 应急：切回 CDN

只有本地文件意外丢失时才需要。打开 `index.html`，把 importmap 的 `imports` 整体替换为顶部注释里的备选 A（npmmirror+unpkg）/ B（unpkg）/ C（jsdelivr），刷新即可。
换回来 = 恢复 `./libs/...` 映射，或重跑 `node tools/vendor-libs.mjs`。
