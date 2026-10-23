import * as THREE from 'three';
import gsap from 'gsap';

/**
 * 2.5D / 3D 相机控制器：
 * 固定斜角俯视 + 球面轨道、正交/透视一键切换、GSAP 屏幕震动。
 * 所有数学临时量在构造期预分配，update() 零 GC 分配。
 */
export class CameraController {
  static moduleName = 'camera';

  constructor(engine, options = {}) {
    this.engine = engine;

    this.target = new THREE.Vector3(
      options.target ? options.target.x : 0,
      options.target ? options.target.y : 0,
      options.target ? options.target.z : 0,
    );

    this.distance = options.distance || 18;
    this.minDistance = options.minDistance ?? 6;
    this.maxDistance = options.maxDistance ?? 42;
    this.polar = options.polar ?? THREE.MathUtils.degToRad(52);
    this.minPolar = options.minPolar ?? THREE.MathUtils.degToRad(28);
    this.maxPolar = options.maxPolar ?? THREE.MathUtils.degToRad(78);
    this.azimuth = options.azimuth ?? THREE.MathUtils.degToRad(28);
    this.damping = options.damping ?? 8;
    this.zoomSpeed = options.zoomSpeed ?? 0.0016;
    this.rotateSpeed = options.rotateSpeed ?? 0.005;

    this.mode = 'perspective';

    this._perspCam = engine.camera;
    this._perspCam.fov = options.fov || 42;
    this._perspCam.updateProjectionMatrix();

    this._orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, -200, 400);
    this._orthoCam.userData.frustumHeight = options.frustumHeight || 16;

    this._smooth = {
      distance: this.distance,
      polar: this.polar,
      azimuth: this.azimuth,
    };

    // 帧内复用的临时量
    this._tempSpherical = new THREE.Spherical();
    this._offset = new THREE.Vector3();
    this._shakeOffset = new THREE.Vector3();
    this._lookTarget = new THREE.Vector3();
    this._shake = { amplitude: 0 };

    this._orbiting = false;
    this._lastPointerX = 0;
    this._lastPointerY = 0;
    this._lastH = -1;
    this._lastAspect = -1;

