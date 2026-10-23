import * as THREE from 'three';

/**
 * 3D 拾取与拖拽交互：
 * 射线检测悬停/点击，拖拽时把指针投影到可配置平面（默认 3D 桌面平面）。
 * target 结构：
 *   {
 *     object,                    // 注册的 Object3D（递归拾取子网格）
 *     hoverIn(target, event), hoverOut(target, event),
 *     click(target, event),
 *     dragStart(point, event), drag(point, event), dragEnd(point, event),
 *     plane,                     // 可选：该 target 私有的拖拽平面 THREE.Plane
 *     userData
 *   }
 * 所有事件同步广播到全局 EventBus：raycast:hover / raycast:out / raycast:click /
 * raycast:dragstart / raycast:drag / raycast:dragend。
 */
export class RaycastManager {
  static moduleName = 'raycast';

  constructor(engine, options = {}) {
    this.engine = engine;
    this.dom = options.dom || engine.canvas;
    this.dragThreshold = options.dragThreshold ?? 4;
    this.enabled = true; // 编辑模式下由 SceneEditor 关闭，让位给编辑拾取

    this._raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this._dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._dragPoint = new THREE.Vector3();

    this._targets = new Map(); // Object3D -> target
    this._objects = [];
    this._hovered = null;
    this._pressed = null;
    this._dragging = null;
    this._downX = 0;
    this._downY = 0;

    this._boundDown = this._onDown.bind(this);
    this._boundMove = this._onMove.bind(this);
    this._boundUp = this._onUp.bind(this);
    this._boundLeave = this._onLeave.bind(this);
  }

  init() {
    this.dom.addEventListener('pointerdown', this._boundDown);
    this.dom.addEventListener('pointermove', this._boundMove);
    this.dom.addEventListener('pointerup', this._boundUp);
    this.dom.addEventListener('pointercancel', this._boundUp);
    this.dom.addEventListener('pointerleave', this._boundLeave);
  }

  addTarget(target) {
    this._targets.set(target.object, target);
    this._objects.push(target.object);
    return target;
  }

  removeTarget(targetOrObject) {
    const target = typeof targetOrObject === 'object' && targetOrObject.object
      ? targetOrObject
      : this._targets.get(targetOrObject);
    if (!target) return;
    if (this._hovered === target) this._hovered = null;
    if (this._pressed === target) this._pressed = null;
    if (this._dragging === target) this._dragging = null;
    this._targets.delete(target.object);
    const idx = this._objects.indexOf(target.object);
    if (idx >= 0) this._objects.splice(idx, 1);
  }

  /** 全局拖拽投影平面（如 3D 牌桌平面） */
  setDragPlane(normal, point) {
    this._dragPlane.setFromNormalAndCoplanarPoint(normal, point);
  }

  /** 当前指针在拖拽平面上的投影点（复用同一 Vector3，勿长期持有） */
  getDragPoint(eventLike) {
    this._updateNdc(eventLike);
    this._raycaster.setFromCamera(this._ndc, this.engine.camera);
    this._raycaster.ray.intersectPlane(this._dragPlane, this._dragPoint);
    return this._dragPoint;
  }

  update() {
    // 拾取为事件驱动，无需逐帧轮询；保留 update 钩子以统一模块协议
  }

  _onDown(e) {
    if (!this.enabled) return;
    if (e.button !== 0) return;
    this._downX = e.clientX;
    this._downY = e.clientY;
    const hit = this._pick(e);
    this._pressed = hit;
    if (hit && typeof hit.dragStart === 'function') {
      // 真正的 dragStart 在越过阈值后触发，这里只记录候选
      try { this.dom.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    }
  }

  _onMove(e) {
    if (!this.enabled) return;
    if (this._dragging) {
      const point = this._project(e, this._dragging);
      this._dragging.drag(point, e);
      this.engine.eventBus.emit('raycast:drag', { target: this._dragging, point, event: e });
      return;
    }

    if (this._pressed) {
      const dist = Math.abs(e.clientX - this._downX) + Math.abs(e.clientY - this._downY);
      if (dist >= this.dragThreshold && typeof this._pressed.dragStart === 'function') {
        this._dragging = this._pressed;
        const point = this._project(e, this._dragging);
        this._dragging.dragStart(point, e);
        this.engine.eventBus.emit('raycast:dragstart', { target: this._dragging, point, event: e });
        this._setHover(null, e);
      }
      return;
    }

    this._setHover(this._pick(e), e);
  }

  _onUp(e) {
    if (!this.enabled && !this._dragging) return;
    const point = this._dragging ? this._project(e, this._dragging) : null;

    if (this._dragging) {
      const target = this._dragging;
      this._dragging = null;
      if (typeof target.dragEnd === 'function') target.dragEnd(point, e);
      this.engine.eventBus.emit('raycast:dragend', { target, point, event: e });
    } else if (this._pressed) {
      const released = this._pick(e);
      if (released && released === this._pressed) {
        if (typeof released.click === 'function') released.click(e);
        this.engine.eventBus.emit('raycast:click', { target: released, event: e });
      }
    }

    this._pressed = null;
    try { this.dom.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
  }

  _onLeave() {
    this._setHover(null, null);
    this._pressed = null;
    this._dragging = null;
  }

  _setHover(target, e) {
    if (target === this._hovered) return;
    const prev = this._hovered;
    this._hovered = target;

    if (prev) {
      if (typeof prev.hoverOut === 'function') prev.hoverOut(prev, e);
      this.engine.eventBus.emit('raycast:out', { target: prev, event: e });
    }
    if (target) {
      if (typeof target.hoverIn === 'function') target.hoverIn(target, e);
      this.engine.eventBus.emit('raycast:hover', { target, event: e });
    }
  }

  _pick(e) {
    if (!this._objects.length) return null;
    this._updateNdc(e);
    this._raycaster.setFromCamera(this._ndc, this.engine.camera);
    const hits = this._raycaster.intersectObjects(this._objects, true);
    for (let i = 0; i < hits.length; i++) {
      const owner = this._resolveOwner(hits[i].object);
      if (owner) return owner;
    }
    return null;
  }

  _project(e, target) {
    this._updateNdc(e);
    this._raycaster.setFromCamera(this._ndc, this.engine.camera);
    const plane = target && target.plane ? target.plane : this._dragPlane;
    return this._raycaster.ray.intersectPlane(plane, this._dragPoint);
  }

  _updateNdc(e) {
    const rect = this.dom.getBoundingClientRect();
    this._ndc.x = ((e.clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1;
    this._ndc.y = -((e.clientY - rect.top) / Math.max(rect.height, 1)) * 2 + 1;
  }

  _resolveOwner(obj) {
    let node = obj;
    while (node) {
      const target = this._targets.get(node);
      if (target) return target;
      node = node.parent;
    }
    return null;
  }

  dispose() {
    this.dom.removeEventListener('pointerdown', this._boundDown);
    this.dom.removeEventListener('pointermove', this._boundMove);
    this.dom.removeEventListener('pointerup', this._boundUp);
    this.dom.removeEventListener('pointercancel', this._boundUp);
    this.dom.removeEventListener('pointerleave', this._boundLeave);
    this._targets.clear();
    this._objects.length = 0;
  }
}
