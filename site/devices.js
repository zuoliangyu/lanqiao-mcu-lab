// SPDX-License-Identifier: MIT
const bcd = n => (Math.floor(n / 10) << 4) | (n % 10);
const dec = n => (n >> 4) * 10 + (n & 15);

export class I2CBus {
  constructor(board, saved) {
    this.board = board; this.memory = new Uint8Array(256).fill(255);
    if (saved?.length === 256) this.memory.set(saved);
    this.ptr = 0; this.control = 0; this.sample = 0; this.dac = 0; this.pending = []; this.busyUntil = 0;
    this.writes = 0; this.transactions = 0; this.reads = 0; this.version = 0; this.resetBus();
  }
  resetBus() { this.scl = 1; this.sda = 1; this.drive = 1; this.phase = 'idle'; this.device = null; this.buffer = []; this.bits = 0; this.byte = 0; }
  commit(now) {
    if (this.pending.length && now >= this.busyUntil) {
      for (const [a, v] of this.pending) this.memory[a] = v;
      this.pending = []; this.writes++; this.version++;
    }
  }
  accept(v, now) {
    if (!this.device) {
      this.reading = !!(v & 1); this.index = 0; this.readCount = 0;
      if ((v >> 1) === 0x50 && now >= this.busyUntil) this.device = 'eeprom';
      else if ((v >> 1) === 0x48) this.device = 'pcf';
      else return false;
      this.transactions++; return true;
    }
    if (this.device === 'eeprom') {
      if (!this.index++) { this.ptr = v; this.page = v & 248; this.offset = v & 7; }
      else { this.buffer.push([this.page | this.offset, v]); this.offset = (this.offset + 1) & 7; this.ptr = this.page | this.offset; }
    } else {
      if (!this.index++) { this.control = v; if (v & 0x30) this.board.warn('PCF8591 当前配置了差分输入模式；本版仅实现四路单端 ADC。'); }
      else this.dac = v;
    }
    return true;
  }
  nextByte() {
    this.reads++; this.readCount++;
    if (this.device === 'eeprom') { const v = this.memory[this.ptr]; this.ptr = (this.ptr + 1) & 255; return v; }
    const previous = this.sample;
    this.sample = Math.max(0, Math.min(255, Math.floor(this.board.inputs.analog[this.control & 3] / 5 * 256)));
    if (this.control & 4) this.control = (this.control & ~3) | ((this.control + 1) & 3);
    return previous;
  }
  send() { this.byte = this.nextByte(); this.bits = 0; this.phase = 'send'; this.drive = (this.byte >>> 7) & 1; }
  update(scl, sda, now) {
    this.commit(now);
    if (scl && this.scl && sda !== this.sda) {
      if (!sda) { this.phase = 'receive'; this.device = null; this.bits = 0; this.byte = 0; this.drive = 1; }
      else {
        if (this.buffer.length) { this.pending = this.buffer; this.buffer = []; this.busyUntil = now + 5000; }
        this.phase = 'idle'; this.drive = 1;
      }
    } else if (scl !== this.scl) {
      if (scl) {
        if (this.phase === 'receive') {
          this.byte = (this.byte << 1) | sda;
          if (++this.bits === 8) { this.ack = this.accept(this.byte, now); this.phase = 'ack-setup'; }
        } else if (this.phase === 'ack') this.phase = 'ack-end';
        else if (this.phase === 'send') this.bits++;
        else if (this.phase === 'master-ack') {
          this.continueRead = !sda; this.phase = 'master-ack-end';
          if (sda && this.device === 'pcf' && this.readCount === 1) this.board.warn('PCF8591 读事务仅取首字节，得到的是上一转换结果；切换通道后通常应丢弃首字节再读。');
        }
      } else {
        if (this.phase === 'ack-setup') { this.drive = this.ack ? 0 : 1; this.phase = 'ack'; }
        else if (this.phase === 'ack-end') {
          this.drive = 1;
          if (!this.ack) this.phase = 'idle';
          else if (this.reading) this.send();
          else { this.phase = 'receive'; this.bits = 0; this.byte = 0; }
        } else if (this.phase === 'send') {
          if (this.bits === 8) { this.drive = 1; this.phase = 'master-ack'; }
          else this.drive = (this.byte >> (7 - this.bits)) & 1;
        } else if (this.phase === 'master-ack-end') {
          if (this.continueRead) this.send(); else { this.phase = 'idle'; this.drive = 1; }
        }
      }
    }
    this.scl = scl; this.sda = sda;
  }
}

