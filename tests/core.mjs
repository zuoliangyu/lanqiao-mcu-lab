import assert from 'node:assert/strict';
import { Machine } from '../site/machine.js';
import { parseHex, encodeHex } from '../site/hex.js';
import { demoHex } from '../site/demo.js';
import { program, run, display } from './helpers.mjs';
let count=0;
function check(name, test) { test(); count++; console.log('PASS', name); }
check('HEX 校验和、长度、范围、EOF 与冲突拒绝',()=>{
  const hex=encodeHex(Uint8Array.from([0x80,0xfe])); assert.equal(parseHex(hex).count,2);
  assert.throws(()=>parseHex(hex.replace('80FE','81FE')),/校验和/);
  assert.throws(()=>parseHex(':00000001FF'),/复位地址/);
  assert.throws(()=>parseHex(':02F0000080FE90\n:00000001FF'),/60 KB/);
});
check('ADD/ADDC/SUBB 标志与结果，确定性边界向量',()=>{
  const m=program([0x24,0]);
  for (const op of [0x24,0x34,0x94]) for (const a of [0,1,15,16,127,128,254,255]) for (const b of [0,1,15,16,127,128,254,255]) for (const carry of [0,1]) {
    m.cpu.pc=0; m.cpu.code[0]=op; m.cpu.code[1]=b; m.cpu.a=a; m.cpu.sfr[0xd0]=carry<<7;
    m.cpu.step(); const c=op===0x24?0:carry, result=op===0x94?a-b-c:a+b+c;
    assert.equal(m.cpu.a,result&255); assert.equal(m.cpu.cy,+(op===0x94?result<0:result>255));
    const signed=(a<<24>>24)+(op===0x94?-1:1)*(b<<24>>24)+(op===0x94?-c:c);
    assert.equal(!!(m.cpu.sfr[0xd0]&4),signed>127||signed< -128);
  }
});
check('高位间接 RAM 不与 SFR 重叠，寄存器组切换',()=>{
  const m=program([0x78,0xe0,0x76,0x55,0x74,0x12,0x75,0xd0,8,0x78,0xaa,0xe8]);
  for(let i=0;i<6;i++)m.cpu.step(); assert.equal(m.cpu.ram[0xe0],0x55); assert.equal(m.cpu.a,0xaa); assert.equal(m.cpu.ram[0],0xe0);
});
check('LCALL/RET 与低字节先入栈',()=>{
  const m=program([0x12,0,6,0x80,0xfe,0,0x74,0x42,0x22]);
  m.cpu.step(); assert.equal(m.cpu.ram[8],3); assert.equal(m.cpu.ram[9],0); m.cpu.step(); m.cpu.step(); assert.equal(m.cpu.a,0x42); assert.equal(m.cpu.pc,3); assert.equal(m.cpu.sfr[0x81],7);
});
check('STC Y5 指令周期：MUL 2 / DIV 6 / MOVC 5 / DJNZ 4',()=>{
  const m=program([0xa4,0x84,0x93,0xd8,0]);m.cpu.sfr[0xf0]=2; m.cpu.wrn(0,1);
  for(const expected of [2,6,5,4]){const before=m.cpu.cycles;m.cpu.step();assert.equal(m.cpu.cycles-before,expected);}
});
check('pdata MOVX @Ri 不受 P2 的锁存选通值影响',()=>{
  const m=program([0x75,0xa0,0x80,0x78,0x22,0x74,0x5a,0xf2,0x75,0xa0,0x1f,0xe2]);
  for(let i=0;i<6;i++)m.cpu.step();assert.equal(m.cpu.a,0x5a);assert.equal(m.cpu.xram[0x22],0x5a);
});
check('端口读引脚、读改写读锁存，矩阵键盘连通',()=>{
  const m=program([0xe5,0xb0,0x53,0xb0,0xfe]); m.setInput('keys',[4]);m.cpu.sfr[0xc0]&=~16;
  m.cpu.step();assert.equal(m.cpu.a&8,0);m.cpu.step();assert.equal(m.cpu.sfr[0xb0],254);
});
check('STC Timer0 模式0自动重装，12T / 1T',()=>{
  const m=program([0x80,0xfe]);m.cpu.write(0x8a,0x18);m.cpu.write(0x8c,0xfc);m.cpu.write(0x88,0x10);
  run(m,10000);assert.equal(m.overflowCounts[0],10);assert.equal(m.cpu.sfr[0x8a]|m.cpu.sfr[0x8c]<<8,0xfc18);
  m.cpu.write(0x8e,0x81);run(m,1000);assert.equal(m.overflowCounts[0],22);
});
check('Timer0 外部计数与 PCA 溢出',()=>{
  const m=program([0x80,0xfe],{inputs:{frequencyEnabled:true,frequency:1234}});m.cpu.write(0x89,5);m.cpu.write(0x88,0x10);run(m,1000000);
  assert.equal(m.cpu.sfr[0x8a]|m.cpu.sfr[0x8c]<<8,1234);m.cpu.write(0xd8,0x40);run(m,65536);assert.ok(m.cpu.sfr[0xd8]&128);
  // TMOD=05H，TR0=1，R7=100：CLR P3.4／SETB P3.4 循环，程序自己拉低引脚的下降沿同样计数
  const loop=[0x75,0x89,0x05,0xd2,0x8c,0x7f,0x64,0xc2,0xb4,0,0,0xd2,0xb4,0,0,0xdf,0xf6,0x80,0xfe];
  for(const frequencyEnabled of [false,true]){const t=program(loop,{inputs:{frequencyEnabled,frequency:100}});run(t,2000);assert.equal(t.cpu.sfr[0x8a],100);}
});
check('中断保存返回地址、定时扫描与演示按键实际执行',()=>{
  const m=new Machine();m.load(demoHex());run(m,100000);assert.equal(display(m),'2026  51');assert.ok(m.irqCounts[1]>100);
  m.setInput('keys',[4]);run(m,50000);assert.equal(m.latch[0]&8,0);m.setInput('keys',[]);run(m,30000);assert.equal(m.latch[0]&8,8);
});
check('UART1 Timer2 波特率、发送完成延时与接收中断标志',()=>{
  const m=program([0x80,0xfe]); m.cpu.write(0x98,0x50); m.cpu.write(0xd7,0xe6);m.cpu.write(0xd6,0xff);m.cpu.write(0x8e,0x11);
  assert.ok(Math.abs(m.baud()-9600)<30);m.cpu.write(0x99,65);run(m,500);assert.equal(m.cpu.sfr[0x98]&2,0);run(m,600);assert.equal(m.tx[0],65);assert.ok(m.cpu.sfr[0x98]&2);
  m.serialInput([66]);run(m,1100);assert.equal(m.readSfr(0x99),66);assert.ok(m.cpu.sfr[0x98]&1);
});
check('Timer2 IE2 使能、0063H 向量与自动清除溢出请求',()=>{
  const m=program([0x80,0xfe]);m.cpu.code[0x63]=0x32;
  m.cpu.write(0xd7,0);m.cpu.write(0xd6,0xff);m.cpu.write(0xaf,4);m.cpu.write(0xa8,0x80);m.cpu.write(0x8e,0x14);
  for(let i=0;i<1000&&m.cpu.pc!==0x63;i++)m.cpu.step();
  assert.equal(m.cpu.pc,0x63);assert.equal(m.irqCounts[12],1);assert.equal(m.irqCounts[8],0);assert.equal(m.timer2Pending,false);
  m.cpu.step();assert.equal(m.cpu.isr.length,0);
  m.cpu.write(0xaf,0);run(m,1000);assert.equal(m.irqCounts[12],1);assert.equal(m.timer2Pending,false);
});
check('I²C EEPROM 通过引脚写入、忙时 NACK、页回卷、随机读',()=>{
  const m=program([0x80,0xfe]); let t=0; const bus=m.i2c;
  const pin=(c,d)=>bus.update(c,d,t+=10), start=()=>{pin(0,1);pin(1,1);pin(1,0);pin(0,0);},stop=()=>{pin(0,0);pin(1,0);pin(1,1);};
  const send=b=>{for(let i=7;i>=0;i--){pin(0,b>>i&1);pin(1,b>>i&1);pin(0,b>>i&1);}pin(0,1);pin(1,1);const ack=!bus.drive;pin(0,1);return ack;};
  const read=()=>{let v=0;for(let i=0;i<8;i++){pin(1,1);v=v*2+bus.drive;pin(0,1);}pin(1,1);pin(0,1);return v;};
  start();assert.ok(send(0xa0));assert.ok(send(7));send(0x12);send(0x34);stop();
  start();assert.equal(send(0xa0),false);stop();t+=5000;bus.commit(t);assert.equal(bus.memory[7],0x12);assert.equal(bus.memory[0],0x34);
  start();send(0xa0);send(7);start();send(0xa1);assert.equal(read(),0x12);stop();
});
check('DS1302 时钟进位、停止位与写保护',()=>{
  const m=program([0x80,0xfe]), r=m.rtc;r.reg.set([0x59,0x59,0x23,0x28,2,6,0x26,0x80]);r.tick(1000000);assert.equal(r.display(1000000),'2026-03-01 00:00:00');r.addr=0;r.writeByte(0x30,1000000);assert.equal(r.reg[0],0);r.reg[0]|=128;r.tick(10000000);assert.equal(r.reg[0],128);
});
check('DS18B20 原始时隙、750ms 转换结束时采样、负温度与 CRC',()=>{
  const m=program([0x80,0xfe]);const d=m.temp;let t=0;
  const reset=()=>{d.update(0,t);t+=500;d.update(1,t);t+=30;assert.equal(d.read(t),0);t+=400;};
  const write=b=>{for(let i=0;i<8;i++){d.update(0,t);t+=(b>>i&1)?2:60;d.update(1,t);t+=(b>>i&1)?68:10;}};
  const read=()=>{let b=0;for(let i=0;i<8;i++){d.update(0,t);t+=2;d.update(1,t);t+=10;b|=d.read(t)<<i;t+=58;}return b;};
  m.inputs.temperature=30;reset();write(0xcc);write(0x44);m.inputs.temperature=-10.5;assert.equal(d.scratch[0],0x50);t+=750000;d.tick(t);
  reset();write(0xcc);write(0xbe);assert.equal(read(),0x58);assert.equal(read(),0xff);
  // 写 1 的低电平被中断拉长到 25µs 仍在典型采样点之前
  const slow=b=>{for(let i=0;i<8;i++){d.update(0,t);t+=(b>>i&1)?25:60;d.update(1,t);t+=(b>>i&1)?45:10;}};
  reset();slow(0xcc);slow(0xbe);assert.equal(read(),0x58);
});
check('超声波板载40kHz脉冲串：容忍个别被中断拉长的半周期，单脉冲不触发',()=>{
  const burst=(widths)=>{const m=program([0x80,0xfe]);const set=(v,us)=>{m.cpu.cycles+=Math.round(us*12);m.cpu.write(0x90,v);};set(0xfe,1000);for(const w of widths){set(0xff,14);set(0xfe,w);}return m.pings;};
  assert.equal(burst(Array(8).fill(12.5)),1);assert.equal(burst([12.5,12.5,12.5,26,12.5,12.5,12.5,12.5]),1);
  assert.equal(burst([12.5]),0);assert.equal(burst([12.5,12.5,12.5,80,12.5,12.5,12.5,12.5]),0);
});
check('EEPROM 复位／断电保留，RTC 仅断电重置',()=>{
  const m=program([0x80,0xfe]);m.i2c.memory[3]=42;m.rtc.reg[2]=0x21;m.reset();assert.equal(m.i2c.memory[3],42);assert.equal(m.rtc.hour(),21);m.reset(true);assert.equal(m.i2c.memory[3],42);assert.equal(m.rtc.hour(),12);
});
console.log(`${count} 个针对性验证通过`);
