import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

/**
 * 场景编辑器（内嵌式，零构建，注册表驱动）：
 * 通过 URL `?edit=1` 启用。一套代码两用——编辑模式摆资产，预览模式直接玩。
 *
 * 引擎只认注册表，不认任何游戏名词：
 *   - 工具栏 / 大纲 / 变换 Inspector 为通用机制
 *   - 类型专属 Inspector 经 sceneio.registerType({ inspector, applyProp, ... }) 注入
 *   - 资源栏由 AssetCatalog（catalog）驱动
 *   - 草稿存取经 ScenePersistence（persist）
 *   - 拖放图片 → 查 acceptsAsset/createFromAsset，由游戏决定落成何种类型
 *
 * 编辑态隔离经 EventBus：
 *   editor:enter / editor:exit / editor:preview {previewing}
 *   游戏层订阅后自行隐藏手牌、HUD 等（引擎不引用 hand/hud 业务对象）。
 *   编辑时自动：RaycastManager.enabled=false、PhysicsWorld.paused=true；预览时恢复。
 * 变换三处同步：对象 transform、def、physics.applyTransformFromMesh。
 * 事件：editor:enter/exit/preview/select/rebuild/destroy
 */
export class SceneEditor {
  static moduleName = 'editor';

  constructor(engine, options = {}) {
    this.engine = engine;
    this.grid = options.grid ?? 0.5;
    this.snap = options.snap !== false;
    this.mode = 'move'; // move | rotate | scale → gizmo translate/rotate/scale
    this.previewing = false;

    /** 场景名：persist 存取与导出文件名用 */
    this.sceneName = options.sceneName || 'scene';
    /** 导出下载文件名（不含扩展名）；缺省 = sceneName */
    this.exportName = options.exportName || this.sceneName;
    /** 编辑态隐藏的 HUD 选择器；空字符串则不隐藏 */
    this.hudSelector = options.hudSelector === undefined ? '#hud' : options.hudSelector;
    /** 放置时相对相机目标的落点高度 */
    this.placeOffsetY = options.placeOffsetY ?? 0;

    this._raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this._plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._hit = new THREE.Vector3();

    this.selected = null; // SceneIO entry
    this._helper = null;  // THREE.BoxHelper 选中高亮
    this._tc = null;      // TransformControls
    this._gridHelper = null;
    this._placeSeq = 0;

    this._boundDown = this._onDown.bind(this);
    this._boundKey = this._onKey.bind(this);
    this._boundDragOver = this._onDragOver.bind(this);
    this._boundDrop = this._onDrop.bind(this);
    this._boundDragLeave = this._onDragLeave.bind(this);
    this._boundGizmoChange = this._onGizmoChange.bind(this);
    this._boundSceneSwitched = this._onSceneSwitched.bind(this);
  }

  init() {
    this.sceneio = this.engine.get('sceneio');
    this.raycast = this.engine.get('raycast');
    this.physics = this.engine.get('physics');
    this.cameraCtl = this.engine.get('camera');
    this.persist = this.engine.get('persist');
    this.catalog = this.engine.get('catalog');
    this.billboard = this.engine.get('billboard');
    this.skeletons = this.engine.get('skeletons');

    if (this.raycast) this.raycast.enabled = false;
    if (this.physics) this.physics.paused = true;

    this._setHudVisible(false);

    // ---------- 地面辅助网格（编辑态可见，预览隐藏） ----------
    this._gridHelper = new THREE.GridHelper(20, 40, 0x6ea8fe, 0x2c4460);
    this._gridHelper.position.y = 0.02;
    this._gridHelper.material.transparent = true;
    this._gridHelper.material.opacity = 0.45;
    this.engine.scene.add(this._gridHelper);

    // ---------- TransformControls 操纵轴（先建，抢占 canvas 指针监听顺序） ----------
    this._tc = new TransformControls(this.engine.camera, this.engine.canvas);
    this._tc.setMode('translate');
    this._applySnap();
    this._tc.addEventListener('objectChange', this._boundGizmoChange);
    this.engine.scene.add(this._tc.getHelper());

    this._injectStyle();
    this._buildDom();

    const canvas = this.engine.canvas;
    canvas.addEventListener('pointerdown', this._boundDown);
    window.addEventListener('keydown', this._boundKey);
    window.addEventListener('dragover', this._boundDragOver);
    window.addEventListener('drop', this._boundDrop);
    window.addEventListener('dragleave', this._boundDragLeave);
    this.engine.eventBus.on('scene:switched', this._boundSceneSwitched);
    if (this.catalog) {
      this._boundCatalogChange = () => this._refreshCatalog();
      this.engine.eventBus.on('catalog:change', this._boundCatalogChange);
    }

    this._refreshOutliner();
    this._refreshCatalog();
    this._renderInspector();
    this._status('编辑模式：点击选中 · W/R/S 沿轴变换 · G 吸附 · Ctrl+D 复制 · Del 删除');
    this.engine.eventBus.emit('editor:enter');
  }

