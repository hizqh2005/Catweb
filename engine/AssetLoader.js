import * as THREE from 'three';

/**
 * 资源加载器：统一管理 Texture / JSON / Audio 预加载与进度回调。
 * 单项失败不阻塞整体（默认宽松模式），并通过 EventBus 广播进度。
 */
export class AssetLoader {
  static moduleName = 'assets';

  constructor(engine) {
    this.engine = engine;
    this._cache = new Map();
    this._textureLoader = new THREE.TextureLoader();
    this._loaded = 0;
    this._total = 0;
    this._tempProgress = { name: '', loaded: 0, total: 0, percent: 0 };
  }

  /**
   * @param {Array<{name:string,type:'texture'|'json'|'audio',url:string}>} manifest
   */
  async load(manifest, options = {}) {
    const strict = options.strict === true;
    this._loaded = 0;
    this._total = manifest.length;

    const results = new Map();
    for (const item of manifest) {
      try {
        const asset = await this._loadOne(item);
        this._cache.set(item.name, asset);
        results.set(item.name, asset);
      } catch (err) {
        console.warn(`[AssetLoader] 加载失败: ${item.url}`, err);
        if (strict) throw err;
      } finally {
        this._loaded++;
        this._tempProgress.name = item.name;
        this._tempProgress.loaded = this._loaded;
        this._tempProgress.total = this._total;
        this._tempProgress.percent = this._total ? this._loaded / this._total : 1;
        this.engine.eventBus.emit('assets:progress', this._tempProgress);
      }
    }

    this.engine.eventBus.emit('assets:done', results);
    return results;
  }

  async _loadOne(item) {
    switch (item.type) {
      case 'texture':
        return this.loadTexture(item.url);
      case 'json':
        return this.loadJSON(item.url);
      case 'audio':
        return this.loadAudio(item.url);
      default:
        throw new Error(`[AssetLoader] 未知资源类型: ${item.type}`);
    }
  }

  loadTexture(url) {
    return new Promise((resolve, reject) => {
      this._textureLoader.load(
        url,
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          resolve(tex);
        },
        undefined,
        reject,
      );
    });
  }

  async loadJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async loadAudio(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = await res.arrayBuffer();
    const audio = this.engine.get('audio');
    if (audio && typeof audio.decode === 'function') return audio.decode(buffer);
    return buffer;
  }

  set(name, asset) {
    this._cache.set(name, asset);
    return asset;
  }

  get(name) {
    return this._cache.get(name) || null;
  }

  has(name) {
    return this._cache.has(name);
  }

  release(name) {
    const asset = this._cache.get(name);
    if (asset && asset.isTexture) asset.dispose();
    this._cache.delete(name);
  }

  dispose() {
    for (const [name] of this._cache) this.release(name);
    this._cache.clear();
  }
}
