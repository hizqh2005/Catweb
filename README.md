# CatWab — 零构建的 2.5D / 3D 卡牌游戏引擎

> 个人长期复用的轻量级 WebGL 引擎轮子。纯原生 HTML + ES6 Modules，
> **不需要 npm、不需要打包、不需要编译**——把整个文件夹扔到任意静态服务器（Nginx / `python -m http.server`）上，浏览器打开 `index.html` 就能玩。

面向的游戏形态与工具链：

- **2.5D / HD-2D**：3D 场景 + 2D 分件骨骼纸片人（贴图块挂骨骼树、锁定朝向相机、投影软阴影）
- **3D 卡牌游戏**：3D 牌桌、扇形手牌、拖拽出牌、物理骰子
- **场景编辑器**：`?edit=1` 内嵌式可视化编辑器——拖拽摆资产、改属性、导出/导入场景 JSON
- **2D 骨骼系统**：自研分件骨骼（姿态关键帧 + 程序化动画：待机呼吸/走路/挥手），预留外部格式导入

> 🤖 **要用 AI 改这个项目？** 把 [`AIdocument.md`](AIdocument.md) 整份发给 AI 当上下文——
> 里面是逐文件/逐方法的全量说明书（精确行号）、15 个"需求→改哪里"修改剧本、坑清单与提问模板。

---

## 目录

