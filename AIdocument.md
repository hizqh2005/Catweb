# AIdocument — CatWab 项目 AI 上下文说明书

> **本文档不是给人读的教程，是喂给 AI 的项目全量上下文。**
> 使用方式：把本文件连同你问的问题一起发给 AI；AI 应据此回答"改哪里、怎么改、有什么坑"。
> 项目红线（第 2 节）对 AI 具有最高优先级，任何代码建议都必须遵守。
> 生成时间基准：2026-10-21（v5：引擎可复用化——ScenePersistence/AssetCatalog 新模块、registerType 元数据契约、SceneEditor 注册表驱动去 demo 耦合、SceneDirector 装载锁与失败回滚、游戏层 Inspector 回收；v4：场景解耦重构——Core.setScene / SceneDirector 场景导演 / SandboxScene 自持 THREE.Scene；v3：场景编辑器体验重构——TransformControls 操纵轴/大纲/动态 Inspector/图片拖放；v2：新增场景编辑器 + 2D 分件骨骼），与当前代码库逐行核对。

---

## 0. 使用本文档的方式（给 AI 的元指令）

当使用者提出修改需求时，AI 必须：

1. 先读第 2 节红线 → 任何建议不得违反（零构建、GC 铁律、分层解耦）。
2. 查第 6 节定位要改的文件/方法（含精确行号）。
3. 查第 8 节是否有现成的"修改剧本"，有就照剧本给改动。
4. 改动代码时遵守第 7 节不变量与第 9 节坑清单。
5. 给出的每段代码都要能**直接粘贴替换**，标明插入位置（文件 + 方法 + 行号）。
6. 自己不确定的事实（库 API、坐标变换、物理行为）→ 明确说"未验证"，或让使用者按第 10 节调试手册验证，**不要编造**。
7. 需要使用者补充信息时，按第 11 节提问模板问（编号 + 默认假设）。

---

## 1. 项目一句话与技术栈

**CatWab**：零构建（Zero-Build）、纯原生 ES6 模块化的 WebGL 个人游戏引擎 + 测试沙盒，面向 2.5D/HD-2D 与 3D 卡牌游戏。整个目录扔到任意静态服务器（Nginx / `python3 -m http.server`）即可玩。

| 依赖（ImportMap 标识符） | 版本 | 用途 | 备注 |
| --- | --- | --- | --- |
| `three` | 0.170.0 | 渲染（WebGL2 / sRGB / ACES / PCFSoft 阴影） | `three/addons/` 映射已预留，引擎核心暂未用 |
| `gsap` | 3.12.5 | 补间动画（手牌、出牌、震屏） | ESM `index.js` 入口 |
| `cannon-es` | 0.20.0 | 物理（骰子、地面、牌桌刚体） | **走 unpkg**，npmmirror 白名单不含它（403） |
| `howler` | 2.2.4 | 真实音频文件播放 | **懒加载**（`await import('howler')`），可完全不装 |

CDN 现状：`index.html` importmap 用 npmmirror（three/gsap/howler）+ unpkg（cannon-es）；`index.html` 内注释含 unpkg 全家桶 / jsdelivr 全家桶 / 本地 `/libs/` 三套备选映射。

**运行方式**：`python3 -m http.server 8123` → 浏览器开 `http://127.0.0.1:8123/`。
**禁止**：`file://` 直接双击（ES module CORS 限制）；任何 `npm`/打包器/编译步骤；React/Vue/TypeScript。

---

## 2. 红线（AI 建议必须遵守，违反即错误答案）

1. **零构建**：不得引入 `package.json`、Vite/Webpack/Rollup、任何需要 `npm run build` 的东西。新依赖只能走 ImportMap + CDN/本地 libs。
2. **GC 铁律**：任何 `update(dt)` 帧循环内禁止 `new THREE.Vector3/Quaternion/Matrix4/Euler/Box3/Plane/Raycaster` 等。数学临时量必须在**构造器或模块作用域**预分配复用。事件回调、`init()`、一次性函数不受限。GSAP 补间目标必须是长期持有的对象字段（如 `entry.anim`），不得每帧新建。
3. **分层解耦**：`/engine` 只放绝对通用模块，禁止出现任何具体游戏的业务数值、牌面名、资源路径；`/game` 只通过引擎暴露的 API 组装玩法。
4. **模块间通信走 EventBus**：模块不得互相 import 彼此实例去调用；跨模块副作用一律 `engine.eventBus.emit/on`。取用其他模块只允许 `engine.get(name)`。
5. **UI 用原生 HTML**：HUD 是 DOM 层（`index.html` + `style.css`），不是 canvas 内绘制；整层 `pointer-events: none` 穿透给 3D 拾取，可交互控件单独 `pointer-events: auto`。
6. **程序化资源兜底**：沙盒零外部文件可运行；真实资源失败时回退程序化贴图，不得开天窗。

---

## 3. 启动链路与帧循环时序

```text
index.html
  ├─ <script type="importmap">     四个依赖标识符 → CDN URL
  ├─ <canvas id="game-canvas">     WebGL 画布
  ├─ <div id="hud">                按钮 + stat-line + toast（pointer-events 控制）
  └─ <script type="module" src="./game/main.js">
        │
game/main.js  boot()
        ├─ new Core({ canvas, container: #app })        创建默认 Scene/Renderer/相机
        ├─ engine.use(...)  按顺序注册模块               ←── 换游戏改这里
        ├─ engine.use(SceneDirector) + director.register('sandbox', SandboxScene)
        ├─ await director.loadScene('sandbox')          调度首关（先于 start，
        │                                               保证 SceneEditor.init 能看到关卡物体）
        ├─ window.engine = engine                        调试句柄
        └─ await engine.start()
              ├─ 按注册顺序 await 每个模块 init()
              ├─ _resize()
              └─ requestAnimationFrame(_loop)  ⟲ 60fps
```

**帧循环（`engine/Core.js` `_loop`）时序**：

```text
now → dt = clamp((now-last)/1000, 0, 0.1)      ← 切后台回来不跳变
     → engine.time.{delta, elapsed} 更新
     → 按注册顺序调用各模块 update(dt, elapsed)
          顺序：AssetLoader(无) → AudioManager(无) → CameraController
                → PhysicsWorld(物理步进+同步) → RaycastManager(空)
                → Skeleton2DManager(骨骼姿态) → CardHandManager(base+anim 写网格)
                → BillboardUnitManager(朝向+影子) → SceneIO(空)
                → SceneDirector(转发 SandboxScene 的 FPS/骰子落定/HUD)
                → SceneEditor(仅 ?edit=1，选中框刷新)
     → renderer.render(scene, camera)      ← scene = 当前激活场景（Core.setScene 可切换）
     → emit('core:frame', time)
```

**模块注册顺序即 init/update 顺序**（`game/main.js` 的 `boot()`）：`AssetLoader → AudioManager → CameraController → PhysicsWorld → RaycastManager → Skeleton2DManager → CardHandManager → BillboardUnitManager → SceneIO → ScenePersistence → AssetCatalog → SceneDirector → SceneEditor(仅 ?edit=1)`。相机先于其他；物理先于手牌；骨骼先于纸片人；SceneIO 先于 persist/catalog 与 SceneDirector（关卡装载要挂场景物体）；编辑器最后（DOM 依赖场景已装载，且 init 内会禁用 RaycastManager/暂停物理——因此首关必须在 `engine.start()` 之前 loadScene）。

**场景类协议**（SceneDirector 装载的关卡/场景，如 `game/SandboxScene.js`）：

```js
export class XxxScene {
  constructor(engine, params) {
    this.scene = new THREE.Scene();   // 关卡私有 THREE.Scene：灯光/雾/网格全挂这里
  }
  async init() { this.engine.setScene(this.scene); /* 建环境/装载资源 */ }
  update(dt, elapsed) {}              // 每帧；零分配
  dispose() {}                        // 切关时调用；对称拆线 + 释放 GPU + this.scene.clear()
}
```

**模块协议**（任何新增模块必须遵守）：

```js
export class Xxx {
  static moduleName = 'xxx';        // 全局唯一名，engine.get('xxx') 用它取
  constructor(engine, options) {}   // 只做字段初始化 + 预分配临时量；不做 IO
  async init() {}                   // 可异步；DOM 绑定、资源加载、场景构建放这里
  update(dt, elapsed) {}            // 每帧；零分配
  dispose() {}                      // 引擎.dispose() 倒序调用；解绑监听、释放 GPU 资源
}
```

---

## 4. 目录总览

