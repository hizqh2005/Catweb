import * as THREE from 'three';

/**
 * 最小可复用场景冒烟件：只有一盏灯 + 一个盒子。
 * 用途：验证 SceneDirector 切关往返、SceneEditor 注册表驱动不依赖沙盒特有对象。
 * 换游戏或做引擎回归时可 loadScene('mini') / loadScene('sandbox') 来回切。
 */
export class MiniScene {
  static moduleName = 'mini';

  constructor(engine) {
    this.engine = engine;
    this.scene = new THREE.Scene();
  }

  async init() {
    const engine = this.engine;
    engine.setScene(this.scene);
    this.scene.background = new THREE.Color(0x1a2230);

    const light = new THREE.DirectionalLight(0xffffff, 1.2);
    light.position.set(4, 8, 6);
    this.scene.add(light);
    this.scene.add(new THREE.AmbientLight(0x8899bb, 0.45));

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 40),
      new THREE.MeshStandardMaterial({ color: 0x2a3344, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    this.scene.add(ground);

    // 注册一个极简类型，证明编辑器完全由注册表驱动
    const sceneio = engine.get('sceneio');
    if (sceneio) {
      sceneio.registerType('miniBox', (def) => {
        const size = (def.props && def.props.size) || 1;
        return new THREE.Mesh(
          new THREE.BoxGeometry(size, size, size),
          new THREE.MeshStandardMaterial({ color: (def.props && def.props.color) || '#6ea8fe' }),
        );
      }, {
        label: '方块', icon: '▣', placeY: 0.5,
        defaultProps: { size: 1, color: '#6ea8fe' },
        inspector(box, entry) {
          const props = entry.def.props || {};
          const size = document.createElement('input');
          size.type = 'number';
          size.step = '0.1';
          size.value = String(props.size ?? 1);
          size.dataset.k = 'size';
          const color = document.createElement('input');
          color.type = 'color';
          color.value = props.color || '#6ea8fe';
          color.dataset.k = 'color';
          const l1 = document.createElement('label');
          l1.textContent = '尺寸 ';
          l1.appendChild(size);
          const l2 = document.createElement('label');
          l2.textContent = '颜色 ';
          l2.appendChild(color);
          box.appendChild(l1);
          box.appendChild(l2);
        },
        applyProp(entry, key, value, inputEl, editor) {
          const props = entry.def.props || (entry.def.props = {});
          props[key] = value;
          if (key === 'color') {
            const mat = entry.object.material;
            if (mat && mat.color) mat.color.set(value);
            return true;
          }
          if (key === 'size') {
            editor._rebuild(entry, false);
            return true;
          }
          return true;
        },
      });
    }

    if (sceneio) {
      sceneio.load({
        name: 'mini',
        version: 1,
        objects: [
          { id: 'box1', type: 'miniBox', position: { x: 0, y: 0.5, z: 0 }, props: { size: 1.2 } },
        ],
      });
    }

    this.engine.eventBus.emit('mini:ready', { name: 'mini' });
  }

  update() { /* 空场景无需帧逻辑 */ }

  dispose() {
    const scene = this.scene;
    scene.traverse((node) => {
      if (node.geometry) node.geometry.dispose();
      const mat = node.material;
      if (mat) {
        const mats = Array.isArray(mat) ? mat : [mat];
        for (let i = 0; i < mats.length; i++) {
          if (mats[i].map) mats[i].map.dispose();
          mats[i].dispose();
        }
      }
    });
    scene.clear();
    const sceneio = this.engine.get('sceneio');
    if (sceneio) sceneio.clear();
  }
}
