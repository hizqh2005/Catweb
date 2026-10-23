/**
 * 场景持久化服务：场景 JSON 的 load / save / clear / list，可插拔存储后端。
 *
 * 设计：引擎只定义 Adapter 接口与错误广播，不关心游戏用什么前缀、什么介质。
 *   adapter = {
 *     load(name) -> object|null,
 *     save(name, data) -> void,
 *     clear(name) -> void,
 *     list() -> string[],
 *   }
 * 默认 LocalStorageAdapter；游戏可换 File / 自定义后端。
 * 事件：persist:saved / persist:loaded / persist:cleared / persist:error
 */

/** localStorage 后端：key = keyPrefix + name，全部 try/catch，不向调用方抛存储异常 */
export function createLocalStorageAdapter(keyPrefix = 'app.scene.') {
  return {
    load(name) {
      try {
        const raw = localStorage.getItem(keyPrefix + name);
        return raw ? JSON.parse(raw) : null;
      } catch (err) {
        return null;
      }
    },
    save(name, data) {
      localStorage.setItem(keyPrefix + name, JSON.stringify(data));
    },
    clear(name) {
      localStorage.removeItem(keyPrefix + name);
    },
    list() {
      const out = [];
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.startsWith(keyPrefix)) out.push(key.slice(keyPrefix.length));
        }
      } catch (err) { /* 隐私模式等 */ }
      return out;
    },
  };
}

export class ScenePersistence {
  static moduleName = 'persist';

  constructor(engine, options = {}) {
    this.engine = engine;
    this.keyPrefix = options.keyPrefix ?? 'app.scene.';
    this.adapter = options.adapter || createLocalStorageAdapter(this.keyPrefix);
  }

  configure({ keyPrefix, adapter } = {}) {
    if (keyPrefix !== undefined) this.keyPrefix = keyPrefix;
    if (adapter) this.adapter = adapter;
  }

  load(name) {
    try {
      const data = this.adapter.load(name);
      if (data) this.engine.eventBus.emit('persist:loaded', { name, data });
      return data;
    } catch (err) {
      this.engine.eventBus.emit('persist:error', { op: 'load', name, error: err });
      return null;
    }
  }

  /** 存储失败不抛出，广播 persist:error 并返回 false */
  save(name, data) {
    try {
      this.adapter.save(name, data);
      this.engine.eventBus.emit('persist:saved', { name });
      return true;
    } catch (err) {
      this.engine.eventBus.emit('persist:error', { op: 'save', name, error: err });
      return false;
    }
  }

  clear(name) {
    try {
      this.adapter.clear(name);
      this.engine.eventBus.emit('persist:cleared', { name });
      return true;
    } catch (err) {
      this.engine.eventBus.emit('persist:error', { op: 'clear', name, error: err });
      return false;
    }
  }

  list() {
    try {
      return this.adapter.list() || [];
    } catch (err) {
      this.engine.eventBus.emit('persist:error', { op: 'list', name: null, error: err });
      return [];
    }
  }

  dispose() {
    /* adapter 后端无引擎侧资源；若游戏传入自定义 adapter，可自行 dispose */
  }
}
