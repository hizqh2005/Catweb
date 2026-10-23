/**
 * 通用输入系统：键盘状态 + HTML5 Gamepad + 零 GC 轴输出。
 *
 * 模块协议：static moduleName = 'input'；init / update(dt) / dispose。
 * 红线：getAxis 结果写入预分配 `_axis`，查询与帧路径严禁 new 对象。
 *
 * 帧时序（重要）：
 *   监听器在帧间隙写入 `_pendingJust*`；
 *   update() 开头提升为本帧 `_just*`（游戏逻辑在本帧后续模块里读到），
 *   同时清空 pending，实现"当帧触发状态只对本帧可见"。
 *
 * 用法：
 *   const input = engine.get('input');
 *   if (input.isJustPressed('Space')) jump();
 *   const a = input.getAxis('KeyA', 'KeyD', 'KeyS', 'KeyW'); // 返回内部 {x,y} 引用
 *   input.isGamepadButtonJustPressed(0); // A / Cross
 *
 * 事件：
 *   input:gamepadconnected    { index, id }
 *   input:gamepaddisconnected { index, id }
 */
export class InputManager {
  static moduleName = 'input';

  constructor(engine, options = {}) {
    this.engine = engine;

    /** 摇杆死区（默认 0.15，消除漂移） */
    this.deadzone = options.deadzone ?? 0.15;
    /** 轴输出预分配结果（勿长期持有；下帧会被覆写） */
    this._axis = { x: 0, y: 0 };

    /** @type {Set<string>} 当前按住的 KeyboardEvent.code */
    this._down = new Set();
    /** @type {Set<string>} 本帧可见的刚按下 */
    this._justPressed = new Set();
    /** @type {Set<string>} 本帧可见的刚松开 */
    this._justReleased = new Set();
    /** @type {Set<string>} 监听器写入的待提升状态 */
    this._pendingJustPressed = new Set();
    /** @type {Set<string>} */
    this._pendingJustReleased = new Set();

    // 手柄状态：普通数组，避免每帧 Map 分配
    /** @type {Array<{index:number, id:string, buttons:Array<{pressed:boolean, value:number}>, axes:Array<number>}>} */
    this._pads = [];
    /** 按钮上一帧按下布尔，索引对齐 _pads：_prevButtons[padSlot][buttonIndex] */
    this._prevButtons = [];
    /** 本帧可见的按钮触发状态：_padJustPressed[padSlot][buttonIndex] */
    this._padJustPressed = [];
    this._padJustReleased = [];

    this._boundKeyDown = this._onKeyDown.bind(this);
    this._boundKeyUp = this._onKeyUp.bind(this);
    this._boundBlur = this._onBlur.bind(this);
    this._boundPadConnected = this._onPadConnected.bind(this);
    this._boundPadDisconnected = this._onPadDisconnected.bind(this);
  }

  init() {
    window.addEventListener('keydown', this._boundKeyDown);
    window.addEventListener('keyup', this._boundKeyUp);
    window.addEventListener('blur', this._boundBlur);
    window.addEventListener('gamepadconnected', this._boundPadConnected);
    window.addEventListener('gamepaddisconnected', this._boundPadDisconnected);
    this._pollGamepads();
  }

  // ---------- 键盘 ----------

  isDown(code) {
    return this._down.has(code);
  }

  isJustPressed(code) {
    return this._justPressed.has(code);
  }

  isJustReleased(code) {
    return this._justReleased.has(code);
  }

  _onKeyDown(e) {
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const code = e.code;
    if (!this._down.has(code)) {
      this._pendingJustPressed.add(code);
    }
    this._down.add(code);
    if (code === 'Space' || code.startsWith('Arrow')) {
      if (e.preventDefault) e.preventDefault();
    }
  }

  _onKeyUp(e) {
    const code = e.code;
    if (this._down.has(code)) {
      this._down.delete(code);
      this._pendingJustReleased.add(code);
    }
  }

  _onBlur() {
    for (const code of this._down) this._pendingJustReleased.add(code);
    this._down.clear();
  }

  // ---------- 手柄 ----------

  isGamepadConnected() {
    return this._pads.length > 0;
  }

