import * as THREE from 'three';

/**
 * 场景序列化（Scene JSON）：
 * 场景 = { name, version, objects: [def] }，def 结构：
 *   {
 *     id: 'table1',                 // 场景内唯一
 *     type: 'table',                // 工厂类型（游戏层 registerType 注册）
 *     position: {x,y,z},            // 世界坐标
 *     rotation: {x,y,z},            // 欧拉角（弧度）
 *     scale: {x,y,z},
 *     props: {...}                  // 类型私有参数，工厂自由解释
 *   }
 * 引擎只认识"类型 + 变换 + props"，如何实例化每种 type 由游戏层工厂决定（分层解耦）。
 * 编辑器与运行时共用本模块：编辑器改 transform → serialize() 出 JSON；游戏 load() 读 JSON。
 */
export class SceneIO {
  static moduleName = 'sceneio';

  constructor(engine) {
    this.engine = engine;
    /** @type {Map<string, (def: object) => THREE.Object3D>} */
    this._types = new Map();
    /** @type {Array<{def: object, object: THREE.Object3D, type: string}>} */
    this.entries = [];
    this._seq = 0;
    this._tempVec = new THREE.Vector3();
    this._tempEuler = new THREE.Euler();
  }

  /**
   * 游戏层注册物体工厂：factory(def) -> Object3D（可选 def.props 解释私有参数）。
   *
   * options 元数据（编辑器/工具只认这些字段，不认具体游戏名词）：
   *   label          显示名
   *   icon           短图标字符
   *   defaultProps   放置时合并进 def.props 的默认值；或 (placeIndex) => ({})
   *   placeY         放置默认高度
   *   inspector      (box, entry, editor) => void 动态属性面板控件
   *   acceptsAsset   (asset) => bool  该资源能否落成此类型
   *   createFromAsset (asset, def) => def  把资源信息写入 def.props
   */
  registerType(type, factory, options = {}) {
    this._types.set(type, {
      factory,
      label: options.label || type,
      icon: options.icon || '▪',
      defaultProps: options.defaultProps ?? null,
      placeY: options.placeY ?? 0,
      inspector: options.inspector || null,
      acceptsAsset: options.acceptsAsset || null,
      createFromAsset: options.createFromAsset || null,
    });
  }

  listTypes() {
    const out = [];
    for (const [type, info] of this._types) {
      out.push({
        type,
        label: info.label,
        icon: info.icon,
        defaultProps: info.defaultProps,
        placeY: info.placeY,
      });
    }
    return out;
  }

  /** 取完整类型元数据（含 factory/inspector 等），未注册返回 null */
  getType(type) {
    return this._types.get(type) || null;
  }

  hasType(type) {
    return this._types.has(type);
  }

  /** 放置用：合并 defaultProps，返回新 def（不实例化） */
  makeDef(type, overrides = {}, placeIndex = 0) {
    const info = this._types.get(type);
    let defaults = {};
    if (info && info.defaultProps) {
      defaults = typeof info.defaultProps === 'function'
        ? info.defaultProps(placeIndex) || {}
        : info.defaultProps;
    }
    return {
      type,
      position: { x: 0, y: (info && info.placeY) || 0, z: 0, ...(overrides.position || {}) },
      rotation: { x: 0, y: 0, z: 0, ...(overrides.rotation || {}) },
      scale: { x: 1, y: 1, z: 1, ...(overrides.scale || {}) },
      props: { ...defaults, ...(overrides.props || {}) },
      ...(overrides.id ? { id: overrides.id } : {}),
    };
  }

  /** 按 def 实例化并挂进场景，返回 entry */
  createObject(def) {
    const info = this._types.get(def.type);
    if (!info) {
      console.warn(`[SceneIO] 未注册的物体类型: ${def.type}`);
      return null;
    }

    const object = info.factory(def);
    if (!object) return null;

    const norm = SceneIO.normalizeDef(def, ++this._seq);
    SceneIO.applyTransform(object, norm);

    object.userData.sceneObject = true;
    object.userData.sceneId = norm.id;
    object.userData.sceneDef = norm;

    this.engine.scene.add(object);
    const entry = { def: norm, object, type: norm.type };
    this.entries.push(entry);
    return entry;
  }