export class DS1302 {
  constructor(now = 0) {
    this.reg = new Uint8Array([0, 0, 0x12, 1, 1, 1, 0x26, 0x80, 0]);
    this.ram = new Uint8Array(31); this.last = now; this.reads = 0; this.writes = 0; this.resetBus();
  }
  resetBus() { this.ce = 0; this.sck = 1; this.drive = 1; this.command = 0; this.bits = 0; this.byte = 0; this.stage = 'command'; }
  hour() { const r = this.reg[2]; return r & 128 ? dec(r & 31) % 12 + (r & 32 ? 12 : 0) : dec(r & 63); }
  tick(now) {
    if (this.reg[0] & 128) { this.last = now; return; }
    const sec = Math.floor((now - this.last) / 1e6); if (sec <= 0) return;
    this.last += sec * 1e6;
    const d = new Date(Date.UTC(2000 + dec(this.reg[6]), Math.max(1, dec(this.reg[4])) - 1, Math.max(1, dec(this.reg[3])), this.hour(), dec(this.reg[1]), dec(this.reg[0]) + sec));
    const oldDay = new Date(Date.UTC(2000 + dec(this.reg[6]), Math.max(1, dec(this.reg[4])) - 1, Math.max(1, dec(this.reg[3]))));
    const days = Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - oldDay.getTime()) / 86400000);
    this.reg[0] = bcd(d.getUTCSeconds()); this.reg[1] = bcd(d.getUTCMinutes());
    this.reg[2] = this.reg[2] & 128 ? 128 | (d.getUTCHours() >= 12 ? 32 : 0) | bcd(d.getUTCHours() % 12 || 12) : bcd(d.getUTCHours());
    this.reg[3] = bcd(d.getUTCDate()); this.reg[4] = bcd(d.getUTCMonth() + 1); this.reg[6] = bcd(d.getUTCFullYear() % 100);
    this.reg[5] = ((Math.max(1, this.reg[5]) - 1 + days) % 7) + 1;
  }
  readByte(now) { this.tick(now); this.reads++; return (this.isRam ? this.ram : this.reg)[this.addr] || 0; }
  writeByte(v, now) {
    this.tick(now);
    if (!(this.reg[7] & 128) || (!this.isRam && this.addr === 7)) {
      (this.isRam ? this.ram : this.reg)[this.addr] = v; this.writes++;
      if (!this.isRam && this.addr === 0) this.last = now;
    }
  }
  update(ce, sck, data, now) {
    if (!ce) { this.ce = 0; this.sck = sck; this.drive = 1; return; }
    if (!this.ce) { this.stage = 'command'; this.bits = 0; this.byte = 0; this.drive = 1; }
    if (sck !== this.sck) {
      if (sck && this.stage !== 'read') {
        this.byte |= data << this.bits;
        if (++this.bits === 8) {
          if (this.stage === 'command') {
            this.command = this.byte; this.isRam = !!(this.byte & 64); this.addr = (this.byte >> 1) & 31;
            this.burst = this.addr === 31; if (this.burst) this.addr = 0;
            this.stage = !(this.byte & 128) ? 'invalid' : this.byte & 1 ? 'read' : 'write'; this.outIndex = 0;
            if (this.stage === 'read') this.outByte = this.readByte(now);
          } else if (this.stage === 'write') { this.writeByte(this.byte, now); if (this.burst) this.addr = (this.addr + 1) % (this.isRam ? 31 : 8); }
          this.bits = 0; this.byte = 0;
        }
      } else if (!sck && this.stage === 'read') {
        if (this.outIndex === 8) {
          this.outIndex = 0; if (this.burst) this.addr = (this.addr + 1) % (this.isRam ? 31 : 8);
          this.outByte = this.readByte(now);
        }
        this.drive = (this.outByte >> this.outIndex++) & 1;
      }
    }
    this.ce = ce; this.sck = sck;
  }
  setTime(value, now) {
    const d = new Date(value); if (Number.isNaN(+d)) return;
    this.reg.set([bcd(d.getSeconds()), bcd(d.getMinutes()), bcd(d.getHours()), bcd(d.getDate()), bcd(d.getMonth() + 1), d.getDay() || 7, bcd(d.getFullYear() % 100), 0x80]); this.last = now;
  }
  display(now) { this.tick(now); return `20${dec(this.reg[6]).toString().padStart(2, '0')}-${dec(this.reg[4]).toString().padStart(2, '0')}-${dec(this.reg[3]).toString().padStart(2, '0')} ${[this.hour(), dec(this.reg[1]), dec(this.reg[0] & 127)].map(x => x.toString().padStart(2, '0')).join(':')}`; }
}

