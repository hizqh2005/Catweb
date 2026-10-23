import * as THREE from 'three';

/**
 * 轻量 2D/3D 相交与战斗判定：AABB / 圆形距离平方 / 点入区域。
 * 模块协议：static moduleName = 'collision'；init / update(dt) / dispose。
 *
 * 红线（GC 铁律）：模块作用域预分配 `_tmpBoxA/_tmpBoxB/_tmpV3`，相交测试与 update 循环严禁 new。
 * 引擎只提供数学盒接口，不含卡牌/角色业务规则（group 语义由游戏层解释）。
 *
 * 碰撞体 def：
 *   {
 *     id: string,
 *     type: 'box' | 'circle' | 'zone',
 *     group: string,            // 同 group 跳过判定
 *     targetMesh?: THREE.Object3D,  // 有则每帧同步世界坐标到 center
 *     size?: { x, y, z },       // box 半尺寸（全尺寸的一半；若给 fullSize 则自动折半）
 *     radius?: number,          // circle
 *     center?: { x, y, z },     // 无 targetMesh 时的静态中心
 *     enabled?: boolean,
 *     onTrigger?: (other, self) => void,
 *   }
 *
 * 事件：collision:trigger { a, b, ax, az, bx, bz }
 */
const _tmpBoxA = new THREE.Box3();
const _tmpBoxB = new THREE.Box3();
const _tmpV3 = new THREE.Vector3();

export class Collision2D {
  static moduleName = 'collision';

  constructor(engine) {
    this.engine = engine;

    /** @type {Map<string, object>} id → collider runtime */
    this._items = new Map();

    /** 本帧启用碰撞体列表（预分配，update 复用） */
    this._list = [];

    // 本帧触发对计数（调试）
    this._triggerCount = 0;
  }

  init() {
    // 无 DOM 监听；纯数据结构
  }

  /**
   * 注册碰撞体。def 见文件头注释。
   * 返回 runtime 引用（含 center 可变字段），供游戏层原地改坐标。
   */
  register(id, def = {}) {
    if (!id) {
      console.warn('[Collision2D] register 需要 id');
      return null;
    }
    const type = def.type || 'box';
    const size = def.size || { x: 0.5, y: 0.5, z: 0.5 };
    const item = {
      id,
      type,
      group: def.group || 'default',
      targetMesh: def.targetMesh || null,
      // 半尺寸语义：存储为 half extents
      half: {
        x: size.x !== undefined ? size.x : 0.5,
        y: size.y !== undefined ? size.y : 0.5,
        z: size.z !== undefined ? size.z : 0.5,
      },
      radius: def.radius ?? 0.5,
      // 中心（世界坐标）；targetMesh 存在时每帧同步
      cx: (def.center && def.center.x) || 0,
      cy: (def.center && def.center.y) || 0,
      cz: (def.center && def.center.z) || 0,
      enabled: def.enabled !== false,
      onTrigger: def.onTrigger || null,
    };
    if (def.targetMesh) this._syncCenter(item);
    this._items.set(id, item);
    return item;
  }

  unregister(id) {
    return this._items.delete(id);
  }

  get(id) {
    return this._items.get(id) || null;
  }

  setEnabled(id, enabled) {
    const item = this._items.get(id);
    if (item) item.enabled = !!enabled;
  }

  /** 无 targetMesh 时手动改中心 */
  setCenter(id, x, y, z) {
    const item = this._items.get(id);
    if (!item) return;
    item.cx = x;
    item.cy = y;
    item.cz = z;
  }

  /** 同步 targetMesh 世界坐标到碰撞体中心（update 自动调用） */
  _syncCenter(item) {
    const mesh = item.targetMesh;
    if (!mesh) return;
    if (mesh.matrixWorldNeedsUpdate !== undefined) mesh.updateWorldMatrix(true, false);
    _tmpV3.setFromMatrixPosition(mesh.matrixWorld);
    item.cx = _tmpV3.x;
    item.cy = _tmpV3.y;
    item.cz = _tmpV3.z;
  }

  /** Box3 相交（AABB）。结果写入模块级 _tmpBoxA/_tmpBoxB 后比较 */
  static boxesOverlap(a, b) {
    Collision2D._setBox(_tmpBoxA, a);
    Collision2D._setBox(_tmpBoxB, b);
    return _tmpBoxA.intersectsBox(_tmpBoxB);
  }

  static _setBox(box, item) {
    box.min.x = item.cx - item.half.x;
    box.min.y = item.cy - item.half.y;
    box.min.z = item.cz - item.half.z;
    box.max.x = item.cx + item.half.x;
    box.max.y = item.cy + item.half.y;
    box.max.z = item.cz + item.half.z;
    return box;
  }