| 文件 | 行数 | 层 | 一句话职责 |
| --- | --- | --- | --- |
| `index.html` | 79 | 壳 | ImportMap（含 TransformControls 显式映射）+ Canvas + HUD DOM（含"场景编辑器"入口按钮） |
| `style.css` | — | 壳 | 全屏自适应、pointer-events 穿透 |
| `README.md` | — | 文档 | 人类入门文档 |
| `AIdocument.md` | — | 文档 | 本文（AI 上下文） |
| `libs/README.md` | — | 文档 | 离线库下载/切换说明 |
| `assets/README.md` | — | 文档 | 真实资源命名约定 + 加载示例 |
| `assets/scenes/sandbox.json` | — | 游戏数据 | 场景 JSON（编辑器导出物的落盘处） |
| `assets/rigs/hero.json` | — | 游戏数据 | 骨骼 JSON（分件骨骼 + 关键帧 clip） |
| `engine/Core.js` | 164 | 引擎 | 微内核：rAF、Renderer/相机、模块注册、`setScene` 动态切换渲染目标 |
| `engine/EventBus.js` | 64 | 引擎 | 发布/订阅，emit 零拷贝 |
| `engine/InputManager.js` | 349 | 引擎 | 键盘/Gamepad 输入：isDown/isJustPressed、死区摇杆、零 GC `getAxis` |
| `engine/Collision2D.js` | 243 | 引擎 | 轻量相交：AABB/圆形距离平方/点入区域；`onTrigger` + `collision:trigger` |
| `engine/ObjectPool.js` | 107 | 引擎 | 对象池：createFn/resetFn/get/recycle/clear，弹幕/特效复用 |
| `engine/CameraController.js` | 235 | 引擎 | 斜角轨道相机、正交切换、GSAP 震屏 |
| `engine/RaycastManager.js` | ~215 | 引擎 | 悬停/点击/平面投影拖拽（`enabled` 可禁用） |
| `engine/PhysicsWorld.js` | 184 | 引擎 | cannon-es 胶水（`paused` 可暂停；`applyTransformFromMesh` 网格→刚体回写） |
| `engine/SceneIO.js` | 241 | 引擎 | 场景 JSON：物体工厂注册表（defaultProps/inspector/acceptsAsset）、装载/导出 |
| `engine/ScenePersistence.js` | 105 | 引擎 | 场景草稿持久化：可插拔 Adapter（默认 localStorage），save/clear 失败不抛 |
| `engine/AssetCatalog.js` | 86 | 引擎 | 资源目录：分组登记（prefab/image/rig/scene），供编辑器资源栏 |
| `engine/SceneDirector.js` | 139 | 引擎 | 场景导演：场景类注册/装载/切换/卸载（并发锁 + 失败回滚） |
| `engine/SceneEditor.js` | 1070 | 引擎 | 内嵌场景编辑器（?edit=1）：**注册表驱动**，操纵轴/大纲/catalog 资源栏/Inspector/拖放/草稿 |
| `engine/Skeleton2D.js` | 366 | 引擎 | 2D 分件骨骼：骨骼树/部件/clip/程序化动画（update 零分配） |
| `engine/CardHandManager.js` | 234 | 引擎 | 扇形手牌、悬停挤开 |
| `engine/BillboardUnitManager.js` | 111 | 引擎 | 公告板朝向、地面软影 |
| `engine/AudioManager.js` | 365 | 引擎 | Web Audio 合成 + BGM + Howler 懒加载 |
| `engine/AssetLoader.js` | 115 | 引擎 | Texture/JSON/Audio 预加载 |
| `game/main.js` | 84 | 游戏 | 模块装配入口（persist keyPrefix / 编辑器 options / SceneDirector 调度关卡） |
| `game/SandboxScene.js` | 1227 | 游戏 | 沙盒关卡：自持 THREE.Scene + 工厂/Inspector/默认 props（策略层）+ 手牌 + 程序化贴图 |
| `game/MiniScene.js` | 114 | 游戏 | 最小冒烟场景（loadScene('mini') 证明编辑器不依赖沙盒对象） |
| `tools/check-fn-refs.mjs` | 206 | 工具 | 核对脚本：重写文件后防丢工具函数/bind 方法（node 直接跑） |

---

## 5. 事件总线全表（跨模块通信契约）

`engine.eventBus.emit(type, payload)`；订阅 `on(type, fn)` 返回退订函数。

| 事件名 | 载荷 | 发出方 | 典型订阅方 |
| --- | --- | --- | --- |
| `core:start` / `core:stop` | — | Core.start/stop | 任意 |
| `core:resize` | `{width, height, aspect}` | Core._resize | CameraController、游戏层 |
| `core:frame` | `{delta, elapsed}` | Core._loop | 调试/统计 |
| `core:camera` | camera 实例 | Core.setCamera | 任意 |
| `camera:mode` | `{mode: 'perspective'\|'orthographic'}` | CameraController.setMode | HUD |
| `camera:shake` | `{intensity, duration}` | CameraController.shake | 音画联动 |
| `raycast:hover` / `raycast:out` | `{target, event}` | RaycastManager | 拾取反馈 |
| `raycast:click` | `{target, event}` | RaycastManager | 点击逻辑 |
| `raycast:dragstart` / `raycast:drag` / `raycast:dragend` | `{target, point, event}` | RaycastManager | 拖拽逻辑（point 可能为 null） |
| `hand:change` | `{action:'add'\|'remove', card, count}` | CardHandManager | HUD 手牌数 |
| `hand:hover` / `hand:out` | `{card, index?}` | CardHandManager | 音效/放大预览 |
| `hand:layout` | `{count}` | CardHandManager.layout | 任意 |
| `billboard:spawn` / `billboard:remove` | unit | BillboardUnitManager | 任意 |
| `assets:progress` | `{name, loaded, total, percent}` | AssetLoader.load | 加载条 UI |
| `assets:done` | results Map | AssetLoader.load | 隐藏加载条 |
| `audio:bgm` | `{preset?, state:'start'\|'stop'}` | AudioManager | HUD |
| `scene:loaded` | `{name, count}` | SceneIO.load | 任意 |
| `scene:switched` | `{name, scene}`（scene 为场景实例，`.scene` 是 THREE.Scene） | SceneDirector.loadScene | SceneEditor 重挂 gizmo/大纲；游戏层重挂依赖 |
| `editor:enter` / `editor:exit` | — | SceneEditor.init/dispose | 游戏层让位（隐藏手牌/HUD）——引擎不引用业务对象 |
| `editor:select` | `{entry}` | SceneEditor.select | 属性面板联动 |
| `editor:rebuild` | `{entry}` | SceneEditor._rebuild | 游戏层重接线（如 SandboxScene._wireEntry） |
| `editor:destroy` | `{entry}` | SceneEditor._destroyEntry | 游戏层补清理 |
| `editor:preview` | `{previewing}` | SceneEditor.togglePreview | 游戏层恢复交互 |
| `persist:saved` / `persist:loaded` / `persist:cleared` | `{name}` / `{name,data}` | ScenePersistence | 状态提示 |
| `persist:error` | `{op, name, error}` | ScenePersistence | 失败提示（save/clear 不抛出） |
| `catalog:change` | `{reason:'register'\|'remove'\|'clear', id}` | AssetCatalog | 编辑器资源栏刷新 |
| `input:gamepadconnected` / `input:gamepaddisconnected` | `{index, id}` | InputManager | 手柄提示 |
| `collision:trigger` | `{a, b, ax, az, bx, bz}` | Collision2D.update | 战斗判定/触发区域 |
| `sandbox:stat` | string（HUD 文本） | SandboxScene._writeStat | main.js 写 DOM |
| `sandbox:dice` | `{value}` | SandboxScene._checkDiceSettled | 游戏规则 |
| `sandbox:play` | `{card}` | SandboxScene._playCard | 游戏规则 |

---

## 6. 逐文件详解（含精确行号）

### 6.1 `index.html`（壳）

- **importmap**（文件顶部注释含 4 套等价映射：当前混合源 / unpkg / jsdelivr / 本地 libs）。改依赖版本或源 → 只动这里。
- **HUD DOM**：`#stat-line`（状态文本）、`#toast`（浮动提示）、6 个按钮 `#btn-draw #btn-shuffle #btn-dice #btn-shake #btn-camera #btn-bgm`。加按钮 → 此处加 `<button id="btn-xxx">` + `SandboxScene._bindHud()` 绑定。
- 末行 `<script type="module" src="./game/main.js">` 是唯一入口脚本。

### 6.2 `style.css`（壳）

关键设计：`.hud { pointer-events: none }` 整层穿透 → `.panel / button { pointer-events: auto }` 收回。
**改 UI 布局不会影响 3D 拾取，但若给新元素加 `pointer-events: auto`，它覆盖区域的拖拽会失效。**

### 6.3 `engine/Core.js`

