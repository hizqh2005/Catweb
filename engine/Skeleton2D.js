import * as THREE from 'three';

/**
 * 2D 分件骨骼系统（Skeleton2D）——贴图块挂骨骼树 + 姿态插值/程序化动画。
 *
 * 数据格式（/assets/rigs/*.json）：
 * {
 *   name: 'hero',
 *   bones: [ { name:'root', parent:null, x:0, y:0, rotation:0, scale:1 }, ... ],
 *   parts: [ { bone:'head', texture:'part_head', x:0, y:0.4, rotation:0, scale:1,
 *              width:1.1, height:1.1, z:0 }, ... ],
 *   clips: { wave: { duration:1.2, loop:false,
 *            keys:[ { time:0, pose:{ armR:{ rotation:0 } } }, ... ] } }
 * }
 *
 * 姿态（pose）语义：相对绑定姿态的偏移——
 *   position = bone.{x,y} + pose.{x,y}；rotation = bone.rotation + pose.rotation；
 *   scale = bone.scale * pose.scale。缺省字段视为中性（0 / 1）。
 *
 * 动画两条路：
 *   1) 关键帧 clip：play('wave')，线性插值，支持 loop/一次性 + 回调；
 *   2) 程序化驱动：startProcedural('idle'|'walk'|fn)，每帧由函数直接写姿态（呼吸/走路摆臂）。
 *
 * 外部格式扩展点（Spine/DragonBones 导入器预留）：
 *   Skeleton2D.registerImporter('spine', (data) => 转成本格式 rigData);
 *   Skeleton2D.fromFormat('spine', json, resolveTexture)。
 *
 * v1 不做蒙皮变形（mesh 顶点权重）——纯分件挂接，满足 2.5D 纸片人换装/动作需求。
 * GC 铁律：全部姿态对象构造期预分配，update() 零分配。
 */
export class Skeleton2D {
  static importers = new Map();

  static registerImporter(name, fn) {
    Skeleton2D.importers.set(name, fn);
  }

  static fromFormat(name, data, resolveTexture, options) {
    const importer = Skeleton2D.importers.get(name);
    if (!importer) throw new Error(`[Skeleton2D] 未注册的导入格式: ${name}`);
    return new Skeleton2D(importer(data), resolveTexture, options);
  }

  constructor(rigData, resolveTexture, options = {}) {
    this.rigData = rigData;
    this.root = new THREE.Group();
    this.name = rigData.name || 'rig';

    /** @type {Map<string, {group: THREE.Group, base: object, pose: object}>} */
    this.bones = new Map();
    /** 与 bones 同序的数组 + 姿态映射表：update 热路径复用，零分配 */
    this._boneList = [];
    this._poseMap = {};
    /** @type {Array<{mesh: THREE.Mesh, boneName: string}>} */
    this.parts = [];
    this.clips = new Map();

    this._resolveTexture = resolveTexture;
    this._time = 0;
    this._clip = null;   // { name, def, time, speed, onComplete }
    this._driver = null; // (time, poseMap) => void

    this._buildBones(rigData.bones || []);
    this._buildParts(rigData.parts || []);
    this._buildClips(rigData.clips || {});

    this.root.userData.skeleton = this;
    void options;
  }

  _buildBones(boneDefs) {
    for (let i = 0; i < boneDefs.length; i++) {
      const def = boneDefs[i];
      const group = new THREE.Group();
      group.name = `bone_${def.name}`;
      group.position.set(def.x || 0, def.y || 0, 0);
      group.rotation.z = def.rotation || 0;
      const s = def.scale ?? 1;
      group.scale.setScalar(s);

      const parent = def.parent ? this.bones.get(def.parent) : null;
      (parent ? parent.group : this.root).add(group);

      const record = {
        name: def.name,
        group,
        base: { x: def.x || 0, y: def.y || 0, rotation: def.rotation || 0, scale: s },
        pose: { x: 0, y: 0, rotation: 0, scale: 1 },
      };
      this.bones.set(def.name, record);
      this._boneList.push(record);
      this._poseMap[def.name] = record.pose;
    }
  }

