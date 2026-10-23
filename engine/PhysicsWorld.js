import * as CANNON from 'cannon-es';

/**
 * cannon-es 胶水层：世界步进 + 刚体与网格坐标/旋转自动同步。
 * 同步方向可配：bodyToMesh（物理驱动）/ meshToBody（网格拖拽带动刚体，例如手牌吸附）。
 * update() 内零对象分配。
 */
export class PhysicsWorld {
  static moduleName = 'physics';

  constructor(engine, options = {}) {
    this.engine = engine;

    this.world = new CANNON.World({
      gravity: new CANNON.Vec3(0, options.gravity ?? -22, 0),
    });
    this.world.broadphase = new CANNON.SAPBroadphase(this.world);
    this.world.allowSleep = true;

    this.fixedTimeStep = options.fixedTimeStep ?? 1 / 60;
    this.maxSubSteps = options.maxSubSteps ?? 3;
    this.paused = false; // 编辑模式暂停步进，防止动态体在编辑时乱跑

    this.defaultMaterial = new CANNON.Material('default');
    this.world.defaultContactMaterial = new CANNON.ContactMaterial(
      this.defaultMaterial,
      this.defaultMaterial,
      { friction: options.friction ?? 0.4, restitution: options.restitution ?? 0.3 },
    );

    /** @type {Array<{body: CANNON.Body, mesh: any, mode: string}>} */
    this._pairs = [];
    this._byBody = new Map();
    this._byMesh = new Map();
    this._collideHandlers = [];
  }

  /** 直接登记已构造好的 body + mesh */
  add(mesh, body, mode = 'bodyToMesh') {
    if (!body.material) body.material = this.defaultMaterial;
    this.world.addBody(body);
    const pair = { body, mesh, mode };
    this._pairs.push(pair);
    this._byBody.set(body, pair);
    this._byMesh.set(mesh, pair);
    return pair;
  }

  addBox(mesh, params = {}) {
    const size = params.size || { x: 1, y: 1, z: 1 };
    const half = new CANNON.Vec3(size.x / 2, size.y / 2, size.z / 2);
    const body = new CANNON.Body({
      mass: params.mass ?? 1,
      shape: new CANNON.Box(half),
      position: this._toVec3(params.position || mesh.position),
      quaternion: this._toQuat(params.quaternion || mesh.quaternion),
      linearDamping: params.linearDamping ?? 0.05,
      angularDamping: params.angularDamping ?? 0.12,
    });
    if (params.allowSleep === false) body.allowSleep = false;
    if (params.sleepSpeedLimit !== undefined) body.sleepSpeedLimit = params.sleepSpeedLimit;
    if (params.sleepTimeLimit !== undefined) body.sleepTimeLimit = params.sleepTimeLimit;
    return this.add(mesh, body, params.mode || 'bodyToMesh');
  }

  addSphere(mesh, params = {}) {
    const body = new CANNON.Body({
      mass: params.mass ?? 1,
      shape: new CANNON.Sphere(params.radius ?? 0.5),
      position: this._toVec3(params.position || mesh.position),
      quaternion: this._toQuat(params.quaternion || mesh.quaternion),
      linearDamping: params.linearDamping ?? 0.01,
      angularDamping: params.angularDamping ?? 0.05,
    });
    return this.add(mesh, body, params.mode || 'bodyToMesh');
  }

  /** 无限大地面（mass = 0 静态） */
  addGround(mesh = null, params = {}) {
    const body = new CANNON.Body({
      mass: 0,
      shape: params.shape || new CANNON.Plane(),
      position: this._toVec3(params.position || { x: 0, y: 0, z: 0 }),
    });
    if (params.quaternion) body.quaternion.copy(this._toQuat(params.quaternion));
    else body.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    return this.add(mesh || this.engine.scene, body, 'bodyToMesh');
  }

  onCollide(meshOrBody, handler) {
    const pair = this._byMesh.get(meshOrBody) || this._byBody.get(meshOrBody);
    if (!pair) return () => {};
    const listener = (e) => handler(e, pair);
    pair.body.addEventListener('collide', listener);
    const entry = { body: pair.body, listener };
    this._collideHandlers.push(entry);
    return () => {
      pair.body.removeEventListener('collide', listener);
      const idx = this._collideHandlers.indexOf(entry);
      if (idx >= 0) this._collideHandlers.splice(idx, 1);
    };
  }

  setSyncMode(meshOrBody, mode) {
    const pair = this._byMesh.get(meshOrBody) || this._byBody.get(meshOrBody);
    if (pair) pair.mode = mode;
  }

  /** 把网格当前变换写回刚体（编辑器移动物体后调用，避免 bodyToMesh 把位置改回去） */
  applyTransformFromMesh(mesh) {
    const pair = this._byMesh.get(mesh);
    if (!pair) return false;
    mesh.updateWorldMatrix(true, false);
    pair.body.position.set(mesh.position.x, mesh.position.y, mesh.position.z);
    pair.body.quaternion.set(
      mesh.quaternion.x,
      mesh.quaternion.y,
      mesh.quaternion.z,
      mesh.quaternion.w,
    );
    pair.body.velocity.set(0, 0, 0);
    pair.body.angularVelocity.set(0, 0, 0);
    if (pair.body.sleepState !== undefined && typeof pair.body.sleep === 'function') pair.body.sleep();
    return true;
  }

  getPair(meshOrBody) {
    return this._byMesh.get(meshOrBody) || this._byBody.get(meshOrBody) || null;
  }

  update(dt) {
    if (this.paused) return;
    this.world.step(this.fixedTimeStep, dt, this.maxSubSteps);

    for (let i = 0; i < this._pairs.length; i++) {
      const pair = this._pairs[i];
      // 哨兵（addGround(null) 挂的 Scene 对象）不参与同步；isScene 兜底场景切换后 engine.scene 已换的情况
      if (!pair.mesh || pair.mesh === this.engine.scene || pair.mesh.isScene) continue;

      if (pair.mode === 'meshToBody') {
        pair.body.position.set(pair.mesh.position.x, pair.mesh.position.y, pair.mesh.position.z);
        pair.body.quaternion.set(
          pair.mesh.quaternion.x,
          pair.mesh.quaternion.y,
          pair.mesh.quaternion.z,
          pair.mesh.quaternion.w,
        );
        pair.body.velocity.set(0, 0, 0);
        pair.body.angularVelocity.set(0, 0, 0);
      } else {
        pair.mesh.position.copy(pair.body.position);
        pair.mesh.quaternion.copy(pair.body.quaternion);
      }
    }
  }

  remove(meshOrBody) {
    const pair = this._byMesh.get(meshOrBody) || this._byBody.get(meshOrBody);
    if (!pair) return;
    this.world.removeBody(pair.body);
    const idx = this._pairs.indexOf(pair);
    if (idx >= 0) this._pairs.splice(idx, 1);
    this._byBody.delete(pair.body);
    this._byMesh.delete(pair.mesh);
  }

  _toVec3(v) {
    return new CANNON.Vec3(v.x || 0, v.y || 0, v.z || 0);
  }

  _toQuat(q) {
    return new CANNON.Quaternion(q.x || 0, q.y || 0, q.z || 0, q.w === undefined ? 1 : q.w);
  }

  dispose() {
    for (let i = this._pairs.length - 1; i >= 0; i--) {
      this.world.removeBody(this._pairs[i].body);
    }
    this._pairs.length = 0;
    this._byBody.clear();
    this._byMesh.clear();
    this._collideHandlers.length = 0;
  }
}