| 成员 | 行 | 说明 |
| --- | --- | --- |
| `constructor(options)` | 22 | options: `canvas, container, antialias=true, pixelRatioMax=2, fov=42, near=0.1, far=300`。建 Scene、WebGLRenderer（sRGB、ACES、toneMappingExposure 1.05、PCFSoftShadow）、PerspectiveCamera、`time={delta,elapsed}`。注册 resize/orientationchange 监听 |
| `use(ModuleClass, options)` | 60 | `new ModuleClass(this, options)` + 注册；重名 throw。返回实例 |
| `get(name)` | 70 | 按 `moduleName` 取实例，无则 null |
| `start()` | 75 | 顺序 `await mod.init()` → `_resize()` → 启动 rAF → emit `core:start` |
| `stop()` | 88 | 停 rAF，emit `core:stop` |
| `setCamera(camera)` | 94 | 换活动相机 + resize，emit `core:camera` |
| `setScene(threeScene)` | 104 | 切换渲染目标场景（SceneDirector/关卡动态换景用）；`_loop` 只渲染 `this.scene` |
| `dispose()` | 109 | stop + 倒序 `mod.dispose()` + `renderer.dispose()` |
| `_loop(now)` | 118 | dt 钳 0.1 → 依序 `mod.update` → render → emit `core:frame` |
| `_resize()` | 142 | `renderer.setSize` + 透视改 aspect / 正交读 `camera.userData.frustumHeight` 设视锥（**契约**：正交相机必须带这个 userData 字段） |

### 6.4 `engine/EventBus.js`

| 成员 | 行 | 说明 |
| --- | --- | --- |
| `on(type, handler)` | 15 | 加入 Set，返回退订函数 |
| `once(type, handler)` | 28 | 包装一次性 |
| `off(type, handler)` | 35 | 删监听；通道空则删通道 |
| `onAny/offAny` | 42/49 | 全局监听（调试神器） |
| `emit(type, payload)` | 48 | **遍历 Set 本身不拷贝**（零分配）；handler 内新增的本轮不触发，退订立即失效 |
| `clear(type?)` | 58 | 清单通道/全清 |

### 6.5 `engine/CameraController.js`

字段：`target`(Vector3)、`distance=18`、`minDistance=6`、`maxDistance=42`、`polar=52°`、`minPolar=28°`、`maxPolar=78°`、`azimuth=28°`、`damping=8`、`zoomSpeed=0.0016`、`rotateSpeed=0.005`、`mode`、`_smooth{distance,polar,azimuth}`、`_shake{amplitude}`、`_perspCam`（即 engine.camera）、`_orthoCam`（`userData.frustumHeight`）。

| 成员 | 行 | 说明 |
| --- | --- | --- |
| `init()` | 71 | 绑定：canvas `pointerdown`（**仅右键**起轨道旋转）、window move/up、`wheel`（缩放，preventDefault）、`contextmenu` 禁用、`core:resize` |
| `get camera()` | 91 | 返回当前活动相机 |
| `update(dt)` | 96 | 指数阻尼逼近 → `_applyPose()`（target+球面偏移+随机震偏）→ `_updateProjection()` |
| `setTarget(x,y,z)` | 133 | 轨道中心 |
| `setOrbit({distance,polar,azimuth})` | 137 | 带 clamp |
| `setMode(mode)` | 158 | 切换前同步位姿防跳变；正交 frustumHeight=`distance*0.72`；emit `camera:mode` |
| `toggleMode()` | 177 | 一键切换，返回新模式 |
| `shake(intensity=0.35, duration=0.45)` | 183 | gsap 把 `_shake.amplitude` 补到 0；emit `camera:shake`。震偏在 `_applyPose` 内乘进相机 position |
| `dispose()` | 206 | 解绑全部 |

**手感参数都可在 `game/main.js` 的 `use(CameraController, {...})` 里覆盖。**

### 6.6 `engine/RaycastManager.js`

target 结构（`addTarget` 收对象）：

```js
{
  object,                       // Object3D，递归拾子网格，向上找注册对象
  hoverIn(target, event), hoverOut(target, event),
  click(event),
  dragStart(point, event), drag(point, event), dragEnd(point, event),  // point=平面投影世界坐标|null
  plane,                        // 可选：该 target 私有拖拽平面（THREE.Plane）
  userData,
}
```

| 成员 | 行 | 说明 |
| --- | --- | --- |
| `addTarget(target)` | 53 | 注册，返回 target 本身 |
| `removeTarget(targetOrObject)` | 61 | 清 hover/pressed/dragging 引用 |
| `setDragPlane(normal, point)` | 73 | **全局**拖拽投影平面（沙盒设为 y=1.9 桌面抬升面） |
| `getDragPoint(eventLike)` | 80 | 当前指针在平面的投影；**返回复用 Vector3，勿持有** |
| `_onDown/_onMove/_onUp/_onLeave` | 105+ | 左键专用；拖拽阈值 4px（`dragThreshold`）；`setPointerCapture` 包 try/catch |

**行为细节**：`dragStart` 在越过阈值时才触发（不是 pointerdown）；`click` 需 down 命中目标 === up 命中目标且未发生拖拽；拖拽中 hover 被清空。事件同步广播 `raycast:*`。

### 6.7 `engine/PhysicsWorld.js`

字段：`world`（gravity 默认 **-22**，SAPBroadphase，allowSleep）、`fixedTimeStep=1/60`、`maxSubSteps=3`、`defaultMaterial`（friction 0.4 / restitution 0.3 的 ContactMaterial）。

| 成员 | 行 | 说明 |
| --- | --- | --- |
| `add(mesh, body, mode='bodyToMesh')` | 34 | 登记同步对；mode: `bodyToMesh`（物理驱动）/ `meshToBody`（网格带刚体，每帧清速度） |
| `addBox(mesh, params)` | 48 | params: `size{x,y,z}, mass, position, quaternion, linearDamping=0.05, angularDamping=0.12, allowSleep, sleepSpeedLimit, sleepTimeLimit, mode`。box 由 mesh/params 提供位姿 |
| `addSphere(mesh, params)` | 72 | `radius, mass, ...` |
| `addGround(mesh=null, params)` | 86 | CANNON.Plane，`mesh=null` 时挂 `engine.scene` 哨兵（同步循环跳过它）；默认绕 X 转 -90° 使法线朝上 |
| `onCollide(meshOrBody, handler)` | 101 | `(e, pair)=>{}`；返回退订函数 |
| `setSyncMode` / `getPair` | 112 / 118 | 查/改同步对 |
| `update(dt)` | 122 | `world.step(fixed, dt, maxSub)` + 依 mode 同步 position/quaternion（**duck-typing 直接 copy CANNON.Vec3 → THREE.Vector3，零分配**） |
| `remove(meshOrBody)` / `dispose()` | 138 / 148 | 移除刚体与同步对 |

### 6.8 `engine/CardHandManager.js`

**核心数据结构**（改手感/加动画必看）：

```js
entry = {
  mesh, meta,                                  // meta 是游戏层自由数据
  base: { x, y, z, rz },                       // layout() 算出的排布基准（root 局部）
  anim: { dx, dy, dz, rz, scale },             // GSAP 补间的目标字段（唯一动画通道）
}
```

`update()`（行 193）每帧写 `mesh.position = base+anim`、`mesh.rotation.z = base.rz+anim.rz`、`mesh.scale = anim.scale`；跳过 `mesh.userData.handDragging === true` 的牌。**动画 = gsap.to(entry.anim, ...)**，因此任何新动画都往 `anim` 上挂，别直接补间 mesh（会被 update 覆盖）。

config（`setConfig` 可热改，构造 options 可覆盖）：
`radius=11, maxArc=52°, minStep=4°, maxStep=9°, curve=0.22, tilt=0.72, hoverLift=1.15, hoverScale=1.12, neighborPush=0.55, neighborRot=0.09, animDuration=0.42`

| 成员 | 行 | 说明 |
| --- | --- | --- |
| `setRoot(object3D)` | 40 | 手牌根节点（局部坐标系的原点/朝向由它决定） |
| `addCard(mesh, meta, options)` | 49 | 入场：`anim` 从 `{fromX=0, fromY=3.2, fromZ=-4, scale=0.72}` 补到 0/1；emit `hand:change` |
| `removeCard(meshOrEntry)` | 64 | 从 root 摘除 + kill tweens + 重排 |
| `layout(animated=true)` | 85 | 弧线数学：`step=clamp(maxArc/(n-1),minStep,maxStep)`；`angle=(i-(n-1)/2)*step`；`base.x=sin(angle)*radius`、`base.z=(1-cos(angle))*radius`、`base.y=-(1-cos(angle))*radius*curve`、`base.rz=-angle*tilt` |
| `hoverIn(meshOrEntry)` | 121 | 自身 `anim.{dy,scale}` 补到 hoverLift/hoverScale；邻居 `anim.{dx,rz}` 按 `dir*push/|i-idx|` 挤开；emit `hand:hover` |
| `hoverOut(meshOrEntry)` | 152 | 全部归零 |
| `setDragged(meshOrEntry, dragged)` | 174 | true：kill tweens+hoverOut，配合 `userData.handDragging` 脱离 update 写位；false：`_animateEntry` 回位 |
| `_resolve(x)` | 216 | 入参兼容 entry 或 mesh（经 `mesh.userData.cardEntry`） |