  // ---------- 拾取与 Gizmo ----------

  _onDown(e) {
    if (this.previewing || e.button !== 0) return;
    if (this._tc && (this._tc.dragging || this._tc.axis !== null)) return;
    this.select(this._pick(e));
  }

  _onGizmoChange() {
    this._syncTransform();
  }

  _onKey(e) {
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    const key = e.key.toLowerCase();
    if (e.ctrlKey && key === 'd') {
      e.preventDefault();
      this.duplicateSelected();
    } else if (key === 'delete' || key === 'backspace') {
      e.preventDefault();
      this.deleteSelected();
    } else if (key === 'escape') {
      this.select(null);
    } else if (key === 'w') {
      this.setMode('move');
    } else if (key === 'r') {
      this.setMode('rotate');
    } else if (key === 's') {
      this.setMode('scale');
    } else if (key === 'g') {
      this.toggleSnap();
    } else if (key === 'f') {
      this.focusSelected();
    }
  }

  _pick(e) {
    const rect = this.engine.canvas.getBoundingClientRect();
    this._ndc.x = ((e.clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1;
    this._ndc.y = -((e.clientY - rect.top) / Math.max(rect.height, 1)) * 2 + 1;
    this._raycaster.setFromCamera(this._ndc, this.engine.camera);

    const objects = [];
    for (let i = 0; i < this.sceneio.entries.length; i++) objects.push(this.sceneio.entries[i].object);

    const hits = this._raycaster.intersectObjects(objects, true);
    if (!hits.length) return null;
    return this.sceneio.getEntry(hits[0].object);
  }

  _projectGround(e) {
    const rect = this.engine.canvas.getBoundingClientRect();
    this._ndc.x = ((e.clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1;
    this._ndc.y = -((e.clientY - rect.top) / Math.max(rect.height, 1)) * 2 + 1;
    this._raycaster.setFromCamera(this._ndc, this.engine.camera);
    this._plane.set(UP, 0);
    return this._raycaster.ray.intersectPlane(this._plane, this._hit) !== null;
  }

  _syncTransform() {
    const entry = this.selected;
    if (!entry) return;
    SceneIO_writeTransform(entry);
    if (this.physics) this.physics.applyTransformFromMesh(entry.object);
    this._updateTransformFields();
  }

  // ---------- 编辑操作 ----------

  select(entry) {
    if (entry === this.selected) return;
    this.selected = entry;
    this._disposeHelper();
    if (this._tc) this._tc.detach();

    if (entry) {
      this._helper = new THREE.BoxHelper(entry.object, 0x6ea8fe);
      this.engine.scene.add(this._helper);
      if (this._tc && !this.previewing) this._tc.attach(entry.object);
    }
    this._refreshOutliner();
    this._renderInspector();
    this.engine.eventBus.emit('editor:select', { entry });
  }

  setMode(mode) {
    this.mode = mode;
    if (this._tc) this._tc.setMode(mode === 'move' ? 'translate' : mode);
    this._status(`模式: ${mode.toUpperCase()}${this.snap ? ' · 吸附开' : ''}`);
    this._syncModeButtons();
  }

  toggleSnap() {
    this.snap = !this.snap;
    this._applySnap();
    this._status(`网格吸附: ${this.snap ? '开' : '关'}`);
    this._syncModeButtons();
  }

  _applySnap() {
    if (!this._tc) return;
    this._tc.setTranslationSnap(this.snap ? this.grid : null);
    this._tc.setRotationSnap(this.snap ? THREE.MathUtils.degToRad(15) : null);
    this._tc.setScaleSnap(this.snap ? 0.1 : null);
  }

  duplicateSelected() {
    const entry = this.selected;
    if (!entry) return;
    this._syncTransform();
    const def = JSON.parse(JSON.stringify(entry.def));
    def.id = `${def.type}_${Date.now().toString(36)}`;
    def.position.x += this.grid * 2;
    def.position.z += this.grid * 2;
    const created = this.sceneio.createObject(def);
    if (created) {
      this.select(created);
      this._toast(`已复制: ${def.id}`);
    }
  }

  deleteSelected() {
    const entry = this.selected;
    if (!entry) return;
    const id = entry.def.id;
    this.select(null);
    this._destroyEntry(entry);
    this.sceneio.removeObject(id);
    this._refreshOutliner();
    this._toast(`已删除: ${id}`);
  }

  /**
   * 放置类型：合并注册表 defaultProps，落点在相机目标附近地面，连续放置自动错开。
   * overrides 可传 position/props/id。
   */
  placeType(type, overrides = {}) {
    const meta = this.sceneio.getType && this.sceneio.getType(type);
    if (!meta) {
      this._toast(`未注册类型: ${type}`);
      return null;
    }
    const target = this._placeAnchor();
    const n = this._placeSeq++;
    const def = this.sceneio.makeDef(type, {
      position: {
        x: target.x + (overrides.x ?? n * this.grid),
        y: (meta.placeY ?? 0) + this.placeOffsetY,
        z: target.z + (overrides.z ?? 0),
      },
      ...(overrides.id ? { id: overrides.id } : {}),
      props: overrides.props,
    }, n);
    const created = this.sceneio.createObject(def);
    if (created) {
      this.select(created);
      this._toast(`已放置: ${meta.label || type}`);
    }
    return created;
  }

  /** 放置锚点：相机 target 的 xz，缺省原点 */
  _placeAnchor() {
    if (this.cameraCtl && this.cameraCtl.target) {
      return { x: this.cameraCtl.target.x, z: this.cameraCtl.target.z };
    }
    return { x: 0, z: 0 };
  }

  focusSelected() {
    if (!this.selected || !this.cameraCtl) return;
    const p = this.selected.object.position;
    this.cameraCtl.setTarget(p.x, p.y, p.z);
    this._toast(`相机对准: ${this.selected.def.id}`);
  }

  /**
   * 结构级 props 变更：经工厂重建对象，保证几何与刚体一致。
   * 重建前回写变换；rerender=false 时保留面板 DOM（连续键入数字不丢焦点）。
   */
  _rebuild(entry, rerender = true) {
    const def = entry.def;
    SceneIO_writeTransform(entry);
    this._destroyEntry(entry);
    this.sceneio.removeObject(def.id);
    const created = this.sceneio.createObject(def);
    if (!created) {
      this.select(null);
      return;
    }
    if (rerender) {
      this.select(created);
    } else {
      this.selected = created;
      this._disposeHelper();
      this._helper = new THREE.BoxHelper(created.object, 0x6ea8fe);
      this.engine.scene.add(this._helper);
      if (this._tc && !this.previewing) {
        this._tc.detach();
        this._tc.attach(created.object);
      }
      this._refreshOutliner();
    }
    this.engine.eventBus.emit('editor:rebuild', { entry: created });
  }

  /** 模块资源对称清理 + 广播 editor:destroy 供游戏层补线 */
  _destroyEntry(entry) {
    const obj = entry.object;
    if (this.raycast) this.raycast.removeTarget(obj);
    if (this.physics) this.physics.remove(obj);
    if (this.billboard) {
      const unit = findUnit(this.billboard, entry.def.id);
      if (unit) this.billboard.remove(unit);
    }
    const sk = obj.userData && obj.userData.skeleton;
    if (sk && this.skeletons) this.skeletons.remove(sk);
    this.engine.eventBus.emit('editor:destroy', { entry });
  }

  // ---------- 拖放导入图片 → 经类型注册表落成物体 ----------

  _onDragOver(e) {
    if (this.previewing || !hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (this._root) this._root.classList.add('cw-ed-dropping');
  }

  _onDragLeave(e) {
    if (e.relatedTarget === null && this._root) this._root.classList.remove('cw-ed-dropping');
  }

  _onDrop(e) {
    if (this._root) this._root.classList.remove('cw-ed-dropping');
    if (this.previewing || !hasFiles(e)) return;
    e.preventDefault();

    const files = e.dataTransfer.files;
    const images = [];
    for (let i = 0; i < files.length; i++) {
      if (/^image\/(png|jpeg|jpg|webp)$/i.test(files[i].type)) images.push(files[i]);
    }
    if (!images.length) {
      this._toast('仅支持拖入图片文件 (.png / .jpg / .webp)');
      return;
    }

    const ok = this._projectGround(e);
    const bx = ok ? this._hit.x : this._placeAnchor().x;
    const bz = ok ? this._hit.z : this._placeAnchor().z;

    for (let i = 0; i < images.length; i++) {
      const file = images[i];
      const src = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const asset = {
          id: `img_${Date.now().toString(36)}_${i}`,
          kind: 'image',
          group: '图片',
          label: file.name,
          name: file.name,
          src,
          aspect: img.naturalWidth / Math.max(img.naturalHeight, 1),
          img,
        };
        if (this.catalog) {
          this.catalog.register({
            id: asset.id,
            group: asset.group,
            label: asset.label,
            thumbnail: src,
            kind: 'image',
            data: asset,
          });
        }
        this.placeAsset(asset, bx + i * this.grid * 2, bz);
      };
      img.onerror = () => {
        URL.revokeObjectURL(src);
        this._toast(`图片读取失败: ${file.name}`);
      };
      img.src = src;
    }
  }

  /**
   * 把资源落成场景物体：查找 acceptsAsset 的类型，经 createFromAsset 写入 props。
   * 未注册合适类型时提示，不硬编码任何 type 名。
   */
  placeAsset(asset, x = 0, z = 0) {
    const types = this.sceneio.listTypes();
    for (let i = 0; i < types.length; i++) {
      const meta = this.sceneio.getType(types[i].type);
      if (!meta || !meta.acceptsAsset) continue;
      if (!meta.acceptsAsset(asset)) continue;

      const n = this._placeSeq++;
      let def = this.sceneio.makeDef(types[i].type, {
        id: `${types[i].type}_${Date.now().toString(36)}`,
        position: { x, y: (meta.placeY ?? 0) + this.placeOffsetY, z },
      }, n);
      if (meta.createFromAsset) def = meta.createFromAsset(asset, def) || def;
      const created = this.sceneio.createObject(def);
      if (created) {
        this.select(created);
        this._toast(`已放置: ${asset.label || asset.name || asset.id}`);
        return created;
      }
    }
    this._toast('没有接受该资源的已注册类型');
    return null;
  }

  // ---------- 草稿 / 导入导出（经 persist，失败不阻断下载） ----------

  /** 仅保存草稿到持久化后端 */
  saveDraft(name = this.sceneName) {
    if (!this.persist) {
      this._toast('未装载 persist 模块，无法保存草稿');
      return false;
    }
    const data = this.sceneio.serialize(name);
    const ok = this.persist.save(name, data);
    this._status(this._sourceLine(ok ? '已存草稿' : '草稿保存失败'));
    return ok;
  }

  clearDraft(name = this.sceneName) {
    if (!this.persist) {
      this._toast('未装载 persist 模块');
      return false;
    }
    const ok = this.persist.clear(name);
    this._toast(ok ? '已清除草稿，下次加载读场景文件' : '清除草稿失败');
    return ok;
  }

  /** 导出：写草稿 + 下载 JSON（blob src 转 dataURL）+ 可选剪贴板 */
  async exportScene(name = this.sceneName) {
    const data = this.sceneio.serialize(name);
    await this._inlineBlobSources(data);

    const json = JSON.stringify(data, null, 2);
    let draftOk = true;
    if (this.persist) {
      draftOk = this.persist.save(name, data);
    } else {
      draftOk = false;
    }

    const fileName = `${this.exportName || name}.json`;
    try {
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      this._toast(`下载失败: ${err.message}`);
      return;
    }

    const suffix = draftOk ? '已存草稿 + 下载 ' : '草稿失败，已下载 ';
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(json).then(
        () => this._toast(`${suffix}${fileName} + 剪贴板`),
        () => this._toast(`${suffix}${fileName}`),
      );
    } else {
      this._toast(`${suffix}${fileName}`);
    }
  }

  /** 把 def 里 blob: 的 src 转为 dataURL，保证导出文件可迁移 */
  async _inlineBlobSources(data) {
    if (!data || !data.objects) return;
    for (let i = 0; i < data.objects.length; i++) {
      const props = data.objects[i] && data.objects[i].props;
      if (!props || typeof props.src !== 'string' || !props.src.startsWith('blob:')) continue;
      try {
        props.src = await blobToDataURL(props.src);
      } catch (err) {
        this._toast(`图片未能序列化: ${data.objects[i].id || ''}`);
      }
    }
  }

  importFromText(text) {
    try {
      const data = JSON.parse(text);
      for (let i = this.sceneio.entries.length - 1; i >= 0; i--) {
        this._destroyEntry(this.sceneio.entries[i]);
      }
      const entries = this.sceneio.load(data);
      this.select(null);
      this._refreshOutliner();
      this._toast(`已导入 ${entries.length} 个物体`);
    } catch (err) {
      this._toast(`导入失败: ${err.message}`);
    }
  }

  togglePreview() {
    this.previewing = !this.previewing;
    if (this.raycast) this.raycast.enabled = this.previewing;
    if (this.physics) this.physics.paused = !this.previewing;

    if (this.previewing) this.select(null);
    if (this._tc) {
      this._tc.enabled = !this.previewing;
      if (this.previewing) this._tc.detach();
    }
    if (this._gridHelper) this._gridHelper.visible = !this.previewing;

    if (this._root) this._root.style.display = this.previewing ? 'none' : '';
    this._setHudVisible(this.previewing);

    this.engine.eventBus.emit('editor:preview', { previewing: this.previewing });
    this._toast(this.previewing ? '运行预览：游戏交互已启用' : '返回编辑');
  }

  update() {
    if (this._helper) this._helper.update();
    if (this._tc && this._tc.camera !== this.engine.camera) this._tc.camera = this.engine.camera;
  }

  /** 切关后重挂 gizmo/网格，清选中，刷新面板 */
  _onSceneSwitched() {
    this.select(null);
    this._placeSeq = 0;
    if (this._gridHelper && this._gridHelper.parent !== this.engine.scene) {
      this.engine.scene.add(this._gridHelper);
    }
    if (this._tc) {
      const helper = this._tc.getHelper();
      if (helper && helper.parent !== this.engine.scene) this.engine.scene.add(helper);
      this._tc.camera = this.engine.camera;
    }
    this._refreshOutliner();
    this._refreshCatalog();
    this._renderInspector();
  }

  // ---------- DOM ----------

  _buildDom() {
    const root = el('div', 'cw-ed');
    root.innerHTML = `
      <div class="cw-ed-toolbar">
        <button data-mode="move" class="on">移动(W)</button>
        <button data-mode="rotate">旋转(R)</button>
        <button data-mode="scale">缩放(S)</button>
        <button data-act="snap" class="on">吸附(G)</button>
        <span class="cw-ed-sep"></span>
        <button data-act="dup">复制(Ctrl+D)</button>
        <button data-act="del">删除(Del)</button>
        <button data-act="focus">对准(F)</button>
        <span class="cw-ed-sep"></span>
        <button data-act="save">保存草稿</button>
        <button data-act="export">导出JSON</button>
        <button data-act="clearDraft">清除草稿</button>
        <button data-act="import">导入JSON</button>
        <button data-act="preview">▶ 运行预览</button>
      </div>
      <div class="cw-ed-body">
        <aside class="cw-ed-left">
          <h3>场景大纲</h3>
          <div class="cw-ed-outliner"></div>
          <h3>资源</h3>
          <div class="cw-ed-catalog"></div>
          <h3>帮助</h3>
          <div class="cw-ed-help">点击物体或大纲项选中，拖操纵轴沿轴变换。<br>右侧控件改动即时生效。<br>资源栏点选可放置。</div>
        </aside>
        <aside class="cw-ed-right">
          <h3>属性</h3>
          <div class="cw-ed-props"></div>
        </aside>
      </div>
      <div class="cw-ed-status"></div>
    `;
    document.body.appendChild(root);
    this._root = root;

    root.querySelector('.cw-ed-toolbar').addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const mode = btn.dataset.mode;
      const act = btn.dataset.act;
      if (mode) this.setMode(mode);
      else if (act === 'snap') this.toggleSnap();
      else if (act === 'dup') this.duplicateSelected();
      else if (act === 'del') this.deleteSelected();
      else if (act === 'focus') this.focusSelected();
      else if (act === 'save') this.saveDraft();
      else if (act === 'export') this.exportScene();
      else if (act === 'clearDraft') this.clearDraft();
      else if (act === 'import') this._importFile();
      else if (act === 'preview') this.togglePreview();
      this._syncModeButtons();
    });

    const propsBox = root.querySelector('.cw-ed-props');
    propsBox.addEventListener('input', (e) => this._onInspectorEvent(e));
    propsBox.addEventListener('change', (e) => this._onInspectorEvent(e));

    this._syncModeButtons();
  }

  _syncModeButtons() {
    if (!this._root) return;
    const buttons = this._root.querySelectorAll('.cw-ed-toolbar button');
    for (let i = 0; i < buttons.length; i++) {
      const btn = buttons[i];
      if (btn.dataset.mode) btn.classList.toggle('on', btn.dataset.mode === this.mode);
      if (btn.dataset.act === 'snap') btn.classList.toggle('on', this.snap);
    }
  }

  // ---------- 场景大纲 ----------

  _refreshOutliner() {
    const box = this._root && this._root.querySelector('.cw-ed-outliner');
    if (!box) return;
    box.innerHTML = '';
    const entries = this.sceneio.entries;
    if (!entries.length) {
      box.appendChild(el('div', 'cw-ed-help')).textContent = '场景为空';
      return;
    }
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const meta = this.sceneio.getType && this.sceneio.getType(entry.type);
      const rowEl = el('button', 'cw-ed-oitem');
      const icon = el('span', 'ico');
      icon.textContent = (meta && meta.icon) || '▪';
      const id = el('span', 'id');
      id.textContent = entry.def.id;
      const type = el('em', '');
      type.textContent = entry.type;
      rowEl.appendChild(icon);
      rowEl.appendChild(id);
      rowEl.appendChild(type);
      if (entry === this.selected) rowEl.classList.add('on');
      rowEl.addEventListener('click', () => this.select(entry));
      box.appendChild(rowEl);
    }
  }

