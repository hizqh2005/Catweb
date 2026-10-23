import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import gsap from 'gsap';
import {
  el, row, numInput, colorInput, selectInput, checkboxInput, rangeInput, findUnit,
} from '../engine/SceneEditor.js';

// 帧循环复用的模块级临时量（GC 铁律）
const _tmpV3 = new THREE.Vector3();
const _tmpQuat = new THREE.Quaternion();
const _localPoint = new THREE.Vector3();

// 骰子面法线（本地空间）→ 点数（对面点数之和为 7）
const DICE_FACES = [
  { value: 2, normal: new THREE.Vector3(1, 0, 0) },
  { value: 5, normal: new THREE.Vector3(-1, 0, 0) },
  { value: 1, normal: new THREE.Vector3(0, 1, 0) },
  { value: 6, normal: new THREE.Vector3(0, -1, 0) },
  { value: 3, normal: new THREE.Vector3(0, 0, 1) },
  { value: 4, normal: new THREE.Vector3(0, 0, -1) },
];

const CARD_TITLES = ['火球', '冰锥', '护盾', '雷击', '疾风', '治疗', '侦查', '重击'];
const CARD_HUES = [8, 205, 152, 48, 320, 128, 262, 0];

// 走位与跳跃手感常量（零 GC：模块级常量，禁止在 update 内 new）
const PLAYER_SPEED = 5.0;
const JUMP_VELOCITY = 6.8;
const GRAVITY = 20.0;

/**
 * 综合测试沙盒：3D 牌桌 + 可拖拽扇形手牌 + 2.5D 分件骨骼纸片人 + 物理骰子。
 *
 * v2 架构：场景由【场景 JSON】驱动（localStorage 草稿 → /assets/scenes/sandbox.json → 内联默认），
 * 物体通过 SceneIO 工厂注册（table / prop / skeleton / dice），可在 ?edit=1 编辑器里摆完导出 JSON。
 * 纸片人由 Skeleton2D 分件骨骼驱动（程序化待机/走路 + 关键帧挥手）。
 *
 * v4 解耦：本关自持 THREE.Scene（灯光/雾/地面等环境全部私有），由 SceneDirector 装载调度；
 * init 里 engine.setScene(this.scene) 激活渲染目标，dispose 整体卸载，杜绝多光源残留过曝。
 */
export class SandboxScene {
  static moduleName = 'sandbox';

  constructor(engine) {
    this.engine = engine;

    // 关卡私有三维场景：环境与场景物体全挂这里，切关时随 dispose 整体卸载
    this.scene = new THREE.Scene();

    this._cardSeq = 0;
    this._cardTargets = new Map();
    this._faceTextureCache = new Map();
    this._partTextureCache = new Map();
    this._diceResult = 0;
    this._diceSettled = true;
    this._bgmOn = false;
    this._walking = false;

    this._statTimer = 0;
    this._fpsSmooth = 60;
    this._toastTimer = 0;

    this._tableBounds = { x: 6.4, z: 3.8 };
    this._dragHeight = 1.9;

    // 走位/跳跃（Kinematic，禁用刚体驱动角色）
    this._velY = 0;
    this._grounded = true;
    this._moving = false;

    this._boundStat = this._writeStat.bind(this);
  }

  async init() {
    const engine = this.engine;
    this.audio = engine.get('audio');
    this.cameraCtl = engine.get('camera');
    this.physics = engine.get('physics');
    this.raycast = engine.get('raycast');
    this.hand = engine.get('hand');
    this.billboard = engine.get('billboard');
    this.skeletons = engine.get('skeletons');
    this.sceneio = engine.get('sceneio');
    this.persist = engine.get('persist');
    this.catalog = engine.get('catalog');
    this.input = engine.get('input');
    this.collision = engine.get('collision');

    // 激活本关渲染目标：此后 engine.scene === this.scene，各引擎模块挂对象都进本关
    engine.setScene(this.scene);

    this._buildEnvironment();

    // 部件贴图解析器注入骨骼系统（程序化贴图，零外部文件）
    this.skeletons.setTextureResolver((name) => this._getPartTexture(name));

    this._rigs = { hero: await this._loadRig() };
    this._registerSceneTypes();

    const sceneDef = await this._loadSceneDef();
    this.sceneio.load(sceneDef);
    this._wireSceneObjects();

    // 输入/碰撞链路验证：受击盒 + 触发区域
    this._setupMovementColliders();

    // 编辑器重建对象（改形状/尺寸等经工厂重建）后重新挂交互
    this._boundRewire = (payload) => {
      if (payload && payload.entry) this._wireEntry(payload.entry);
    };
    engine.eventBus.on('editor:rebuild', this._boundRewire);

    // 编辑器让位：手牌/HUD 显隐由游戏层订阅（引擎不引用业务对象）
    this._boundEditorEnter = () => this._setEditorChrome(true);
    this._boundEditorExit = () => this._setEditorChrome(false);
    this._boundEditorPreview = ({ previewing }) => this._setEditorChrome(!previewing);
    engine.eventBus.on('editor:enter', this._boundEditorEnter);
    engine.eventBus.on('editor:exit', this._boundEditorExit);
    engine.eventBus.on('editor:preview', this._boundEditorPreview);

    this._bindInteractions();
    this._bindHud();

    // 手牌根节点：抬到镜头近侧，微微朝向相机
    this.handRoot = new THREE.Group();
    this.handRoot.position.set(0, 1.25, 7.4);
    this.handRoot.rotation.set(-0.22, -0.3, 0);
    this.scene.add(this.handRoot);
    this.hand.setRoot(this.handRoot);

    for (let i = 0; i < 5; i++) this.drawCard(true);

    engine.eventBus.on('core:resize', this._boundStat);
    this._writeStat();
    this._toast('拖动手牌 / 点击纸片人 / 点击掷骰 / ?edit=1 进编辑器');
  }

  // ---------- 环境（灯光/雾/地面，代码内置不属于场景 JSON，全挂本关私有场景） ----------