### 6.9 `engine/BillboardUnitManager.js`

| 成员 | 行 | 说明 |
| --- | --- | --- |
| `spawn(params)` | 33 | params: `object, id?, facing='full'|'yaw'|'none', shadowTexture, shadowSize=1.6, shadowOpacity=0.55`。有 shadowTexture 则建地面 Plane 软影（`groundY=0.02`，renderOrder -1） |
| `remove(unitOrId)` | 57 | 同时销毁影子几何/材质 |
| `setFacing(unit, facing)` | 70 | 运行时切朝向模式 |
| `update()` | 75 | `full`：网格直接 copy 相机 quaternion；`yaw`：从相机欧拉抽 Y 分量绕 UP_Y 转（纸片站立）；影子跟随 x/z |

### 6.10 `engine/AudioManager.js`

双轨：**原生 Web Audio 合成**（默认，零文件）+ **Howler 懒加载**（真实音频文件，可缺省）。
Why 动态 import：howler 发行包是 UMD 无 ESM 导出，静态 import 会炸；`globalThis.Howl` 兜底。

| 成员 | 行 | 说明 |
| --- | --- | --- |
| `init()` | 63 | 挂一次性 `pointerdown/keydown` → `ensureContext()`（浏览器自动播放策略解锁） |
| `ensureContext()` | 69 | 懒建 AudioContext + `_masterGain/_sfxGain/_musicGain` + 0.5s 白噪声 buffer；自动 resume |
| `decode(arrayBuffer)` | 86 | `ctx.decodeAudioData`，给 AssetLoader 的 `type:'audio'` 用 |
| `registerSfx(name, synthFn)` | 69 | synthFn 签名 `(ctx, dest, opts, noiseBuffer)`，自行建节点、自带结束时间 |
| `playSfx(name, opts)` | 73 | 并发限流 `opts.maxVoices=6`；内置音色：**click / draw / whoosh / dice / chime / deal**；opts 常用 `{gain, freq}` |
| `startBgm(preset, opts)` | 96 | 合成 Pad：`preset ∈ ambient/warm/tension`（和弦表在文件底部 `BGMB_PRESETS`）；opts `{volume=0.42, fadeIn=1.2, cutoff=760}`；内部 4 振荡器 + 慢 LFO |
| `fadeBgm(volume, duration=0.8)` | 145 | 音量渐变 |
| `stopBgm(fadeOut=1)` | 154 | 淡出后延迟 stop+disconnect 所有节点 |
| `setMasterVolume(v)` | 180 | |
| `enableHowler()` / `loadHowl(name,urls,opts)` / `play(name)` | 186/199/207 | 真实文件播放路径；失败静默降级 |
| `dispose()` | 215 | 停 BGM、unload howls、close ctx |

### 6.11 `engine/AssetLoader.js`

| 成员 | 行 | 说明 |
| --- | --- | --- |
| `load(manifest, options)` | 22 | manifest: `[{name, type:'texture'|'json'|'audio', url}]`；`options.strict=false` 默认单项失败不阻塞；进度 emit `assets:progress`，完成 emit `assets:done`，返回 Map |
| `loadTexture(url)` | 50 | TextureLoader + `colorSpace=SRGB` |
| `loadJSON(url)` | 59 | fetch → json |
| `loadAudio(url)` | 65 | fetch → 有 audio 模块则 `audio.decode()`，否则存原始 ArrayBuffer |
| `get/has/set/release/dispose` | 78+ | 缓存管理；release 对 Texture 调 dispose |

### 6.12 `game/main.js`

`boot()` 唯一职责：装配。当前注册顺序与 options：

```js
engine.use(AssetLoader);
engine.use(AudioManager);
engine.use(CameraController, { distance: 21, polar: 0.30π, azimuth: 0.16π, target: {x:0,y:1,z:1.5} });
engine.use(PhysicsWorld);
engine.use(RaycastManager);
engine.use(Skeleton2DManager);
engine.use(CardHandManager, { radius: 9, maxArc: 0.26π, hoverLift: 1.1, hoverScale: 1.12 });
engine.use(BillboardUnitManager, { groundY: 0.03 });
engine.use(SceneIO);

const director = engine.use(SceneDirector);
director.register('sandbox', SandboxScene);      // ← 换游戏 = 注册别的场景类
await director.loadScene('sandbox');             // 调度首关（必须在 engine.start() 之前，见 §3）
await engine.start();
```

`window.engine` 是调试句柄；`sandbox:stat` 事件写入 `#stat-line`。
**换游戏 = `director.register('名字', 场景类)` + `loadScene('名字')`；调全局手感 = 改这里的 options。**

### 6.13 `game/SandboxScene.js`（1036 行，关卡玩法与场景工厂全在这）

**架构 v4**：本关**自持 `THREE.Scene`**（`this.scene`，构造函数里创建）——灯光/雾气/地面等环境全部挂在本关场景下，`init()` 里 `engine.setScene(this.scene)` 激活渲染目标（此后 `engine.scene === this.scene`，SceneIO/Billboard/Skeleton 挂对象都自动进本关）；`dispose()` 释放 GPU 资源 + `this.scene.clear()` 整体卸载，杜绝多光源残留过曝。场景由 SceneDirector 装载调度（见 6.17）。
**架构 v2**：场景由【场景 JSON】驱动。加载优先级：persist 草稿(`persist.load('sandbox')`，key=`catwab.scene.sandbox`) → `fetch ./assets/scenes/sandbox.json` → 内联 `DEFAULT_SCENE`。骨骼同理：`./assets/rigs/hero.json` → 内联 `RIG_HERO`。物体经 SceneIO 工厂实例化。**Inspector/默认 props/acceptsAsset 全在 `_registerSceneTypes` 注册时提供（游戏层策略），引擎编辑器只认元数据。**

**模块级复用临时量**（GC 铁律示范）：`_tmpV3, _tmpQuat, _localPoint`（文件顶部）。
**常量表**：`DICE_FACES`（对面和 7：+X=2/-X=5/+Y=1/-Y=6/+Z=3/-Z=4）、`CARD_TITLES`、`CARD_HUES`、`DEFAULT_SCENE`、`RIG_HERO`。

| 成员 | 行 | 说明 |
| --- | --- | --- |
| `init()` | 61 | `engine.setScene(this.scene)` 激活本关 → 建环境 → 注入部件贴图解析器 → 载 rig/场景 → `sceneio.load` → `_wireSceneObjects` → 绑 HUD → `handRoot`（Group，位 `(0,1.25,7.4)`）→ 发 5 张起手牌 |
| `_buildEnvironment()` | 112 | 背景/雾/半球光+平行光（2048 阴影图）+ 地面网格 **+ 地面刚体 y=-1.6（兜骰子）**——全部挂 `this.scene` |
| `dispose()` | 687 | 对称拆线：off 事件 → 场景清扫（`disposeObject3D` 释放几何/材质/贴图 + 杀补间 + `scene.clear()`）→ 摘手牌 → 按 `_destroyEntry` 同构拆拾取/刚体/软影/骨骼 → 清贴图缓存 |
| `_loadSceneDef()` / `_loadRig()` | 221/233 | persist 草稿 → fetch 文件 → 内联兜底（三层降级） |
| `_registerSceneTypes()` | 243 | 注册 5 种工厂 + **defaultProps/inspector/applyProp/acceptsAsset/createFromAsset**（游戏层策略）；并 `catalog.register` 骨骼/场景资源 |
| `_makeTable()` | 172 | 毛毡 Box(14×0.8×9)+木沿+静态物理盒；**物体原点 = 物理盒中心** |
| `_makeProp(def)` | 202 | props: `{shape:'box'\|'cylinder'\|'sphere', color, size\|radius, height}` + 静态碰撞体 |
| `_makeSkeleton(def)` | 240 | `skeletons.spawn(rig)` + billboard(facing/shadow props) + `startProcedural('idle')` |
| `_makeBillboard(def)` | 260 | 图片纸片人：`props.src/aspect` 建贴图 Plane + billboard + 软影（编辑器拖图用） |
| `_makeDice(def)` | 294 | 六面点数贴图 Box(1.35)；停泊 y=-20 并 sleep；sleepSpeedLimit=0.32 |
| `_wireSceneObjects()` / `_wireEntry(entry)` | 332/339 | 场景装载后接线：dice click→throwDice、skeleton click→`_heroAction`（wave clip）；**订阅 `editor:rebuild`（init 行 79-82）在工厂重建后重接** |
| `_registerCardTarget(entry)` | 386 | 悬停转接 hand.hoverIn/Out；**拖拽坐标转换**（世界点 → `hand.root.worldToLocal`）；`dragEnd` 判 `onTable`（\|x\|≤6.4 且 \|z\|≤3.8）→ 出牌 / 否则回位 |
| `_playCard(entry, point)` | 445 | 取世界变换 → 摘出手牌/拾取 → 挂回 scene → gsap 平躺桌面 → emit `sandbox:play` |
| `drawCard(silent=false)` | 490 | 程序化牌面 → `hand.addCard` → 注册拾取 |
| `throwDice()` | 519 | wakeUp + 随机位姿/速度/角速度（起点 y=8.2 z=5.2） |
| `_checkDiceSettled()` | 545 | `sleepState === CANNON.Body.SLEEPING` → 顶面读点 → emit `sandbox:dice`（模块级 `_tmpV3`，零分配） |
| `_bindHud()` | 570 | 8 按钮（抽牌/重排/掷骰/走路/震屏/正交/BGM/场景编辑器跳转） |
| `_writeStat()` / `update(dt)` | 636/645 | FPS 平滑 + 骰子落定检测 + stat 节流（0.3s 才拼一次字符串） |
| `make*Texture()` 系列 | 691+ | 程序化 Canvas 贴图：felt/cardFace/**partTexture(part_head/torso/arm/leg)**/shadow/diceFace |

