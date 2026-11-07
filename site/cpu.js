// SPDX-License-Identifier: MIT
// MCS-51 interpreter. STC15 timing is in oscillator clocks, not 12T machine cycles.
export class CPU {
  constructor(bus) { this.bus = bus; this.code = new Uint8Array(65536); this.reset(); }
  reset() {
    this.ram = new Uint8Array(256); this.sfr = new Uint8Array(256); this.xram = new Uint8Array(65536);
    this.sfr[0x81] = 7;
    for (const p of [0x80, 0x90, 0xa0, 0xb0, 0xc0, 0xc8]) this.sfr[p] = 255;
    this.pc = 0; this.cycles = 0; this.instructions = 0; this.isr = []; this.irqDelay = 0;
  }
  get a() { return this.sfr[0xe0]; } set a(v) { this.sfr[0xe0] = v; }
  get cy() { return this.sfr[0xd0] >>> 7; } set cy(v) { this.sfr[0xd0] = (this.sfr[0xd0] & 127) | (v ? 128 : 0); }
  get dptr() { return this.sfr[0x82] | this.sfr[0x83] << 8; }
  set dptr(v) { this.sfr[0x82] = v; this.sfr[0x83] = v >>> 8; }
  rn(n) { return this.ram[(this.sfr[0xd0] & 24) + n]; }
  wrn(n, v) { this.ram[(this.sfr[0xd0] & 24) + n] = v; }
  read(a, latch = false) { return a < 128 ? this.ram[a] : this.bus.readSfr(a, latch); }
  write(a, v) {
    v &= 255;
    if (a < 128) this.ram[a] = v;
    else { const old = this.sfr[a]; this.sfr[a] = v; this.bus.writeSfr(a, v, old); if ([0xa8, 0xaf, 0xb8, 0xb7, 0xb5, 0xb6].includes(a)) this.irqDelay = 1; }
  }
  bit(b, latch = false) { return (this.read(b < 128 ? 0x20 + (b >> 3) : b & 248, latch) >> (b & 7)) & 1; }
  wbit(b, v) { const a = b < 128 ? 0x20 + (b >> 3) : b & 248; this.write(a, (this.read(a, true) & ~(1 << (b & 7))) | ((v ? 1 : 0) << (b & 7))); }
  fetch() { const v = this.code[this.pc]; this.pc = (this.pc + 1) & 65535; return v; }
  word() { return this.fetch() * 256 + this.fetch(); }
  rel(take) { const n = this.fetch(); if (take) this.pc = (this.pc + (n > 127 ? n - 256 : n)) & 65535; }
  push(v) { this.sfr[0x81]++; this.ram[this.sfr[0x81]] = v; }
  pop() { const v = this.ram[this.sfr[0x81]]; this.sfr[0x81]--; return v; }
  call(addr) { this.push(this.pc & 255); this.push(this.pc >> 8); this.pc = addr; }
  ret() { this.pc = (this.pop() << 8) | this.pop(); }
  add(v, carry = 0, sub = false) {
    const a = this.a, result = sub ? a - v - carry : a + v + carry, out = result & 255;
    const ac = sub ? (a & 15) < (v & 15) + carry : (a & 15) + (v & 15) + carry > 15;
    const ov = sub ? ((a ^ v) & (a ^ out) & 128) : (~(a ^ v) & (a ^ out) & 128);
    this.sfr[0xd0] = (this.sfr[0xd0] & ~0xc4) | ((sub ? result < 0 : result > 255) ? 128 : 0) | (ac ? 64 : 0) | (ov ? 4 : 0);
    this.a = out;
  }
  operand(op) { const low = op & 15; return low === 4 ? this.fetch() : low === 5 ? this.read(this.fetch()) : low < 8 ? this.ram[this.rn(low & 1)] : this.rn(low & 7); }
  interrupt() {
    if (this.irqDelay) { this.irqDelay--; return false; }
    const ie = this.sfr[0xa8]; if (!(ie & 128)) return false;
    const tc = this.sfr[0x88], pca = this.sfr[0xd8], cm = this.sfr[0xd9];
    const pending = [tc & 2, tc & 32, tc & 8, tc & 128, this.sfr[0x98] & 3, 0, 0, ((pca & 128) && (cm & 1)), 0, 0, 0, 0, this.bus.timer2Pending];
    const vectors = [3, 11, 19, 27, 35, 43, 51, 59, 67, 75, 83, 91, 99];
    let chosen = -1, best = this.isr.length ? this.isr[this.isr.length - 1] : -1;
    for (let i = 0; i < pending.length; i++) {
      const enabled = i === 12 ? this.sfr[0xaf] & 4 : i === 7 ? true : ie & (1 << i);
      if (!pending[i] || !enabled) continue;
      const priority = i === 12 ? 0 : ((this.sfr[0xb8] >> i) & 1) + (((this.sfr[0xb7] >> i) & 1) << 1);
      if (priority > best) { chosen = i; best = priority; }
    }
    if (chosen < 0) return false;
    if (chosen === 1) this.sfr[0x88] &= ~32;
    if (chosen === 3) this.sfr[0x88] &= ~128;
    if (chosen === 0) this.sfr[0x88] &= ~2;
    if (chosen === 2) this.sfr[0x88] &= ~8;
    if (chosen === 12) this.bus.timer2Pending = false;
    this.sfr[0x87] &= ~1; this.isr.push(best); this.call(vectors[chosen]); this.bus.irqCounts[chosen]++;
    this.advance(4); return true;
  }
  advance(n) { this.cycles += n; this.bus.advance(n); }
  step() {
    if (this.interrupt()) return;
    if (this.sfr[0x87] & 3) { this.advance(12); return; }
    const at = this.pc, op = this.fetch(), low = op & 15, high = op & 0xf0;
    let n = 1, x, y, v;
    if ((op & 31) === 1) { x = this.fetch(); this.pc = (this.pc & 0xf800) | ((op & 0xe0) << 3) | x; n = 3; }
    else if ((op & 31) === 17) { x = this.fetch(); this.call((this.pc & 0xf800) | ((op & 0xe0) << 3) | x); n = 4; }
    else if ((high === 0x20 || high === 0x30 || high === 0x90) && low >= 4) {
      v = this.operand(op); this.add(v, high === 0x20 ? 0 : this.cy, high === 0x90); n = low < 8 ? 2 : 1;
    } else if ((high === 0x40 || high === 0x50 || high === 0x60) && low >= 4) {
      v = this.operand(op); this.a = high === 0x40 ? this.a | v : high === 0x50 ? this.a & v : this.a ^ v; n = low < 8 ? 2 : 1;
    } else if (low >= 8) {
      const r = op & 7;
      switch (high) {
        case 0x00: this.wrn(r, this.rn(r) + 1); n = 2; break;
        case 0x10: this.wrn(r, this.rn(r) - 1); n = 2; break;
        case 0x70: this.wrn(r, this.fetch()); n = 2; break;
        case 0x80: this.write(this.fetch(), this.rn(r)); n = 2; break;
        case 0xa0: this.wrn(r, this.read(this.fetch())); n = 3; break;
        case 0xb0: v = this.fetch(); this.cy = this.rn(r) < v; this.rel(this.rn(r) !== v); n = 4; break;
        case 0xc0: v = this.rn(r); this.wrn(r, this.a); this.a = v; n = 2; break;
        case 0xd0: this.wrn(r, this.rn(r) - 1); this.rel(this.rn(r) !== 0); n = 4; break;
        case 0xe0: this.a = this.rn(r); break;
        case 0xf0: this.wrn(r, this.a); break;
      }
    } else {
      switch (op) {
        case 0x00: break;
        case 0x02: this.pc = this.word(); n = 4; break;
        case 0x03: this.a = (this.a >>> 1) | (this.a << 7); break;
        case 0x04: this.a++; break;
        case 0x05: x = this.fetch(); this.write(x, this.read(x, true) + 1); n = 3; break;
        case 0x06: case 0x07: this.ram[this.rn(op & 1)]++; n = 3; break;
        case 0x10: x = this.fetch(); v = this.bit(x, true); if (v) this.wbit(x, 0); this.rel(v); n = 5; break;
        case 0x12: this.call(this.word()); n = 4; break;
        case 0x13: v = this.cy; this.cy = this.a & 1; this.a = (this.a >>> 1) | (v << 7); break;
        case 0x14: this.a--; break;
        case 0x15: x = this.fetch(); this.write(x, this.read(x, true) - 1); n = 3; break;
        case 0x16: case 0x17: this.ram[this.rn(op & 1)]--; n = 3; break;
        case 0x20: x = this.fetch(); this.rel(this.bit(x)); n = 5; break;
        case 0x22: this.ret(); n = 4; break;
        case 0x23: this.a = (this.a << 1) | (this.a >>> 7); break;
        case 0x30: x = this.fetch(); this.rel(!this.bit(x)); n = 5; break;
        case 0x32: this.ret(); this.isr.pop(); this.irqDelay = 1; n = 4; break;
        case 0x33: v = this.cy; this.cy = this.a & 128; this.a = (this.a << 1) | v; break;
        case 0x40: this.rel(this.cy); n = 3; break;
        case 0x42: case 0x52: case 0x62:
        case 0x43: case 0x53: case 0x63:
          x = this.fetch(); y = this.read(x, true); v = op & 1 ? this.fetch() : this.a;
          this.write(x, high === 0x40 ? y | v : high === 0x50 ? y & v : y ^ v); n = 3; break;
        case 0x50: this.rel(!this.cy); n = 3; break;
        case 0x60: this.rel(this.a === 0); n = 4; break;
        case 0x70: this.rel(this.a !== 0); n = 4; break;
        case 0x72: this.cy = this.cy | this.bit(this.fetch()); n = 2; break;
        case 0x73: this.pc = (this.a + this.dptr) & 65535; n = 5; break;
        case 0x74: this.a = this.fetch(); n = 2; break;
        case 0x75: x = this.fetch(); this.write(x, this.fetch()); n = 3; break;
        case 0x76: case 0x77: this.ram[this.rn(op & 1)] = this.fetch(); n = 2; break;
        case 0x80: this.rel(true); n = 3; break;
        case 0x82: this.cy = this.cy & this.bit(this.fetch()); n = 2; break;
        case 0x83: this.a = this.code[(this.pc + this.a) & 65535]; n = 4; break;
        case 0x84: v = this.sfr[0xf0]; x = this.a; this.cy = 0; this.sfr[0xd0] = (this.sfr[0xd0] & ~4) | (v ? 0 : 4); if (v) { this.a = Math.floor(x / v); this.sfr[0xf0] = x % v; } n = 6; break;
        case 0x85: x = this.fetch(); this.write(this.fetch(), this.read(x)); n = 3; break;
        case 0x86: case 0x87: this.write(this.fetch(), this.ram[this.rn(op & 1)]); n = 3; break;
        case 0x90: this.dptr = this.word(); n = 3; break;
        case 0x92: this.wbit(this.fetch(), this.cy); n = 3; break;
        case 0x93: this.a = this.code[(this.dptr + this.a) & 65535]; n = 5; break;
        case 0xa0: this.cy = this.cy | (1 - this.bit(this.fetch())); n = 2; break;
        case 0xa2: this.cy = this.bit(this.fetch()); n = 2; break;
        case 0xa3: this.dptr++; n = 1; break;
        case 0xa4: v = this.a * this.sfr[0xf0]; this.a = v; this.sfr[0xf0] = v >> 8; this.cy = 0; this.sfr[0xd0] = (this.sfr[0xd0] & ~4) | (v > 255 ? 4 : 0); n = 2; break;
        case 0xa5: throw new Error(`不支持的保留指令 A5H，PC=${at.toString(16).padStart(4, '0')}`);
        case 0xa6: case 0xa7: this.ram[this.rn(op & 1)] = this.read(this.fetch()); n = 3; break;
        case 0xb0: this.cy = this.cy & (1 - this.bit(this.fetch())); n = 2; break;
        case 0xb2: x = this.fetch(); this.wbit(x, 1 - this.bit(x, true)); n = 3; break;
        case 0xb3: this.cy = !this.cy; break;
        case 0xb4: case 0xb5: case 0xb6: case 0xb7:
          x = op < 0xb6 ? this.a : this.ram[this.rn(op & 1)]; y = this.fetch(); v = op === 0xb5 ? this.read(y) : y;
          this.cy = x < v; this.rel(x !== v); n = op === 0xb4 ? 4 : 5; break;
        case 0xc0: this.push(this.read(this.fetch())); n = 3; break;
        case 0xc2: this.wbit(this.fetch(), 0); n = 3; break;
        case 0xc3: this.cy = 0; break;
        case 0xc4: this.a = (this.a << 4) | (this.a >>> 4); break;
        case 0xc5: x = this.fetch(); v = this.read(x); this.write(x, this.a); this.a = v; n = 3; break;
        case 0xc6: case 0xc7: x = this.rn(op & 1); v = this.ram[x]; this.ram[x] = this.a; this.a = v; n = 3; break;
        case 0xd0: x = this.fetch(); v = this.pop(); this.write(x, v); n = 2; break;
        case 0xd2: this.wbit(this.fetch(), 1); n = 3; break;
        case 0xd3: this.cy = 1; break;
        case 0xd4:
          v = this.a; x = this.cy; if ((v & 15) > 9 || (this.sfr[0xd0] & 64)) v += 6;
          if (v > 0x9f || x) v += 0x60; this.cy = x || v > 255; this.a = v; n = 3; break;
        case 0xd5: x = this.fetch(); v = (this.read(x, true) - 1) & 255; this.write(x, v); this.rel(v !== 0); n = 5; break;
        case 0xd6: case 0xd7: x = this.rn(op & 1); v = this.ram[x]; this.ram[x] = (v & 240) | (this.a & 15); this.a = (this.a & 240) | (v & 15); n = 3; break;
        case 0xe0: this.a = this.bus.readX(this.dptr); n = 2; break;
        case 0xe2: case 0xe3: this.a = this.bus.readX(this.rn(op & 1), true); n = 3; break;
        case 0xe4: this.a = 0; break;
        case 0xe5: this.a = this.read(this.fetch()); n = 2; break;
        case 0xe6: case 0xe7: this.a = this.ram[this.rn(op & 1)]; n = 2; break;
        case 0xf0: this.bus.writeX(this.dptr, this.a); n = 3; break;
        case 0xf2: case 0xf3: this.bus.writeX(this.rn(op & 1), this.a, true); n = 4; break;
        case 0xf4: this.a = ~this.a; break;
        case 0xf5: this.write(this.fetch(), this.a); n = 2; break;
        case 0xf6: case 0xf7: this.ram[this.rn(op & 1)] = this.a; n = 2; break;
        default: throw new Error(`未实现指令 ${op.toString(16)}`);
      }
    }
    v = this.a; v ^= v >>> 4; v ^= v >>> 2; v ^= v >>> 1;
    this.sfr[0xd0] = (this.sfr[0xd0] & 254) | (v & 1); this.instructions++; this.advance(n);
  }
}