  getGamepad() {
    return this._pads.length ? this._pads[0] : null;
  }

  isGamepadButtonDown(buttonIndex, padIndex = 0) {
    const pad = this._pads[padIndex];
    if (!pad) return false;
    const btn = pad.buttons[buttonIndex];
    return !!(btn && btn.pressed);
  }

  isGamepadButtonJustPressed(buttonIndex, padIndex = 0) {
    const arr = this._padJustPressed[padIndex];
    return !!(arr && arr[buttonIndex]);
  }

  isGamepadButtonJustReleased(buttonIndex, padIndex = 0) {
    const arr = this._padJustReleased[padIndex];
    return !!(arr && arr[buttonIndex]);
  }

  /**
   * 读主手柄左摇杆（零 GC：写入并返回内部 `_axis`）。
   * 超出死区才输出并做重映射；否则 {x:0,y:0}。
   */
  getGamepadAxis() {
    return this.getAxis(null, null, null, null);
  }

  _onPadConnected(e) {
    const gp = e.gamepad;
    this._ensurePadSlot(gp.index, gp.id);
    this.engine.eventBus.emit('input:gamepadconnected', { index: gp.index, id: gp.id });
  }

  _onPadDisconnected(e) {
    const gp = e.gamepad;
    for (let i = 0; i < this._pads.length; i++) {
      if (this._pads[i].index === gp.index) {
        this._pads.splice(i, 1);
        this._prevButtons.splice(i, 1);
        this._padJustPressed.splice(i, 1);
        this._padJustReleased.splice(i, 1);
        break;
      }
    }
    this.engine.eventBus.emit('input:gamepaddisconnected', { index: gp.index, id: gp.id });
  }

  _ensurePadSlot(index, id) {
    let slot = -1;
    for (let i = 0; i < this._pads.length; i++) {
      if (this._pads[i].index === index) {
        slot = i;
        break;
      }
    }
    if (slot < 0) {
      this._pads.push({
        index,
        id: id || `gamepad_${index}`,
        buttons: [],
        axes: [],
      });
      this._pads.sort((a, b) => a.index - b.index);
      for (let i = 0; i < this._pads.length; i++) {
        if (this._pads[i].index === index) {
          slot = i;
          break;
        }
      }
    }
    if (!this._prevButtons[slot]) this._prevButtons[slot] = [];
    if (!this._padJustPressed[slot]) this._padJustPressed[slot] = [];
    if (!this._padJustReleased[slot]) this._padJustReleased[slot] = [];
    return slot;
  }

  /**
   * 轮询 navigator.getGamepads()：
   * 同步按钮/轴数值，并相对上一帧计算本帧 just 触发数组。
   */
  _pollGamepads() {
    if (!navigator.getGamepads) return;
    const list = navigator.getGamepads();

    const seenCount = new Array(this._pads.length);
    for (let i = 0; i < seenCount.length; i++) seenCount[i] = 0;

    for (let i = 0; i < list.length; i++) {
      const gp = list[i];
      if (!gp) continue;
      const slot = this._ensurePadSlot(gp.index, gp.id);
      const pad = this._pads[slot];
      seenCount[slot] = 1;

      const prev = this._prevButtons[slot];
      const justOn = this._padJustPressed[slot];
      const justOff = this._padJustReleased[slot];

      const btnLen = gp.buttons.length;
      for (let b = 0; b < btnLen; b++) {
        const pressed = gp.buttons[b].pressed;
        const was = !!prev[b];
        justOn[b] = pressed && !was;
        justOff[b] = !pressed && was;

        let btn = pad.buttons[b];
        if (!btn) {
          btn = { pressed: false, value: 0 };
          pad.buttons[b] = btn;
        }
        btn.pressed = pressed;
        btn.value = gp.buttons[b].value;
      }
      if (pad.buttons.length > btnLen) pad.buttons.length = btnLen;
      if (justOn.length > btnLen) justOn.length = btnLen;
      if (justOff.length > btnLen) justOff.length = btnLen;

      for (let a = 0; a < gp.axes.length; a++) pad.axes[a] = gp.axes[a];
      if (pad.axes.length > gp.axes.length) pad.axes.length = gp.axes.length;
    }

    // 兜底移除本轮未见到的 pad（正常由事件清理）
    for (let i = this._pads.length - 1; i >= 0; i--) {
      if (!seenCount[i]) {
        this._pads.splice(i, 1);
        this._prevButtons.splice(i, 1);
        this._padJustPressed.splice(i, 1);
        this._padJustReleased.splice(i, 1);
      }
    }
  }

