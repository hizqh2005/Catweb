/**
 * 场景导演（SceneDirector）：注册 / 装载 / 切换游戏场景，驱动活动场景生命周期。
 * 引擎层不关心任何关卡内容（灯光、雾气、卡牌、玩法），只负责场景的生灭与帧转发。
 *
 * 场景类协议（游戏层实现，如 game/SandboxScene.js）：
 *   class XxxScene {
 *     constructor(engine, params) {
 *       this.scene = new THREE.Scene();   // 关卡私有三维场景（环境/灯光/网格全挂这里）
 *     }
 *     async init() {}                     // 可异步；内部调 engine.setScene(this.scene) 激活渲染目标
 *     update(dt, elapsed) {}              // 每帧，零分配
 *     dispose() {}                        // 切换/退出时调用；解绑监听、释放 GPU 资源
 *   }
 *
 * loadScene 切换流程：
 *   旧场景 dispose() + 清理旧 THREE.Scene → 实例化新场景 + engine.setScene()
 *   → await 新场景 init() → emit('scene:switched', { name, scene })
 */
export class SceneDirector {
  static moduleName = 'director';

  constructor(engine) {
    this.engine = engine;
    /** @type {Map<string, Function>} 场景名 → 场景类 */
    this._registry = new Map();
    /** 当前活动场景实例（含 .scene THREE.Scene 句柄） */
    this.active = null;
    this.activeName = null;
    this._ready = false;
    /** 装载并发锁：防止快速连续 loadScene 交错 */
    this._loading = false;
  }

  /** 注册场景类：name 全局唯一，SceneClass 需实现 init/update/dispose 协议 */
  register(name, SceneClass) {
    if (!name) throw new Error('[SceneDirector] 场景名不能为空');
    if (typeof SceneClass !== 'function') throw new Error(`[SceneDirector] 场景类无效: ${name}`);
    this._registry.set(name, SceneClass);
    return this;
  }

  has(name) {
    return this._registry.has(name);
  }

  /**
   * 装载并切换到目标场景（可运行时反复调用，旧场景会被完整卸载）。
   * 并发保护：装载中再次调用会抛错；init 失败会回滚（半成品 dispose、active 清空）。
   * @param {string} name register() 注册过的场景名
   * @param {object} params 透传给场景构造函数的参数
   */
  async loadScene(name, params = {}) {
    if (this._loading) throw new Error('[SceneDirector] 已有场景正在装载');
    const SceneClass = this._registry.get(name);
    if (!SceneClass) throw new Error(`[SceneDirector] 未注册的场景: ${name}`);

    this._loading = true;
    let scene = null;
    try {
      // 1. 卸载旧场景（先 dispose 让场景自行对称拆线，再清理 THREE.Scene 兜底，防资源泄漏）
      if (this.active) {
        const old = this.active;
        this.active = null;
        this.activeName = null;
        this._ready = false;
        if (typeof old.dispose === 'function') old.dispose();
        if (old.scene) clearSceneResources(old.scene);
      }

      // 2. 实例化新场景并切换渲染目标
      scene = new SceneClass(this.engine, params);
      this.active = scene;
      this.activeName = name;
      if (scene.scene) this.engine.setScene(scene.scene);

      // 3. 初始化（可异步装载资源 / 搭建环境）
      if (typeof scene.init === 'function') await scene.init();
      this._ready = true;

      // 4. 广播切换完成
      this.engine.eventBus.emit('scene:switched', { name, scene });
      return scene;
    } catch (err) {
      // 回滚：半成品场景 dispose + 兜底清扫，避免 active 残留
      this._ready = false;
      this.active = null;
      this.activeName = null;
      if (scene) {
        try {
          if (typeof scene.dispose === 'function') scene.dispose();
          if (scene.scene) clearSceneResources(scene.scene);
        } catch (cleanupErr) {
          console.error('[SceneDirector] 场景失败清理出错', cleanupErr);
        }
      }
      throw err;
    } finally {
      this._loading = false;
    }
  }

  update(dt, elapsed) {
    // 场景 init 未完成前不转发（运行时切景期间帧循环仍在跑）
    if (!this._ready) return;
    const scene = this.active;
    if (scene && typeof scene.update === 'function') scene.update(dt, elapsed);
  }

  dispose() {
    if (this.active) {
      const old = this.active;
      this.active = null;
      this.activeName = null;
      this._ready = false;
      if (typeof old.dispose === 'function') old.dispose();
      if (old.scene) clearSceneResources(old.scene);
    }
    this._registry.clear();
  }
}

/** 通用场景清理：释放子树几何/材质/贴图后整体摘除（场景类 dispose 未做净时的兜底） */
function clearSceneResources(threeScene) {
  threeScene.traverse((node) => {
    if (node.geometry) node.geometry.dispose();
    const mat = node.material;
    if (mat) {
      const mats = Array.isArray(mat) ? mat : [mat];
      for (let i = 0; i < mats.length; i++) {
        const m = mats[i];
        if (m.map) m.map.dispose();
        m.dispose();
      }
    }
  });
  threeScene.clear();
  threeScene.background = null;
  threeScene.fog = null;
}