  _buildParts(partDefs) {
    for (let i = 0; i < partDefs.length; i++) {
      const def = partDefs[i];
      const bone = this.bones.get(def.bone);
      if (!bone) {
        console.warn(`[Skeleton2D] 部件挂在不存在的骨骼上: ${def.bone}`);
        continue;
      }
      const texture = this._resolveTexture ? this._resolveTexture(def.texture, def) : null;
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(def.width || 1, def.height || 1),
        new THREE.MeshBasicMaterial({
          map: texture || null,
          color: texture ? 0xffffff : 0x8899bb,
          transparent: true,
          alphaTest: 0.02,
          side: THREE.DoubleSide,
        }),
      );
      mesh.position.set(def.x || 0, def.y || 0, def.z ?? i * 0.01);
      mesh.rotation.z = def.rotation || 0;
      mesh.scale.setScalar(def.scale ?? 1);
      bone.group.add(mesh);
      this.parts.push({ mesh, boneName: def.bone });
    }
  }

  _buildClips(clipDefs) {
    for (const name of Object.keys(clipDefs)) {
      const def = clipDefs[name];
      this.clips.set(name, {
        name,
        duration: def.duration || 1,
        loop: def.loop !== false,
        keys: (def.keys || []).slice().sort((a, b) => a.time - b.time),
      });
    }
  }

  /** 播放关键帧 clip；一次性 clip 播完回调 onComplete */
  play(clipName, options = {}) {
    const def = this.clips.get(clipName);
    if (!def) {
      console.warn(`[Skeleton2D] 未定义的 clip: ${clipName}`);
      return false;
    }
    this._clip = {
      name: clipName,
      def,
      time: options.startTime || 0,
      speed: options.speed ?? 1,
      loop: options.loop ?? def.loop,
      onComplete: options.onComplete || null,
    };
    this._driver = null;
    return true;
  }

  /** 程序化动画驱动：'idle' | 'walk' | 自定义 fn(time, poseMap) */
  startProcedural(nameOrFn, params = {}) {
    this._clip = null;
    if (typeof nameOrFn === 'function') {
      this._driver = nameOrFn;
      return;
    }
    this._driver = PROCEDURAL[nameOrFn] || null;
    if (!this._driver) console.warn(`[Skeleton2D] 未定义的程序化动画: ${nameOrFn}`);
    void params;
  }

  stopAnimation() {
    this._clip = null;
    this._driver = null;
    this._resetPose();
  }

  /** 一次性姿态叠加（换装/受击等） */
  setPose(pose, alpha = 1) {
    for (const name of Object.keys(pose)) {
      const bone = this.bones.get(name);
      if (!bone) continue;
      const p = pose[name];
      if (p.x !== undefined) bone.pose.x += (p.x - bone.pose.x) * alpha;
      if (p.y !== undefined) bone.pose.y += (p.y - bone.pose.y) * alpha;
      if (p.rotation !== undefined) bone.pose.rotation += (p.rotation - bone.pose.rotation) * alpha;
      if (p.scale !== undefined) bone.pose.scale += (p.scale - bone.pose.scale) * alpha;
    }
    this._applyPose();
  }

  update(dt) {
    this._time += dt;

    if (this._clip) {
      const c = this._clip;
      c.time += dt * c.speed;
      if (!c.loop && c.time >= c.def.duration) {
        this._sampleClip(c.def, c.def.duration);
        this._applyPose();
        const cb = c.onComplete;
        this._clip = null;
        if (cb) cb();
      } else {
        this._sampleClip(c.def, c.time);
        this._applyPose();
      }
      return;
    }

    if (this._driver) {
      this._resetPose();
      this._driver(this._time, this._poseMap);
      this._applyPose();
    }
  }

  /** 关键帧采样：相邻两 key 线性插值，缺省字段按中性值 */
  _sampleClip(def, time) {
    const keys = def.keys;
    const n = keys.length;
    if (!n) return;

    let t = time;
    if (def.loop) {
      t = t % def.duration;
      if (t < 0) t += def.duration;
    } else {
      t = Math.min(t, def.duration);
    }

    let k0 = keys[0];
    let k1 = keys[n - 1];
    for (let i = 0; i < n - 1; i++) {
      if (t >= keys[i].time && t <= keys[i + 1].time) {
        k0 = keys[i];
        k1 = keys[i + 1];
        break;
      }
    }
    const span = Math.max(k1.time - k0.time, 1e-6);
    const a = THREE.MathUtils.clamp((t - k0.time) / span, 0, 1);

    for (let i = 0; i < this._boneList.length; i++) {
      const bone = this._boneList[i];
      const p0 = k0.pose[bone.name];
      const p1 = k1.pose[bone.name];
      bone.pose.x = lerp(p0 && p0.x !== undefined ? p0.x : 0, p1 && p1.x !== undefined ? p1.x : 0, a);
      bone.pose.y = lerp(p0 && p0.y !== undefined ? p0.y : 0, p1 && p1.y !== undefined ? p1.y : 0, a);
      bone.pose.rotation = lerp(
        p0 && p0.rotation !== undefined ? p0.rotation : 0,
        p1 && p1.rotation !== undefined ? p1.rotation : 0,
        a,
      );
      bone.pose.scale = lerp(
        p0 && p0.scale !== undefined ? p0.scale : 1,
        p1 && p1.scale !== undefined ? p1.scale : 1,
        a,
      );
    }
  }

  _resetPose() {
    for (let i = 0; i < this._boneList.length; i++) {
      const bone = this._boneList[i];
      bone.pose.x = 0;
      bone.pose.y = 0;
      bone.pose.rotation = 0;
      bone.pose.scale = 1;
    }
  }

  _applyPose() {
    for (let i = 0; i < this._boneList.length; i++) {
      const bone = this._boneList[i];
      bone.group.position.x = bone.base.x + bone.pose.x;
      bone.group.position.y = bone.base.y + bone.pose.y;
      bone.group.rotation.z = bone.base.rotation + bone.pose.rotation;
      bone.group.scale.setScalar(bone.base.scale * bone.pose.scale);
    }
  }

  dispose() {
    this.stopAnimation();
    for (const part of this.parts) {
      part.mesh.geometry.dispose();
      part.mesh.material.dispose();
    }
    this.parts.length = 0;
    this.bones.clear();
    if (this.root.parent) this.root.parent.remove(this.root);
  }
}

