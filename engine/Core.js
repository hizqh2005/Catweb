import * as THREE from 'three';
import { EventBus } from './EventBus.js';

/**
 * 微内核：rAF 主循环 / Scene / Renderer 管理 / 模块注册 / 全局事件总线。
 *
 * 模块协议（engine 与 game 通用）：
 *   class Xxx {
 *     static moduleName = 'xxx';
 *     constructor(engine, options) {}
 *     init() {}                    // 可 async
 *     update(dt, elapsed) {}       // 每帧，按注册顺序调用
 *     dispose() {}
 *   }
 */
export class Core {
  constructor(options = {}) {
    this.canvas = options.canvas || document.createElement('canvas');
    this.container = options.container || this.canvas.parentElement || document.body;

    this.eventBus = new EventBus();
    this.scene = new THREE.Scene();

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: options.antialias !== false,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, options.pixelRatioMax || 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.camera = new THREE.PerspectiveCamera(
      options.fov || 42,
      1,
      options.near || 0.1,
      options.far || 300,
    );

    this.time = { delta: 0, elapsed: 0 };

    this._modules = [];
    this._moduleMap = new Map();
    this._running = false;
    this._started = false;
    this._rafId = 0;
    this._lastTime = 0;
    this._boundLoop = this._loop.bind(this);
    this._boundResize = this._resize.bind(this);

    window.addEventListener('resize', this._boundResize);
    window.addEventListener('orientationchange', this._boundResize);
    this._resize();
  }

  use(ModuleClass, options = {}) {
    const name = ModuleClass.moduleName || ModuleClass.name;
    if (!name) throw new Error('[Core] 模块必须提供 static moduleName 或类名');
    if (this._moduleMap.has(name)) throw new Error(`[Core] 模块重复注册: ${name}`);

    const instance = new ModuleClass(this, options);
    this._modules.push(instance);
    this._moduleMap.set(name, instance);
    return instance;
  }

  get(name) {
    return this._moduleMap.get(name) || null;
  }

  async start() {
    if (this._started) return;
    this._started = true;

    for (const mod of this._modules) {
      if (typeof mod.init === 'function') await mod.init();
    }

    this._resize();
    this._running = true;
    this._lastTime = performance.now();
    this._rafId = requestAnimationFrame(this._boundLoop);
    this.eventBus.emit('core:start');
  }

  stop() {
    this._running = false;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = 0;
    this.eventBus.emit('core:stop');
  }

  setCamera(camera) {
    this.camera = camera;
    this._resize();
    this.eventBus.emit('core:camera', camera);
  }

  /** 切换当前渲染目标场景（关卡/SceneDirector 动态换景用；_loop 只渲染 this.scene） */
  setScene(threeScene) {
    if (!threeScene) return;
    this.scene = threeScene;
  }

  dispose() {
    this.stop();
    window.removeEventListener('resize', this._boundResize);
    window.removeEventListener('orientationchange', this._boundResize);

    for (let i = this._modules.length - 1; i >= 0; i--) {
      const mod = this._modules[i];
      if (typeof mod.dispose === 'function') mod.dispose();
    }
    this._modules.length = 0;
    this._moduleMap.clear();
    this.eventBus.clear();
    this.renderer.dispose();
  }

  _loop(now) {
    if (!this._running) return;
    this._rafId = requestAnimationFrame(this._boundLoop);

    // 大 dt（切后台回来）钳制，防止物理与补间跳跃
    const raw = (now - this._lastTime) / 1000;
    this._lastTime = now;
    const dt = raw > 0.1 ? 0.1 : raw;

    this.time.delta = dt;
    this.time.elapsed += dt;

    for (let i = 0; i < this._modules.length; i++) {
      const mod = this._modules[i];
      if (typeof mod.update === 'function') mod.update(dt, this.time.elapsed);
    }

    this.renderer.render(this.scene, this.camera);
    this.eventBus.emit('core:frame', this.time);
  }

  _resize() {
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;

    this.renderer.setSize(width, height, true);

    const aspect = width / Math.max(height, 1);
    if (this.camera.isPerspectiveCamera) {
      this.camera.aspect = aspect;
    } else if (this.camera.isOrthographicCamera) {
      const frustum = this.camera.userData.frustumHeight || 10;
      this.camera.top = frustum / 2;
      this.camera.bottom = -frustum / 2;
      this.camera.left = (-frustum / 2) * aspect;
      this.camera.right = (frustum / 2) * aspect;
    }
    this.camera.updateProjectionMatrix();
    this.eventBus.emit('core:resize', { width, height, aspect });
  }
}