  _buildEnvironment() {
    const scene = this.scene;
    scene.background = new THREE.Color(0x0d1420);
    scene.fog = new THREE.Fog(0x0d1420, 34, 96);

    const hemi = new THREE.HemisphereLight(0xbcd6ff, 0x24301c, 0.9);
    scene.add(hemi);

    const dir = new THREE.DirectionalLight(0xfff1dc, 1.35);
    dir.position.set(9, 17, 11);
    dir.castShadow = true;
    dir.shadow.mapSize.set(2048, 2048);
    dir.shadow.camera.left = -16;
    dir.shadow.camera.right = 16;
    dir.shadow.camera.top = 16;
    dir.shadow.camera.bottom = -16;
    dir.shadow.camera.near = 1;
    dir.shadow.camera.far = 60;
    dir.shadow.bias = -0.0006;
    scene.add(dir);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(160, 160),
      new THREE.MeshStandardMaterial({ color: 0x17212e, roughness: 1, metalness: 0 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -1.6;
    ground.receiveShadow = true;
    scene.add(ground);

    // 地面刚体：兜住滚出桌沿的骰子，避免无限下坠
    this.physics.addGround(null, { position: { x: 0, y: -1.6, z: 0 } });
  }

  // ---------- 场景数据加载（草稿 → 文件 → 内联兜底） ----------

  /** 场景数据加载（persist 草稿 → 文件 → 内联兜底） */
  async _loadSceneDef() {
    if (this.persist) {
      const draft = this.persist.load('sandbox');
      if (draft) return draft;
    }
    try {
      const res = await fetch('./assets/scenes/sandbox.json');
      if (res.ok) return await res.json();
    } catch (err) { /* 离线/404 走内联 */ }
    return DEFAULT_SCENE;
  }

  async _loadRig() {
    try {
      const res = await fetch('./assets/rigs/hero.json');
      if (res.ok) return await res.json();
    } catch (err) { /* 离线/404 走内联 */ }
    return RIG_HERO;
  }

  // ---------- 场景物体工厂（SceneIO 注册，编辑器资源面板同源） ----------

  _registerSceneTypes() {
    const sceneio = this.sceneio;

    sceneio.registerType('table', (def) => this._makeTable(def), {
      label: '牌桌', icon: '▦', placeY: -0.4, defaultProps: {},
    });

    sceneio.registerType('prop', (def) => this._makeProp(def), {
      label: '道具', icon: '◆', placeY: 0.5,
      defaultProps: { shape: 'box', color: '#8899bb', size: 1 },
      inspector: buildPropInspector,
      applyProp: applyPropFields,
    });

    sceneio.registerType('skeleton', (def) => this._makeSkeleton(def), {
      label: '纸片人', icon: '♟', placeY: 0,
      defaultProps: { rig: 'hero', facing: 'yaw', shadow: true, shadowSize: 2.3 },
      inspector: buildFacingInspector,
      applyProp: applyBillboardFields,
    });

    sceneio.registerType('billboard', (def) => this._makeBillboard(def), {
      label: '图片纸片人', icon: '▤', placeY: 0,
      defaultProps: { facing: 'yaw', shadow: true, shadowSize: 1.9 },
      inspector: (box, entry, editor) => {
        const props = entry.def.props || {};
        const src = typeof props.src === 'string' ? props.src : '';
        const label = src.startsWith('data:') ? 'dataURL 图片' : (src.split('/').pop() || src || '未设置');
        box.appendChild(row('图片', readonlyLike(label)));
        buildFacingInspector(box, entry, editor);
      },
      applyProp: applyBillboardFields,
      acceptsAsset: (asset) => asset && asset.kind === 'image' && !!asset.src,
      createFromAsset: (asset, def) => {
        def.props = {
          ...def.props,
          src: asset.src,
          aspect: asset.aspect ?? 0.72,
          facing: 'yaw',
          shadow: true,
          shadowSize: 1.9,
        };
        return def;
      },
    });

    sceneio.registerType('dice', (def) => this._makeDice(def), {
      label: '骰子', icon: '⚂', placeY: 0.8, defaultProps: {},
    });

    // 资源目录：供编辑器资源栏放置
    if (this.catalog) {
      this.catalog.register({ id: 'rig_hero', group: '骨骼', label: 'hero 分件骨骼', icon: '♟', kind: 'rig', data: { rig: 'hero' } });
      this.catalog.register({ id: 'scene_sandbox', group: '场景', label: 'sandbox.json', icon: '▦', kind: 'scene', data: { url: './assets/scenes/sandbox.json' } });
    }
  }

  /** 编辑器 enter/exit/preview 时的视口让位（手牌 + HUD） */
  _setEditorChrome(editing) {
    if (this.hand && this.hand.root && this.hand.root !== this.engine.scene) {
      this.hand.root.visible = !editing;
    }
    const hud = document.getElementById('hud');
    if (hud) hud.style.display = editing ? 'none' : '';
  }

  _makeTable() {
    const felt = makeFeltTexture();
    const wood = new THREE.MeshStandardMaterial({ color: 0x4a2f1c, roughness: 0.72, metalness: 0.05 });
    const feltMat = new THREE.MeshStandardMaterial({ map: felt, roughness: 0.92, metalness: 0.02 });

    // 物体原点 = 物理盒中心（编辑器平移语义与刚体一致）
    const table = new THREE.Mesh(
      new THREE.BoxGeometry(14, 0.8, 9),
      [wood, wood, feltMat, wood, wood, wood],
    );
    table.castShadow = true;
    table.receiveShadow = true;

    const rim = new THREE.Mesh(
      new THREE.BoxGeometry(14.6, 0.28, 9.6),
      new THREE.MeshStandardMaterial({ color: 0x2c1c10, roughness: 0.6 }),
    );
    rim.position.set(0, -0.44, 0);
    rim.receiveShadow = true;
    table.add(rim);

    this.physics.addBox(table, {
      size: { x: 14, y: 0.8, z: 9 },
      mass: 0,
      position: { x: 0, y: -0.4, z: 0 },
      restitution: 0.34,
    });
    return table;
  }

  _makeProp(def) {
    const props = def.props || {};
    const color = new THREE.Color(props.color || '#8899bb');
    const material = new THREE.MeshStandardMaterial({ color, roughness: 0.68, metalness: 0.06 });

    let mesh;
    let size = { x: 1, y: 1, z: 1 };
    const shape = props.shape || 'box';
    if (shape === 'cylinder') {
      const r = props.radius ?? 0.6;
      const h = props.height ?? 1.2;
      mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 24), material);
      size = { x: r * 2, y: h, z: r * 2 };
    } else if (shape === 'sphere') {
      const r = props.radius ?? 0.6;
      mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 14), material);
      size = { x: r * 2, y: r * 2, z: r * 2 };
    } else {
      const s = props.size ?? 1;
      mesh = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), material);
      size = { x: s, y: s, z: s };
    }
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    // 静态碰撞体（原点 = 网格原点），骰子可与之碰撞
    this.physics.addBox(mesh, {
      size,
      mass: 0,
      position: {
        x: def.position?.x || 0,
        y: def.position?.y || 0,
        z: def.position?.z || 0,
      },
    });
    return mesh;
  }

  _makeSkeleton(def) {
    const props = def.props || {};
    const rig = this._rigs[props.rig || 'hero'] || this._rigs.hero;
    const sk = this.skeletons.spawn(rig, {});
    sk.startProcedural('idle');

    const unit = this.billboard.spawn({
      id: def.id,
      object: sk.root,
      facing: props.facing || 'yaw',
      shadowTexture: makeShadowTexture(),
      shadowSize: props.shadowSize ?? 2.3,
      shadowOpacity: 0.5,
    });
    // 软影常驻、用 visible 开关：编辑器切换阴影免重建对象
    if (unit.shadow) unit.shadow.visible = props.shadow !== false;
    return sk.root;
  }

  /** 图片纸片人：拖放导入的贴图直接成 2.5D 公告板（原点=脚底，props.src=贴图地址） */
  _makeBillboard(def) {
    const props = def.props || {};
    const aspect = props.aspect || 0.72;
    const height = props.height ?? 2.6;
    const width = height * aspect;

    const texture = new THREE.TextureLoader().load(props.src);
    texture.colorSpace = THREE.SRGBColorSpace;

    const group = new THREE.Group();
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(width, height),
      new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        alphaTest: 0.02,
        side: THREE.DoubleSide,
      }),
    );
    plane.position.y = height / 2;
    group.add(plane);

    const unit = this.billboard.spawn({
      id: def.id,
      object: group,
      facing: props.facing || 'yaw',
      shadowTexture: makeShadowTexture(),
      shadowSize: props.shadowSize ?? Math.max(width, 1.2),
      shadowOpacity: 0.45,
    });
    if (unit.shadow) unit.shadow.visible = props.shadow !== false;
    return group;
  }

  _makeDice(def) {
    const size = 1.35;
    const materials = [];
    // 材质槽顺序 = BoxGeometry 面序 [+X,-X,+Y,-Y,+Z,-Z]，点数必须与 DICE_FACES 读点映射一致
    for (let i = 0; i < 6; i++) {
      materials.push(new THREE.MeshStandardMaterial({
        map: makeDiceFaceTexture([2, 5, 1, 6, 3, 4][i]),
        roughness: 0.42,
        metalness: 0.06,
      }));
    }

    const dice = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), materials);
    dice.castShadow = true;
    dice.receiveShadow = true;

    this.physics.addBox(dice, {
      size: { x: size, y: size, z: size },
      mass: 2.6,
      position: {
        x: def.position?.x || 0,
        y: def.position?.y ?? -20,
        z: def.position?.z || 0,
      },
      linearDamping: 0.01,
      angularDamping: 0.06,
      sleepSpeedLimit: 0.32,
      sleepTimeLimit: 0.35,
    });

    this.dice = dice;
    this.dicePair = this.physics.getPair(dice);
    this.dicePair.body.allowSleep = true;
    this.dicePair.body.sleep();
    return dice;
  }

  /** 场景装载后：抓引用 + 挂游戏交互 */
  _wireSceneObjects() {
    for (let i = 0; i < this.sceneio.entries.length; i++) {
      this._wireEntry(this.sceneio.entries[i]);
    }
  }

  /** 单个物体接线（场景装载 / 编辑器重建后共用） */
  _wireEntry(entry) {
    if (entry.type === 'dice') {
      this.dice = entry.object;
      this.dicePair = this.physics.getPair(entry.object);
      if (this.dicePair) {
        this.dicePair.body.allowSleep = true;
        this.dicePair.body.sleep();
      }
      this._diceSettled = true;
      this.raycast.addTarget({ object: entry.object, click: () => this.throwDice() });
    }

    if (entry.type === 'skeleton') {
      const sk = entry.object.userData.skeleton;
      if (sk) {
        this.hero = sk;
        this.raycast.addTarget({
          object: entry.object,
          click: () => this._heroAction(),
        });
        // 编辑器重建后重挂受击盒
        if (this.collision && this.collision.get('player_hit')) {
          const ph = this.collision.get('player_hit');
          ph.targetMesh = entry.object;
        }
      }
    }
  }

  /**
   * 输入/碰撞链路验证：
   * 1) 主角受击盒（group 'player'，绑 hero.root）
   * 2) 牌桌上 TriggerZone（group 'zone'，2x1x2）+ 半透明绿框展示
   */
  _setupMovementColliders() {
    if (!this.collision) return;

    // 主角受击盒（若 _wireEntry 已抓到 hero）
    if (this.hero) {
      this.collision.register('player_hit', {
        type: 'box',
        group: 'player',
        targetMesh: this.hero.root,
        size: { x: 0.5, y: 1.0, z: 0.5 },
      });
    }

    // 触发区域：牌桌上方，2x1x2
    const zoneCenter = { x: 3.2, y: 0.6, z: 1.2 };
    this.collision.register('table_zone', {
      type: 'zone',
      group: 'zone',
      center: zoneCenter,
      size: { x: 1, y: 0.5, z: 1 },
      onTrigger: (other) => {
        if (other && other.group === 'player') {
          this._toast('进入触发区域！');
          this.audio.playSfx('chime', { freq: 880, gain: 0.12 });
        }
      },
    });

    // 半透明绿框展示区域
    this._zoneMesh = new THREE.Mesh(
      new THREE.BoxGeometry(2, 1, 2),
      new THREE.MeshBasicMaterial({
        color: 0x33ff88,
        transparent: true,
        opacity: 0.22,
        depthWrite: false,
      }),
    );
    this._zoneMesh.position.set(zoneCenter.x, zoneCenter.y, zoneCenter.z);
    this.scene.add(this._zoneMesh);

    // 线框描边，便于看清边界
    this._zoneWire = new THREE.LineSegments(
      new THREE.EdgesGeometry(this._zoneMesh.geometry),
      new THREE.LineBasicMaterial({ color: 0x33ff88, transparent: true, opacity: 0.85 }),
    );
    this._zoneWire.position.copy(this._zoneMesh.position);
    this.scene.add(this._zoneWire);
  }

  /** Kinematic 走位 + 跳跃（禁用 Cannon 刚体驱动角色） */
  _updatePlayerMovement(dt) {
    if (!this.hero || !this.input) return;
    const root = this.hero.root;

    // 1) 水平轴（零 GC：复用 input 内部 _axis）
    const axis = this.input.getAxis('KeyA', 'KeyD', 'KeyS', 'KeyW');
    const ax = axis.x;
    const az = axis.y;
    const mag = Math.sqrt(ax * ax + az * az);
    this._moving = mag > 0.01;

    if (this._moving) {
      root.position.x += ax * PLAYER_SPEED * dt;
      root.position.z += az * PLAYER_SPEED * dt;
      // 简单面朝移动方向（绕 Y）
      root.rotation.y = Math.atan2(ax, az);
    }

    // 2) 跳跃：Space 或手柄按钮 0（A）
    const jumpPressed =
      (this.input.isJustPressed && this.input.isJustPressed('Space')) ||
      (this.input.isGamepadButtonJustPressed && this.input.isGamepadButtonJustPressed(0));
    if (jumpPressed && this._grounded) {
      this._velY = JUMP_VELOCITY;
      this._grounded = false;
      this.audio.playSfx('draw', { gain: 0.1 });
    }

    // 3) 垂直 Kinematic 重力
    if (!this._grounded) {
      this._velY -= GRAVITY * dt;
      root.position.y += this._velY * dt;
      if (root.position.y <= 0) {
        root.position.y = 0;
        this._velY = 0;
        this._grounded = true;
      }
    }

    // 4) 动作切换：移动切 walk，静止切 idle（忽略挥手 one-shot 时的覆盖）
    if (!this._heroWaving) {
      const wantWalk = this._moving && this._grounded;
      if (wantWalk && this._walkState !== 'walk') {
        this.hero.startProcedural('walk');
        this._walkState = 'walk';
      } else if (!wantWalk && this._walkState !== 'idle' && this._grounded) {
        this.hero.startProcedural('idle');
        this._walkState = 'idle';
      }
    }

    // 5) 受击盒中心随 mesh 同步（Collision2D.update 也会同步，这里保持一致）
    if (this.collision && this.collision.get('player_hit')) {
      this.collision.setCenter('player_hit', root.position.x, root.position.y + 1, root.position.z);
    }
  }

  _heroAction() {
    if (!this.hero) return;
    this._walking = false;
    this._heroWaving = true;
    this._walkState = null;
    this._syncWalkButton();
    this.hero.play('wave', {
      onComplete: () => {
        this._heroWaving = false;
        this._walkState = null;
        if (this.hero) this.hero.startProcedural('idle');
      },
    });
    this.audio.playSfx('chime', { freq: 659.25 });
    gsap.fromTo(
      this.hero.root.rotation,
      { z: -0.1 },
      { z: 0, duration: 0.9, ease: 'elastic.out(1, 0.35)', overwrite: 'auto' },
    );
    this._toast('纸片人：挥手！');
  }

  // ---------- 交互 ----------

  _bindInteractions() {
    // 全局拖拽投影平面 = 3D 桌面上方的抬升平面（手牌拖拽用）
    this.raycast.setDragPlane(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, this._dragHeight, 0));
  }

  _registerCardTarget(entry) {
    const mesh = entry.mesh;
    const target = this.raycast.addTarget({
      object: mesh,
      hoverIn: () => {
        if (!mesh.userData.handDragging) {
          this.hand.hoverIn(entry);
          this.audio.playSfx('click', { freq: 980, gain: 0.08 });
        }
      },
      hoverOut: () => this.hand.hoverOut(entry),
      click: () => this._toast(`${entry.meta.title} · 费用 ${entry.meta.cost}`),
      dragStart: (point) => {
        if (!point) return;
        _localPoint.copy(point);
        this.hand.root.worldToLocal(_localPoint);
        entry.dragOffsetX = mesh.position.x - _localPoint.x;
        entry.dragOffsetZ = mesh.position.z - _localPoint.z;
        mesh.userData.handDragging = true;
        this.hand.setDragged(entry, true);
        this.audio.playSfx('draw', { gain: 0.16 });
      },
      drag: (point) => {
        if (!point || !mesh.userData.handDragging) return;
        _localPoint.copy(point);
        this.hand.root.worldToLocal(_localPoint);
        mesh.position.set(
          _localPoint.x + entry.dragOffsetX,
          _localPoint.y,
          _localPoint.z + entry.dragOffsetZ,
        );
        mesh.rotation.set(0, 0, 0);
        mesh.scale.setScalar(1.08);
      },
      dragEnd: (point) => {
        if (!mesh.userData.handDragging) return;

        const onTable = point
          && Math.abs(point.x) <= this._tableBounds.x
          && Math.abs(point.z) <= this._tableBounds.z;

        if (onTable) {
          this._playCard(entry, point);
        } else {
          // 记录当前偏移，让回位动画从拖拽点平滑飞回扇形位
          entry.anim.dx = mesh.position.x - entry.base.x;
          entry.anim.dy = mesh.position.y - entry.base.y;
          entry.anim.dz = mesh.position.z - entry.base.z;
          entry.anim.rz = -entry.base.rz;
          entry.anim.scale = 1.08;
          mesh.userData.handDragging = false;
          this.hand.setDragged(entry, false);
        }
      },
    });
    this._cardTargets.set(entry, target);
    return target;
  }

  _playCard(entry, point) {
    const mesh = entry.mesh;

    // 先取世界变换，脱离手牌根后无缝转为世界坐标驱动
    mesh.updateWorldMatrix(true, false);
    _tmpV3.setFromMatrixPosition(mesh.matrixWorld);
    _tmpQuat.setFromRotationMatrix(mesh.matrixWorld);

    this.hand.removeCard(entry);
    this.raycast.removeTarget(mesh);
    this._cardTargets.delete(entry);
    mesh.userData.handDragging = true; // 脱离手牌 update 驱动

    this.scene.add(mesh);
    mesh.position.copy(_tmpV3);
    mesh.quaternion.copy(_tmpQuat);

    const targetY = 0.11;
    gsap.to(mesh.position, {
      x: THREE.MathUtils.clamp(point.x, -this._tableBounds.x + 0.8, this._tableBounds.x - 0.8),
      y: targetY,
      z: THREE.MathUtils.clamp(point.z, -this._tableBounds.z + 0.7, this._tableBounds.z - 0.7),
      duration: 0.42,
      ease: 'power3.out',
      overwrite: 'auto',
    });
    gsap.to(mesh.rotation, {
      x: -Math.PI / 2 + 0.02,
      y: 0,
      z: (Math.random() * 2 - 1) * 0.22,
      duration: 0.42,
      ease: 'power3.out',
      overwrite: 'auto',
    });
    gsap.to(mesh.scale, { x: 1, y: 1, z: 1, duration: 0.3, overwrite: 'auto' });

    this.audio.playSfx('chime', { freq: 440 + entry.meta.cost * 38 });
    this.cameraCtl.shake(0.16, 0.32);
    this._toast(`打出：${entry.meta.title}`);
    this.engine.eventBus.emit('sandbox:play', { card: entry });
    this._writeStat();
  }

  // ---------- 行为 ----------

  drawCard(silent = false) {
    const index = this._cardSeq++;
    const meta = {
      title: CARD_TITLES[index % CARD_TITLES.length],
      cost: 1 + (index % 6),
      hue: CARD_HUES[index % CARD_HUES.length],
      index,
    };

    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1.52, 2.12),
      new THREE.MeshBasicMaterial({ map: this._getFaceTexture(index, meta), side: THREE.DoubleSide }),
    );

    const entry = this.hand.addCard(mesh, meta, {
      fromX: (Math.random() * 2 - 1) * 1.2,
      fromY: 3.4,
      fromZ: -5,
    });

    this._registerCardTarget(entry);
    if (!silent) {
      this.audio.playSfx('deal');
      this._toast(`抽到：${meta.title}`);
    }
    this._writeStat();
    return entry;
  }

  throwDice() {
    if (!this.dicePair) return;
    const body = this.dicePair.body;
    body.wakeUp();
    body.position.set(-3.2 + Math.random() * 1.6, 8.2, 5.2);
    body.quaternion.setFromEuler(
      Math.random() * Math.PI,
      Math.random() * Math.PI,
      Math.random() * Math.PI,
    );
    body.velocity.set(1.6 + Math.random() * 2.2, -1.2, -7.2 - Math.random() * 2.6);
    body.angularVelocity.set(
      (Math.random() * 2 - 1) * 15,
      (Math.random() * 2 - 1) * 15,
      (Math.random() * 2 - 1) * 15,
    );

    this._diceSettled = false;
    this._diceResult = 0;
    this.audio.playSfx('dice');
    this.cameraCtl.shake(0.22, 0.35);
    this._toast('骰子飞出！');
    this._writeStat();
  }

  /** 骰子静止后按朝向读顶面点数 */
  _checkDiceSettled() {
    if (this._diceSettled || !this.dicePair) return;
    const body = this.dicePair.body;
    if (body.sleepState !== CANNON.Body.SLEEPING) return;

    let best = 0;
    let bestY = -Infinity;
    for (let i = 0; i < DICE_FACES.length; i++) {
      _tmpV3.copy(DICE_FACES[i].normal).applyQuaternion(this.dice.quaternion);
      if (_tmpV3.y > bestY) {
        bestY = _tmpV3.y;
        best = DICE_FACES[i].value;
      }
    }

    this._diceSettled = true;
    this._diceResult = best;
    this.audio.playSfx('chime', { freq: 523.25 + best * 22 });
    this._toast(`骰子点数：${best}`);
    this.engine.eventBus.emit('sandbox:dice', { value: best });
    this._writeStat();
  }

  // ---------- HUD ----------

  _bindHud() {
    this._toastEl = document.getElementById('toast');
    this._statEl = document.getElementById('stat-line');

    this._bindButton('btn-draw', () => this.drawCard());
    this._bindButton('btn-shuffle', () => {
      this.hand.layout(true);
      this.audio.playSfx('whoosh', { gain: 0.16 });
    });
    this._bindButton('btn-dice', () => this.throwDice());
    this._bindButton('btn-shake', () => {
      this.cameraCtl.shake(0.55, 0.5);
      this.audio.playSfx('whoosh');
    });
    this._bindButton('btn-camera', (btn) => {
      const mode = this.cameraCtl.toggleMode();
      btn.textContent = mode === 'orthographic' ? '透视相机' : '正交相机';
      this.audio.playSfx('click');
    });
    this._bindButton('btn-walk', () => {
      if (!this.hero) return;
      this._walking = !this._walking;
      this.hero.startProcedural(this._walking ? 'walk' : 'idle');
      this._syncWalkButton();
      this._toast(this._walking ? '纸片人：走路循环' : '纸片人：待机');
    });
    this._bindButton('btn-bgm', (btn) => {
      this._bgmOn = !this._bgmOn;
      if (this._bgmOn) {
        this.audio.startBgm('ambient', { volume: 0.4, fadeIn: 1.4 });
        btn.textContent = 'BGM 开';
        btn.classList.add('on');
      } else {
        this.audio.stopBgm(0.9);
        btn.textContent = 'BGM';
        btn.classList.remove('on');
      }
    });
    this._syncWalkButton();
  }

  _syncWalkButton() {
    const btn = document.getElementById('btn-walk');
    if (!btn) return;
    btn.textContent = this._walking ? '待机' : '走路';
    btn.classList.toggle('on', this._walking);
  }

  _bindButton(id, handler) {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.addEventListener('click', () => {
      this.audio.playSfx('click', { gain: 0.12 });
      handler(btn);
    });
  }

  _toast(text) {
    const el = this._toastEl;
    if (!el) return;
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.remove('show'), 1700);
  }

  _writeStat() {
    const mode = this.cameraCtl.mode === 'orthographic' ? '正交' : '透视';
    const dice = this._diceResult ? `骰子 ${this._diceResult} 点` : '骰子未投';
    const text = `FPS ${this._fpsSmooth.toFixed(0)}  ·  手牌 ${this.hand.cards.length} 张  ·  ${dice}\n相机: ${mode}  ·  右键旋转 / 滚轮缩放 / ?edit=1 编辑`;
    this.engine.eventBus.emit('sandbox:stat', text);
  }

  // ---------- 帧循环 ----------

  update(dt) {
    if (dt > 0) {
      this._fpsSmooth = this._fpsSmooth * 0.92 + (1 / dt) * 0.08;
    }
    this._checkDiceSettled();
    this._updatePlayerMovement(dt);

    this._statTimer += dt;
    if (this._statTimer >= 0.3) {
      this._statTimer = 0;
      this._writeStat();
    }
  }

  // ---------- 程序化贴图（初始化期分配） ----------

  _getFaceTexture(index, meta) {
    let tex = this._faceTextureCache.get(index);
    if (!tex) {
      tex = makeCardFaceTexture(index, meta);
      this._faceTextureCache.set(index, tex);
    }
    return tex;
  }

  _getPartTexture(name) {
    let tex = this._partTextureCache.get(name);
    if (!tex) {
      tex = makePartTexture(name);
      this._partTextureCache.set(name, tex);
    }
    return tex;
  }

  dispose() {
    const engine = this.engine;

    // 事件对称解绑（init 里挂的都在这卸）
    if (this._boundRewire) engine.eventBus.off('editor:rebuild', this._boundRewire);
    if (this._boundEditorEnter) engine.eventBus.off('editor:enter', this._boundEditorEnter);
    if (this._boundEditorExit) engine.eventBus.off('editor:exit', this._boundEditorExit);
    if (this._boundEditorPreview) engine.eventBus.off('editor:preview', this._boundEditorPreview);
    engine.eventBus.off('core:resize', this._boundStat);

    // 碰撞体注销 + 触发区域网格/材质清理
    if (this.collision) {
      this.collision.unregister('player_hit');
      this.collision.unregister('table_zone');
    }
    if (this._zoneMesh) {
      this.scene.remove(this._zoneMesh);
      this._zoneMesh.geometry.dispose();
      this._zoneMesh.material.dispose();
      this._zoneMesh = null;
    }
    if (this._zoneWire) {
      this.scene.remove(this._zoneWire);
      this._zoneWire.geometry.dispose();
      this._zoneWire.material.dispose();
      this._zoneWire = null;
    }

    // 彻底卸载关卡专属光源/网格：释放 GPU 资源 + 杀残留补间后整体摘除，杜绝多光源残留过曝
    disposeObject3D(this.scene);
    this.scene.clear();
    this.scene.background = null;
    this.scene.fog = null;

    // 手牌清空：摘牌 + 杀入场补间（牌面网格已在上面的场景清扫里释放）
    if (this.hand) {
      for (let i = this.hand.cards.length - 1; i >= 0; i--) {
        this.hand.removeCard(this.hand.cards[i]);
      }
    }

    // 场景物体对称拆线（与 SceneEditor._destroyEntry 同构）：拾取/刚体/软影/骨骼
    if (this.sceneio) {
      for (let i = 0; i < this.sceneio.entries.length; i++) {
        const entry = this.sceneio.entries[i];
        const obj = entry.object;
        if (this.raycast) this.raycast.removeTarget(obj);
        if (this.physics) this.physics.remove(obj);
        if (this.billboard) {
          const unit = this.billboard.units.find((u) => u.id === entry.def.id);
          if (unit) {
            // 软影贴图是 spawn 时新建的，billboard.remove 只释放几何/材质
            if (unit.shadow && unit.shadow.material.map) unit.shadow.material.map.dispose();
            this.billboard.remove(unit);
          }
        }
        const sk = obj.userData && obj.userData.skeleton;
        if (sk && this.skeletons) this.skeletons.remove(sk);
      }
      this.sceneio.clear();
    }
    if (this.raycast) {
      for (const target of this._cardTargets.values()) this.raycast.removeTarget(target);
    }
    this._cardTargets.clear();

    // 地面刚体哨兵（_buildEnvironment 的 addGround(null) 挂在本关场景上）
    if (this.physics) this.physics.remove(this.scene);

    for (const tex of this._faceTextureCache.values()) tex.dispose();
    this._faceTextureCache.clear();
    for (const tex of this._partTextureCache.values()) tex.dispose();
    this._partTextureCache.clear();
  }
}

