// SPDX-License-Identifier: MIT
export function parseHex(text) {
  const code = new Uint8Array(65536).fill(0xff), used = new Uint8Array(65536);
  let base = 0, count = 0, eof = false, max = 0;
  for (const [lineIndex, raw] of text.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    const line = raw.trim(); if (!line) continue;
    const fail = message => { throw new Error(`HEX 第 ${lineIndex + 1} 行：${message}`); };
    if (eof) fail('结束记录之后仍有数据');
    if (!/^:[0-9a-f]+$/i.test(line) || line.length % 2 !== 1) fail('格式不正确');
    const bytes = Uint8Array.from(line.slice(1).match(/../g), x => parseInt(x, 16));
    const n = bytes[0], addr = bytes[1] * 256 + bytes[2], type = bytes[3];
    if (bytes.length !== n + 5) fail('记录长度不符');
    if (bytes.reduce((a, b) => a + b, 0) & 255) fail('校验和错误');
    if (type === 0) {
      if (base + addr + n > 0xf000) fail('超出 STC15F2K60S2 的 60 KB 程序空间');
      for (let i = 0; i < n; i++) {
        const at = base + addr + i;
        if (used[at] && code[at] !== bytes[4 + i]) fail('地址存在冲突数据');
        if (!used[at]) count++;
        used[at] = 1; code[at] = bytes[4 + i]; max = Math.max(max, at);
      }
    } else if (type === 1) { if (n || addr) fail('非法结束记录'); eof = true; }
    else if (type === 2 || type === 4) {
      if (n !== 2 || addr) fail('非法地址扩展记录');
      base = (bytes[4] * 256 + bytes[5]) * (type === 2 ? 16 : 65536);
    } else if (type === 3 || type === 5) { if (n !== 4 || addr) fail('非法入口记录'); }
    else fail(`不支持的记录类型 ${type}`);
  }
  if (!eof || !count || !used[0]) throw new Error('需要包含复位地址 0000H 和结束记录的 Intel HEX');
  return { code, count, max };
}

export function encodeHex(bytes) {
  let out = '';
  for (let a = 0; a < bytes.length; a += 16) {
    const row = [Math.min(16, bytes.length - a), a >> 8, a & 255, 0, ...bytes.slice(a, a + 16)];
    row.push((-row.reduce((x, y) => x + y, 0)) & 255);
    out += ':' + row.map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase() + '\n';
  }
  return out + ':00000001FF\n';
}
