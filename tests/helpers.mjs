import { Machine } from '../site/machine.js';
import { encodeHex } from '../site/hex.js';
export function program(bytes, options) { const m = new Machine(options); m.load(encodeHex(Uint8Array.from(bytes))); return m; }
export function run(m, us) { for (let done = 0; done < us; done += 10000) m.runUs(Math.min(10000, us - done)); }
export function display(m) {
  m.snapshot(); run(m, 30000); const s = m.snapshot();
  const map = {63:'0',6:'1',91:'2',79:'3',102:'4',109:'5',125:'6',7:'7',127:'8',111:'9',0:' ',64:'-',57:'C',113:'F'};
  return Array.from({length:8}, (_, i) => { const a = s.segments.slice(i*8,i*8+8); return (map[a.slice(0,7).reduce((x,b,j)=>x|(b>.1?1<<j:0),0)] ?? '?') + (a[7]>.1?'.':''); }).join('');
}
export function press(m, key, duration = 40000) { m.setInput('keys',[key]); run(m,duration); m.setInput('keys',[]); run(m,40000); }