  /** 圆/球：距离平方 <= (r1+r2)^2，无开方 */
  static circlesOverlap(a, b) {
    const dx = a.cx - b.cx;
    const dy = a.cy - b.cy;
    const dz = a.cz - b.cz;
    const r = a.radius + b.radius;
    // 3D 距离平方（2D 场景可把 cy 视为同高）
    return dx * dx + dy * dy + dz * dz <= r * r;
  }

  /**
   * 点是否落入指定 zone（box 型碰撞体）。
   * point 可以是 {x,y,z} 或 THREE.Vector3。
   */
  testPointInZone(point, zoneId) {
    const zone = this._items.get(zoneId);
    if (!zone) return false;
    const px = point.x;
    const py = point.y !== undefined ? point.y : 0;
    const pz = point.z;
    return (
      px >= zone.cx - zone.half.x && px <= zone.cx + zone.half.x &&
      py >= zone.cy - zone.half.y && py <= zone.cy + zone.half.y &&
      pz >= zone.cz - zone.half.z && pz <= zone.cz + zone.half.z
    );
  }

  /** box vs circle：最近点距离平方与半径比较 */
  static boxCircleOverlap(boxItem, circleItem) {
    Collision2D._setBox(_tmpBoxA, boxItem);
    const cx = circleItem.cx;
    const cy = circleItem.cy;
    const cz = circleItem.cz;
    // 夹到盒内最近点
    const nx = cx < _tmpBoxA.min.x ? _tmpBoxA.min.x : (cx > _tmpBoxA.max.x ? _tmpBoxA.max.x : cx);
    const ny = cy < _tmpBoxA.min.y ? _tmpBoxA.min.y : (cy > _tmpBoxA.max.y ? _tmpBoxA.max.y : cy);
    const nz = cz < _tmpBoxA.min.z ? _tmpBoxA.min.z : (cz > _tmpBoxA.max.z ? _tmpBoxA.max.z : cz);
    const dx = cx - nx;
    const dy = cy - ny;
    const dz = cz - nz;
    const r = circleItem.radius;
    return dx * dx + dy * dy + dz * dz <= r * r;
  }

  /** 两碰撞体是否重叠（按 type 自动分派） */
  static overlaps(a, b) {
    const ta = a.type === 'zone' ? 'box' : a.type;
    const tb = b.type === 'zone' ? 'box' : b.type;
    if (ta === 'circle' && tb === 'circle') return Collision2D.circlesOverlap(a, b);
    if (ta === 'box' && tb === 'box') return Collision2D.boxesOverlap(a, b);
    if (ta === 'box' && tb === 'circle') return Collision2D.boxCircleOverlap(a, b);
    if (ta === 'circle' && tb === 'box') return Collision2D.boxCircleOverlap(b, a);
    return false;
  }

  /**
   * 帧循环解算：同步 targetMesh、两两判定（跳过同 group 与禁用）、触发回调与广播。
   * 复杂度 O(n^2)；n 小（战斗体 < 数百）时可接受。高频弹幕请用 circle + 控制注册数量。
   */
  update() {
    this._triggerCount = 0;

    // 先同步所有 targetMesh 世界坐标（一遍，零分配）
    for (const item of this._items.values()) {
      if (item.targetMesh && item.enabled) this._syncCenter(item);
    }

    // 两两判定（跳过同 group 与禁用）；列表预分配复用
    const list = this._list;
    list.length = 0;
    for (const item of this._items.values()) {
      if (item.enabled) list.push(item);
    }

    const n = list.length;
    for (let i = 0; i < n; i++) {
      const a = list[i];
      for (let j = i + 1; j < n; j++) {
        const b = list[j];
        if (a.group === b.group) continue;
        if (!Collision2D.overlaps(a, b)) continue;

        this._triggerCount++;
        if (a.onTrigger) a.onTrigger(b, a);
        if (b.onTrigger) b.onTrigger(a, b);
        this.engine.eventBus.emit('collision:trigger', {
          a, b,
          ax: a.cx, az: a.cz,
          bx: b.cx, bz: b.cz,
        });
      }
    }
  }

  /** 本帧触发对数（调试） */
  get triggerCount() {
    return this._triggerCount;
  }

  /** 清除全部（不调用业务 dispose） */
  clear() {
    this._items.clear();
    this._triggerCount = 0;
    if (this._list) this._list.length = 0;
  }

  dispose() {
    this.clear();
  }
}
