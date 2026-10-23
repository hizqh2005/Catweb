# /libs —— 本地化第三方库（可选离线方案）

本目录默认**为空**，项目直接走 CDN（见 `index.html` 的 `<script type="importmap">`）。
如需完全离线 / 内网部署，把下列库的发行文件放进来，再把 ImportMap 切到"备选 C：本地离线"。

## 需要下载的文件

| 标识符 | 目录结构 | 来源 |
| --- | --- | --- |
| `three` | `libs/three/build/three.module.js`<br>`libs/three/examples/jsm/**` | npm 包 `three@0.170.0` |
| `gsap` | `libs/gsap/index.js`<br>`libs/gsap/gsap-core.js`<br>`libs/gsap/CSSPlugin.js`<br>（`index.js` 的相对引用兄弟文件都要下） | npm 包 `gsap@3.12.5` |
| `cannon-es` | `libs/cannon-es/dist/cannon-es.js` | npm 包 `cannon-es@0.20.0` |
| `howler` | `libs/howler/dist/howler.js` | npm 包 `howler@2.2.4` |

## 一条命令下载（有网机器上执行）

```bash
mkdir -p libs/three/build libs/three/examples libs/gsap libs/cannon-es/dist libs/howler/dist

curl -o libs/three/build/three.module.js https://registry.npmmirror.com/three/0.170.0/files/build/three.module.js
curl -o libs/three/examples/jsm.zip        https://registry.npmmirror.com/three/0.170.0/files/examples/jsm/ || true

curl -o libs/gsap/index.js        https://registry.npmmirror.com/gsap/3.12.5/files/index.js
curl -o libs/gsap/gsap-core.js    https://registry.npmmirror.com/gsap/3.12.5/files/gsap-core.js
curl -o libs/gsap/CSSPlugin.js    https://registry.npmmirror.com/gsap/3.12.5/files/CSSPlugin.js

# cannon-es 在 npmmirror 的 unpkg-files 白名单之外（403），需从 unpkg / jsdelivr 取
curl -o libs/cannon-es/dist/cannon-es.js https://unpkg.com/cannon-es@0.20.0/dist/cannon-es.js
curl -o libs/howler/dist/howler.js       https://registry.npmmirror.com/howler/2.2.4/files/dist/howler.js
```

> `three/examples/jsm/` 若只需本引擎当前用到的模块可以不下（引擎核心不依赖 addons）；
> 用到 `three/addons/` 的扩展（如后期处理）时再补对应子目录即可。

## 切换方式

打开 `index.html`，把 importmap 的 `imports` 整体替换为注释里的"备选 C"，刷新即可。
注意 `gsap` 的 `index.js` 内部用相对路径引 `gsap-core.js` / `CSSPlugin.js`，必须保持同级目录。