// ============ 工具函数 ============

/** 释放 Object3D 子树的 GPU 资源（几何/材质/贴图）并杀掉残留补间（仅 dispose 期调用） */
function disposeObject3D(root) {
  root.traverse((node) => {
    gsap.killTweensOf(node.position);
    gsap.killTweensOf(node.rotation);
    gsap.killTweensOf(node.scale);
    if (node.geometry) node.geometry.dispose();
    const mat = node.material;
    if (mat) {
      const mats = Array.isArray(mat) ? mat : [mat];
      for (let i = 0; i < mats.length; i++) {
        const m = mats[i];
        if (m.map) m.map.dispose();
        m.dispose();
      }
    }
  });
}

// ============ 游戏层 Inspector（经 registerType 挂到引擎编辑器） ============

function readonlyLike(text) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = text;
  input.readOnly = true;
  return input;
}

/** 纸片人/图片公告板：朝向 + 软阴影 + 影子大小 */
function buildFacingInspector(box, entry) {
  const props = entry.def.props || {};
  box.appendChild(row('朝向', selectInput('facing', [
    ['yaw', 'yaw 仅水平朝向相机'],
    ['full', 'full 全公告板'],
  ], props.facing || 'yaw')));

  const shadowWrap = el('label', 'cw-ed-check');
  const cb = checkboxInput('shadow', props.shadow !== false);
  shadowWrap.appendChild(cb);
  shadowWrap.appendChild(document.createTextNode('软阴影'));
  box.appendChild(shadowWrap);

  const size = props.shadowSize ?? 2.3;
  const slider = rangeInput('shadowSize', size, 0.5, 5, 0.1);
  const out = el('output', '');
  out.textContent = Number(size).toFixed(1);
  const wrap = el('label', '');
  wrap.textContent = '影子大小';
  wrap.appendChild(slider);
  wrap.appendChild(out);
  box.appendChild(wrap);
}

