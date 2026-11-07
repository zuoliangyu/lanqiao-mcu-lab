// SPDX-License-Identifier: MIT
import { Machine } from './machine.js';
let machine = new Machine(), running = false, speed = 1, timer = null, generation = 0;
const clock = () => performance.timeOrigin + performance.now();
let lastWall = performance.now(), lastSim = 0, rate = 0, frame = 0;
function publish() {
  const wall = performance.now(), sim = machine.now;
  if (wall - lastWall >= 300) { rate = (sim - lastSim) / 1000 / (wall - lastWall); lastWall = wall; lastSim = sim; }
  postMessage({ type: 'state', state: machine.snapshot(), running, rate }); frame = wall;
}
// Paused or stepping: pending key events take effect now so a later direct input cannot be overtaken.
function halt() { running = false; generation++; machine.flushInputs(); if (timer !== null) clearTimeout(timer); timer = null; }
function loop(token) {
  if (!running || token !== generation) return;
  const start = performance.now();
  try {
    const target = machine.now + 16000 * speed, wallStart = clock(), simStart = machine.now;
    do {
      if (machine.runUs(Math.min(1000, target - machine.now), 10000) === 'breakpoint') { halt(); postMessage({ type: 'notice', message: '已到达地址断点。' }); break; }
    } while (machine.now < target && performance.now() - start < 24 && running);
    machine.markSlice(wallStart, simStart, clock());
    if (performance.now() - frame > 32 || !running) publish();
  } catch (error) { halt(); publish(); postMessage({ type: 'error', message: error.message }); }
  if (running) timer = setTimeout(() => loop(token), Math.max(0, 16 - (performance.now() - start)));
}
onmessage = ({ data }) => {
  try {
    switch (data.type) {
      case 'load': {
        // Validate in a new instance. An invalid upload cannot destroy the current program.
        const next = new Machine({ hz: data.hz, inputs: machine.inputs, eeprom: machine.snapshot().eeprom });
        const info = next.load(data.hex); halt(); machine = next; lastWall = performance.now(); lastSim = 0; rate = 0;
        postMessage({ type: 'loaded', info }); publish(); break;
      }
      case 'run': if (!machine.codeInfo || running) break; running = true; generation++; lastWall = performance.now(); lastSim = machine.now; loop(generation); break;
      case 'pause': halt(); publish(); break;
      case 'reset': halt(); machine.reset(data.power); lastWall = performance.now(); lastSim = 0; rate = 0; publish(); break;
      case 'step': halt(); if (machine.codeInfo) machine.cpu.step(); publish(); break;
      case 'input':
        if (data.name === 'keys' && running && Number.isFinite(data.wall)) machine.queueKeys(data.value, data.wall, 16000 * speed);
        else machine.setInput(data.name, data.value);
        if (!running) publish(); break;
      case 'speed': speed = Math.max(0.1, Math.min(4, Number(data.value) || 1)); break;
      case 'serial': machine.serialInput(data.bytes); break;
      case 'eeprom': if (data.bytes?.length === 256) { machine.i2c.memory.set(data.bytes); machine.i2c.version++; machine.i2c.pending = []; machine.i2c.busyUntil = 0; } publish(); break;
      case 'rtc': machine.rtc.setTime(data.value, machine.now); publish(); break;
      case 'breakpoint': machine.breakpoints = new Set(data.address === null ? [] : [data.address]); break;
      case 'memory': postMessage({ type: 'memory', iram: [...machine.cpu.ram], xram: [...machine.cpu.xram.slice(0, 256)] }); break;
    }
  } catch (error) { postMessage({ type: 'error', message: error.message }); }
};
publish();