### 6.14 `engine/SceneIO.js`（场景序列化）

| 成员 | 行 | 说明 |
| --- | --- | --- |
| `registerType(type, factory, opts)` | 32 | 游戏层注册物体工厂 `factory(def) -> Object3D`；opts 见下表（编辑器只认这些字段） |
| `getType(type)` | 85 | 取完整元数据（含 factory/inspector/applyProp/acceptsAsset） |
| `makeDef(type, overrides, placeIndex)` | 95 | 合并 `defaultProps`（对象或 `(i)=>({})`）生成 def，供放置 |
| `createObject(def)` | 62 | 规范化 def → 工厂实例化 → 应用变换 → `userData.{sceneObject,sceneId,sceneDef}` → 入表 |
| `load(sceneDef)` | 116 | 清空重建全部物体，emit `scene:loaded` |
| `serialize(name)` | 140 | 从**实时变换**导出 `{name, version, objects:[def]}` |
| `removeObject` / `getEntry` / `clear` | 85/97/128 | 移除（含几何/材质释放）/ 按 id 或 Object3D 向上找 entry / 清空 |
| `SceneIO.normalizeDef / applyTransform / writeTransformToDef` | 185+ | def 补全 / def→对象 / 对象→def（静态，编辑器复用） |

**registerType options 契约**（游戏层提供策略，引擎只认字段名）：

| 字段 | 类型 | 用途 |
| --- | --- | --- |
| `label` / `icon` | string | 资源栏/大纲显示 |
| `defaultProps` | object \| `(i)=>object` | `placeType`/`makeDef` 合并进 def.props |
| `placeY` | number | 放置默认高度 |
| `inspector` | `(box, entry, editor) => void` | 类型专属属性面板（DOM 工具从 `SceneEditor.js` 导入） |
| `applyProp` | `(entry, key, value, inputEl, editor) => bool` | 处理 data-k 字段；返回 false 则走通用写入；需重建时调 `editor._rebuild` |
| `acceptsAsset` | `(asset) => bool` | 拖放/资源点击能否落成此类型 |
| `createFromAsset` | `(asset, def) => def` | 把资源信息写入 def.props |

def 结构：`{ id, type, position{x,y,z}, rotation{x,y,z 弧度}, scale{x,y,z}, props{} }`。

### 6.15 `engine/SceneEditor.js`（内嵌编辑器，?edit=1，**注册表驱动**）

v5 要点：**引擎只认注册表，不含任何游戏名词**。类型专属 Inspector/默认 props/图片放置全经 `sceneio.registerType` 元数据；草稿经 `persist`；资源栏经 `catalog`；手牌/HUD 让位经 `editor:enter/exit/preview` 由游戏层订阅。变换用 TransformControls（W/R/S）。

| 成员 | 行 | 说明 |
| --- | --- | --- |
| `init()` | 58 | GridHelper + TransformControls → 注入 CSS/DOM → 绑事件 + 订阅 `scene:switched`/`catalog:change`；`raycast.enabled=false`、`physics.paused=true`、emit `editor:enter` |
| `_onDown/_onGizmoChange/_onKey` | 120/130/134 | 拾取选中 / 操纵轴→同步 / 快捷键 |
| `_pick` / `_projectGround` | 161/176 | raycaster 拾取 / 投影 y=0 地面 |
| `_syncTransform()` | 186 | 变换三处同步：def + 刚体 + 面板数值 |
| `select(entry)` | 193 | BoxHelper + gizmo；emit `editor:select` |
| `placeType(type, overrides)` | 248 | **合并 defaultProps**，落点=相机 target + placeY，连续放置错开 |
| `placeAsset(asset, x, z)` | 331 | 查 `acceptsAsset` 类型 → `createFromAsset` 写 props → 创建 |
| `_rebuild(entry, rerender)` | 275 | 工厂重建；emit `editor:rebuild` |
| `_destroyEntry(entry)` | 312 | 对称清理 + emit `editor:destroy` |
| `saveDraft` / `clearDraft` / `exportScene` | 373/384/395 | 经 persist；导出下载 `exportName.json`，**blob src 转 dataURL**；setItem 失败不阻断下载 |
| `togglePreview()` | 457 | 预览/编辑互斥；emit `editor:preview` |
| `_onSceneSwitched()` | 500 | 切关后重挂 grid/gizmo、清选中、刷大纲/资源栏 |
| `_buildDom` / `_refreshOutliner` / `_refreshCatalog` | 518/617/653 | 工具栏（保存草稿/导出/清除草稿）+ 大纲 + **catalog 资源栏** |
| `_renderInspector` / `_onInspectorEvent` / `_applyProp` | 698/743/783 | 通用变换控件 + `typeMeta.inspector/applyProp` |
| 导出 DOM 工具 | 900+ | `el/row/numInput/colorInput/selectInput/checkboxInput/rangeInput/findUnit`——**游戏层 Inspector 从这里 import** |

快捷键：`W/R/S` 模式、`G` 吸附、`Ctrl+D` 复制、`Del` 删除、`Esc` 取消选中、`F` 对准。
**构造 options**：`{ grid, snap, sceneName, exportName, hudSelector, placeOffsetY }`。

### 6.16 `engine/Skeleton2D.js`（2D 分件骨骼）

数据格式（`/assets/rigs/*.json`）：`{ name, bones[{name,parent,x,y,rotation,scale}], parts[{bone,texture,x,y,rotation,scale,width,height,z}], clips{ name:{duration,loop,keys[{time,pose}]} } }`。
**姿态语义**：相对绑定偏移（rotation 相加 / scale 相乘 / position 相加），缺省中性值 0/1。

| 成员 | 行 | 说明 |
| --- | --- | --- |
| `Skeleton2D.registerImporter(name, fn)` | 34 | 外部格式（Spine/DragonBones）导入扩展点 |
| `Skeleton2D.fromFormat(name, data, resolveTexture)` | 38 | 用导入器转成本格式后构造 |
| `play(clipName, {loop, speed, onComplete})` | 136 | 关键帧 clip（线性插值），一次性 clip 播完回调 |
| `startProcedural('idle'\|'walk'\|fn)` | 155 | 程序化驱动：内置待机呼吸/走路摆臂，或自定义 `(time, poseMap) => {}`（poseMap 为实例复用对象，勿持有跨帧引用） |
| `setPose(pose, alpha)` | 173 | 一次性姿态叠加（受击/换装摆姿） |
| `update(dt)` | 186 | 推进 clip/驱动 → `_sampleClip`(213) 插值 → `_applyPose`(267) 写骨骼 Group；**热路径零分配**（`_boneList` 数组 + `_poseMap` 复用，不许回退成 `for...of` Map / 每帧建对象） |
| `Skeleton2DManager.spawn(rigData, opts)` | 307 | 模块 `skeletons`：数组存储批量驱动；`setTextureResolver(fn)` 注入部件贴图解析 |

骨骼实现：每根骨骼 = THREE.Group（父子层级），部件 = Plane 网格挂骨骼 Group；渲染用 `MeshBasicMaterial` + `alphaTest`（分件透明底）。

### 6.17 `engine/SceneDirector.js`（场景导演）

管理场景类（而非 THREE.Scene）的生灭与帧转发。场景类协议见第 3 节；`engine.get('director')` 取本模块，`director.active` 是当前场景实例。

