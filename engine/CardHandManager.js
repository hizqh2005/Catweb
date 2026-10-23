import * as THREE from 'three';
import gsap from 'gsap';

/**
 * 3D 卡牌手牌系统：扇形/弧线排布、抽牌入场、悬停抬升放大、邻居挤开。
 *
 * 实现要点：每张卡持有 base（排布基准）与 anim（动画偏移）两组数据，
 * update() 仅做叠加写入 position/rotation/scale，帧循环内零分配。
 * 卡牌本身的几何/材质由游戏层创建后通过 addCard(mesh) 传入，引擎不含任何牌面数据。
 */
export class CardHandManager {
  static moduleName = 'hand';

  constructor(engine, options = {}) {
    this.engine = engine;

    this.root = options.root || engine.scene;
    this.config = {
      radius: options.radius ?? 11,
      maxArc: options.maxArc ?? THREE.MathUtils.degToRad(52),
      minStep: options.minStep ?? THREE.MathUtils.degToRad(4),
      maxStep: options.maxStep ?? THREE.MathUtils.degToRad(9),
      curve: options.curve ?? 0.22,
      tilt: options.tilt ?? 0.72,
      hoverLift: options.hoverLift ?? 1.15,
      hoverScale: options.hoverScale ?? 1.12,
      neighborPush: options.neighborPush ?? 0.55,
      neighborRot: options.neighborRot ?? 0.09,
      animDuration: options.animDuration ?? 0.42,
    };

    /** @type {Array<{mesh: any, meta: any, base: {x:number,y:number,z:number,rz:number}, anim: {dx:number,dy:number,dz:number,rz:number,scale:number}}>} */
    this.cards = [];
    this._hovered = null;

    this._tempVec = new THREE.Vector3();
    this._tempQuat = new THREE.Quaternion();
  }

  setRoot(object3D) {
    this.root = object3D;
  }

  setConfig(partial) {
    Object.assign(this.config, partial);
    this.layout(true);
  }

  addCard(mesh, meta = {}, options = {}) {
    const entry = {
      mesh,
      meta,
      base: { x: 0, y: 0, z: 0, rz: 0 },
      anim: { dx: 0, dy: 0, dz: 0, rz: 0, scale: 1 },
    };
    mesh.userData.cardEntry = entry;
    this.root.add(mesh);
    this.cards.push(entry);

    // 入场：从牌堆方向（root 局部原点）滑入
    entry.anim.dx = options.fromX ?? 0;
    entry.anim.dy = options.fromY ?? 3.2;
    entry.anim.dz = options.fromZ ?? -4;
    entry.anim.scale = 0.72;

    this.layout(true);
    this._animateEntry(entry);
    this.engine.eventBus.emit('hand:change', { action: 'add', card: entry, count: this.cards.length });
    return entry;
  }

  removeCard(meshOrEntry) {
    const entry = meshOrEntry && meshOrEntry.mesh ? meshOrEntry : this.cards.find((c) => c.mesh === meshOrEntry);
    if (!entry) return;
    const idx = this.cards.indexOf(entry);
    if (idx >= 0) this.cards.splice(idx, 1);
    if (this._hovered === entry) this._hovered = null;
    gsap.killTweensOf(entry.anim);
    this.root.remove(entry.mesh);
    this.layout(true);
    this.engine.eventBus.emit('hand:change', { action: 'remove', card: entry, count: this.cards.length });
  }

  /** 弧线排布：角度均分，边缘下沉形成扇面 */
  layout(animated = true) {
    const n = this.cards.length;
    if (!n) return;

    const { radius, maxArc, minStep, maxStep, curve, tilt } = this.config;
    const step = n > 1 ? THREE.MathUtils.clamp(maxArc / (n - 1), minStep, maxStep) : 0;

    for (let i = 0; i < n; i++) {
      const entry = this.cards[i];
      const angle = (i - (n - 1) / 2) * step;

      entry.base.x = Math.sin(angle) * radius;
      entry.base.z = (1 - Math.cos(angle)) * radius;
      entry.base.y = -(1 - Math.cos(angle)) * radius * curve;
      entry.base.rz = -angle * tilt;

      if (animated) {
        const dx = entry.base.x + entry.anim.dx - entry.mesh.position.x;
        const dz = entry.base.z + entry.anim.dz - entry.mesh.position.z;
        if (Math.abs(dx) > 0.001 || Math.abs(dz) > 0.001) {
          // 排布变化只补位置，scale/rz 由 anim 状态机负责
          gsap.to(entry.mesh.position, {
            x: entry.base.x + entry.anim.dx,
            y: entry.base.y + entry.anim.dy,
            z: entry.base.z + entry.anim.dz,
            duration: this.config.animDuration,
            ease: 'power2.out',
            overwrite: 'auto',
          });
        }
      }
    }

    this.engine.eventBus.emit('hand:layout', { count: n });
  }