  // ---------- 资源栏（AssetCatalog 驱动） ----------

  _refreshCatalog() {
    const box = this._root && this._root.querySelector('.cw-ed-catalog');
    if (!box) return;
    box.innerHTML = '';

    // 类型按钮（无 catalog 时至少能按类型放置）
    const types = this.sceneio.listTypes();
    const typeWrap = el('div', 'cw-ed-types');
    for (let i = 0; i < types.length; i++) {
      const btn = el('button', 'cw-ed-type');
      btn.textContent = `${types[i].icon} ${types[i].label}`;
      btn.addEventListener('click', () => this.placeType(types[i].type));
      typeWrap.appendChild(btn);
    }
    if (types.length) {
      box.appendChild(el('div', 'cw-ed-help')).textContent = '类型';
      box.appendChild(typeWrap);
    }

    if (!this.catalog) {
      box.appendChild(el('div', 'cw-ed-help')).textContent = '未装载 catalog 模块';
      return;
    }

    const groups = this.catalog.byGroup();
    let count = 0;
    for (let g = 0; g < groups.length; g++) {
      const group = groups[g];
      // 类型已在上方按钮区列出，跳过 prefab 类资源（若游戏也登记了同名）
      const assets = group.assets.filter((a) => a.kind !== 'prefab');
      if (!assets.length) continue;
      box.appendChild(el('div', 'cw-ed-help')).textContent = group.group;
      for (let i = 0; i < assets.length; i++) {
        const asset = assets[i];
        const btn = el('button', 'cw-ed-img');
        if (asset.thumbnail) {
          const img = el('img', '');
          img.src = asset.thumbnail;
          img.alt = asset.label;
          btn.appendChild(img);
        } else {
          const ico = el('span', 'ico');
          ico.textContent = asset.icon;
          btn.appendChild(ico);
        }
        const name = el('span', '');
        name.textContent = asset.label;
        btn.appendChild(name);
        btn.addEventListener('click', () => this.placeAsset(asset.data || asset));
        box.appendChild(btn);
        count++;
      }
    }
    if (!count && !types.length) {
      box.appendChild(el('div', 'cw-ed-help')).textContent = '暂无资源';
    }
  }