| 成员 | 行 | 说明 |
| --- | --- | --- |
| `register(name, SceneClass)` | 33 | 注册场景类（name 全局唯一），返回 this 可链式 |
| `has(name)` | 44 | 查注册表 |
| `loadScene(name, params)` | 62 | 切换流程：旧场景 `dispose()` + `clearSceneResources()` → `new SceneClass` + `setScene` → `await init()` → emit `scene:switched`；**`_loading` 并发锁（装载中再调抛错）+ init 失败回滚（半成品 dispose、active 清空）** |
| `update(dt, elapsed)` | 78 | 转发活动场景 `update()`（`_ready` 门闩：场景 init 未完成不转发，运行时切景期间帧循环照跑不误）；零分配 |
| `dispose()` | 85 | 卸载当前场景 + 清空注册表 |
| `clearSceneResources(threeScene)` | 98 | 模块级兜底：子树几何/材质/贴图释放 + `clear()` + 清 background/fog |

**切关时资源清理的分工**：场景类 `dispose()` 负责自己的对称拆线（EventBus/拾取/刚体/骨骼/贴图缓存）+ `scene.clear()`；`clearSceneResources` 是场景类没清干净时的引擎层兜底（先 dispose 再兜底，故场景 clear 后兜底自然为空操作）。

### 6.18 `engine/ScenePersistence.js`（场景草稿持久化）

模块名 `persist`。**save/clear 失败不抛出**，广播 `persist:error` 并返回 false。

| 成员 | 说明 |
| --- | --- |
| `configure({keyPrefix, adapter})` | 换前缀或存储后端 |
| `load(name)` / `save(name, def)` / `clear(name)` / `list()` | 草稿读写清列 |
| `createLocalStorageAdapter(keyPrefix)` | 默认后端；adapter 接口 `{load,save,clear,list}` 可换 File/自定义 |

游戏配置：`engine.use(ScenePersistence, { keyPrefix: 'catwab.scene.' })`。**SceneEditor 不直接碰 localStorage**。

### 6.19 `engine/AssetCatalog.js`（资源目录）

模块名 `catalog`。与 AssetLoader 分工：Loader 管运行时加载，Catalog 管目录元数据（供 UI/放置）。

| 成员 | 说明 |
| --- | --- |
| `register(asset)` | `{id, group, label, icon, thumbnail, kind, data}`；emit `catalog:change` |
| `remove(id)` / `get(id)` / `list()` / `byGroup()` | 查询与分组 |
| `clear()` | 清空并广播 |

kind 约定：`'prefab' | 'image' | 'rig' | 'scene' | ...`（自定义）。编辑器资源栏渲染 `byGroup()`，点选走 `editor.placeAsset`。

### 6.20 `engine/InputManager.js`（输入系统）

模块名 `input`。**零 GC 轴输出**：`getAxis` 写入并返回内部 `_axis` 引用，函数内严禁 new。

| 成员 | 说明 |
| --- | --- |
| `isDown(code)` | 当前按住（`KeyboardEvent.code`，如 `'KeyW'`/`'Space'`） |
| `isJustPressed(code)` / `isJustReleased(code)` | 本帧刚按下/松开（双缓冲：监听器写 pending，update 提升为本帧可见） |
| `isGamepadButtonDown(btn, pad=0)` | 手柄按钮按住 |
| `isGamepadButtonJustPressed(btn)` / `JustReleased` | 相对上一帧快照的触发 |
| `getAxis(negX, posX, negY, posY)` | **零 GC**：优先左摇杆（死区 0.15 重映射），否则键盘；对角归一 |
| `getGamepadAxis()` | 仅摇杆轴 |
| 事件 | `input:gamepadconnected` / `input:gamepaddisconnected` `{index, id}` |

options：`{ deadzone: 0.15 }`。**帧时序**：游戏逻辑在 InputManager 之后的模块里读 `isJustPressed` 均可见；不要在 InputManager.update 之前读。

### 6.21 `engine/Collision2D.js`（轻量相交与战斗判定）

模块名 `collision`。**GC 铁律**：模块作用域预分配 `_tmpBoxA/_tmpBoxB/_tmpV3`，相交测试严禁 new。

| 成员 | 说明 |
| --- | --- |
| `register(id, def)` | def：`{type:'box'\|'circle'\|'zone', group, targetMesh?, size?, radius?, center?, enabled?, onTrigger?}` |
| `unregister(id)` / `setEnabled(id, on)` / `setCenter(id,x,y,z)` | 生命周期与坐标 |
| `testPointInZone(point, zoneId)` | 点落入 box 区域（卡牌放槽位/区域触发） |
| `Collision2D.boxesOverlap(a,b)` | AABB（`Box3.intersectsBox`） |
| `Collision2D.circlesOverlap(a,b)` | 距离平方 ≤ (r1+r2)²，高频弹幕 |
| `Collision2D.overlaps(a,b)` | 按 type 自动分派（zone 视作 box） |
| `update(dt)` | 同步 targetMesh 世界坐标 → 两两判定（**跳过同 group**）→ `onTrigger` + emit `collision:trigger` |

复杂度 O(n²)，适合战斗体（百级）；弹幕请用 circle 并控制注册数量。`size` 为半尺寸。

### 6.22 `engine/ObjectPool.js`（对象池工具）

**非 Core 模块**，游戏层直接 `import { ObjectPool }` 使用。

| 成员 | 说明 |
| --- | --- |
| `new ObjectPool(createFn, resetFn, initialSize=20)` | 预开辟实体 |
| `get()` | 优先闲置栈（调 resetFn），空则 createFn；热路径零分配 |
| `recycle(item)` | 隐藏并归还；**不销毁 geometry/material**；防重复归还 |
| `clear(disposeFn)` | 场景销毁时批量释放（disposeFn 负责 GPU 资源） |
| `freeCount` / `activeCount` / `createdCount` | 调试计数 |

---

## 7. 不变量清单（AI 检查自己的改动是否踩线）

1. `update(dt)` 内无 `new THREE.*` 数学对象；新临时量进构造器/模块作用域。
2. 新动画只补间 `entry.anim`（或等价的长期字段），不直接补间会被每帧覆写的 `mesh.position/rotation/scale`。
3. 手牌卡牌的 `position` 是 **handRoot 局部坐标**；拖拽/出牌逻辑里跨坐标系必须 `worldToLocal` / `updateWorldMatrix`（见 `_playCard`）。
4. `mesh.userData.handDragging === true` 表示"该牌暂由拖拽逻辑驱动"，`CardHandManager.update` 会跳过；任何自定义驱动都要设/清这个旗标。
5. 正交相机必须带 `userData.frustumHeight`（Core._resize 靠它算视锥）。
6. 注册到 RaycastManager 的对象，其任意子网格命中会向上解析到注册对象；拖拽终点 point 可能为 `null`（射线平行于平面），回调要判空。
7. `EventBus.emit` 里不要指望"本轮新增监听器被触发"；退订即时生效。
8. cannon-es 的 Vec3/Quaternion 与 THREE 的对象是 **duck-typing copy**（`.copy()` 只读 x/y/z/w），不要用 `instanceof` 判断。
9. 物理动态体如需静止，用 `body.sleep()` + `sleepSpeedLimit/sleepTimeLimit`，别每帧写位置。
10. 沙盒的一切数值（牌名、点数、桌面尺寸）都只能存在于 `game/`，严禁上移到 `engine/`。
11. **角色动作控制、跳跃手感与 2D 碰撞判定必须走 Kinematic 纯代码解算与数学盒（Collision2D），严禁直接使用 3D 刚体（Cannon-es）驱动角色移动/跳跃。** 重力、速度、接地判定用常量 + 代数积分；受击盒/触发区用 `Collision2D.register`。
12. 音频节点在事件回调里即时建即可（不是帧循环）；但 BGM 节点要存进 `_bgm.nodes` 以便 stop 时释放。
13. `dispose()` 里必须对称解绑：DOM 监听、EventBus 订阅、gsap.killTweensOf、GPU 资源。
14. **物体原点 = 物理盒中心**（场景 def 的 position 与刚体位置严格同义）；编辑器平移后必须 `physics.applyTransformFromMesh(mesh)` 回写刚体。
15. 编辑模式互斥：`SceneEditor` 开启时 `raycast.enabled=false`、`physics.paused=true`；预览时恢复。新增"会移动物体"的编辑功能必须遵守同样的互斥。
16. 场景物体标记：`object.userData.{sceneObject, sceneId, sceneDef}` 由 SceneIO 统一写入；自定义 pick 靠 `sceneio.getEntry(obj)` 向上解析。
17. 骨骼姿态是**相对绑定偏移**（rotation 相加/scale 相乘/position 相加），clip 缺省中性值 0/1；动画只写 `bone.pose`，由 `_applyPose()` 统一落盘到 Group。
18. 编辑器变换要同步三处：对象 transform、`entry.def`、物理刚体（有 pair 时）。
19. 场景加载三层降级（persist 草稿 → `/assets/scenes/*.json` → 内联）——改默认场景时**内联常量和 JSON 文件要同步改**。
20. **整体重写文件后必跑 `node tools/check-fn-refs.mjs <文件>`**：已两次丢过"只被调用不被引用"的工具函数（`el()`、`_onKey`），运行前才炸。构造器 bind 的方法、工具函数区的 `el/row/*Input` 一个都不能少。
21. **关卡环境（灯光/雾/背景/网格）只能挂场景类自持的 `this.scene`**（SandboxScene 构造期创建、`init` 里 `engine.setScene(this.scene)` 激活），不要写死 `engine.scene.add(...)`——`engine.scene` 只是"当前激活场景"指针，切关后指向会变；同一关卸载后必须 `dispose()` 释放 GPU + `scene.clear()`，否则旧光源残留导致画面过曝。