  hoverIn(meshOrEntry) {
    const entry = this._resolve(meshOrEntry);
    if (!entry || entry === this._hovered) return;
    if (this._hovered) this.hoverOut(this._hovered);

    this._hovered = entry;
    gsap.to(entry.anim, {
      dy: this.config.hoverLift,
      scale: this.config.hoverScale,
      duration: 0.22,
      ease: 'power2.out',
      overwrite: 'auto',
    });

    const idx = this.cards.indexOf(entry);
    for (let i = 0; i < this.cards.length; i++) {
      if (i === idx) continue;
      const other = this.cards[i];
      const dir = i < idx ? -1 : 1;
      const falloff = 1 / (1 + Math.abs(i - idx) - 1);
      gsap.to(other.anim, {
        dx: dir * this.config.neighborPush * falloff,
        rz: dir * this.config.neighborRot * falloff,
        duration: 0.28,
        ease: 'power2.out',
        overwrite: 'auto',
      });
    }

    this.engine.eventBus.emit('hand:hover', { card: entry, index: idx });
  }

  hoverOut(meshOrEntry) {
    const entry = this._resolve(meshOrEntry);
    if (!entry) return;
    if (entry === this._hovered) this._hovered = null;

    gsap.to(entry.anim, {
      dy: 0,
      scale: 1,
      duration: 0.24,
      ease: 'power2.out',
      overwrite: 'auto',
    });

    for (let i = 0; i < this.cards.length; i++) {
      const other = this.cards[i];
      if (other === entry) continue;
      gsap.to(other.anim, {
        dx: 0,
        rz: 0,
        duration: 0.28,
        ease: 'power2.out',
        overwrite: 'auto',
      });
    }

    this.engine.eventBus.emit('hand:out', { card: entry });
  }

  /** 把被拖拽的牌临时移出手牌动画系统（拖拽由 RaycastManager 驱动） */
  setDragged(meshOrEntry, dragged) {
    const entry = this._resolve(meshOrEntry);
    if (!entry) return;
    if (dragged) {
      gsap.killTweensOf(entry.anim);
      if (this._hovered === entry) this.hoverOut(entry);
    } else {
      this._animateEntry(entry);
    }
  }

  update() {
    for (let i = 0; i < this.cards.length; i++) {
      const entry = this.cards[i];
      const mesh = entry.mesh;
      if (mesh.userData.handDragging) continue;

      mesh.position.set(
        entry.base.x + entry.anim.dx,
        entry.base.y + entry.anim.dy,
        entry.base.z + entry.anim.dz,
      );
      mesh.rotation.set(0, 0, entry.base.rz + entry.anim.rz);
      mesh.scale.setScalar(entry.anim.scale);
    }
  }

  _animateEntry(entry) {
    gsap.to(entry.anim, {
      dx: 0,
      dy: 0,
      dz: 0,
      rz: 0,
      scale: 1,
      duration: this.config.animDuration,
      ease: 'power3.out',
      overwrite: 'auto',
    });
  }

  _resolve(meshOrEntry) {
    if (!meshOrEntry) return null;
    if (meshOrEntry.mesh && meshOrEntry.base) return meshOrEntry;
    return meshOrEntry.userData ? meshOrEntry.userData.cardEntry || null : null;
  }

  dispose() {
    for (let i = 0; i < this.cards.length; i++) {
      gsap.killTweensOf(this.cards[i].anim);
    }
    this.cards.length = 0;
  }
}