  // ---------- 动态属性面板 ----------

  _renderInspector() {
    const box = this._root && this._root.querySelector('.cw-ed-props');
    if (!box) return;
    box.innerHTML = '';
    const entry = this.selected;
    if (!entry) {
      box.appendChild(el('div', 'cw-ed-help')).textContent =
        '未选中物体。点击场景物体或左侧大纲项进行选择。';
      return;
    }

    box.appendChild(row('id', readonlyText(entry.def.id)));
    box.appendChild(row('type', readonlyText(entry.def.type)));
    const obj = entry.object;
    box.appendChild(row('pos.x', numInput('px', obj.position.x, 0.05)));
    box.appendChild(row('pos.y', numInput('py', obj.position.y, 0.05)));
    box.appendChild(row('pos.z', numInput('pz', obj.position.z, 0.05)));
    box.appendChild(row('rot.y°', numInput('ry', THREE.MathUtils.radToDeg(obj.rotation.y), 1)));
    box.appendChild(row('scale', numInput('s', obj.scale.x, 0.05)));

    const meta = this.sceneio.getType && this.sceneio.getType(entry.type);
    if (meta && typeof meta.inspector === 'function') {
      meta.inspector(box, entry, this);
    } else {
      box.appendChild(el('div', 'cw-ed-help')).textContent = '该类型无专属属性';
    }
  }

