/**
 * 资源目录（AssetCatalog）：游戏登记可放置/可引用资源，工具（如场景编辑器左栏）按分组渲染。
 *
 * 与 AssetLoader 的分工：
 *   AssetLoader  —— 运行时批量加载贴图/JSON/音频，产出 THREE 资源
 *   AssetCatalog —— 目录与元数据（名字、分组、缩略图、kind、data），供 UI 与放置管线
 *
 * asset = {
 *   id: string          全局唯一
 *   group: string       分组名（UI 按此归类）
 *   label: string       显示名
 *   icon?: string       短图标
 *   thumbnail?: string  缩略图 URL（可选）
 *   kind: string        'prefab' | 'image' | 'rig' | 'scene' | ... 自定义
 *   data?: any          类型私有数据（工厂/放置器解释）
 * }
 * 事件：catalog:change { reason:'register'|'remove', id }
 */
export class AssetCatalog {
  static moduleName = 'catalog';

  constructor(engine) {
    this.engine = engine;
    /** @type {Map<string, object>} */
    this._assets = new Map();
    /** @type {string[]} 分组登记顺序 */
    this._groupOrder = [];
  }

  register(asset) {
    if (!asset || !asset.id) {
      console.warn('[AssetCatalog] register 需要 asset.id');
      return null;
    }
    const entry = {
      id: asset.id,
      group: asset.group || '未分组',
      label: asset.label || asset.id,
      icon: asset.icon || '▪',
      thumbnail: asset.thumbnail || null,
      kind: asset.kind || 'generic',
      data: asset.data ?? null,
    };
    if (!this._groupOrder.includes(entry.group)) this._groupOrder.push(entry.group);
    this._assets.set(entry.id, entry);
    this.engine.eventBus.emit('catalog:change', { reason: 'register', id: entry.id });
    return entry;
  }

  remove(id) {
    if (!this._assets.delete(id)) return false;
    this.engine.eventBus.emit('catalog:change', { reason: 'remove', id });
    return true;
  }

  get(id) {
    return this._assets.get(id) || null;
  }

  list() {
    return Array.from(this._assets.values());
  }

  /** [{ group, assets: [...] }]，按登记分组顺序 */
  byGroup() {
    const buckets = new Map();
    for (const g of this._groupOrder) buckets.set(g, []);
    for (const asset of this._assets.values()) {
      if (!buckets.has(asset.group)) buckets.set(asset.group, []);
      buckets.get(asset.group).push(asset);
    }
    const out = [];
    for (const [group, assets] of buckets) out.push({ group, assets });
    return out;
  }

  clear() {
    this._assets.clear();
    this._groupOrder.length = 0;
    this.engine.eventBus.emit('catalog:change', { reason: 'clear', id: null });
  }

  dispose() {
    this.clear();
  }
}