    this._boundDown = this._onPointerDown.bind(this);
    this._boundMove = this._onPointerMove.bind(this);
    this._boundUp = this._onPointerUp.bind(this);
    this._boundWheel = this._onWheel.bind(this);
    this._boundContext = (e) => e.preventDefault();
    this._boundResize = this._onResize.bind(this);
  }

  init() {
    const dom = this.engine.canvas;
    dom.addEventListener('pointerdown', this._boundDown);
    window.addEventListener('pointermove', this._boundMove);
    window.addEventListener('pointerup', this._boundUp);
    dom.addEventListener('wheel', this._boundWheel, { passive: false });
    dom.addEventListener('contextmenu', this._boundContext);
    this.engine.eventBus.on('core:resize', this._boundResize);

    this.engine.setCamera(this.camera);
    this._applyPose();
    this._updateProjection();
  }

  get camera() {
    return this.mode === 'perspective' ? this._perspCam : this._orthoCam;
  }

  update(dt) {
    const t = 1 - Math.exp(-this.damping * dt);
    this._smooth.distance += (this.distance - this._smooth.distance) * t;
    this._smooth.polar += (this.polar - this._smooth.polar) * t;
    this._smooth.azimuth += (this.azimuth - this._smooth.azimuth) * t;

    this._applyPose();
    this._updateProjection();
  }

  /** 相机位姿：target + 球面偏移 + 震动偏移 */
  _applyPose() {
    this._tempSpherical.set(this._smooth.distance, this._smooth.polar, this._smooth.azimuth);
    this._offset.setFromSpherical(this._tempSpherical);
    this._lookTarget.copy(this.target);

    const cam = this.camera;
    cam.position.copy(this.target).add(this._offset);

    if (this._shake.amplitude > 0.0001) {
      const a = this._shake.amplitude;
      this._shakeOffset.set(
        (Math.random() * 2 - 1) * a,
        (Math.random() * 2 - 1) * a * 0.6,
        (Math.random() * 2 - 1) * a,
      );
      cam.position.add(this._shakeOffset);
    }

    cam.lookAt(this._lookTarget);
  }

  _updateProjection() {
    const cam = this.camera;
    if (cam.isPerspectiveCamera) {
      const w = this.engine.container.clientWidth || window.innerWidth;
      const h = this.engine.container.clientHeight || window.innerHeight;
      const aspect = w / Math.max(h, 1);
      if (aspect !== cam.aspect) {
        cam.aspect = aspect;
        cam.updateProjectionMatrix();
      }
      return;
    }

    // 正交：视锥高度随距离变化，保持"拉远看更多"的直观手感
    const frustumHeight = this._orthoCam.userData.frustumHeight;
    const w = this.engine.container.clientWidth || window.innerWidth;
    const h = this.engine.container.clientHeight || window.innerHeight;
    const aspect = w / Math.max(h, 1);
    if (frustumHeight !== this._lastH || aspect !== this._lastAspect) {
      this._lastH = frustumHeight;
      this._lastAspect = aspect;
      const half = frustumHeight / 2;
      cam.top = half;
      cam.bottom = -half;
      cam.left = -half * aspect;
      cam.right = half * aspect;
      cam.updateProjectionMatrix();
    }
  }

  setTarget(x, y, z) {
    this.target.set(x, y, z);
  }

  setOrbit({ distance, polar, azimuth } = {}) {
    if (distance !== undefined) this.distance = THREE.MathUtils.clamp(distance, this.minDistance, this.maxDistance);
    if (polar !== undefined) this.polar = THREE.MathUtils.clamp(polar, this.minPolar, this.maxPolar);
    if (azimuth !== undefined) this.azimuth = azimuth;
  }

  setMode(mode) {
    const next = mode === 'orthographic' ? 'orthographic' : 'perspective';
    if (next === this.mode) return this.mode;

    // 切换前同步位姿，避免视觉跳变
    const from = this.camera;
    this.mode = next;
    const to = this.camera;
    to.position.copy(from.position);
    to.quaternion.copy(from.quaternion);
    if (to.isOrthographicCamera) {
      to.userData.frustumHeight = Math.max(2, this._smooth.distance * 0.72);
      this._lastH = -1;
    }
    this.engine.setCamera(to);
    this._updateProjection();
    this.engine.eventBus.emit('camera:mode', { mode: this.mode });
    return this.mode;
  }

  toggleMode() {
    return this.setMode(this.mode === 'perspective' ? 'orthographic' : 'perspective');
  }

  /** GSAP 屏幕震动 */
  shake(intensity = 0.35, duration = 0.45) {
    this._shake.amplitude = intensity;
    gsap.killTweensOf(this._shake);
    gsap.to(this._shake, {
      amplitude: 0,
      duration,
      ease: 'power2.out',
    });
    this.engine.eventBus.emit('camera:shake', { intensity, duration });
  }

  _onPointerDown(e) {
    if (e.button !== 2) return; // 右键轨道旋转，左键留给拾取/拖拽
    this._orbiting = true;
    this._lastPointerX = e.clientX;
    this._lastPointerY = e.clientY;
  }

  _onPointerMove(e) {
    if (!this._orbiting) return;
    const dx = e.clientX - this._lastPointerX;
    const dy = e.clientY - this._lastPointerY;
    this._lastPointerX = e.clientX;
    this._lastPointerY = e.clientY;
    this.azimuth -= dx * this.rotateSpeed;
    this.polar = THREE.MathUtils.clamp(this.polar - dy * this.rotateSpeed, this.minPolar, this.maxPolar);
  }

  _onPointerUp() {
    this._orbiting = false;
  }

  _onWheel(e) {
    e.preventDefault();
    const next = this.distance * (1 + e.deltaY * this.zoomSpeed);
    this.distance = THREE.MathUtils.clamp(next, this.minDistance, this.maxDistance);
  }

  _onResize() {
    if (this.mode === 'orthographic') this._lastH = -1;
  }

  dispose() {
    const dom = this.engine.canvas;
    dom.removeEventListener('pointerdown', this._boundDown);
    window.removeEventListener('pointermove', this._boundMove);
    window.removeEventListener('pointerup', this._boundUp);
    dom.removeEventListener('wheel', this._boundWheel);
    dom.removeEventListener('contextmenu', this._boundContext);
    this.engine.eventBus.off('core:resize', this._boundResize);
    gsap.killTweensOf(this._shake);
  }
}