  _updateTransformFields() {
    if (!this._root) return;
    const entry = this.selected;
    if (!entry) return;
    const obj = entry.object;
    const values = {
      px: obj.position.x.toFixed(2),
      py: obj.position.y.toFixed(2),
      pz: obj.position.z.toFixed(2),
      ry: THREE.MathUtils.radToDeg(obj.rotation.y).toFixed(1),
      s: obj.scale.x.toFixed(2),
    };
    for (const key of Object.keys(values)) {
      const input = this._root.querySelector(`[data-t="${key}"]`);
      if (input && document.activeElement !== input) input.value = values[key];
    }
  }

  _onInspectorEvent(e) {
    const t = e.target;
    if (!t || !t.dataset) return;
    const discrete = t.tagName === 'SELECT' || t.type === 'checkbox';
    if (discrete !== (e.type === 'change')) return;

    const entry = this.selected;
    if (!entry) return;

    // 通用变换字段
    if (t.dataset.t) {
      const v = parseFloat(t.value);
      if (!Number.isFinite(v)) return;
      const obj = entry.object;
      const key = t.dataset.t;
      if (key === 'px') obj.position.x = v;
      else if (key === 'py') obj.position.y = v;
      else if (key === 'pz') obj.position.z = v;
      else if (key === 'ry') obj.rotation.y = THREE.MathUtils.degToRad(v);
      else if (key === 's') obj.scale.setScalar(v);
      this._syncTransform();
      return;
    }

    // 类型专属字段 → 注册表 applyProp
    if (t.dataset.k) {
      const key = t.dataset.k;
      const value = t.type === 'checkbox' ? t.checked
        : t.type === 'range' || t.type === 'number' ? parseFloat(t.value)
        : t.value;
      this._applyProp(entry, key, value, t);
    }
  }

