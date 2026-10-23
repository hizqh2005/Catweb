import * as THREE from 'three';

/**
 * 2.5D 纸片人 / 骨骼适配层：
 * - 挂载 Sprite / Plane / Spine 容器，统一"锁定朝向相机"（全公告板或仅 Y 轴）
 * - 可选投射 3D 阴影（地面圆形软影，跟随单位 XZ）
 * 通用容器：游戏层把任意 Object3D 交给 spawn()，本模块不关心贴图内容。
 */
export class BillboardUnitManager {
  static moduleName = 'billboard';

  constructor(engine, options = {}) {
    this.engine = engine;
    this.groundY = options.groundY ?? 0.02;
    this.defaultShadowSize = options.shadowSize ?? 1.6;

    /** @type {Array<{id: string, object: any, shadow: any, facing: string}>} */
    this.units = [];
    this._seq = 0;

    // 复用临时量
    this._tempEuler = new THREE.Euler();
    this._tempQuat = new THREE.Quaternion();
  }

  /**
   * @param {object} params
   * @param {THREE.Object3D} params.object   纸片人容器（Sprite / Plane / Group）
   * @param {'full'|'yaw'|'none'} [params.facing] 默认 full
   * @param {THREE.Texture} [params.shadowTexture] 提供则生成圆形软影
   * @param {number} [params.shadowSize]
   */
  spawn(params) {
    const { object } = params;
    const id = params.id || `unit_${++this._seq}`;
    const facing = params.facing || 'full';
    let shadow = null;

    if (params.shadowTexture) {
      shadow = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({
          map: params.shadowTexture,
          transparent: true,
          opacity: params.shadowOpacity ?? 0.55,
          depthWrite: false,
        }),
      );
      const size = params.shadowSize ?? this.defaultShadowSize;
      shadow.scale.set(size, size, 1);
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.set(object.position.x, this.groundY, object.position.z);
      shadow.renderOrder = -1;
      this.engine.scene.add(shadow);
    }

    const unit = { id, object, shadow, facing };
    this.units.push(unit);
    this.engine.eventBus.emit('billboard:spawn', unit);
    return unit;
  }

  remove(unitOrId) {
    const unit = typeof unitOrId === 'string'
      ? this.units.find((u) => u.id === unitOrId)
      : unitOrId;
    if (!unit) return;
    const idx = this.units.indexOf(unit);
    if (idx >= 0) this.units.splice(idx, 1);
    if (unit.shadow) {
      this.engine.scene.remove(unit.shadow);
      unit.shadow.geometry.dispose();
      unit.shadow.material.dispose();
    }
    this.engine.eventBus.emit('billboard:remove', unit);
  }

  setFacing(unit, facing) {
    unit.facing = facing;
  }

  update() {
    const camera = this.engine.camera;

    for (let i = 0; i < this.units.length; i++) {
      const unit = this.units[i];
      const obj = unit.object;

      if (unit.facing === 'full') {
        obj.quaternion.copy(camera.quaternion);
      } else if (unit.facing === 'yaw') {
        // 仅绕 Y 轴朝向相机，保持纸片"站立"
        this._tempEuler.setFromQuaternion(camera.quaternion, 'YXZ');
        this._tempQuat.setFromAxisAngle(UP_Y, this._tempEuler.y);
        obj.quaternion.copy(this._tempQuat);
      }

      if (unit.shadow) {
        unit.shadow.position.x = obj.position.x;
        unit.shadow.position.z = obj.position.z;
      }
    }
  }

  dispose() {
    for (let i = this.units.length - 1; i >= 0; i--) this.remove(this.units[i]);
    this.units.length = 0;
  }
}

const UP_Y = new THREE.Vector3(0, 1, 0);