/** 道具：颜色 + 形状 + 尺寸（按形状切换） */
function buildPropInspector(box, entry) {
  const props = entry.def.props || {};
  const shape = props.shape || 'box';
  box.appendChild(row('颜色', colorInput(props.color || '#8899bb')));
  box.appendChild(row('形状', selectInput('shape', [
    ['box', 'box 方块'],
    ['cylinder', 'cylinder 圆柱'],
    ['sphere', 'sphere 球体'],
  ], shape)));
  if (shape === 'cylinder') {
    box.appendChild(row('半径', numInput('radius', props.radius ?? 0.6, 0.05, 'k')));
    box.appendChild(row('高度', numInput('height', props.height ?? 1.2, 0.05, 'k')));
  } else if (shape === 'sphere') {
    box.appendChild(row('半径', numInput('radius', props.radius ?? 0.6, 0.05, 'k')));
  } else {
    box.appendChild(row('尺寸', numInput('size', props.size ?? 1, 0.05, 'k')));
  }
}

/** 纸片人/公告板 props 应用：轻量字段就地改，软阴影缺失时重建 */
function applyBillboardFields(entry, key, value, inputEl, editor) {
  const props = entry.def.props || (entry.def.props = {});

  if (key === 'facing') {
    props.facing = value;
    const unit = findUnit(editor.billboard, entry.def.id);
    if (unit && editor.billboard) editor.billboard.setFacing(unit, value);
    return true;
  }

  if (key === 'shadowSize') {
    if (!Number.isFinite(value)) return true;
    props.shadowSize = value;
    const unit = findUnit(editor.billboard, entry.def.id);
    if (unit && unit.shadow) unit.shadow.scale.set(value, value, 1);
    return true;
  }

  if (key === 'shadow') {
    props.shadow = value;
    const unit = findUnit(editor.billboard, entry.def.id);
    if (unit && unit.shadow) {
      unit.shadow.visible = value;
      return true;
    }
    if (!value) return true;
    editor._rebuild(entry, true);
    return true;
  }

  return false;
}