  /**
   * props 应用：优先类型注册表 applyProp；未处理则通用写入 def.props。
   * 需要几何重建时由 applyProp 调用 editor._rebuild。
   */
  _applyProp(entry, key, value, inputEl) {
    const meta = this.sceneio.getType && this.sceneio.getType(entry.type);
    if (meta && typeof meta.applyProp === 'function') {
      const handled = meta.applyProp(entry, key, value, inputEl, this);
      if (handled !== false) return;
    }
    const props = entry.def.props || (entry.def.props = {});
    props[key] = value;
    // 同步只读 output（range 控件）
    if (inputEl && inputEl.parentElement) {
      const out = inputEl.parentElement.querySelector('output');
      if (out && typeof value === 'number') out.textContent = value.toFixed(1);
    }
  }

  _importFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => this.importFromText(String(reader.result));
      reader.readAsText(file);
    });
    input.click();
  }

  _setHudVisible(visible) {
    if (!this.hudSelector) return;
    const hud = document.querySelector(this.hudSelector);
    if (hud) hud.style.display = visible ? '' : 'none';
  }

  _disposeHelper() {
    if (!this._helper) return;
    this.engine.scene.remove(this._helper);
    if (this._helper.geometry) this._helper.geometry.dispose();
    if (this._helper.material) this._helper.material.dispose();
    this._helper = null;
  }

  _injectStyle() {
    if (document.getElementById('cw-ed-style')) return;
    const style = document.createElement('style');
    style.id = 'cw-ed-style';
    style.textContent = `
      .cw-ed { position: fixed; inset: 0; z-index: 30; display: flex; flex-direction: column;
        pointer-events: none; font: 12px/1.6 "PingFang SC","Microsoft YaHei",system-ui,sans-serif; color: #eef2f7; }
      .cw-ed-toolbar { pointer-events: auto; display: flex; gap: 6px; flex-wrap: wrap; align-items: center;
        padding: 8px 10px; background: rgba(14,18,26,.82); border-bottom: 1px solid rgba(255,255,255,.12); }
      .cw-ed-toolbar button, .cw-ed-types button, .cw-ed-oitem, .cw-ed-img, .cw-ed-props button {
        cursor: pointer; border: 1px solid rgba(255,255,255,.16); background: rgba(255,255,255,.08);
        color: inherit; border-radius: 8px; padding: 5px 10px; font-size: 12px; }
      .cw-ed-toolbar button.on, .cw-ed-oitem.on { background: rgba(110,168,254,.45); border-color: #6ea8fe; }
      .cw-ed-sep { width: 1px; height: 18px; background: rgba(255,255,255,.18); margin: 0 4px; }
      .cw-ed-body { flex: 1; display: flex; justify-content: space-between; min-height: 0; }
      .cw-ed-left, .cw-ed-right { pointer-events: auto; width: 220px; margin: 10px; padding: 10px;
        background: rgba(14,18,26,.78); border: 1px solid rgba(255,255,255,.12); border-radius: 12px;
        overflow: auto; }
      .cw-ed h3 { margin: 2px 0 8px; font-size: 12px; opacity: .85; letter-spacing: .05em; }
      .cw-ed-types { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
      .cw-ed-types button { text-align: left; }
      .cw-ed-help { font-size: 11px; opacity: .7; margin: 6px 0; }
      .cw-ed-outliner { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
      .cw-ed-oitem { display: flex; align-items: center; gap: 6px; text-align: left; padding: 4px 8px; }
      .cw-ed-oitem .id { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .cw-ed-oitem em { font-style: normal; opacity: .55; font-size: 10px; }
      .cw-ed-catalog { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
      .cw-ed-img { display: flex; align-items: center; gap: 8px; padding: 4px 8px; text-align: left; }
      .cw-ed-img img { width: 30px; height: 30px; object-fit: contain; border-radius: 6px;
        background: rgba(255,255,255,.1); }
      .cw-ed-img span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
      .cw-ed-props label { display: block; margin-bottom: 6px; opacity: .85; }
      .cw-ed-props input:not([type="checkbox"]):not([type="range"]), .cw-ed-props select {
        display: block; width: 100%; box-sizing: border-box;
        margin-top: 2px; padding: 4px 6px; border-radius: 6px; border: 1px solid rgba(255,255,255,.16);
        background: rgba(255,255,255,.08); color: inherit; font-size: 12px; }
      .cw-ed-props input[type="color"] { display: block; width: 100%; height: 28px; margin-top: 2px;
        padding: 0; border: 1px solid rgba(255,255,255,.16); border-radius: 6px;
        background: transparent; cursor: pointer; }
      .cw-ed-props input[type="range"] { width: 100%; margin-top: 4px; accent-color: #6ea8fe; }
      .cw-ed-props input[type="checkbox"] { accent-color: #6ea8fe; margin-right: 6px; }
      .cw-ed-props output { opacity: .75; font-size: 11px; }
      .cw-ed-status { pointer-events: none; margin: 0 10px 10px; padding: 6px 10px;
        background: rgba(14,18,26,.78); border: 1px solid rgba(255,255,255,.12); border-radius: 10px;
        font-size: 11px; opacity: .9; }
      .cw-ed.cw-ed-dropping::after { content: '松手导入图片资源'; position: absolute; inset: 40px 230px;
        display: flex; align-items: center; justify-content: center; border: 2px dashed #6ea8fe;
        border-radius: 16px; background: rgba(110,168,254,.12); font-size: 18px; letter-spacing: .1em; }
    `;
    document.head.appendChild(style);
  }

  _status(text) {
    this._statusEl = this._root ? this._root.querySelector('.cw-ed-status') : null;
    if (this._statusEl) this._statusEl.textContent = text;
  }

  _sourceLine(base) {
    let source = '未持久化';
    if (this.persist) {
      source = this.persist.load(this.sceneName) ? '草稿' : '场景文件';
    }
    return `${base} · 数据来源: ${source}`;
  }

  _toast(text) {
    this._status(text);
  }

  dispose() {
    const canvas = this.engine.canvas;
    canvas.removeEventListener('pointerdown', this._boundDown);
    window.removeEventListener('keydown', this._boundKey);
    window.removeEventListener('dragover', this._boundDragOver);
    window.removeEventListener('drop', this._boundDrop);
    window.removeEventListener('dragleave', this._boundDragLeave);
    this.engine.eventBus.off('scene:switched', this._boundSceneSwitched);
    if (this._boundCatalogChange) this.engine.eventBus.off('catalog:change', this._boundCatalogChange);

    if (this._tc) {
      this._tc.removeEventListener('objectChange', this._boundGizmoChange);
      this._tc.detach();
      this.engine.scene.remove(this._tc.getHelper());
      this._tc.dispose();
      this._tc = null;
    }
    if (this._gridHelper) {
      this.engine.scene.remove(this._gridHelper);
      this._gridHelper.geometry.dispose();
      this._gridHelper.material.dispose();
      this._gridHelper = null;
    }
    this._disposeHelper();
    if (this._root) this._root.remove();
    if (this.raycast) this.raycast.enabled = true;
    if (this.physics) this.physics.paused = false;
    this._setHudVisible(true);
    this.engine.eventBus.emit('editor:exit');
  }
}

