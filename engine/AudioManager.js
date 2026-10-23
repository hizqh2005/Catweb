/**
 * 音频系统：原生 Web Audio 为主（合成音效池 + BGM 淡入淡出），Howler 懒加载兜底文件播放。
 *
 * 为什么不用静态 import Howler：howler 的发行文件是 UMD（无 ESM 导出），
 * 动态 import + 全局兜底可以做到"装不上也不影响引擎启动"，符合零构建红线。
 * 合成器（synth）即预设音色函数，注册进表后按名播放；帧循环内不会触发任何音频分配。
 */
export class AudioManager {
  static moduleName = 'audio';

  constructor(engine, options = {}) {
    this.engine = engine;
    this.masterVolume = options.masterVolume ?? 0.85;
    this.sfxVolume = options.sfxVolume ?? 0.9;
    this.musicVolume = options.musicVolume ?? 0.5;

    this._ctx = null;
    this._masterGain = null;
    this._sfxGain = null;
    this._musicGain = null;
    this._noiseBuffer = null;

    /** @type {Map<string, Function>} name -> synth(ctx, dest, opts) */
    this._synths = new Map();
    /** @type {Map<string, number>} 并发限流 */
    this._active = new Map();

    this._bgm = null; // { master, nodes: [] }
    this._howler = null;
    this._howls = new Map();

    this._registerBuiltins();
  }

  init() {
    // 浏览器自动播放策略：上下文必须在用户手势里 resume
    const resume = () => this.ensureContext();
    window.addEventListener('pointerdown', resume, { once: true });
    window.addEventListener('keydown', resume, { once: true });
    this._boundResume = resume;
  }

