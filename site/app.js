// SPDX-License-Identifier: MIT
import { demoHex } from './demo.js';
const $ = id => document.getElementById(id), worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
const post = (type, data = {}) => worker.postMessage({ type, ...data });
let loaded = false, running = false, pending = null, currentHex = null, lastState = null, serialBytes = [], savedJSON = '', audio = null, oscillator = null, gain = null;
const held = new Set(), locked = new Set(), paths = [
  'M13 4 H43 L48 9 L42 14 H14 L8 9Z', 'M45 15 L50 10 L54 15 L50 43 L44 48 L40 43Z',
  'M44 52 L49 47 L52 52 L48 80 L42 85 L38 80Z', 'M10 82 H37 L42 87 L36 92 H8 L3 87Z',
  'M5 52 L10 47 L14 52 L10 80 L5 85 L1 80Z', 'M9 15 L14 10 L18 15 L14 43 L9 48 L5 43Z',
  'M13 43 H39 L44 48 L38 53 H12 L7 48Z',
];
const svgNS = 'http://www.w3.org/2000/svg', segments = [], ledDots = [];
for (let d = 0; d < 8; d++) {
  const svg = document.createElementNS(svgNS, 'svg'); svg.setAttribute('viewBox', '0 0 64 100'); svg.classList.add('digit'); svg.setAttribute('aria-hidden', 'true');
  for (let b = 0; b < 8; b++) {
    const el = document.createElementNS(svgNS, b === 7 ? 'circle' : 'path'); el.classList.add('segment');
    if (b === 7) { el.setAttribute('cx', '58'); el.setAttribute('cy', '87'); el.setAttribute('r', '4'); } else el.setAttribute('d', paths[b]);
    svg.append(el); segments.push(el);
  }
  $('digits').append(svg);
  const led = document.createElement('div'); led.className = 'led'; const dot = document.createElement('i'); led.append(dot, document.createTextNode('L' + (d + 1))); $('leds').append(led); ledDots.push(dot);
}
function keysUpdate() {
  for (const el of $('keys').children) {
    const k = Number(el.dataset.key), frequencyConflict = $('frequency-enabled').checked && k >= 16;
    el.disabled = frequencyConflict || ($('key-mode').value === 'independent' && k > 7);
    el.title = frequencyConflict ? 'P3.4 已用于频率输入，请先断开频率输入' : '';
    if (el.disabled) { held.delete(k); locked.delete(k); }
  }
  const keys = [...new Set([...held, ...locked])]; post('input', { name: 'keys', value: keys });
  for (const el of $('keys').children) { const k = Number(el.dataset.key); el.classList.toggle('pressed', keys.includes(k)); el.classList.toggle('locked', locked.has(k)); el.setAttribute('aria-pressed', String(keys.includes(k))); }
}
for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) {
  const k = 7 - row + col * 4, button = document.createElement('button'); button.className = 'key'; button.dataset.key = k;
  const b = document.createElement('b'); b.textContent = 'S' + k; const small = document.createElement('small'); small.textContent = `P3.${row} · C${col + 1}`; button.append(b, small);
  button.setAttribute('aria-label', `按键 S${k}`); button.setAttribute('aria-pressed', 'false');
  button.addEventListener('pointerdown', e => {
    if (e.button !== 0) return; e.preventDefault(); button.setPointerCapture(e.pointerId);
    if (e.shiftKey) { if (locked.has(k)) locked.delete(k); else locked.add(k); } else held.add(k);
    keysUpdate();
  });
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(event, () => { held.delete(k); keysUpdate(); });
  button.addEventListener('contextmenu', e => { e.preventDefault(); if (locked.has(k)) locked.delete(k); else locked.add(k); keysUpdate(); });
  button.addEventListener('keydown', e => { if ([' ', 'Enter'].includes(e.key)) { e.preventDefault(); held.add(k); keysUpdate(); } });
  button.addEventListener('keyup', e => { if ([' ', 'Enter'].includes(e.key)) { held.delete(k); keysUpdate(); } });
  button.addEventListener('blur', () => { held.delete(k); keysUpdate(); }); $('keys').append(button);
}
function releaseAll() { held.clear(); locked.clear(); keysUpdate(); }
$('release-keys').onclick = releaseAll;
addEventListener('blur', () => { held.clear(); keysUpdate(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { held.clear(); keysUpdate(); } });
for (const event of ['keydown', 'keyup']) addEventListener(event, e => {
  if (/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(e.target.tagName) || document.querySelector('dialog[open]')) return;
  if (/^[1-4]$/.test(e.key)) { e.preventDefault(); const k = Number(e.key) + 3; if (event === 'keydown') held.add(k); else held.delete(k); keysUpdate(); }
});
const cells = [];
for (let a = 0; a < 256; a++) {
  const root = a < 64 ? $('eeprom') : $('eeprom-more');
  if (!(a % 8)) { const address = document.createElement('span'); address.className = 'address'; address.textContent = a.toString(16).padStart(2, '0').toUpperCase(); root.append(address); }
  const cell = document.createElement('span'); cell.textContent = 'FF'; cell.title = `地址 ${a.toString(16).padStart(2, '0').toUpperCase()}H`; root.append(cell); cells.push(cell);
}
function alertMessage(message) { $('alert-text').textContent = message; $('alert').hidden = false; }
$('dismiss').onclick = () => { $('alert').hidden = true; };
function serialRender() {
  $('serial').textContent = serialBytes.length ? ($('serial-hex').checked ? serialBytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ') : new TextDecoder().decode(new Uint8Array(serialBytes))) : '等待 UART1 输出…';
  $('serial').scrollTop = $('serial').scrollHeight;
}
function saveMemory(state) {
  if (!state.eepromVersion) return;
  const json = JSON.stringify(state.eeprom); if (json === savedJSON) return;
  try { localStorage.setItem('stc15-eeprom-v1', json); savedJSON = json; } catch { $('storage-note').textContent = '浏览器存储不可用，关闭页面后数据不会保留'; }
}
try {
  const saved = localStorage.getItem('stc15-eeprom-v1');
  if (saved) { const bytes = JSON.parse(saved); if (Array.isArray(bytes) && bytes.length === 256 && bytes.every(b => Number.isInteger(b) && b >= 0 && b < 256)) { savedJSON = saved; post('eeprom', { bytes }); } }
} catch { $('storage-note').textContent = '无法读取浏览器存储，当前仅保存在内存中'; }
function soundUpdate(on) {
  if (gain && audio) gain.gain.setTargetAtTime(on && running && $('sound').checked ? .035 : 0, audio.currentTime, .02);
}
$('sound').onchange = async () => {
  if ($('sound').checked) try {
    if (!audio) { audio = new AudioContext(); oscillator = audio.createOscillator(); gain = audio.createGain(); oscillator.type = 'square'; oscillator.frequency.value = 2400; gain.gain.value = 0; oscillator.connect(gain); gain.connect(audio.destination); oscillator.start(); }
    await audio.resume();
  } catch { $('sound').checked = false; alertMessage('当前浏览器无法启用声音，仍可查看蜂鸣器状态。'); }
  soundUpdate(lastState?.buzzer);
};
function render(state, rate) {
  lastState = state;
  $('status').textContent = running ? '运行中' : loaded ? '已暂停' : '等待程序'; $('status').classList.toggle('running', running);
  $('run').disabled = !loaded || running; $('pause').disabled = !running; $('reset').disabled = !loaded; $('power').disabled = !loaded; $('step').disabled = !loaded || running; $('send').disabled = !loaded;
  $('sim-time').replaceChildren(document.createTextNode(state.time.toFixed(3) + ' ')); const unit = document.createElement('small'); unit.textContent = 's'; $('sim-time').append(unit);
  $('pc').textContent = state.pc.toString(16).padStart(4, '0').toUpperCase() + 'H'; $('rate').textContent = loaded ? rate.toFixed(2) + '×' : '—';
  state.segments.forEach((v, i) => { const on = v > .015; segments[i].style.fill = on ? '#a0efd0' : '#294a4c'; segments[i].style.opacity = on ? .2 + .8 * Math.sqrt(v) : 1; });
  state.leds.forEach((v, i) => { ledDots[i].style.background = v > .01 ? `color-mix(in srgb, #21ac82 ${Math.round(25 + 75 * Math.sqrt(v))}%, #e5ece6)` : '#e5ece6'; ledDots[i].style.boxShadow = v > .1 ? `0 0 9px #43bc7833` : 'none'; ledDots[i].parentElement.title = `L${i + 1} 占空比 ${(v * 100).toFixed(1)}%`; });
  $('buzzer').textContent = state.buzzer ? '开启' : '关闭'; $('relay').textContent = state.relay ? '吸合' : '释放'; $('buzzer-led').classList.toggle('on', state.buzzer); $('relay-led').classList.toggle('on', state.relay); soundUpdate(state.buzzer);
  $('dac').textContent = state.dac.toFixed(3) + ' V'; $('rtc').textContent = state.rtc; $('rtc-state').textContent = state.rtcHalted ? '时钟停止位 CH = 1' : '随仿真时间运行';
  $('temperature-read').textContent = `芯片读数 ${state.temperature.toFixed(2)} °C · ${state.converting ? '转换中' : '等待转换'} · 已完成 ${state.devices.conversions} 次`;
  $('baud').textContent = state.baud ? `${Math.round(state.baud).toLocaleString()} bps` : 'UART1 未配置';
  $('serial-count').textContent = `TX ${state.txCount} · RX ${state.rxCount}`;
  if (state.tx.length) { serialBytes.push(...state.tx); if (serialBytes.length > 16000) serialBytes.splice(0, serialBytes.length - 16000); serialRender(); }
  state.eeprom.forEach((v, i) => { cells[i].textContent = v.toString(16).padStart(2, '0').toUpperCase(); cells[i].classList.toggle('written', v !== 255); }); saveMemory(state);
  $('pings').textContent = state.devices.pings ? `已识别 ${state.devices.pings.toLocaleString()} 次发射` : '等待发射';
  $('diagnostic-count').textContent = state.diagnostics.length;
  $('diagnostic-summary').textContent = loaded ? `I²C ${state.devices.i2c.toLocaleString()} 次 · 中断 ${state.irq.reduce((a, b) => a + b, 0).toLocaleString()} 次` : '就绪';
  $('diagnostics').replaceChildren();
  for (const message of state.diagnostics.length ? state.diagnostics : ['尚未触发运行诊断。']) { const p = document.createElement('p'); p.textContent = message; $('diagnostics').append(p); }
  $('registers').replaceChildren();
  for (const [name, value] of Object.entries(state.registers)) { const span = document.createElement('span'), b = document.createElement('b'); span.textContent = name; b.textContent = value.toString(16).padStart(name === 'DPTR' ? 4 : 2, '0').toUpperCase(); span.append(b); $('registers').append(span); }
  $('timer-info').textContent = `T0 ${state.timers[0]} · T1 ${state.timers[1]} · T2 ${state.timers[2]} · PCA ${state.pca}`;
}
worker.onmessage = ({ data }) => {
  if (data.type === 'state') { running = data.running; render(data.state, data.rate); }
  else if (data.type === 'loaded') {
    loaded = true; currentHex = pending?.hex || currentHex; $('filename').textContent = pending?.name || '程序'; $('fileinfo').textContent = `${data.info.count.toLocaleString()} 字节 · ${(Number($('hz').value) / 1e6).toFixed(3)} MHz · 本地运行`;
    $('empty').hidden = true; serialBytes = []; serialRender(); releaseAll(); $('breakpoint').value = ''; $('breakpoint-state').textContent = '未设置断点';
    $('display-note').textContent = pending?.demo ? '演示：S4～S7 控制 LED · 键盘 1～4 可操作' : '显示内容来自程序对 P0 / P2 的实际写入';
    if (pending?.autostart) post('run'); pending = null;
  } else if (data.type === 'error' || data.type === 'notice') { alertMessage(data.message); pending = null; }
};
worker.onerror = e => { running = false; soundUpdate(false); $('status').textContent = '运行错误'; alertMessage(e.message || '无法加载执行线程，请使用本地服务或 GitHub Pages 打开。'); };
function load(hex, name, demo = false, autostart = false) { pending = { hex, name, demo, autostart }; post('load', { hex, hz: Number($('hz').value) }); }
async function openFile(file) { if (!file) return; if (file.size > 1024 * 1024) { alertMessage('HEX 文件超过 1 MB，请检查是否选择了正确的 Keil 输出文件。'); return; } try { load(await file.text(), file.name); } catch { alertMessage('文件读取失败，请重新选择。'); } }
$('choose').onclick = () => $('file').click(); $('file').onchange = () => { openFile($('file').files[0]); $('file').value = ''; };
for (const id of ['demo', 'demo-again']) $(id).onclick = () => load(demoHex(), '基础显示与按键演示.hex', true, true);
$('run').onclick = () => post('run'); $('pause').onclick = () => post('pause');
for (const id of ['reset', 'power']) $(id).onclick = () => { releaseAll(); serialBytes = []; serialRender(); post('reset', { power: id === 'power' }); $('breakpoint-state').textContent = '未设置断点'; };
$('step').onclick = () => post('step'); $('speed').onchange = () => post('speed', { value: Number($('speed').value) });
$('hz').onchange = () => { if (currentHex) { load(currentHex, $('filename').textContent); alertMessage('主频已修改，程序已重新载入，请点击运行。'); } };
const input = (name, value) => post('input', { name, value });
for (const [id, name, format] of [['temperature', 'temperature', v => v.toFixed(1) + ' °C'], ['distance', 'distance', v => v + ' cm']]) {
  $(id).oninput = () => { const v = Number($(id).value); $(id + '-value').textContent = format(v); input(name, v); };
}
for (let i = 0; i < 4; i++) $('analog' + i).oninput = () => { $('analog' + i + '-value').textContent = Number($('analog' + i).value).toFixed(2) + ' V'; input('analog', [0, 1, 2, 3].map(j => Number($('analog' + j).value))); };
let frequencyValue = Number($('frequency').value);
function updateFrequency(value) {
  frequencyValue = Math.max(100, Math.min(38000, Math.round(value)));
  $('frequency').value = $('frequency-number').value = String(frequencyValue);
  input('frequency', frequencyValue);
}
$('frequency').oninput = () => updateFrequency(Number($('frequency').value));
$('frequency-number').oninput = () => {
  if ($('frequency-number').value !== '' && $('frequency-number').validity.valid) updateFrequency(Number($('frequency-number').value));
};
function commitFrequency() {
  const value = $('frequency-number').valueAsNumber;
  updateFrequency(Number.isFinite(value) ? value : frequencyValue);
}
$('frequency-number').onchange = commitFrequency;
$('frequency-number').onblur = commitFrequency;
$('frequency-number').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); commitFrequency(); } };
$('key-mode').onchange = () => { releaseAll(); input('keyMode', $('key-mode').value); };
$('write-mode').onchange = () => input('writeMode', $('write-mode').value);
$('ultrasonic-mode').onchange = () => input('ultrasonicMode', $('ultrasonic-mode').value);
$('temperature-policy').onchange = () => input('temperaturePolicy', $('temperature-policy').value);
$('echo').onchange = () => input('echo', $('echo').checked);
$('frequency-enabled').onchange = () => {
  input('frequencyEnabled', $('frequency-enabled').checked); keysUpdate();
  $('frequency-note').textContent = $('frequency-enabled').checked
    ? 'P3.4 已接入频率输入，S16～S19 已断开'
    : 'P3.4 用于矩阵键盘第四列；接入频率时自动断开 S16～S19';
};
$('serial-form').onsubmit = e => {
  e.preventDefault(); if (!loaded) return; const text = $('serial-input').value; let bytes;
  if ($('serial-hex').checked) { const hex = text.replace(/\s/g, ''); if (!hex || !/^([0-9a-f]{2})+$/i.test(hex)) { alertMessage('HEX 收发请输入完整字节，例如 4F 4B。'); return; } bytes = hex.match(/../g).map(b => parseInt(b, 16)); }
  else bytes = [...new TextEncoder().encode(text)];
  if ($('newline').checked) bytes.push(13, 10); if (bytes.length) post('serial', { bytes }); $('serial-input').value = '';
};
$('serial-hex').onchange = serialRender; $('clear-serial').onclick = () => { serialBytes = []; serialRender(); };
$('erase-eeprom').onclick = () => { if (confirm('清空本浏览器保存的 256 字节 EEPROM？此操作不可撤销。')) post('eeprom', { bytes: Array(256).fill(255) }); };
$('set-rtc').onclick = () => post('rtc', { value: new Date().toISOString() });
$('set-breakpoint').onclick = () => { const value = $('breakpoint').value.trim(); if (!/^[0-9a-f]{1,4}$/i.test(value) || parseInt(value, 16) >= 0xf000) { alertMessage('请输入 0000～EFFF 之间的十六进制地址。'); return; } post('breakpoint', { address: parseInt(value, 16) }); $('breakpoint-state').textContent = '断点：' + value.toUpperCase().padStart(4, '0') + 'H；到达后暂停'; };
$('clear-breakpoint').onclick = () => { post('breakpoint', { address: null }); $('breakpoint-state').textContent = '未设置断点'; };
$('help').onclick = () => $('help-dialog').showModal(); $('about-button').onclick = () => $('about-dialog').showModal(); $('diagnostics-button').onclick = () => $('diagnostics-dialog').showModal();
document.querySelectorAll('[data-close]').forEach(b => { b.onclick = () => b.closest('dialog').close(); });
// 点击弹窗外的遮罩关闭
document.querySelectorAll('dialog').forEach(d => { d.addEventListener('click', e => { if (e.target === d) d.close(); }); });
let dragDepth = 0;
addEventListener('dragenter', e => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); dragDepth++; $('drop-zone').hidden = false; } });
addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop-zone').hidden = true; } });
addEventListener('drop', e => { e.preventDefault(); dragDepth = 0; $('drop-zone').hidden = true; openFile(e.dataTransfer.files[0]); });
if (location.protocol === 'file:') alertMessage('请双击项目中的 start.cmd 启动本地服务，或在 GitHub Pages 打开。直接打开 HTML 无法加载执行线程。');