  removeObject(objectOrId) {
    const entry = this.getEntry(objectOrId);
    if (!entry) return;
    const idx = this.entries.indexOf(entry);
    if (idx >= 0) this.entries.splice(idx, 1);
    this.engine.scene.remove(entry.object);
    if (typeof entry.object.dispose === 'function') entry.object.dispose();
    entry.object.traverse((node) => {
      if (node.geometry) node.geometry.dispose();
      if (node.material && node.material.dispose && !Array.isArray(node.material)) {
        node.material.dispose();
      }
    });
  }

  getEntry(objectOrId) {
    if (!objectOrId) return null;
    if (typeof objectOrId === 'string') {
      return this.entries.find((e) => e.def.id === objectOrId) || null;
    }
    let node = objectOrId;
    while (node) {
      if (node.userData && node.userData.sceneId) {
        return this.entries.find((e) => e.def.id === node.userData.sceneId) || null;
      }
      node = node.parent;
    }
    return null;
  }

  /** 载入场景定义（清空现有 sceneObject 后重建） */
  load(sceneDef) {
    this.clear();
    const objects = (sceneDef && sceneDef.objects) || [];
    const created = [];
    for (let i = 0; i < objects.length; i++) {
      const entry = this.createObject(objects[i]);
      if (entry) created.push(entry);
    }
    this.engine.eventBus.emit('scene:loaded', { name: sceneDef && sceneDef.name, count: created.length });
    return created;
  }

  clear() {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      this.engine.scene.remove(entry.object);
      entry.object.traverse((node) => {
        if (node.geometry) node.geometry.dispose();
      });
    }
    this.entries.length = 0;
  }

  /** 从当前对象实时变换导出场景 JSON */
  serialize(name = 'scene') {
    const objects = [];
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      SceneIO.writeTransformToDef(entry.object, entry.def);
      objects.push(entry.def);
    }
    return { name, version: 1, objects };
  }

  /** 对象 → def 变换回写 */
  static writeTransformToDef(object, def) {
    def.position = def.position || {};
    def.rotation = def.rotation || {};
    def.scale = def.scale || {};
    def.position.x = object.position.x;
    def.position.y = object.position.y;
    def.position.z = object.position.z;
    def.rotation.x = object.rotation.x;
    def.rotation.y = object.rotation.y;
    def.rotation.z = object.rotation.z;
    def.scale.x = object.scale.x;
    def.scale.y = object.scale.y;
    def.scale.z = object.scale.z;
    return def;
  }

  /** def → 对象变换应用 */
  static applyTransform(object, def) {
    const p = def.position || {};
    const r = def.rotation || {};
    const s = def.scale || {};
    object.position.set(p.x || 0, p.y || 0, p.z || 0);
    object.rotation.set(r.x || 0, r.y || 0, r.z || 0);
    const sx = s.x !== undefined ? s.x : (s !== undefined && typeof s === 'number' ? s : 1);
    object.scale.set(
      typeof s === 'number' ? s : (s.x !== undefined ? s.x : 1),
      typeof s === 'number' ? s : (s.y !== undefined ? s.y : 1),
      typeof s === 'number' ? s : (s.z !== undefined ? s.z : 1),
    );
    void sx;
    return object;
  }

  /** 规范化 def：补 id/变换字段 */
  static normalizeDef(def, seq) {
    return {
      id: def.id || `${def.type}_${seq}`,
      type: def.type,
      position: { x: 0, y: 0, z: 0, ...(def.position || {}) },
      rotation: { x: 0, y: 0, z: 0, ...(def.rotation || {}) },
      scale: {
        x: (def.scale && (typeof def.scale === 'number' ? def.scale : def.scale.x)) ?? 1,
        y: (def.scale && (typeof def.scale === 'number' ? def.scale : def.scale.y)) ?? 1,
        z: (def.scale && (typeof def.scale === 'number' ? def.scale : def.scale.z)) ?? 1,
      },
      props: def.props ? { ...def.props } : {},
    };
  }

  dispose() {
    this.clear();
    this._types.clear();
  }
}