  ensureContext() {
    if (!this._ctx) {
      const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Ctx) return null;
      this._ctx = new Ctx();
      this._masterGain = this._ctx.createGain();
      this._sfxGain = this._ctx.createGain();
      this._musicGain = this._ctx.createGain();
      this._sfxGain.connect(this._masterGain);
      this._musicGain.connect(this._masterGain);
      this._masterGain.connect(this._ctx.destination);
      this._masterGain.gain.value = this.masterVolume;
      this._sfxGain.gain.value = this.sfxVolume;
      this._musicGain.gain.value = this.musicVolume;
      this._noiseBuffer = this._createNoiseBuffer();
    }
    if (this._ctx.state === 'suspended') this._ctx.resume();
    return this._ctx;
  }

  decode(arrayBuffer) {
    const ctx = this.ensureContext();
    if (!ctx) return Promise.resolve(arrayBuffer);
    return ctx.decodeAudioData(arrayBuffer.slice(0));
  }

  registerSfx(name, synthFn) {
    this._synths.set(name, synthFn);
  }

  playSfx(name, opts = {}) {
    const ctx = this.ensureContext();
    if (!ctx) return null;
    const synth = this._synths.get(name);
    if (!synth) {
      console.warn(`[AudioManager] 未注册音效: ${name}`);
      return null;
    }

    const maxVoices = opts.maxVoices ?? 6;
    const active = this._active.get(name) || 0;
    if (active >= maxVoices) return null;
    this._active.set(name, active + 1);

    try {
      return synth(ctx, this._sfxGain, opts, this._noiseBuffer);
    } finally {
      const release = () => this._active.set(name, Math.max(0, (this._active.get(name) || 1) - 1));
      setTimeout(release, ((opts.durationHint || 0.6) * 1000));
    }
  }

  /** BGM 使用合成 Pad（无外部文件也能出声）；fadeDuration 秒淡入 */
  startBgm(preset = 'ambient', opts = {}) {
    const ctx = this.ensureContext();
    if (!ctx) return;
    this.stopBgm(0.2);

    const volume = opts.volume ?? 0.42;
    const fade = opts.fadeIn ?? 1.2;
    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(this._musicGain);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = opts.cutoff ?? 760;
    filter.Q.value = 0.8;
    filter.connect(master);

    const nodes = [];
    const chord = BGMB_PRESETS[preset] || BGMB_PRESETS.ambient;
    for (let i = 0; i < chord.length; i++) {
      const osc = ctx.createOscillator();
      osc.type = i % 2 === 0 ? 'triangle' : 'sawtooth';
      osc.frequency.value = chord[i];
      osc.detune.value = (i - 1) * 6;

      const voice = ctx.createGain();
      voice.gain.value = 0.12 / Math.max(1, chord.length * 0.5);
      osc.connect(voice);
      voice.connect(filter);

      // 慢速 LFO 让 pad 有呼吸感
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.06 + i * 0.017;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 2.4;
      lfo.connect(lfoGain);
      lfoGain.connect(osc.detune);

      osc.start();
      lfo.start();
      nodes.push(osc, lfo, voice, lfoGain);
    }

    master.gain.setValueAtTime(0, ctx.currentTime);
    master.gain.linearRampToValueAtTime(volume, ctx.currentTime + fade);

    this._bgm = { master, nodes };
    this.engine.eventBus.emit('audio:bgm', { preset, state: 'start' });
  }

  fadeBgm(volume, duration = 0.8) {
    if (!this._bgm || !this._ctx) return;
    const g = this._bgm.master.gain;
    const now = this._ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(volume, now + duration);
  }

  stopBgm(fadeOut = 1) {
    const bgm = this._bgm;
    if (!bgm || !this._ctx) return;
    this._bgm = null;

    const now = this._ctx.currentTime;
    const g = bgm.master.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0.0001, now + Math.max(fadeOut, 0.02));

    setTimeout(() => {
      for (let i = 0; i < bgm.nodes.length; i++) {
        const node = bgm.nodes[i];
        if (typeof node.stop === 'function') {
          try { node.stop(); } catch (err) { /* 已停止 */ }
        }
        node.disconnect();
      }
      bgm.master.disconnect();
    }, (fadeOut + 0.1) * 1000);

    this.engine.eventBus.emit('audio:bgm', { state: 'stop' });
  }

  setMasterVolume(v) {
    this.masterVolume = v;
    if (this._masterGain) this._masterGain.gain.value = v;
  }

  /** Howler 懒加载：文件音频场景（真实 assets/audio/*）用它，缺失时静默降级 */
  async enableHowler() {
    if (this._howler) return this._howler;
    try {
      await import('howler');
      this._howler = globalThis.Howl ? { Howl: globalThis.Howl, Howler: globalThis.Howler } : null;
    } catch (err) {
      console.warn('[AudioManager] Howler 不可用，继续使用 Web Audio 合成', err);
      this._howler = null;
    }
    return this._howler;
  }

  async loadHowl(name, urls, opts = {}) {
    const lib = await this.enableHowler();
    if (!lib) return null;
    const howl = new lib.Howl({ src: Array.isArray(urls) ? urls : [urls], ...opts });
    this._howls.set(name, howl);
    return howl;
  }

  play(name, opts = {}) {
    const howl = this._howls.get(name);
    return howl ? howl.play(opts.sprite) : null;
  }

  // ---------- 内置合成器 ----------

  _registerBuiltins() {
    this.registerSfx('click', (ctx, dest, opts, noise) => {
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(opts.freq ?? 760, t);
      osc.frequency.exponentialRampToValueAtTime((opts.freq ?? 760) * 0.55, t + 0.07);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(opts.gain ?? 0.22, t + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
      osc.connect(gain);
      gain.connect(dest);
      osc.start(t);
      osc.stop(t + 0.1);
    });

    this.registerSfx('draw', (ctx, dest, opts, noise) => {
      const t = ctx.currentTime;
      const src = ctx.createBufferSource();
      src.buffer = noise;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(900, t);
      filter.frequency.exponentialRampToValueAtTime(2600, t + 0.16);
      filter.Q.value = 1.1;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(opts.gain ?? 0.3, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      src.connect(filter);
      filter.connect(gain);
      gain.connect(dest);
      src.start(t);
      src.stop(t + 0.2);
    });

    this.registerSfx('whoosh', (ctx, dest, opts, noise) => {
      const t = ctx.currentTime;
      const src = ctx.createBufferSource();
      src.buffer = noise;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(2400, t);
      filter.frequency.exponentialRampToValueAtTime(320, t + 0.32);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(opts.gain ?? 0.32, t + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
      src.connect(filter);
      filter.connect(gain);
      gain.connect(dest);
      src.start(t);
      src.stop(t + 0.36);
    });

    this.registerSfx('dice', (ctx, dest, opts, noise) => {
      const t = ctx.currentTime;
      const src = ctx.createBufferSource();
      src.buffer = noise;
      const filter = ctx.createBiquadFilter();
      filter.type = 'highpass';
      filter.frequency.value = 1400;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(opts.gain ?? 0.26, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
      src.connect(filter);
      filter.connect(gain);
      gain.connect(dest);
      src.start(t);
      src.stop(t + 0.16);

      for (let i = 0; i < 3; i++) {
        const tick = ctx.createOscillator();
        const tg = ctx.createGain();
        const at = t + 0.03 + i * 0.045;
        tick.type = 'square';
        tick.frequency.value = 320 + Math.random() * 260;
        tg.gain.setValueAtTime(0.0001, at);
        tg.gain.exponentialRampToValueAtTime(0.12, at + 0.004);
        tg.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
        tick.connect(tg);
        tg.connect(dest);
        tick.start(at);
        tick.stop(at + 0.06);
      }
    });

    this.registerSfx('chime', (ctx, dest, opts) => {
      const t = ctx.currentTime;
      const base = opts.freq ?? 523.25;
      const partials = [1, 2.01, 3.02];
      for (let i = 0; i < partials.length; i++) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.value = base * partials[i];
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime((opts.gain ?? 0.16) / (i + 1), t + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.7 - i * 0.16);
        osc.connect(gain);
        gain.connect(dest);
        osc.start(t);
        osc.stop(t + 0.8);
      }
    });

    this.registerSfx('deal', (ctx, dest, opts, noise) => {
      const t = ctx.currentTime;
      const src = ctx.createBufferSource();
      src.buffer = noise;
      src.playbackRate.value = 1.6;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 1800;
      filter.Q.value = 0.9;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(opts.gain ?? 0.22, t + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      src.connect(filter);
      filter.connect(gain);
      gain.connect(dest);
      src.start(t);
      src.stop(t + 0.14);
    });
  }

  _createNoiseBuffer() {
    const ctx = this._ctx;
    const length = Math.floor(ctx.sampleRate * 0.5);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  dispose() {
    this.stopBgm(0.05);
    for (const howl of this._howls.values()) howl.unload();
    this._howls.clear();
    if (this._ctx && typeof this._ctx.close === 'function') this._ctx.close();
    this._ctx = null;
    if (this._boundResume) window.removeEventListener('pointerdown', this._boundResume);
  }
}

// BGM 合成和弦预设（频率 Hz）
const BGMB_PRESETS = {
  ambient: [110, 164.81, 220, 246.94],
  warm: [98, 146.83, 196, 233.08],
  tension: [87.31, 130.81, 155.56, 207.65],
};
