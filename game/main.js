import { Core } from '../engine/Core.js';
import { AssetLoader } from '../engine/AssetLoader.js';
import { AudioManager } from '../engine/AudioManager.js';
import { InputManager } from '../engine/InputManager.js';
import { Collision2D } from '../engine/Collision2D.js';
import { CameraController } from '../engine/CameraController.js';
import { RaycastManager } from '../engine/RaycastManager.js';
import { PhysicsWorld } from '../engine/PhysicsWorld.js';
import { Skeleton2DManager } from '../engine/Skeleton2D.js';
import { CardHandManager } from '../engine/CardHandManager.js';
import { BillboardUnitManager } from '../engine/BillboardUnitManager.js';
import { SceneIO } from '../engine/SceneIO.js';
import { ScenePersistence } from '../engine/ScenePersistence.js';
import { AssetCatalog } from '../engine/AssetCatalog.js';
import { SceneDirector } from '../engine/SceneDirector.js';
import { SceneEditor } from '../engine/SceneEditor.js';
import { SandboxScene } from './SandboxScene.js';
import { MiniScene } from './MiniScene.js';

/**
 * 游戏启动入口：只做模块装配，玩法细节全部在 SandboxScene 里。
 * 注册顺序 = init/update 调用顺序：
 *   AssetLoader → AudioManager → Input → Camera → Physics → Raycast → Collision2D
 *   → Skeletons → Hand → Billboard → SceneIO → Persist → Catalog → Director →（Editor）
 * 关卡由 SceneDirector 调度装载（director.register / director.loadScene），换游戏 = 注册别的场景类。
 * URL `?edit=1` 启用内嵌场景编辑器（摆资产、导出 JSON）。
 */
async function boot() {
  const canvas = document.getElementById('game-canvas');
  const app = document.getElementById('app');
  const statLine = document.getElementById('stat-line');
  const editMode = new URLSearchParams(location.search).get('edit') === '1';

  const engine = new Core({ canvas, container: app });

  engine.use(AssetLoader);
  engine.use(AudioManager);
  engine.use(InputManager, { deadzone: 0.15 });
  engine.use(CameraController, {
    distance: 21,
    polar: Math.PI * 0.30,
    azimuth: Math.PI * 0.16,
    target: { x: 0, y: 1, z: 1.5 },
  });
  engine.use(PhysicsWorld);
  engine.use(RaycastManager);
  engine.use(Collision2D);
  engine.use(Skeleton2DManager);
  engine.use(CardHandManager, {
    radius: 9,
    maxArc: Math.PI * 0.26,
    hoverLift: 1.1,
    hoverScale: 1.12,
  });
  engine.use(BillboardUnitManager, { groundY: 0.03 });
  engine.use(SceneIO);
  engine.use(ScenePersistence, { keyPrefix: 'catwab.scene.' });
  engine.use(AssetCatalog);

  // 场景导演：关卡注册/装载/切换收敛在这里（场景自带 THREE.Scene 与灯光环境）
  const director = engine.use(SceneDirector);
  director.register('sandbox', SandboxScene);
  director.register('mini', MiniScene); // 引擎复用冒烟场景：loadScene('mini'|'sandbox') 往返
  if (editMode) {
    engine.use(SceneEditor, {
      grid: 0.5,
      sceneName: 'sandbox',
      exportName: 'sandbox',
      hudSelector: '#hud',
    });
  }

  window.engine = engine; // 沙盒调试句柄

  try {
    // 调度首关：场景先装载、后 engine.start()，保证排在后面的 SceneEditor.init（?edit=1）能看到关卡物体
    await director.loadScene('sandbox');
    await engine.start();
  } catch (err) {
    console.error('[boot] 引擎启动失败', err);
    if (statLine) statLine.textContent = `启动失败: ${err.message}`;
    return;
  }

  engine.eventBus.on('sandbox:stat', (text) => {
    if (statLine) statLine.textContent = text;
  });
}

boot();
