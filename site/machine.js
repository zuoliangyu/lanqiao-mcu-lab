// SPDX-License-Identifier: MIT
import { CPU } from './cpu.js';
import { parseHex } from './hex.js';
import { I2CBus, DS1302, DS18B20 } from './devices.js';
const PORTS = [0x80, 0x90, 0xa0, 0xb0, 0xc0, 0xc8];
const MODE = [[0x93, 0x94], [0x91, 0x92], [0x95, 0x96], [0xb1, 0xb2], [0xb3, 0xb4], [0xc9, 0xca]];
const COLS = [[4, 4], [4, 2], [3, 5], [3, 4]];
export class Machine {
  constructor(options = {}) {
    this.hz = options.hz || 12000000;
    this.inputs = { temperature: 25, temperaturePolicy: 'hold', analog: [0, 2.5, 0, 2.5], distance: 100, echo: true, frequency: 1000, frequencyEnabled: false, keyMode: 'matrix', writeMode: 'io', ultrasonicMode: 'board', keys: [], ...options.inputs };
    this.cpu = new CPU(this); this.i2c = new I2CBus(this, options.eeprom); this.rtc = new DS1302(); this.temp = new DS18B20(this);
    this.codeInfo = null; this.reset();
  }
  get now() { return this.cpu.cycles * 1e6 / this.hz; }
  reset(power = false) {
    const before = this.now; this.i2c.commit(before); this.rtc.tick(before); this.temp.tick(before);
    const busy = Math.max(0, this.i2c.busyUntil - before), conversion = Math.max(0, this.temp.busyUntil - before);
    this.cpu.reset(); this.cpu.sfr[0x8e] = 1; this.cpu.sfr[0xa1] = 0;
    this.i2c.resetBus(); this.i2c.busyUntil = busy; this.rtc.resetBus(); this.rtc.last = 0;
    this.temp.resetBus(); this.temp.busyUntil = conversion;
    if (power) { this.i2c.pending = []; this.i2c.busyUntil = 0; this.rtc = new DS1302(); this.temp = new DS18B20(this); }
    this.reload = [0, 0, 0]; this.frac = [0, 0, 0]; this.pcaFrac = 0;
    this.irqCounts = Array(13).fill(0); this.overflowCounts = [0, 0, 0]; this.timer2Pending = false;
    this.latch = power || !this.latch ? [255, 0, 0, 255] : [...this.latch]; this.latch[3] = 255;
    this.segEnergy = new Float64Array(64); this.ledEnergy = new Float64Array(8);
    this.displayLast = 0; this.frameLast = 0; this.lastSegments = Array(64).fill(0); this.lastLeds = Array(8).fill(0);
    this.latchWrites = [0, 0, 0, 0]; this.tx = []; this.txByte = null; this.txDue = Infinity; this.rxQueue = []; this.rxDue = Infinity; this.rx = 0; this.txCount = 0; this.rxCount = 0;
    this.diagnostics = []; this.warned = new Set(); this.echoAt = Infinity; this.echoUntil = -1; this.lastTx = 1; this.txStart = 0; this.burstStart = -1; this.burstEdges = 0; this.pings = 0;
    this.inputs.keys = []; this.lastP3 = 255; this.breakpoints = new Set();
  }
  load(text) { const info = parseHex(text); this.reset(true); this.cpu.code.set(info.code); this.codeInfo = { count: info.count, max: info.max }; return this.codeInfo; }
  warn(message) { if (!this.warned.has(message)) { this.warned.add(message); this.diagnostics.push(message); } }
  setInput(name, value) {
    if (name === 'keys') this.inputs.keys = value.filter(x => Number.isInteger(x) && x >= 4 && x <= 19 && (!this.inputs.frequencyEnabled || x < 16));
    else if (name === 'frequencyEnabled') {
      this.inputs.frequencyEnabled = !!value;
      if (value) this.inputs.keys = this.inputs.keys.filter(k => k < 16);
    }
    else if (name === 'analog') this.inputs.analog = value.map(v => Math.max(0, Math.min(5, Number(v) || 0)));
    else if (name === 'temperature') this.inputs.temperature = Math.max(-55, Math.min(125, Number(value) || 0));
    else if (name === 'frequency') this.inputs.frequency = Math.max(100, Math.min(38000, Number(value) || 100));
    else if (name === 'distance') this.inputs.distance = Math.max(2, Math.min(1000, Number(value) || 2));
    else if (Object.hasOwn(this.inputs, name)) this.inputs[name] = value;
  }
  pinDrive(port, bit) {
    const s = this.cpu.sfr, [m1, m0] = MODE[port];
    const mode = (((s[m1] >> bit) & 1) << 1) | ((s[m0] >> bit) & 1);
    return mode === 2 ? 1 : (s[PORTS[port]] >> bit) & 1;
  }
  keyboard() {
    const nodes = Array.from({ length: 8 }, (_, i) => i < 4 ? this.pinDrive(3, i) : this.pinDrive(...COLS[i - 4]));
    if (this.inputs.keyMode === 'independent') nodes[4] = 0;
    const edges = this.inputs.keys.map(k => [3 - ((k - 4) % 4), 4 + Math.floor((k - 4) / 4)])
      .filter(([, col]) => (this.inputs.keyMode !== 'independent' || col === 4) && (!this.inputs.frequencyEnabled || col !== 7));
    for (let i = 0; i < 8; i++) for (const [a, b] of edges) if (!nodes[a] || !nodes[b]) nodes[a] = nodes[b] = 0;
    return nodes;
  }
  readPort(p) {
    let value = 0; for (let b = 0; b < 8; b++) value |= this.pinDrive(p, b) << b;
    const now = this.now;
    if (p === 1) { if (!this.temp.read(now)) value &= ~16; if (now >= this.echoAt && now < this.echoUntil) value &= ~2; }
    if (p === 2) { if (!this.i2c.drive) value &= ~2; if (this.rtc.ce && !this.rtc.drive) value &= ~8; }
    if ((p === 3 || p === 4) && (this.inputs.keys.length || this.inputs.keyMode === 'independent')) {
      const k = this.keyboard();
      if (p === 3) { for (let b = 0; b < 4; b++) if (!k[b]) value &= ~(1 << b); if (!k[6]) value &= ~32; if (!k[7]) value &= ~16; }
      else { if (!k[4]) value &= ~16; if (!k[5]) value &= ~4; }
    }
    if (p === 3 && this.inputs.frequencyEnabled && this.inputs.frequency > 0) {
      if (Math.floor(now * this.inputs.frequency * 2 / 1e6) % 2) value &= ~16;
    }
    return value;
  }
  readSfr(a, latch = false) {
    const p = PORTS.indexOf(a);
    if (p >= 0 && !latch) return this.readPort(p);
    if (a === 0x99 && !latch) return this.rx;
    return this.cpu.sfr[a];
  }
  writeSfr(a, v, old) {
    const now = this.now, s = this.cpu.sfr;
    for (let i = 0; i < 2; i++) {
      if (a === 0x8a + i) this.reload[i] = (this.reload[i] & 0xff00) | v;
      if (a === 0x8c + i) this.reload[i] = (this.reload[i] & 255) | (v << 8);
    }
    if (a === 0xd7) this.reload[2] = (this.reload[2] & 0xff00) | v;
    if (a === 0xd6) this.reload[2] = (this.reload[2] & 255) | (v << 8);
    if (a === 0xaf && !(v & 4)) this.timer2Pending = false;
    if (a === 0x99) {
      if (this.txByte !== null) this.warn('串口发送尚未结束时再次写入 SBUF，前一字节被覆盖。');
      this.txByte = v; this.txDue = now + 10e6 / (this.baud() || 9600);
    }
    if (a === 0x80 || a === 0xa0 || a === 0xc0) this.updateLatches();
    if (a === 0xa0 || a === 0x90) {
      this.i2c.update(this.pinDrive(2, 0), this.pinDrive(2, 1), now);
      this.rtc.update(this.pinDrive(1, 3), this.pinDrive(1, 7), this.pinDrive(2, 3), now);
      this.temp.update(this.pinDrive(1, 4), now);
      const tx = this.pinDrive(1, 0);
      if (tx !== this.lastTx) {
        if (tx) this.txStart = now;
        else {
          const pulse = now - this.txStart;
          if (this.inputs.ultrasonicMode === 'pulse' && pulse >= 8 && pulse <= 100) this.ping(now);
          if (this.inputs.ultrasonicMode === 'board') {
            if (this.burstStart < 0 || now - this.burstLast > 100) { this.burstEdges = 0; this.burstStart = this.txStart; }
            if (pulse >= 5 && pulse <= 25) this.burstEdges++; else this.burstEdges = 0;
            if (this.burstEdges === 8) { this.ping(now); this.burstEdges = 0; }
            this.burstLast = now;
          }
        }
        this.lastTx = tx;
      }
    }
    if (a === 0x8e && ((v ^ old) & 2) && (v & 2)) this.warn('已选择外部 MOVX 总线；没有接入外部 RAM，外部读取返回 FFH。');
    if ([0xbc, 0xc2, 0xcd, 0xde, 0xd5, 0x9a].includes(a) && v) this.warn(`写入尚未模拟的功能寄存器 ${a.toString(16).toUpperCase()}H。`);
    if (a === 0x87 && (v & 2)) this.warn('程序进入掉电模式；本版不模拟低功耗唤醒。');
  }
  readX(addr, ri = false) {
    if (ri && !(this.cpu.sfr[0x8e] & 2)) addr &= 255;
    else if (ri) addr |= this.cpu.sfr[0xa0] << 8;
    if (!(this.cpu.sfr[0x8e] & 2) && addr < 0x700) return this.cpu.xram[addr];
    this.warn('程序读取了未连接的外部数据总线，返回 FFH。'); return 255;
  }
  writeX(addr, value, ri = false) {
    if (ri && !(this.cpu.sfr[0x8e] & 2)) addr &= 255;
    else if (ri) addr |= this.cpu.sfr[0xa0] << 8;
    if (!(this.cpu.sfr[0x8e] & 2) && addr < 0x700) { this.cpu.xram[addr] = value; return; }
    if (this.inputs.writeMode === 'bus') {
      const select = (addr >> 13) - 4;
      if (select >= 0 && select < 4) { this.integrateDisplay(); this.latch[select] = value; this.latchWrites[select]++; }
    } else this.warn('发生外部 MOVX 写入，请检查 J13 的 I/O／总线写入模式。');
  }
  updateLatches() {
    const select = (this.cpu.sfr[0xa0] >> 5) - 4;
    if (select < 0 || select > 3 || (this.inputs.writeMode === 'bus' && this.pinDrive(4, 2))) return;
    const value = this.cpu.sfr[0x80];
    if (this.latch[select] !== value) { this.integrateDisplay(); this.latch[select] = value; this.latchWrites[select]++; }
  }
  integrateDisplay() {
    const dt = this.now - this.displayLast; this.displayLast = this.now; if (dt <= 0) return;
    for (let i = 0; i < 8; i++) {
      if (!(this.latch[0] & (1 << i))) this.ledEnergy[i] += dt;
      if (this.latch[2] & (1 << i)) for (let b = 0; b < 8; b++) if (!(this.latch[3] & (1 << b))) this.segEnergy[i * 8 + b] += dt;
    }
  }
  ping(now) {
    this.pings++; this.echoAt = this.inputs.echo ? now + this.inputs.distance / 0.017 : Infinity;
    this.echoUntil = this.echoAt + 2000;
  }
  baud() {
    const s = this.cpu.sfr;
    if ((s[0x98] >> 6) !== 1) return 0;
    if (s[0x8e] & 1) return s[0x8e] & 16 ? this.hz / (s[0x8e] & 4 ? 1 : 12) / (65536 - this.reload[2]) / 4 : 0;
    if (!(s[0x88] & 64)) return 0;
    const period = ((s[0x89] >> 4) & 3) === 2 ? 256 - s[0x8d] : 65536 - this.reload[1];
    return this.hz / (s[0x8e] & 64 ? 1 : 12) / period / ((s[0x87] & 128) ? 16 : 32);
  }
  serialInput(bytes) {
    if (this.rxQueue.length + bytes.length > 4096) throw new Error('串口待发送数据超过 4096 字节，请等待后重试');
    this.rxQueue.push(...bytes); if (!Number.isFinite(this.rxDue)) this.rxDue = this.now + 10e6 / (this.baud() || 9600);
  }
  advance(clocks) {
    const s = this.cpu.sfr, now = this.now, before = now - clocks * 1e6 / this.hz;
    let t0Overflows = 0;
    for (let i = 0; i < 2; i++) {
      const run = 16 << (i * 2); if (!(s[0x88] & run)) continue;
      const mode = (s[0x89] >> (i * 4)) & 15;
      if ((mode & 8) && !(this.readPort(3) & (1 << (2 + i)))) continue;
      let inc;
      if (mode & 4) {
        inc = i === 0 && this.inputs.frequencyEnabled && this.pinDrive(3, 4) ? Math.floor(now * this.inputs.frequency / 1e6 + 0.5) - Math.floor(before * this.inputs.frequency / 1e6 + 0.5) : 0;
      } else {
        const div = (s[0x8e] & (128 >> i)) ? 1 : 12;
        this.frac[i] += clocks; inc = Math.floor(this.frac[i] / div); this.frac[i] %= div;
      }
      if (!inc) continue;
      let value = s[0x8a + i] | s[0x8c + i] << 8, over = 0;
      switch (mode & 3) {
        case 0:
          value += inc;
          while (value > 65535) { value = value - 65536 + this.reload[i]; over++; }
          break;
        case 1: value += inc; over = value >>> 16; value &= 65535; break;
        case 2: {
          let lo = (value & 255) + inc;
          while (lo > 255) { lo = lo - 256 + (value >> 8); over++; }
          value = (value & 0xff00) | lo; break;
        }
        default: this.warn('定时器模式 3 尚未模拟，请使用模式 0、1 或 2。'); continue;
      }
      s[0x8a + i] = value & 255; s[0x8c + i] = value >> 8;
      if (over) { s[0x88] |= 32 << (i * 2); this.overflowCounts[i] += over; if (!i) t0Overflows = over; }
    }
    if (s[0x8e] & 16) {
      const div = s[0x8e] & 4 ? 1 : 12; this.frac[2] += clocks;
      const inc = Math.floor(this.frac[2] / div); this.frac[2] %= div;
      if (s[0x8e] & 8) this.warn('Timer2 外部计数输入尚未接入。');
      else if (inc) {
        let v = (s[0xd7] | s[0xd6] << 8) + inc;
        while (v > 65535) { v = v - 65536 + this.reload[2]; this.timer2Pending = !!(s[0xaf] & 4); this.overflowCounts[2]++; }
        s[0xd7] = v; s[0xd6] = v >> 8;
      }
    }
    if (s[0xd8] & 64) {
      const source = (s[0xd9] >> 1) & 7, div = [12, 2, 0, 0, 1, 4, 6, 8][source];
      let inc = 0;
      if (div) { this.pcaFrac += clocks; inc = Math.floor(this.pcaFrac / div); this.pcaFrac %= div; }
      else if (source === 2) inc = t0Overflows;
      const v = (s[0xe9] | s[0xf9] << 8) + inc;
      if (v > 65535) s[0xd8] |= 128;
      s[0xe9] = v; s[0xf9] = v >> 8;
    }
    if (this.txByte !== null && now >= this.txDue) {
      this.tx.push(this.txByte); this.txByte = null; this.txDue = Infinity; s[0x98] |= 2; this.txCount++;
      if (this.tx.length > 16384) this.tx.splice(0, 8192);
    }
    if (this.rxQueue.length && now >= this.rxDue) {
      const byte = this.rxQueue.shift();
      if (s[0x98] & 16) {
        if (s[0x98] & 1) this.warn('串口接收溢出：固件未及时读取上一字节。');
        else { this.rx = byte; s[0x98] |= 1; this.rxCount++; }
      }
      this.rxDue = this.rxQueue.length ? now + 10e6 / (this.baud() || 9600) : Infinity;
    }
    // External interrupt pins are resolved after the instruction's port writes.
    if ((s[0xa8] & 5) || this.inputs.keys.length) {
      const p3 = this.readPort(3);
      for (let i = 0; i < 2; i++) {
        const mask = 1 << (2 + i), flag = 2 << (i * 2), edge = 1 << (i * 2);
        if (s[0x88] & edge) { if ((this.lastP3 & mask) && !(p3 & mask)) s[0x88] |= flag; }
        else if ((this.lastP3 ^ p3) & mask) s[0x88] |= flag;
      }
      this.lastP3 = p3;
    }
  }
  runUs(us, maxInstructions = 5000000) {
    const target = this.cpu.cycles + us * this.hz / 1e6; let done = 0;
    while (this.cpu.cycles < target && done++ < maxInstructions) {
      if (this.breakpoints.has(this.cpu.pc)) return 'breakpoint';
      if (this.cpu.pc >= 0xf000) throw new Error(`PC 超出 60 KB 程序空间：${this.cpu.pc.toString(16)}`);
      this.cpu.step();
    }
    return this.cpu.cycles >= target ? 'complete' : 'budget';
  }
  snapshot() {
    this.integrateDisplay(); const dt = this.now - this.frameLast;
    if (dt > 0) {
      this.lastSegments = Array.from(this.segEnergy, x => Math.min(1, x / dt * 8));
      this.lastLeds = Array.from(this.ledEnergy, x => Math.min(1, x / dt));
      this.segEnergy.fill(0); this.ledEnergy.fill(0); this.frameLast = this.now;
    }
    this.i2c.commit(this.now); this.temp.tick(this.now);
    const s = this.cpu.sfr;
    return {
      time: this.now / 1e6, pc: this.cpu.pc, instructions: this.cpu.instructions, registers: { A: this.cpu.a, B: s[0xf0], PSW: s[0xd0], SP: s[0x81], DPTR: this.cpu.dptr, ...Object.fromEntries(PORTS.map((a, p) => ['P' + p, s[a]])) },
      segments: this.lastSegments, leds: this.lastLeds, latch: [...this.latch], latchWrites: [...this.latchWrites],
      buzzer: !!(this.latch[1] & 64), relay: !!(this.latch[1] & 16), rtc: this.rtc.display(this.now), rtcHalted: !!(this.rtc.reg[0] & 128),
      temperature: ((this.temp.scratch[0] | this.temp.scratch[1] << 8) << 16 >> 16) / 16, converting: !!this.temp.busyUntil,
      eeprom: [...this.i2c.memory], eepromVersion: this.i2c.version, dac: this.i2c.control & 64 ? this.i2c.dac * 5 / 256 : 0,
      baud: this.baud(), tx: this.tx.splice(0), txCount: this.txCount, rxCount: this.rxCount, irq: [...this.irqCounts],
      devices: { i2c: this.i2c.transactions, rtcReads: this.rtc.reads, tempReads: this.temp.reads, conversions: this.temp.conversions, eepromWrites: this.i2c.writes, pings: this.pings },
      timers: [s[0x8a] | s[0x8c] << 8, s[0x8b] | s[0x8d] << 8, s[0xd7] | s[0xd6] << 8], pca: s[0xe9] | s[0xf9] << 8,
      diagnostics: [...this.diagnostics],
    };
  }
}
