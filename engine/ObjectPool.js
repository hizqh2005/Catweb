/**
 * 对象池：弹幕粒子 / 子弹 Mesh / 战斗特效的复用，杜绝高频 new/dispose 导致 GC 顿卡。
 *
 * 模块协议：这是**工具类**（非 Core 模块），由游戏层直接 import 使用。
 * 红线：get/recycle 热路径不 new；clear 可注入 disposeFn 批量释放。
 *
 * 用法：
 *   const pool = new ObjectPool(
 *     () => new THREE.Mesh(geo, mat),   // createFn：仅在池空时调用
 *     (obj) => { obj.visible = true; obj.position.set(0,0,0); }, // resetFn
 *     20,                               // initialSize 预开辟
 *   );
 *   const bullet = pool.get();      // 优先复用，空则 createFn
 *   // ... 使用 ...
 *   pool.recycle(bullet);           // 隐藏并归还，不销毁 geometry/material
 *   pool.clear((obj) => obj.geometry.dispose()); // 场景销毁时批量释放
 *
 * 约定：
 *   - 实体需有 `visible` 属性（THREE.Object3D 天然具备）；否则由 resetFn 自行处理。
 *   - recycle 不调用任何销毁方法；几何/材质生命周期由调用方在 clear(disposeFn) 时决定。
 */
export class ObjectPool {
  /**
   * @param {function(): any} createFn 创建新实体
   * @param {function(any): void} [resetFn] 取出时重置（默认 visible=true）
   * @param {number} [initialSize=20] 预开辟数量
   */
  constructor(createFn, resetFn, initialSize = 20) {
    if (typeof createFn !== 'function') {
      throw new Error('[ObjectPool] createFn 必须是函数');
    }
    this._createFn = createFn;
    this._resetFn = typeof resetFn === 'function' ? resetFn : defaultReset;
    /** @type {Array<any>} 闲置栈 */
    this._free = [];
    /** 当前借出数量（调试/泄漏排查） */
    this.activeCount = 0;
    /** 历史上累计创建数量（调试） */
    this.createdCount = 0;

    const n = initialSize > 0 ? initialSize : 0;
    for (let i = 0; i < n; i++) {
      this._free.push(this._createFn());
      this.createdCount++;
    }
  }

  /**
   * 取出实体：优先闲置栈（执行 resetFn），空则 createFn。
   * 热路径零分配。
   */
  get() {
    let item;
    if (this._free.length) {
      item = this._free.pop();
    } else {
      item = this._createFn();
      this.createdCount++;
    }
    this.activeCount++;
    this._resetFn(item);
    return item;
  }

  /**
   * 归还实体：隐藏并推回闲置栈。
   * 不调用 geometry/material dispose。重复归还同一对象会跳过（静默）。
   */
  recycle(item) {
    if (!item) return;
    // 防重复归还：栈内线性扫描在池很小（<千级）可接受；大池可换 Set
    for (let i = 0; i < this._free.length; i++) {
      if (this._free[i] === item) return;
    }
    if (typeof item.visible === 'boolean') item.visible = false;
    this._free.push(item);
    if (this.activeCount > 0) this.activeCount--;
  }

  /**
   * 批量归还当前所有闲置 + 可选 disposeFn 清理全部已创建实体。
   * 场景销毁时调用。disposeFn(item) 负责 geometry/material 释放。
   */
  clear(disposeFn) {
    if (typeof disposeFn === 'function') {
      for (let i = 0; i < this._free.length; i++) {
        disposeFn(this._free[i]);
      }
    }
    this._free.length = 0;
    this.activeCount = 0;
  }

  /** 闲置数量（调试） */
  get freeCount() {
    return this._free.length;
  }

  /** 池总规模 = 闲置 + 借出 */
  get totalCount() {
    return this._free.length + this.activeCount;
  }
}

function defaultReset(item) {
  if (item && typeof item.visible === 'boolean') item.visible = true;
}