1. [60 秒跑起来](#1-60-秒跑起来)
2. [整体架构：两层分离](#2-整体架构两层分离)
3. [目录结构与每个文件干什么](#3-目录结构与每个文件干什么)
4. [先懂这 4 个核心概念](#4-先懂这-4-个核心概念)
5. [引擎模块 API 速查](#5-引擎模块-api-速查)
6. [沙盒里能玩什么（功能 ↔ 代码对照）](#6-沙盒里能玩什么功能--代码对照)
7. [场景编辑器（?edit=1）](#7-场景编辑器edit1)
8. [2D 分件骨骼系统（纸片人）](#8-2d-分件骨骼系统纸片人)
9. [手把手：做一个自己的游戏场景](#9-手把手做一个自己的游戏场景)
10. [依赖与 CDN 切换](#10-依赖与-cdn-切换)
11. [常见问题](#11-常见问题)

---

## 1. 60 秒跑起来

```bash
cd CatWab
python3 -m http.server 8123        # 或 nginx / 任何静态服务器
# 浏览器打开 http://127.0.0.1:8123/
```

**启动链条只有一条，记住它：**

```text
index.html  ──<script type="module">──▶  game/main.js  ──▶  engine/Core.js  ──▶  各引擎模块 + game/SandboxScene.js
 (入口页)        (游戏装配入口)            (引擎微内核)        (真正的玩法在 SandboxScene)
```

- `index.html`：唯一入口页。管三件事——ImportMap（依赖清单）、Canvas 容器、HTML HUD 按钮层。
- `game/main.js`：**游戏的 main**。实例化引擎、`use()` 挂载需要的模块、启动主循环。想换游戏就改这里。
- `game/SandboxScene.js`：**真正的玩法代码**。牌桌怎么搭、手牌怎么拖、骰子怎么读点，全在这。

> ⚠️ 不能直接双击 `index.html` 用 `file://` 打开——浏览器禁止 `file://` 下的 ES 模块跨文件 `import`。
> 必须经过一个静态服务器（哪怕 `python3 -m http.server` 一行）。

### 打开后能干什么

| 操作 | 效果 |
| --- | --- |
| 鼠标悬停手牌 | 卡牌抬升放大，两侧手牌被"挤开" |
| 按住手牌拖到牌桌松手 | 出牌：卡牌平躺到桌面并播音效 |
| 把牌拖回手牌区松手 | 收回：平滑飞回扇形位 |
| 点"抽牌" | 从牌堆飞入新手牌 |
| 点"走路" / 点纸片人 | 纸片人走路循环 / 挥手打招呼（骨骼动画） |
| 点"掷骰子" | 骰子抛上桌，物理弹跳落定后**自动读顶面点数** |
| 点"震屏" | GSAP 屏幕震动 |
| 点"正交相机" | 透视 ↔ 正交一键切换（不跳变） |
| 点"BGM" | 合成器 Pad 音乐淡入 / 淡出 |
| 点"场景编辑器"（或 `?edit=1`） | 进入可视化编辑：摆资产、改属性、导出场景 JSON |
| 右键拖动 / 滚轮 | 旋转相机 / 缩放 |
| 点牌面 / 点纸片人 | 查看卡牌数值 / 角色挥手互动 |

---

## 2. 整体架构：两层分离

```text
┌───────────────────────────────────────────────────────────┐
│  /game   业务层（会随项目更换）                              │
│    SandboxScene / main.js                                 │
│    · 玩法逻辑、场景搭建、程序化贴图、HUD 事件                │
└──────────────▲────────────────────────────────────────────┘
               │  只调用引擎暴露的 API，模块间只靠 EventBus 通信
┌──────────────┴────────────────────────────────────────────┐
│  /engine  引擎层（长期复用的轮子，不含任何游戏数值）          │
│    Core 微内核 + 12 个可插拔模块（含 persist / catalog）        │
└──────────────▲────────────────────────────────────────────┘
               │  import map
┌──────────────┴────────────────────────────────────────────┐
│  three / gsap / cannon-es / howler  （CDN 或本地 /libs）    │
└───────────────────────────────────────────────────────────┘
```

**铁律：**

1. `/engine` 里永远不出现具体游戏的名字、数值、资源路径；`/game` 里永远不直接造引擎内部状态。
2. 模块之间解耦通信一律走 `engine.eventBus`，不互相 `import` 对方实例。
3. `update(dt)` 帧循环内**禁止 `new THREE.Vector3()` 等临时对象**，所有数学临时量在构造期预分配复用（GC 铁律，详见第 4 节）。

---

## 3. 目录结构与每个文件干什么

```text
CatWab/
├── index.html                  # 入口页：ImportMap + Canvas + HTML HUD（60 行看懂启动流程）
├── style.css                   # 全局样式：全屏自适应、HUD pointer-events 穿透
├── README.md                   # 本文档（人类入门）
├── AIdocument.md               # AI 上下文说明书（发给 AI 用：全量 API + 修改剧本 + 坑清单）
│
├── /libs
│   └── README.md               # 离线部署时如何下载第三方库、如何切到本地路径
│
├── /assets
│   ├── README.md               # 真实资源的命名约定（贴图/音频/JSON）与加载方法
│   ├── /scenes                 # 场景 JSON（编辑器导出物）：sandbox.json
│   └── /rigs                   # 骨骼 JSON（分件骨骼数据）：hero.json
│
├── /engine                     # ▼ 引擎层（个人轮子，全部通用）
│   ├── Core.js                 # 微内核：rAF 主循环、Scene/Renderer、模块注册、resize
│   ├── EventBus.js             # 发布/订阅事件总线（模块间唯一通信方式）
│   ├── CameraController.js     # 相机：斜角俯视轨道、透视↔正交、GSAP 震屏
│   ├── RaycastManager.js       # 3D 拾取：悬停/点击/拖拽（拖拽投影到桌面平面）
│   ├── PhysicsWorld.js         # cannon-es 胶水：步进世界、刚体↔网格自动同步
│   ├── SceneIO.js              # 场景序列化：工厂注册表（defaultProps/inspector/acceptsAsset）+ JSON 装载/导出
│   ├── ScenePersistence.js     # 场景草稿持久化：可插拔 Adapter（默认 localStorage）
│   ├── AssetCatalog.js         # 资源目录：分组登记，供编辑器资源栏
│   ├── SceneEditor.js          # 场景编辑器（注册表驱动）：?edit=1 摆资产/改属性/草稿/导出 JSON
│   ├── Skeleton2D.js           # 2D 分件骨骼：骨骼树+部件贴图、关键帧 clip、程序化动画
│   ├── CardHandManager.js      # 手牌：扇形排布、抽牌入场、悬停抬升、邻居挤开
│   ├── BillboardUnitManager.js # 纸片人：朝向相机锁定、地面软影跟随
│   ├── AudioManager.js         # 音频：Web Audio 合成音效池 + BGM 淡入淡出 + Howler 兜底
│   └── AssetLoader.js          # 资源加载：Texture/JSON/Audio 预加载 + 进度回调
│
├── /game                       # ▼ 业务层（每个游戏各写一套）
│   ├── main.js                 # 启动入口：new Core → use(模块) → engine.start()
│   ├── SandboxScene.js         # 综合沙盒：工厂/Inspector/默认 props（策略层）+ 手牌/骰子/贴图
│   ├── MiniScene.js            # 最小冒烟场景（切关往返验证）
│
└── /tools                      # ▼ 工程脚本（开发期用，不进运行时）
    └── check-fn-refs.mjs       # 核对脚本：重写文件后防丢工具函数/方法（见第 7 节"防丢清单"）
```

**推荐阅读顺序（也是理解顺序）：**

1. `index.html` —— 看 ImportMap 和 `<script type="module">` 如何指向 `game/main.js`
2. `game/main.js` —— 看模块是怎么被装配起来的（40 行，全貌）
3. `game/SandboxScene.js` —— 看一个"游戏"到底怎么调用引擎
4. `engine/Core.js` —— 看主循环和模块生命周期
5. 其余引擎模块按需读，每个文件顶部注释就是它的说明书

---

## 4. 先懂这 4 个核心概念

### ① 模块协议：一切皆模块

引擎的扩展单位是**模块类**，遵守统一协议即可被微内核接管：

```js
export class MyModule {
  static moduleName = 'mymod';       // 全局唯一名字，engine.get('mymod') 取回
  constructor(engine, options) {}    // 拿到引擎引用，构造期预分配临时变量
  init() {}                          // 可 async；start() 时统一 await
  update(dt, elapsed) {}             // 每帧，按注册顺序调用
  dispose() {}                       // 引擎销毁时倒序调用
}
```

注册与取用（见 [game/main.js:15](game/main.js#L15)、[engine/Core.js:60](engine/Core.js#L60)）：

```js
const engine = new Core({ canvas, container });
engine.use(AudioManager);                 // 注册模块（可传 options）
const director = engine.use(SceneDirector);
director.register('sandbox', SandboxScene);
await director.loadScene('sandbox');      // 调度首关（场景自带 THREE.Scene 与灯光环境）
await engine.start();                     // init 全部完成后进入 rAF 主循环
const audio = engine.get('audio');        // 随时取模块实例
```

**注册顺序 = `update()` 调用顺序**：本项目按 `相机 → 物理 → 拾取 → 手牌 → 纸片人 → 场景导演(关卡)` 排列。

### ② EventBus：模块间唯一通信方式

```js
engine.eventBus.on('sandbox:dice', ({ value }) => console.log(value));  // 订阅（返回退订函数）
engine.eventBus.emit('sandbox:dice', { value: 6 });                     // 广播
engine.eventBus.once('core:start', () => {});                           // 一次性
engine.eventBus.onAny((payload, type) => {});                           // 全局监听（调试利器）
```

引擎内置事件（游戏层直接订阅即可）：

| 事件 | 载荷 | 何时 |
| --- | --- | --- |
| `core:start` / `core:stop` | — | 主循环启停 |
| `core:resize` | `{width, height, aspect}` | 画布尺寸变化 |
| `core:frame` | `{delta, elapsed}` | 每帧渲染前 |
| `camera:mode` / `camera:shake` | `{mode}` / `{intensity}` | 相机切换 / 震屏 |
| `raycast:hover` / `raycast:out` | `{target, event}` | 拾取悬停进出 |
| `raycast:click` | `{target, event}` | 点击命中 |
| `raycast:dragstart` / `raycast:drag` / `raycast:dragend` | `{target, point, event}` | 拖拽三段 |
| `hand:change` / `hand:hover` / `hand:layout` | `{card, count...}` | 手牌增删/悬停/重排 |
| `assets:progress` / `assets:done` | `{loaded, total, percent}` | 资源加载进度 |
| `audio:bgm` | `{state}` | BGM 启停 |

### ③ GC 铁律：帧循环零分配

**规则：`update(dt)` 里永远不 `new` 数学对象**（`Vector3`/`Quaternion`/`Matrix4`…）。
浏览器每秒跑 60 帧，每次 new 都会喂大 GC，卡顿就是这么来的。

正确姿势——构造期预分配，帧内复用：

```js
constructor() {
  this._tmpV3 = new THREE.Vector3();      // ✅ 只 new 一次
}
update(dt) {
  this._tmpV3.copy(a).add(b);             // ✅ 复用
  mesh.position.copy(this._tmpV3);
}
```

GSAP 补间同理：补间目标是**长期存在的字段**（如 `entry.anim`），而不是每帧新建的对象。
`game/SandboxScene.js` 顶部的 `_tmpV3` / `_localPoint` 就是模块级复用临时量的示范。

### ④ 坐标空间：手牌在"局部"，拖拽在"世界"

手牌挂在 `handRoot`（一个 `THREE.Group`）下，卡牌的 `position` 是 **root 局部坐标**；
而鼠标拖拽得到的点是 **世界坐标**（指针投影到桌面平面）。两者转换：

```js
_localPoint.copy(worldPoint);          // 复用临时向量
this.hand.root.worldToLocal(_localPoint);  // 世界 → 手牌局部
mesh.position.copy(_localPoint);
```

出牌时卡牌要脱离手牌根、改挂到 `scene`，需先 `updateWorldMatrix` 取世界变换再重挂，
细节见 [game/SandboxScene.js:283](game/SandboxScene.js#L283) `_playCard()`。

---

## 5. 引擎模块 API 速查

### Core — 微内核（[engine/Core.js](engine/Core.js)）

| 方法 | 说明 |
| --- | --- |
| `new Core({ canvas, container, fov, pixelRatioMax })` | 创建 Scene/Renderer/默认相机 |
| `use(ModuleClass, options)` [:60](engine/Core.js#L60) | 注册模块，返回实例 |
| `get(name)` | 按 `moduleName` 取实例 |
| `start()` [:75](engine/Core.js#L75) | await 全部 `init()` 后启动 rAF 主循环 |
| `stop()` / `dispose()` | 停循环 / 销毁（倒序 dispose 全部模块） |
| `setCamera(camera)` | 换相机（正交切换就靠它） |
| `setScene(threeScene)` | 换渲染目标场景（SceneDirector 切关用） |

自带 `engine.scene`（当前激活场景）、`engine.renderer`、`engine.camera`、`engine.eventBus`、`engine.time`。

### EventBus（[engine/EventBus.js:48](engine/EventBus.js#L48)）

`on / once / off / onAny / offAny / emit / clear`——语义见上文第 ② 节。

### CameraController（[engine/CameraController.js](engine/CameraController.js)）

| 方法 | 说明 |
| --- | --- |
| `setTarget(x, y, z)` | 轨道围绕的目标点 |
| `setOrbit({ distance, polar, azimuth })` | 设球面轨道参数 |
| `toggleMode()` / `setMode('orthographic'\|'perspective')` [:158](engine/CameraController.js#L158) | 正交↔透视，位姿无跳变 |
| `shake(intensity, duration)` [:183](engine/CameraController.js#L183) | GSAP 震屏 |

内置交互：**右键拖动旋转、滚轮缩放**（左键完全让给拾取系统）。

### RaycastManager（[engine/RaycastManager.js](engine/RaycastManager.js)）

```js
const ray = engine.get('raycast');
ray.setDragPlane(UP, TABLE_POINT);          // 拖拽投影平面（如桌面）[:73](engine/RaycastManager.js#L73)
ray.addTarget({                              // 注册可交互物 [:53](engine/RaycastManager.js#L53)
  object: mesh,
  hoverIn(target, e) {}, hoverOut(target, e) {},
  click(e) {},
  dragStart(point, e) {},                    // point = 平面投影世界坐标
  drag(point, e) {},
  dragEnd(point, e) {},
});
ray.removeTarget(mesh);
```

拖拽超过 4px 阈值才算 drag（防止点击误判），支持子网格递归拾取（往父级找注册对象）。

### PhysicsWorld（[engine/PhysicsWorld.js](engine/PhysicsWorld.js)）

```js
const ph = engine.get('physics');
ph.addBox(mesh, { size: {x,y,z}, mass, position, restitution, sleepSpeedLimit }); // [:48](engine/PhysicsWorld.js#L48)
ph.addSphere(mesh, { radius, mass });
ph.addGround(null, { position: { y: -1.6 } });   // 静态地面
ph.onCollide(mesh, (e, pair) => {});             // 碰撞回调
ph.remove(mesh);
```

每帧自动同步：默认 **body → mesh**（物理驱动网格）；`mode: 'meshToBody'` 可反过来让网格拖着刚体走。

### CardHandManager（[engine/CardHandManager.js](engine/CardHandManager.js)）

```js
const hand = engine.get('hand');
hand.setRoot(group);                                  // 手牌根节点 [:40](engine/CardHandManager.js#L40)
hand.addCard(mesh, { title }, { fromX, fromY, fromZ }); // 抽牌入场 [:49](engine/CardHandManager.js#L49)
hand.layout(true);                                    // 弧线重排 [:85](engine/CardHandManager.js#L85)
hand.hoverIn(entry);  hand.hoverOut(entry);            // 抬升/挤开 [:121](engine/CardHandManager.js#L121)
hand.setDragged(entry, true|false);                   // 拖拽时摘出手牌动画系统
hand.removeCard(entry);
hand.setConfig({ radius, maxArc, hoverLift, neighborPush, ... }); // 调手感参数
```

内部实现：每张牌持 `base`（排布基准）+ `anim`（补间偏移），`update()` 只做叠加写入（[:193](engine/CardHandManager.js#L193)），零分配。

### BillboardUnitManager（[engine/BillboardUnitManager.js](engine/BillboardUnitManager.js)）

```js
const bb = engine.get('billboard');
const unit = bb.spawn({                               // [:33](engine/BillboardUnitManager.js#L33)
  object: paperMesh, facing: 'yaw',                   // 'yaw' 站立朝向 / 'full' 全公告板
  shadowTexture: tex, shadowSize: 2.3,                // 可选地面软影
});
bb.remove(unit);
```

### SceneIO — 场景序列化（[engine/SceneIO.js](engine/SceneIO.js)）

场景 = JSON（物体清单：类型 + 变换 + props）。运行时与编辑器共用。游戏层注册工厂与编辑器元数据：

```js
const sio = engine.get('sceneio');
sio.registerType('table', (def) => myMesh, {
  label: '牌桌', icon: '▦',
  defaultProps: {},            // 或 (i) => ({})
  placeY: -0.4,
  inspector: (box, entry, editor) => {},   // 类型专属属性面板
  applyProp: (entry, key, value, inputEl, editor) => true,
  acceptsAsset: (asset) => false,
  createFromAsset: (asset, def) => def,
});
sio.load(sceneDef);          // 装载场景 JSON（清空并重建）
const entry = sio.createObject(def);   // 手动放置一个物体
const data = sio.serialize('scene');   // 从当前实时变换导出 JSON
sio.makeDef(type, overrides);          // 合并 defaultProps 生成 def
sio.removeObject(id);
```

### ScenePersistence / AssetCatalog（[engine/ScenePersistence.js](engine/ScenePersistence.js) / [engine/AssetCatalog.js](engine/AssetCatalog.js)）

```js
engine.use(ScenePersistence, { keyPrefix: 'catwab.scene.' });
engine.use(AssetCatalog);
engine.get('persist').save('sandbox', def);  // 草稿；失败返回 false 不抛
engine.get('persist').load('sandbox');
engine.get('catalog').register({ id, group, label, icon, kind, data });
engine.get('catalog').byGroup();             // 编辑器资源栏渲染用
```

### SceneEditor — 场景编辑器（[engine/SceneEditor.js](engine/SceneEditor.js)）

`index.html?edit=1` 时由 `game/main.js` 注册。**注册表驱动**：工具栏 / 场景大纲 / 资源栏（catalog）/ 属性面板全部自动注入 DOM。
能力：

- **TransformControls 操纵轴**：选中后直接拖轴变换，`W`/`R`/`S` 切移动/旋转/缩放（吸附 `G`）
- **场景大纲**：点列表项选中；**动态属性面板**：通用变换 + 类型控件（由 `sceneio.registerType({inspector, applyProp})` 提供），实时生效
- **资源栏**：类型按钮（带 defaultProps，落在相机附近）+ catalog 分组资源（图片/骨骼/场景）
- **拖 .png/.jpg 进画布** → 经 `acceptsAsset/createFromAsset` 落成物体并登记进 catalog
- **保存草稿 / 导出JSON / 清除草稿**（经 persist；导出文件名 `sandbox.json`，图片 src 转 dataURL）
- 复制(Ctrl+D)、删除(Del)、对准(F)、导入 JSON、运行预览切换

编辑时自动：`raycast.enabled=false`、`physics.paused=true`、emit `editor:enter`（游戏层自行隐藏手牌/HUD）；
预览时全部恢复。变换三处同步：对象 transform、`entry.def`、`physics.applyTransformFromMesh`（网格→刚体）。

### Skeleton2D — 2D 分件骨骼（[engine/Skeleton2D.js](engine/Skeleton2D.js)）

```js
const sk = engine.get('skeletons').spawn(rigData, {});   // rigData = /assets/rigs/hero.json
sk.play('wave', { onComplete: () => sk.startProcedural('idle') });  // 关键帧 clip
sk.startProcedural('walk');                              // 程序化动画（idle/walk/自定义fn）
sk.setPose({ armR: { rotation: -0.5 } }, 0.3);           // 姿态叠加
Skeleton2D.registerImporter('spine', (data) => rigData); // 外部格式导入扩展点
Skeleton2D.fromFormat('spine', json, resolveTexture);
```

姿态语义：相对绑定姿态的偏移（rotation 相加、scale 相乘、position 相加），缺省中性值 0/1。

### AudioManager（[engine/AudioManager.js](engine/AudioManager.js)）

```js
const audio = engine.get('audio');
audio.playSfx('click', { gain: 0.2 });                // [:73](engine/AudioManager.js#L73) 内置: click/draw/whoosh/dice/chime/deal
audio.registerSfx('myfx', (ctx, dest, opts, noise) => {});  // 自定义合成器 [:69](engine/AudioManager.js#L69)
audio.startBgm('ambient', { volume: 0.4, fadeIn: 1.4 });    // [:96](engine/AudioManager.js#B96) 合成 Pad BGM
audio.fadeBgm(0.1, 2);  audio.stopBgm(1);
audio.decode(arrayBuffer);                            // 解码真实音频文件
await audio.loadHowl('bgm', './assets/audio/bgm.mp3'); // Howler 懒加载（可选）
```

> 浏览器自动播放策略：音频上下文在**首次点击/按键**时才解锁（已自动处理）。

### AssetLoader（[engine/AssetLoader.js:22](engine/AssetLoader.js#L22)）

```js
await engine.get('assets').load([
  { name: 'card0', type: 'texture', url: './assets/textures/card_00.png' },
  { name: 'cfg',   type: 'json',    url: './assets/data/cards.json' },
  { name: 'bgm',   type: 'audio',   url: './assets/audio/bgm_main.ogg' },
], { strict: false });     // 默认宽松：单项失败不阻塞（配合程序化兜底贴图）
engine.get('assets').get('card0');   // THREE.Texture / JSON 对象 / AudioBuffer
```

进度自动广播 `assets:progress` / `assets:done`。

---

## 6. 沙盒里能玩什么（功能 ↔ 代码对照）

| 你看到的效果 | 实现位置 |
| --- | --- |
| 牌桌（程序化毛毡贴图 + 阴影 + 碰撞体） | `SandboxScene._makeTable()`（场景工厂，由 `sandbox.json` 的 `table` 条目驱动） |
| 道具（木桶/木箱/灯柱，可碰撞） | `SandboxScene._makeProp()` + `sandbox.json` 的 `prop` 条目 |
| 纸片人（分件骨骼 + 软影 + 点击挥手） | `SandboxScene._makeSkeleton()` + [assets/rigs/hero.json](assets/rigs/hero.json) |
| 骰子 6 面点数贴图 + 抛掷 + **落定自动读点** | `SandboxScene.throwDice()` [:464](game/SandboxScene.js#L464)、`_checkDiceSettled()` [:490](game/SandboxScene.js#L490) |
| 手牌扇形排布 / 抽牌飞入 | `SandboxScene.drawCard()` [:435](game/SandboxScene.js#L435) |
| 悬停抬升 + 邻居挤开 | `CardHandManager.hoverIn()`（沙盒只负责转接 hoverIn/hoverOut） |
| 拖拽出牌 / 拖回收牌 | `SandboxScene._registerCardTarget()` [:331](game/SandboxScene.js#L331)、`_playCard()` [:390](game/SandboxScene.js#L390) |
| HUD 按钮 + toast 提示 | `SandboxScene._bindHud()` |
| 全部贴图（牌面/部件/骰子/毛毡/软影） | `SandboxScene.js` 文件底部的 `make*Texture()` 系列（Canvas 程序化生成） |

所有牌面数值（火球/护盾/费用…）只是沙盒占位数据，**不属于引擎**。

---

## 7. 场景编辑器（?edit=1）

**核心思想**：场景 = JSON 文件（`/assets/scenes/*.json`）。编辑器只是"可视化写 JSON"，
运行时读 JSON 建场景。编辑器本身严格零构建（纯 ES 模块页面，动态注入 DOM）。

### 工作流

```text
1. 点 HUD"场景编辑器"（或访问 index.html?edit=1）进入编辑模式
2. 左侧资源栏点类型放置物体（落在相机附近，带默认属性），或点大纲项/场景物体选中
3. 拖操纵轴沿轴变换（W/R/S 切模式），右侧属性面板控件改动即时生效
4. 直接拖 .png/.jpg 图片进画布 → 按注册表 acceptAsset 生成物体（进 catalog 图片分组）
5. 点"保存草稿"存本地；点"导出JSON"→ 下载 sandbox.json + 复制剪贴板
6. 把 JSON 覆盖到 /assets/scenes/sandbox.json（或你的场景文件）
7. 点"清除草稿"丢弃本地草稿（否则草稿优先于文件）；点"▶ 运行预览"就地试玩
```

### 快捷键

| 键 | 作用 | 键 | 作用 |
| --- | --- | --- | --- |
| `W` / `R` / `S` | 移动 / 旋转 / 缩放模式 | `G` | 网格吸附开关（位置 0.5、旋转 15°） |
| 拖操纵轴 | 沿轴精准变换（按当前模式） | `Ctrl+D` | 复制选中 |
| `Del` | 删除选中 | `Esc` | 取消选中 |
| `F` | 相机对准选中 | 右键拖动 / 滚轮 | 旋转 / 缩放相机 |

### 场景 JSON 结构

```json
{
  "name": "sandbox", "version": 1,
  "objects": [
    { "id": "hero", "type": "skeleton",
      "position": {"x": 5.3, "y": 0, "z": -3.6},
      "rotation": {"x": 0, "y": -0.25, "z": 0},
      "scale": {"x": 1, "y": 1, "z": 1},
      "props": { "rig": "hero", "facing": "yaw", "shadow": true } }
  ]
}
```

- **加载优先级**：persist 草稿（`catwab.scene.sandbox`）→ `/assets/scenes/sandbox.json` → 代码内联兜底（永远能玩）。
- **类型怎么实例化**由游戏层工厂决定（`SandboxScene._registerSceneTypes()`）——引擎只管"类型+变换+props"。
- **物体原点约定**：物体原点 = 物理盒中心（编辑器平移与刚体位置严格一致）。
- **属性面板是动态的**：通用变换控件 + 每种 type 的专属控件（由游戏层 `sceneio.registerType({inspector, applyProp})` 提供）；
  结构级改动（形状/尺寸）走工厂重建（`_rebuild`），轻量改动（颜色/朝向/软影）就地生效。

### 防丢清单（重写文件后必跑）

整体重写文件时容易把"只被调用、不被引用"的工具函数/方法弄丢（已犯两次：丢 `el()`、丢 `_onKey`）。
重写后跑核对脚本，检查构造器 bind 的方法 + 全部调用的工具函数是否都还在：

```bash
node tools/check-fn-refs.mjs engine/SceneEditor.js engine/*.js game/*.js
```

## 8. 2D 分件骨骼系统（纸片人）

**分件骨骼** = 骨骼树（`bones`）+ 部件贴图挂接（`parts`），每个部件就是一张贴图块挂在某根骨骼上
（头/躯干/双臂/双腿各一张）。比真蒙皮轻量得多，**完全满足 2.5D 纸片人换装/动作需求**。

### 骨骼数据（`/assets/rigs/hero.json`）

```json
{
  "bones": [ { "name": "torso", "parent": "root", "x": 0, "y": 1.25, "rotation": 0 } ],
  "parts": [ { "bone": "head", "texture": "part_head", "x": 0, "y": 0.38, "width": 1.15, "height": 1.15 } ],
  "clips": { "wave": { "duration": 1.3, "loop": false, "keys": [
    { "time": 0.25, "pose": { "armR": { "rotation": -2.25 } } } ] } }
}
```

姿态（pose）= **相对绑定姿态的偏移**：`rotation` 相加、`scale` 相乘、`x/y` 相加，缺省中性值 0/1。

### 两条动画路子

```js
const sk = engine.get('skeletons').spawn(rigData, {});

// ① 关键帧 clip（复杂动作写数据）
sk.play('wave', { onComplete: () => sk.startProcedural('idle') });

// ② 程序化动画（循环动作写代码，零关键帧）
sk.startProcedural('idle');   // 待机呼吸（内置）
sk.startProcedural('walk');   // 走路摆臂（内置）
sk.startProcedural((time, pose) => { if (pose.head) pose.head.rotation = Math.sin(time) * 0.1; });
```

### 换装（分件替换）

部件贴图由解析器提供：`engine.get('skeletons').setTextureResolver((name) => texture)`。
换装 = 给不同部件名返回不同贴图（如 `part_head` 换成 `part_head_helmet`），无需重建骨骼。

### 外部格式预留

`Skeleton2D.registerImporter('spine', (data) => 本格式rigData)` +
`Skeleton2D.fromFormat('spine', json, resolveTexture)` 即可接入 Spine/DragonBones 导出数据（v2）。

## 9. 手把手：做一个自己的游戏场景

**第 1 步：写自己的场景模块**（照抄 `SandboxScene.js` 的骨架）

```js
// game/MyGameScene.js
import * as THREE from 'three';

export class MyGameScene {
  static moduleName = 'mygame';

  constructor(engine) {
    this.engine = engine;
    this._tmpV3 = new THREE.Vector3();   // GC 铁律：构造期预分配
  }

  async init() {
    const audio = this.engine.get('audio');
    // 1. 搭场景（灯光/地面/棋盘…）
    // 2. 用 engine.get('hand') / get('physics') / get('raycast') 组装玩法
    // 3. 订阅 EventBus 接 HUD：document.getElementById('btn-xxx').addEventListener(...)
  }

  update(dt) {
    // 帧逻辑（禁止 new 数学对象）
  }

  dispose() {}
}
```

**第 2 步：在 `game/main.js` 换装配**

```js
import { MyGameScene } from './MyGameScene.js';
// ...
director.register('mygame', MyGameScene);   // 替换 director.register('sandbox', SandboxScene)
await director.loadScene('mygame');         // 替换 director.loadScene('sandbox')
```

**第 3 步：放真实资源**（可选）
按 [assets/README.md](assets/README.md) 的命名约定丢进 `/assets`，用 `AssetLoader` 预加载；
加载失败也有程序化贴图兜底，不会开天窗。

**第 4 步：想加新引擎能力？**
新建 `engine/XxxManager.js`，遵守模块协议（`static moduleName` + `init/update/dispose`），
在 `main.js` 里 `use()` 即插即用。**通用逻辑进 `/engine`，游戏逻辑留 `/game`。**

---

## 10. 依赖与 CDN 切换

依赖统一由 `index.html` 的 `<script type="importmap">` 管理，四个标识符固定为：

| 标识符 | 版本 | 用途 |
| --- | --- | --- |
| `three` | 0.170.0 | 渲染 |
| `gsap` | 3.12.5 | 补间动画 / 震屏 |
| `cannon-es` | 0.20.0 | 物理 |
| `howler` | 2.2.4 | 文件音频播放（懒加载，可缺省） |

默认源是 **npmmirror**（国内直连），例外：`cannon-es` 走 **unpkg**
（npmmirror 的 unpkg-files 白名单不含它，返回 403）。

需要切换时，打开 `index.html` 把 `imports` 整体替换为注释里的备选块即可：

- 备选 A：unpkg 全家桶
- 备选 B：jsdelivr 全家桶
- 备选 C：本地 `/libs/` 离线（下载脚本见 [libs/README.md](libs/README.md)）

---

## 11. 常见问题

**Q：双击 index.html 打不开 / 全黑？**
ES 模块必须走 HTTP。用 `python3 -m http.server` 或 Nginx 起个静态服务再访问。

**Q：点了没声音？**
浏览器策略要求音频在用户手势（点击/按键）后解锁。点一下页面任意处即可，首次手势已自动 `resume()` 音频上下文。

**Q：怎么调整手牌手感（弧度/抬起幅度/挤开力度）？**
`game/main.js` 里 `engine.use(CardHandManager, { radius, maxArc, hoverLift, hoverScale, neighborPush, ... })`，
或运行时 `engine.get('hand').setConfig({...})`。

**Q：怎么换相机默认角度？**
`game/main.js` 里 `engine.use(CameraController, { distance, polar, azimuth, target })`。

**Q：帧循环里能创建对象吗？**
不能。这是本引擎的 GC 铁律：所有 `THREE.*` 数学临时量构造期预分配。事件回调、初始化阶段不受限。

**Q：Howler 是必须的吗？**
不是。文件音频（真实 `assets/audio/*`）才需要，`await audio.enableHowler()` 懒加载；
纯合成音效 + 合成 BGM 完全零依赖运行。

**Q：怎么摆场景/做关卡，不用改代码？**
用场景编辑器（`?edit=1`）摆好物体 → 导出 JSON → 覆盖 `/assets/scenes/你的场景.json`。见第 7 节。

**Q：导出 JSON 后刷新页面，编辑没了？**
加载优先级是 persist 草稿 → 文件 → 内联。「保存草稿/导出JSON」会写草稿（下次进来先读草稿），
把导出的 JSON 落盘到 `/assets/scenes/` 后，点编辑器「清除草稿」或执行 `localStorage.removeItem('catwab.scene.sandbox')`。

**Q：怎么做纸片人的动作/换装？**
分件骨骼：部件贴图挂骨骼树，动作走关键帧 clip 或程序化驱动（见第 8 节）。
换装就是换部件贴图（`setTextureResolver` 返回不同纹理）。

**Q：怎么调试？**
浏览器控制台里 `window.engine` 就是引擎实例：
`engine.get('hand').cards`、`engine.get('physics').world.bodies`、`engine.eventBus.onAny(console.log)`。
