# /assets —— 游戏资源目录

当前沙盒**零外部资源开箱即玩**：牌面 / 角色纸片 / 骰子点数贴图由 Canvas 程序化生成，
音效与 BGM 由 Web Audio 实时合成（见 `game/SandboxScene.js` 与 `engine/AudioManager.js`）。
放入真实资源后，按下面的命名约定即可无缝替换。

## 目录约定

```text
/assets
├── scenes/           # 场景 JSON（?edit=1 编辑器导出物，运行时按它建场景）
│   └── sandbox.json        示例：牌桌/纸片人/骰子/道具的摆放
├── rigs/             # 骨骼 JSON（2D 分件骨骼数据）
│   └── hero.json           示例：7 骨骼 6 部件 + wave/nod 关键帧
├── textures/          # 贴图
│   ├── table_felt.png        牌桌桌面
│   ├── card_back.png         牌背
│   ├── card_00.png …         牌面（按 id 命名）
│   ├── char_hero.png         2.5D 纸片人
│   └── shadow_blob.png       圆形软阴影
├── audio/
│   ├── bgm_main.ogg          BGM（支持多格式回退 .mp3/.wav）
│   ├── sfx_draw.ogg          抽牌
│   ├── sfx_click.ogg         点击
│   ├── sfx_whoosh.ogg        挥动/震屏
│   └── sfx_dice_hit.ogg      骰子碰撞
└── data/
    └── cards.json            卡牌数值配置（示例见下）
```

## 加载方式

在 `game/SandboxScene.js`（或任意游戏层代码）里通过 `AssetLoader` 统一预加载：

```js
await engine.get('assets').load([
  { name: 'card_00', type: 'texture', url: './assets/textures/card_00.png' },
  { name: 'cards',   type: 'json',    url: './assets/data/cards.json' },
  { name: 'bgm',     type: 'audio',   url: './assets/audio/bgm_main.ogg' },
]);
const tex = engine.get('assets').get('card_00'); // THREE.Texture
```

加载进度会通过全局 EventBus 广播 `assets:progress` / `assets:done`。

## cards.json 示例

```json
{
  "cards": [
    { "id": 0, "name": "火球", "cost": 3 },
    { "id": 1, "name": "护盾", "cost": 1 }
  ]
}
```

## 替换原则

- 引擎层（`/engine`）**不硬编码任何资源路径**，路径只出现在游戏层。
- 程序化贴图是兜底方案：真实资源加载失败时自动回退，保证永不开天窗。