/**
 * 模块：统一驱动场景内所有 Skeleton2D（注册顺序在游戏层之前）。
 */
export class Skeleton2DManager {
  static moduleName = 'skeletons';

  constructor(engine) {
    this.engine = engine;
    /** @type {Array<Skeleton2D>} 数组存储，update 热路径下标遍历零分配 */
    this.skeletons = [];
    this._factory = null;
  }

  /** 游戏层注入解析器：resolveTexture(textureName, partDef) -> THREE.Texture */
  setTextureResolver(fn) {
    this._factory = fn;
  }

  spawn(rigData, options = {}) {
    const sk = new Skeleton2D(rigData, this._factory, options);
    this.skeletons.push(sk);
    (options.parent || this.engine.scene).add(sk.root);
    return sk;
  }

  remove(sk) {
    const idx = this.skeletons.indexOf(sk);
    if (idx >= 0) this.skeletons.splice(idx, 1);
    sk.dispose();
  }

  update(dt) {
    for (let i = 0; i < this.skeletons.length; i++) this.skeletons[i].update(dt);
  }

  dispose() {
    for (let i = 0; i < this.skeletons.length; i++) this.skeletons[i].dispose();
    this.skeletons.length = 0;
  }
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// ---------- 内置程序化动画（姿态偏移写入 poseMap） ----------

const PROCEDURAL = {
  // 待机：呼吸 + 轻微摇摆
  idle(time, pose) {
    const breathe = Math.sin(time * 1.7);
    const sway = Math.sin(time * 0.9);
    if (pose.torso) {
      pose.torso.rotation = breathe * 0.015;
      pose.torso.y = breathe * 0.02;
    }
    if (pose.head) pose.head.rotation = sway * 0.045;
    if (pose.armL) pose.armL.rotation = sway * 0.06;
    if (pose.armR) pose.armR.rotation = -sway * 0.06;
    if (pose.legL) pose.legL.rotation = breathe * 0.012;
    if (pose.legR) pose.legR.rotation = -breathe * 0.012;
  },

  // 走路：腿部摆动 + 反相摆臂 + 身体起伏
  walk(time, pose) {
    const swing = Math.sin(time * 6.2);
    const bob = Math.abs(Math.cos(time * 6.2));
    if (pose.root) pose.root.y = bob * 0.055;
    if (pose.torso) pose.torso.rotation = swing * 0.03;
    if (pose.head) pose.head.rotation = -swing * 0.035;
    if (pose.legL) pose.legL.rotation = swing * 0.55;
    if (pose.legR) pose.legR.rotation = -swing * 0.55;
    if (pose.armL) pose.armL.rotation = -swing * 0.42;
    if (pose.armR) pose.armR.rotation = swing * 0.42;
  },
};

export { PROCEDURAL };