/** 道具 props 应用：颜色就地改；形状/尺寸走工厂重建 */
function applyPropFields(entry, key, value, inputEl, editor) {
  const props = entry.def.props || (entry.def.props = {});

  if (key === 'color') {
    props.color = value;
    const mat = entry.object.material;
    if (mat && !Array.isArray(mat) && mat.color) mat.color.set(value);
    return true;
  }

  if (key === 'shape') {
    props.shape = value;
    if (value === 'box' && props.size === undefined) props.size = 1;
    if ((value === 'cylinder' || value === 'sphere') && props.radius === undefined) props.radius = 0.6;
    if (value === 'cylinder' && props.height === undefined) props.height = 1.2;
    editor._rebuild(entry, true);
    return true;
  }

  if (key === 'size' || key === 'radius' || key === 'height') {
    if (!Number.isFinite(value) || value <= 0 || props[key] === value) return true;
    props[key] = value;
    editor._rebuild(entry, false);
    return true;
  }

  return false;
}

// ============ Canvas 程序化贴图（仅初始化期分配） ============

function makeFeltTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');

  g.fillStyle = '#1f5d3f';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 2800; i++) {
    g.fillStyle = Math.random() > 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.07)';
    g.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
  }
  g.strokeStyle = 'rgba(255,255,255,0.12)';
  g.lineWidth = 6;
  g.strokeRect(16, 16, 224, 224);
  g.strokeStyle = 'rgba(255,215,120,0.18)';
  g.lineWidth = 3;
  g.strokeRect(34, 34, 188, 188);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function makeCardFaceTexture(index, meta) {
  const w = 256;
  const h = 358;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');

  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, `hsl(${meta.hue}, 62%, 92%)`);
  grad.addColorStop(1, `hsl(${meta.hue}, 55%, 78%)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);

  g.strokeStyle = `hsl(${meta.hue}, 48%, 38%)`;
  g.lineWidth = 10;
  g.strokeRect(10, 10, w - 20, h - 20);

  g.fillStyle = `hsl(${meta.hue}, 52%, 46%)`;
  g.beginPath();
  g.arc(w / 2, h / 2 - 16, 62, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = 'rgba(255,255,255,0.92)';
  g.beginPath();
  g.arc(w / 2, h / 2 - 16, 40, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = `hsl(${meta.hue}, 60%, 42%)`;
  g.font = 'bold 46px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(meta.index % 99), w / 2, h / 2 - 14);

  g.fillStyle = `hsl(${meta.hue}, 46%, 28%)`;
  g.font = 'bold 30px sans-serif';
  g.fillText(meta.title, w / 2, h - 66);

  g.fillStyle = '#2b6cb0';
  g.beginPath();
  g.arc(46, 46, 30, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#ffffff';
  g.font = 'bold 30px sans-serif';
  g.fillText(String(meta.cost), 46, 48);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 骨骼部件贴图：part_head / part_torso / part_arm / part_leg（透明底分件） */
function makePartTexture(name) {
  const w = 256;
  const h = 256;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');

  if (name === 'part_head') {
    g.fillStyle = '#f6d7b0';
    g.beginPath();
    g.arc(128, 138, 88, 0, Math.PI * 2);
    g.fill();

    g.fillStyle = '#2c2331';
    g.beginPath();
    g.arc(128, 112, 92, Math.PI * 0.98, Math.PI * 2.02);
    g.fill();
    roundRect(g, 36, 100, 184, 52, 24);
    g.fill();

    g.fillStyle = '#2c2331';
    g.beginPath();
    g.arc(98, 148, 11, 0, Math.PI * 2);
    g.arc(158, 148, 11, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.arc(101, 145, 4, 0, Math.PI * 2);
    g.arc(161, 145, 4, 0, Math.PI * 2);
    g.fill();

    g.strokeStyle = '#b4655a';
    g.lineWidth = 8;
    g.beginPath();
    g.arc(128, 176, 18, 0.15 * Math.PI, 0.85 * Math.PI);
    g.stroke();
  } else if (name === 'part_torso') {
    g.fillStyle = '#3f6fd8';
    roundRect(g, 48, 30, 160, 210, 36);
        g.fill();
        g.fillStyle = '#e8b23a';
        roundRect(g, 58, 26, 140, 42, 18);
        g.fill();
        g.fillStyle = 'rgba(255,255,255,0.16)';
        roundRect(g, 74, 92, 108, 118, 22);
        g.fill();
  } else if (name === 'part_arm') {
        g.fillStyle = '#355fb8';
        roundRect(g, 84, 18, 88, 190, 40);
        g.fill();
        g.fillStyle = '#f6d7b0';
        g.beginPath();
        g.arc(128, 218, 34, 0, Math.PI * 2);
        g.fill();
  } else {
        // part_leg
        g.fillStyle = '#2f3a52';
        roundRect(g, 82, 12, 92, 180, 34);
        g.fill();
        g.fillStyle = '#1d2433';
        roundRect(g, 72, 192, 112, 50, 22);
        g.fill();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeShadowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 8, 64, 64, 62);
  grad.addColorStop(0, 'rgba(0,0,0,0.85)');
  grad.addColorStop(0.55, 'rgba(0,0,0,0.38)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

function makeDiceFaceTexture(pips) {
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');

  g.fillStyle = '#f7f3ea';
  g.fillRect(0, 0, s, s);
  g.strokeStyle = 'rgba(0,0,0,0.12)';
  g.lineWidth = 8;
  g.strokeRect(6, 6, s - 12, s - 12);

  const positions = {
    1: [[0.5, 0.5]],
    2: [[0.28, 0.28], [0.72, 0.72]],
    3: [[0.26, 0.26], [0.5, 0.5], [0.74, 0.74]],
    4: [[0.28, 0.28], [0.72, 0.28], [0.28, 0.72], [0.72, 0.72]],
    5: [[0.28, 0.28], [0.72, 0.28], [0.5, 0.5], [0.28, 0.72], [0.72, 0.72]],
    6: [[0.28, 0.24], [0.72, 0.24], [0.28, 0.5], [0.72, 0.5], [0.28, 0.76], [0.72, 0.76]],
  };

  g.fillStyle = '#22262e';
  const pts = positions[pips] || positions[1];
  for (let i = 0; i < pts.length; i++) {
    g.beginPath();
    g.arc(pts[i][0] * s, pts[i][1] * s, 11, 0, Math.PI * 2);
    g.fill();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// ============ 内联兜底数据（与 /assets 下的 JSON 同构，保证零资源可玩） ============

const DEFAULT_SCENE = {
  name: 'sandbox',
  version: 1,
  objects: [
    { id: 'table', type: 'table', position: { x: 0, y: -0.4, z: 0 }, props: {} },
    {
      id: 'hero', type: 'skeleton',
      position: { x: 5.3, y: 0, z: -3.6 }, rotation: { y: -0.25 },
      props: { rig: 'hero', facing: 'yaw', shadow: true, shadowSize: 2.3 },
    },
    { id: 'dice', type: 'dice', position: { x: 0, y: -20, z: 0 }, props: {} },
    {
      id: 'barrel_1', type: 'prop', position: { x: -5.4, y: 0.65, z: -2.8 },
      props: { shape: 'cylinder', color: '#b5651d', radius: 0.72, height: 1.3 },
    },
    {
      id: 'crate_1', type: 'prop', position: { x: -4.3, y: 0.55, z: 3.0 }, rotation: { y: 0.4 },
      props: { shape: 'box', color: '#a9744f', size: 1.1 },
    },
    {
      id: 'lamp_1', type: 'prop', position: { x: 0, y: 1.2, z: -3.2 },
      props: { shape: 'cylinder', color: '#5c7c9c', radius: 0.35, height: 2.4 },
    },
  ],
};

const RIG_HERO = {
  name: 'hero',
  bones: [
    { name: 'root', parent: null, x: 0, y: 0, rotation: 0 },
    { name: 'torso', parent: 'root', x: 0, y: 1.25, rotation: 0 },
    { name: 'head', parent: 'torso', x: 0, y: 0.75, rotation: 0 },
    { name: 'armL', parent: 'torso', x: -0.58, y: 0.5, rotation: 0.12 },
    { name: 'armR', parent: 'torso', x: 0.58, y: 0.5, rotation: -0.12 },
    { name: 'legL', parent: 'root', x: -0.26, y: 1.25, rotation: 0 },
    { name: 'legR', parent: 'root', x: 0.26, y: 1.25, rotation: 0 },
  ],
  parts: [
    { bone: 'torso', texture: 'part_torso', x: 0, y: 0.15, width: 1.1, height: 1.35, z: 0 },
    { bone: 'head', texture: 'part_head', x: 0, y: 0.38, width: 1.15, height: 1.15, z: 0.02 },
    { bone: 'armL', texture: 'part_arm', x: 0, y: -0.48, width: 0.38, height: 1.05, z: -0.02 },
    { bone: 'armR', texture: 'part_arm', x: 0, y: -0.48, width: 0.38, height: 1.05, z: -0.02 },
    { bone: 'legL', texture: 'part_leg', x: 0, y: -0.62, width: 0.46, height: 1.3, z: -0.01 },
    { bone: 'legR', texture: 'part_leg', x: 0, y: -0.62, width: 0.46, height: 1.3, z: -0.01 },
  ],
  clips: {
    wave: {
      duration: 1.3,
      loop: false,
      keys: [
        { time: 0, pose: { armR: { rotation: 0 }, head: { rotation: 0 } } },
        { time: 0.25, pose: { armR: { rotation: -2.25 }, head: { rotation: 0.12 } } },
        { time: 0.55, pose: { armR: { rotation: -1.45 }, head: { rotation: 0.12 } } },
        { time: 0.85, pose: { armR: { rotation: -2.25 }, head: { rotation: 0.12 } } },
        { time: 1.3, pose: { armR: { rotation: 0 }, head: { rotation: 0 } } },
      ],
    },
    nod: {
      duration: 0.9,
      loop: false,
      keys: [
        { time: 0, pose: { head: { rotation: 0 } } },
        { time: 0.3, pose: { head: { rotation: 0.22 } } },
        { time: 0.6, pose: { head: { rotation: 0.05 } } },
        { time: 0.9, pose: { head: { rotation: 0 } } },
      ],
    },
  },
};