---

## 8. 修改剧本（Playbook：需求 → 改哪里 → 模板）

> 每条 = 目标 + 精确改动点 + 可粘贴模板 + 验证方法。

### P1 调手牌手感（弧度/抬起/挤开力度）

- 改点：`game/main.js` 的 `engine.use(CardHandManager, {...})`（构造期）或运行时 `engine.get('hand').setConfig({...})`（会自动 re-layout）。
- 字段：`radius / maxArc / curve / tilt / hoverLift / hoverScale / neighborPush / neighborRot / animDuration / minStep / maxStep`。
- 验证：悬停一张牌 → 两侧挤开幅度；抽 7+ 张看扇面是否超宽（maxArc/step 钳制）。

### P2 改卡牌外观/牌面内容（程序化）

- 改点：`game/SandboxScene.js` 底部 `makeCardFaceTexture(index, meta)`（行 493 附近）与 `CARD_TITLES / CARD_HUES`（文件顶部）。
- `meta` 由 `drawCard()`（行 328）构造（title/cost/hue/index）——加字段要同步改贴图函数。
- 验证：点"抽牌"看新牌面；牌面缓存按 index 存于 `_faceTextureCache`，改代码后要刷新页面。

### P3 换成真实贴图/音频资源

- 贴图：按 `assets/README.md` 命名放 `/assets/textures/`，在场景 `init()` 里：
  ```js
  await engine.get('assets').load([
    { name: 'card_00', type: 'texture', url: './assets/textures/card_00.png' },
  ]);
  const tex = engine.get('assets').get('card_00'); // 替换程序化贴图参数
  ```
- 音频：`await engine.get('audio').loadHowl('bgm', './assets/audio/bgm_main.ogg')` → `audio.play('bgm')`；或 `assets.load` 的 `type:'audio'` 走 `audio.decode`。
- 验证：Network 面板 200；失败时程序化兜底仍工作。

### P4 加一个新的可交互 3D 物体

- 改点：`SandboxScene.init()`（或 `_bindInteractions()`）：
  ```js
  this.raycast.addTarget({
    object: myMesh,
    hoverIn: () => { /* 提高 emissive/放大 */ },
    hoverOut: () => { /* 还原 */ },
    click: (e) => { this._toast('点击了'); },
    dragStart: (point) => {}, drag: (point) => {}, dragEnd: (point) => {},
  });
  ```
- 注意：拖拽回调 point 是**全局拖拽平面**投影（默认 y=1.9）；若该物体要在别的平面拖，给 target 传 `plane: new THREE.Plane(normal, constant)`。
- 移除：`this.raycast.removeTarget(myMesh)`（dispose 里也要清）。

### P5 改物理手感（重力/弹性/骰子）

- 重力/全局摩擦：`game/main.js` → `engine.use(PhysicsWorld, { gravity: -22, friction: 0.4, restitution: 0.3 })`。
- 骰子参数：`SandboxScene._buildDice()`（行 164）的 `mass / linearDamping / angularDamping / sleepSpeedLimit`；抛掷力度在 `throwDice()`（行 356）的速度/角速度公式。
- 验证：连点"掷骰子"10 次，观察是否穿桌、是否长时间不落定（sleep 参数）。

### P6 加/改音效

- 纯合成（零文件）：`audio.registerSfx('myfx', (ctx, dest, opts, noise) => { /* osc/gain/envelope */ })` 后 `playSfx('myfx')`；内置 6 种见 6.10。
- 真实文件：见 P3 音频段。
- BGM 换和弦：改 `engine/AudioManager.js` 底部 `BGMB_PRESETS`，或 `startBgm('warm'|'tension')`。

### P7 调相机默认视角/限制

- 改点：`game/main.js` 的 `use(CameraController, { distance, polar, azimuth, target, minDistance, maxDistance, minPolar, maxPolar, damping })`。
- 想禁右键旋转：删 `CameraController.init()` 里的 pointerdown 绑定（行 71 附近）。
- 验证：右键拖动到极限角不穿地（minPolar/maxPolar）；滚轮远近边界。

### P8 改出牌规则（哪里能出、出牌后干什么）

- 改点：`SandboxScene._registerCardTarget()` 的 `dragEnd`（行 260 附近）——`onTable` 判定就是出牌区域；`_playCard()`（行 283）是出牌落点动画与事件。
- 示例：只允许出在桌子右半区 → `point.x > 0 && Math.abs(point.z) <= 3.8`。
- 业务规则（费用校验、回合制）放 `sandbox:play` 事件订阅里，别塞进引擎。

### P9 改骰子（面数/读点/外观）

- 点数映射：`DICE_FACES`（文件顶部）+ `makeDiceFaceTexture(pips)`（文件底部）；点数读取逻辑 `_checkDiceSettled()`（行 381）。
- 换 D20 等异形骰 = 新几何体 + 新法线表，读顶面逻辑同构（法线转世界比 y）。

### P10 加/换 HUD 按钮

- `index.html` 加 `<button id="btn-xxx">`；`SandboxScene._bindHud()` 里 `this._bindButton('btn-xxx', (btn) => {...})`。
- 统计文本：改 `_writeStat()`（行 636）。

### P11 场景编辑器工作流（摆关卡/改布局）

- 不改代码：`?edit=1` → 摆放/变换 → "导出JSON" → 覆盖 `/assets/scenes/你的场景.json`。
- 加可放置物体类型：`SandboxScene._registerSceneTypes()`（行 163）注册新工厂（参考 `_makeProp`）。
- 改编辑器行为（吸附步长/快捷键/面板字段）：`engine/SceneEditor.js`（构造 options `grid/sceneName/exportName/hudSelector`；`_onKey` 快捷键；**类型专属控件加在游戏层 `registerType({inspector, applyProp})`**，不要写回引擎；结构级改动走 `_rebuild` 工厂重建）。
- 坑：persist 草稿优先于文件——测试文件改动前用编辑器「清除草稿」或 `localStorage.removeItem('catwab.scene.sandbox')`。

### P12 纸片人骨骼（动作/换装/新角色）

- 新角色：写 `/assets/rigs/xxx.json`（bones/parts/clips），在 `_loadRig()` 返回表加一行；场景 JSON 里 `props.rig: 'xxx'`。
- 新动作：复杂动作写 `clips` 关键帧（`sk.play('name')`）；循环动作用程序化（`sk.startProcedural('idle'|'walk'|fn)`）。
- 换装：`skeletons.setTextureResolver((name) => tex)` 按部件名返回不同贴图（如 `part_head` → `part_head_helmet`）。
- 新部件贴图：`SandboxScene.makePartTexture(name)` 加分支（程序化）或改为真实贴图（AssetLoader）。
- 姿态调试：`sk.setPose({ armR: { rotation: -0.5 } }, 1)` 即时看效果，再写进 clip。

### P13 加一个全新引擎模块

- 新建 `engine/XxxManager.js`，照第 3 节模块协议写；顶部注释写清职责（引擎文件顶部注释就是它的说明书）。
- `game/main.js` import + `use()`（注意 update 顺序依赖：有 per-frame 写位的模块放在游戏层之前）。
- 若需要跨模块通信，只 emit EventBus 事件并加进第 5 节事件表（**记得同步更新本表**）。

### P14 换游戏（新建自己的场景替换沙盒）

```js
// game/MyGameScene.js —— 从 SandboxScene 复制骨架改
export class MyGameScene {
  static moduleName = 'mygame';
  constructor(engine) {
    this.engine = engine;
    this.scene = new THREE.Scene();     // 关卡私有场景（灯光/雾/网格挂这里）
    this._tmpV3 = new THREE.Vector3();
  }
  async init() {
    this.engine.setScene(this.scene);   // 激活渲染目标
    /* 搭环境 + use 引擎 API + 绑 HUD */
  }
  update(dt) { /* 零分配帧逻辑 */ }
  dispose() { /* 对称拆线 + 释放 GPU + this.scene.clear() */ }
}
```
`game/main.js` 把 `director.register('sandbox', SandboxScene)` / `loadScene('sandbox')` 换成 `director.register('mygame', MyGameScene)` / `loadScene('mygame')`。红线上移不变。

### P15 切换 CDN / 离线部署