// ---------- DOM 小工具（导出供游戏层 Inspector 使用） ----------

export function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

export function row(labelText, input) {
  const label = el('label', '');
  label.textContent = labelText + ' ';
  label.appendChild(input);
  return label;
}

export function readonlyText(value) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  input.readOnly = true;
  return input;
}

export function numInput(field, value, step, mode = 't') {
  const input = document.createElement('input');
  input.type = 'number';
  input.step = String(step);
  input.value = Number(value).toFixed(step < 0.1 ? 2 : 1);
  input.dataset[mode] = field;
  return input;
}

export function colorInput(value) {
  const input = document.createElement('input');
  input.type = 'color';
  input.value = value;
  input.dataset.k = 'color';
  return input;
}

export function selectInput(field, options, value) {
  const select = document.createElement('select');
  select.dataset.k = field;
  for (let i = 0; i < options.length; i++) {
    const opt = document.createElement('option');
    opt.value = options[i][0];
    opt.textContent = options[i][1];
    if (options[i][0] === value) opt.selected = true;
    select.appendChild(opt);
  }
  return select;
}

export function checkboxInput(field, checked) {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.dataset.k = field;
  return input;
}

export function rangeInput(field, value, min, max, step) {
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.dataset.k = field;
  return input;
}

export function findUnit(billboard, id) {
  if (!billboard) return null;
  for (let i = 0; i < billboard.units.length; i++) {
    if (billboard.units[i].id === id) return billboard.units[i];
  }
  return null;
}

const UP = new THREE.Vector3(0, 1, 0);

function hasFiles(e) {
  if (!e.dataTransfer) return false;
  const types = e.dataTransfer.types;
  for (let i = 0; i < types.length; i++) {
    if (types[i] === 'Files') return true;
  }
  return false;
}

function blobToDataURL(blobUrl) {
  return fetch(blobUrl)
    .then((res) => res.blob())
    .then((blob) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    }));
}

function SceneIO_writeTransform(entry) {
  const def = entry.def;
  const obj = entry.object;
  def.position.x = obj.position.x;
  def.position.y = obj.position.y;
  def.position.z = obj.position.z;
  def.rotation.x = obj.rotation.x;
  def.rotation.y = obj.rotation.y;
  def.rotation.z = obj.rotation.z;
  def.scale.x = obj.scale.x;
  def.scale.y = obj.scale.y;
  def.scale.z = obj.scale.z;
}
