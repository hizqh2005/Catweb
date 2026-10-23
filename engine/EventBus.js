/**
 * 轻量发布/订阅事件系统。
 * emit 遍历 Set 本身（不拷贝数组），保证帧循环内零 GC 分配；
 * 订阅中新增的监听器本轮不触发，退订的监听器立即失效。
 */
export class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._channels = new Map();
    /** @type {Set<Function>} */
    this._any = new Set();
  }

  on(type, handler) {
    let set = this._channels.get(type);
    if (!set) {
      set = new Set();
      this._channels.set(type, set);
    }
    set.add(handler);
    return () => this.off(type, handler);
  }

  once(type, handler) {
    const wrapper = (payload) => {
      this.off(type, wrapper);
      handler(payload);
    };
    return this.on(type, wrapper);
  }

  off(type, handler) {
    const set = this._channels.get(type);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) this._channels.delete(type);
  }

  onAny(handler) {
    this._any.add(handler);
    return () => this.offAny(handler);
  }

  offAny(handler) {
    this._any.delete(handler);
  }

  emit(type, payload) {
    const set = this._channels.get(type);
    if (set) {
      for (const handler of set) handler(payload, type);
    }
    for (const handler of this._any) handler(payload, type);
  }

  clear(type) {
    if (type === undefined) {
      this._channels.clear();
      this._any.clear();
      return;
    }
    this._channels.delete(type);
  }
}