- 只动 `index.html` importmap（注释里有 unpkg / jsdelivr / 本地 `/libs/` 三套整块替换）。
- 本地下载脚本：`libs/README.md`。注意 cannon-es 在 npmmirror 是 403，必须 unpkg/jsdelivr/本地。

---

## 9. 已知坑（AI 提建议时主动规避/提醒）

| # | 坑 | 后果 | 规避 |
| --- | --- | --- | --- |
| 1 | `file://` 双击打开 | 模块全挂、全黑 | 必须 HTTP 静态服务 |
| 2 | npmmirror 无 cannon-es（白名单 403） | 物理模块 import 失败 | 走 unpkg（已配） |
| 3 | howler 是 UMD | `import {Howl} from 'howler'` 无导出 | 已用动态 import + `globalThis.Howl` 兜底；新代码别静态 import |
| 4 | 浏览器自动播放策略 | 首次无声 | AudioManager.init 已挂首个手势 resume；新音频代码也从用户手势触发 |
| 5 | 手牌局部坐标 vs 拖拽世界坐标 | 牌飞到天边 | 一律 `worldToLocal`/`updateWorldMatrix`（照抄 `_registerCardTarget`/`_playCard`） |
| 6 | 直接 gsap 补间 `mesh.position`（手牌牌） | 被 `CardHandManager.update` 每帧覆写，动画无效 | 补间 `entry.anim` |
| 7 | 物理骰子滚出桌沿 | 无限下坠 | 已加地面刚体 y=-1.6（`_buildEnvironment`）；别删 |
| 8 | `getDragPoint()` 返回复用 Vector3 | 存起来会跨帧污染 | 要留存就 `.clone()`（仅在事件回调里允许） |
| 9 | 正交相机漏 `userData.frustumHeight` | resize 后视锥错乱 | 切换/新建正交相机时设置 |
| 10 | dt 大跳（切后台） | 物理爆冲/补间瞬移 | Core 已钳 0.1；自己写的计时逻辑也要防 |
| 11 | HUD 元素 `pointer-events: auto` 误盖画布 | 该区域拖不动牌 | 保持 HUD 整层 none，仅控件 auto |
| 12 | emit 内部修改订阅表 | 本轮行为不符合直觉 | 见 6.4 语义；循环外退订 |
| 13 | 拖拽阈值 4px 内的 move | 不触发 dragStart（属 click） | 模拟输入时先跨过阈值再大位移 |
| 14 | `body.quaternion.setFromEuler` 等 CANNON API 与 THREE 同名不同物 | 传错对象报错 | 看 PhysicsWorld `_toVec3/_toQuat` 的转换习惯 |
| 15 | gsap `overwrite:'auto'` 未加 | 新旧补间打架抖动 | 沿用现有补间写法 |
| 16 | persist 草稿优先于场景文件 | 改了 `sandbox.json` 却看不到变化 | 编辑器点「清除草稿」，或 `localStorage.removeItem('catwab.scene.sandbox')`；草稿在「保存草稿/导出JSON」时写入 |
| 17 | 编辑器移动带物理的物体没回写刚体 | 松手后被 bodyToMesh 拉回原位 | 变换后调 `physics.applyTransformFromMesh(mesh)`（SceneEditor._syncTransform 已做） |
| 18 | 编辑时没暂停物理/没禁拾取 | 骰子乱滚、点物体触发游戏交互 | SceneEditor.init 统一处理 `physics.paused` / `raycast.enabled`，别绕过 |
| 19 | 骨骼姿态当绝对值写 | 动作叠加错乱 | pose 是相对绑定偏移：rotation 相加、scale 相乘 |
| 20 | 点击骨骼纸片人打在脚底 | 拾取不中 | `skeleton.root` 原点在脚底，交互/测试投影取 `root.position.y + 1.5` 附近 |
| 21 | 场景 def 与内联 DEFAULT_SCENE 不同步 | 兜底场景和文件场景表现不一致 | 改 JSON 必须同步 `SandboxScene.js` 底部内联常量（不变量 18） |
| 22 | 场景物体原点约定破坏（如原点放桌角） | 编辑器平移与物理错位 | 原点 = 物理盒中心，工厂里几何居中、def.position 给中心点 |
| 23 | 骰子贴图槽序与 `DICE_FACES` 读点映射不一致 | 读出的点数和顶面花色对不上 | BoxGeometry 材质槽序 `[-X?]` 固定为 `[+X,-X,+Y,-Y,+Z,-Z]`，`_makeDice` 的贴图数组与 `DICE_FACES` 必须同一套映射 |
| 24 | 把游戏专有 Inspector/类型名写回 `engine/SceneEditor` | 引擎无法复用（v5 红线） | 类型控件一律 `registerType({inspector, applyProp})`；放置管线用 `acceptsAsset/createFromAsset` |
| 25 | loadScene 未加锁就并发调用 | 两场景交错 init、active 错乱 | 已有 `_loading` 锁；自定义调度器也要串行化 |

---

## 10. 调试手册（改完怎么验证）

```bash
cd CatWab && python3 -m http.server 8123    # 打开 http://127.0.0.1:8123/
```

浏览器控制台（`window.engine` 是引擎实例）：

```js
engine.eventBus.onAny((p, t) => console.log(t, p));        // 盯所有事件
engine.get('hand').cards.length                            // 手牌数
engine.get('physics').world.bodies.map(b => b.position)    // 刚体位置
engine.get('director').active._diceResult                  // 骰子点数（当前关卡实例）
engine.get('camera').mode                                  // 相机模式
```

**四条基准链路**（任何改动后回归）：

1. 悬停手牌 → 抬升 1.1 + 邻居挤开（0.55 / 0.28 衰减）
2. 拖手牌到桌面 → 出牌平躺 + toast；拖回 → 平滑归位
3. 点震屏 → 相机抖动衰减；正交/透视切换无跳变
4. 掷骰子 → 弹跳 → 休眠 → 自动读顶面点数（点数 = 朝上那面）

**编辑器链路**（改 SceneIO/SceneEditor/场景相关后回归，`?edit=1`）：

5. 大纲点击选中（BoxHelper + 操纵轴挂上）→ W/R/S 拖轴沿轴变换 → 变换三处同步（对象/def/刚体一致）
6. 属性面板实时生效（无"应用"按钮）：skeleton/billboard 改朝向/软阴影/影子大小；prop 改颜色/形状/尺寸（形状切换走工厂重建、连续键入不丢焦点）——**控件来自游戏层 registerType.inspector**
7. 资源栏点类型按钮放置（落在相机附近、带 defaultProps）；拖 .png/.jpg 进画布 → 经 `acceptsAsset/createFromAsset` 生成图片物体；Ctrl+D / Del / F 正常
8. 「保存草稿」→ 刷新仍在；「导出JSON」下载 **sandbox.json**（图片 src 为 dataURL）；「清除草稿」→ 刷新读 `assets/scenes/sandbox.json`
9. **切关往返**：控制台 `await engine.get('director').loadScene('mini')` 再 `loadScene('sandbox')` → 编辑器大纲/操纵轴仍可用、无报错；快速连打两次 loadScene → 第二次抛「已有场景正在装载」

**骨骼链路**（改 Skeleton2D/纸片人后回归）：

10. 待机呼吸（idle 程序化）→ 点击纸片人挥手（wave clip 一次性播完回 idle）→ "走路"按钮循环摆臂
11. 骨骼部件随 billboard 朝向相机、软影跟随

查看 console 有无 error/warn；FPS 显示在 HUD（`#stat-line`）。
改引擎后重点看：GC（Performance 面板内存曲线应平稳无锯齿）。

---

## 11. 给 AI 的提问模板（信息不足时这样反问）

AI 发现需求含糊时，**不要猜**，按下式反问（编号 + 默认假设），使用者可整体回答"按默认"：

```
在动手前确认 N 点（每题含默认值，回复"按默认"即全部采用）：
1. <问题>？默认：<方案 A>。
2. <问题>？默认：<方案 A>。
以下按默认直接做（有异议请指出）：
- <假设 1>、<假设 2>。
```

**使用者向 AI 提问时的高效格式**（把本文档附上后）：

```
【目标】我要 <做成什么>
【现状】涉及 <文件/功能>（不确定就写"你来定位"）
【要求】遵守 AIdocument 第 2 节红线；改动给可粘贴代码 + 插入位置（文件:行号）
【验证】按第 10 节四条链路回归，列出你要我手动确认的点
```

**AI 回答修改需求时的自检清单**：
- [ ] 违反第 2 节红线了吗？（尤其 update 内 new、engine 含业务数值）
- [ ] 改动定位到了文件 + 方法 + 行号吗？
- [ ] 坐标空间 / handDragging 旗标 / anim 补间通道走对了吗？
- [ ] dispose 里对称清理了吗？
- [ ] 事件表（第 5 节）需要同步更新吗？
- [ ] 事实拿不准时标注"未验证"了吗？