export function crc8(bytes) {
  let crc = 0;
  for (let b of bytes) for (let i = 0; i < 8; i++) { const mix = (crc ^ b) & 1; crc >>= 1; if (mix) crc ^= 0x8c; b >>= 1; }
  return crc;
}
export class DS18B20 {
  constructor(board) {
    this.board = board; this.scratch = new Uint8Array([0x50, 0x05, 75, 70, 0x7f, 255, 12, 16, 0]);
    this.saved = [75, 70, 0x7f]; this.busyUntil = 0; this.conversions = 0; this.reads = 0; this.resetBus();
  }
  resetBus() { this.level = 1; this.fall = 0; this.presenceStart = -1; this.presenceEnd = -1; this.lowUntil = -1; this.phase = 'rom'; this.bits = 0; this.byte = 0; this.out = []; this.index = 0; }
  tick(now) {
    if (this.busyUntil && now >= this.busyUntil) {
      const shift = 3 - ((this.scratch[4] >> 5) & 3), raw = Math.round(this.target * 16) & (0xffff << shift);
      this.scratch[0] = raw & 255; this.scratch[1] = (raw >> 8) & 255; this.busyUntil = 0; this.conversions++;
    }
  }
  queue(bytes) { this.out = bytes.flatMap(b => Array.from({ length: 8 }, (_, i) => (b >> i) & 1)); this.phase = 'read'; }
  accept(v, now) {
    if (this.phase === 'rom') {
      if (v === 0xcc) this.phase = 'command';
      else if (v === 0x33) { const rom = [0x28, 1, 2, 3, 4, 5, 6]; this.queue([...rom, crc8(rom)]); }
      else if (v === 0x55) { this.phase = 'match'; this.index = 0; }
      else this.phase = 'idle';
    } else if (this.phase === 'match') { if (++this.index === 8) this.phase = 'command'; }
    else if (this.phase === 'scratch') { this.scratch[2 + this.index++] = v; if (this.index === 3) this.phase = 'command'; }
    else if (this.phase === 'command') {
      if (v === 0x44) {
        this.tick(now);
        if (this.busyUntil) {
          this.board.warn(this.board.inputs.temperaturePolicy === 'hold' ? '温度使用兼容策略：转换忙时忽略重复的 44H 命令。该重触发行为未经实物核对。' : 'DS18B20 尚未转换完成又收到 44H；本模型重新计时。若读数持续为 85°C，请检查转换间隔，或选择忙时保持的兼容策略。');
          if (this.board.inputs.temperaturePolicy === 'hold') { this.phase = 'poll'; return; }
        }
        this.target = this.board.inputs.temperature;
        this.busyUntil = now + 93750 * 2 ** ((this.scratch[4] >> 5) & 3); this.phase = 'poll';
      } else if (v === 0xbe) {
        this.tick(now); this.scratch[8] = crc8(this.scratch.slice(0, 8)); this.queue([...this.scratch]); this.reads++;
      } else if (v === 0x4e) { this.phase = 'scratch'; this.index = 0; }
      else if (v === 0x48) { this.saved = [...this.scratch.slice(2, 5)]; }
      else if (v === 0xb8) this.scratch.set(this.saved, 2);
      else if (v === 0xb4) this.queue([255]);
    }
  }
  update(level, now) {
    this.tick(now); if (level === this.level) return;
    if (!level) {
      this.fall = now; this.slotRead = this.phase === 'read' || this.phase === 'poll';
      if (this.slotRead) {
        const b = this.phase === 'poll' ? (this.busyUntil ? 0 : 1) : (this.out.shift() ?? 1);
        this.lowUntil = b ? -1 : now + 60;
      }
    } else {
      const duration = now - this.fall;
      if (duration >= 400) {
        this.phase = 'rom'; this.out = []; this.bits = 0; this.byte = 0; this.lowUntil = -1;
        this.presenceStart = now + 15; this.presenceEnd = now + 240;
      } else if (!this.slotRead) {
        this.byte |= (duration < 15 ? 1 : 0) << this.bits;
        if (++this.bits === 8) { this.accept(this.byte, now); this.bits = 0; this.byte = 0; }
      }
    }
    this.level = level;
  }
  read(now) { this.tick(now); return (now >= this.presenceStart && now < this.presenceEnd) || now < this.lowUntil ? 0 : 1; }
}