  /** 把当前按钮按下态写入 _prevButtons（在 just 计算之后调用） */
  _snapshotButtons() {
    for (let i = 0; i < this._pads.length; i++) {
      const pad = this._pads[i];
      let prev = this._prevButtons[i];
      if (!prev) {
        prev = [];
        this._prevButtons[i] = prev;
      }
      for (let b = 0; b < pad.buttons.length; b++) {
        prev[b] = pad.buttons[b].pressed;
      }
      if (prev.length > pad.buttons.length) prev.length = pad.buttons.length;
    }
  }

  // ---------- 组合轴 ----------

  /**
   * 轴输出（零 GC）：优先主手柄左摇杆（超死区），否则键盘。
   * @param {string|null} negKeyX
   * @param {string|null} posKeyX
   * @param {string|null} negKeyY
   * @param {string|null} posKeyY
   * @returns {{x:number,y:number}} 模块内部预分配引用
   */
  getAxis(negKeyX, posKeyX, negKeyY, posKeyY) {
    if (this._pads.length) {
      const dz = this.deadzone;
      const pad = this._pads[0];
      const gx = pad.axes[0] || 0;
      const gy = pad.axes[1] || 0;
      const mag = Math.sqrt(gx * gx + gy * gy);
      if (mag >= dz) {
        const scaled = mag > 1 ? 1 : (mag - dz) / (1 - dz);
        const inv = scaled / mag;
        this._axis.x = gx * inv;
        this._axis.y = gy * inv;
        return this._axis;
      }
    }
    let x = 0;
    let y = 0;
    if (negKeyX && this._down.has(negKeyX)) x -= 1;
    if (posKeyX && this._down.has(posKeyX)) x += 1;
    if (negKeyY && this._down.has(negKeyY)) y -= 1;
    if (posKeyY && this._down.has(posKeyY)) y += 1;
    if (x !== 0 && y !== 0) {
      const inv = 0.7071067811865476;
      x *= inv;
      y *= inv;
    }
    this._axis.x = x;
    this._axis.y = y;
    return this._axis;
  }

  // ---------- 帧循环 ----------

  update() {
    // 1) 提升监听器写入的触发状态 → 本帧可见
    this._justPressed.clear();
    for (const code of this._pendingJustPressed) this._justPressed.add(code);
    this._pendingJustPressed.clear();

    this._justReleased.clear();
    for (const code of this._pendingJustReleased) this._justReleased.add(code);
    this._pendingJustReleased.clear();

    // 2) 手柄轮询：相对上一帧快照算 just 数组（数组在本帧后续可被安全读取）
    this._pollGamepads();

    // 3) 把当前按钮态存为"上一帧"，供下轮 poll 比较
    this._snapshotButtons();
  }

  /** 清空本帧键盘触发状态（一般不需要手动调；update 已双缓冲） */
  endFrame() {
    this._justPressed.clear();
    this._justReleased.clear();
  }

  dispose() {
    window.removeEventListener('keydown', this._boundKeyDown);
    window.removeEventListener('keyup', this._boundKeyUp);
    window.removeEventListener('blur', this._boundBlur);
    window.removeEventListener('gamepadconnected', this._boundPadConnected);
    window.removeEventListener('gamepaddisconnected', this._boundPadDisconnected);
    this._down.clear();
    this._justPressed.clear();
    this._justReleased.clear();
    this._pendingJustPressed.clear();
    this._pendingJustReleased.clear();
    this._pads.length = 0;
    this._prevButtons.length = 0;
    this._padJustPressed.length = 0;
    this._padJustReleased.length = 0;
    this._axis.x = 0;
    this._axis.y = 0;
  }
}
