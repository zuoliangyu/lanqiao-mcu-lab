// User firmware is loaded from the supplied local directories; never distributed with the site.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { Machine } from '../site/machine.js';
import { run, display, press } from './helpers.mjs';
const [root, templateFile] = process.argv.slice(2);
if (!root || !templateFile) { console.error('用法：node tests/firmware.mjs "全模块测试例程目录" "大模板.hex"'); process.exit(2); }
const results=[];
function firmware(name, file) {
  const bytes=fs.readFileSync(file),m=new Machine();m.load(bytes.toString('utf8'));
  results.push({name,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),bytes:m.codeInfo.count});return m;
}
const load=name=>firmware(name,path.join(root,name,'User','Objects','zuolan.hex'));
const record=(result)=>{results.at(-1).result=result;console.log('PASS',results.at(-1).name,result);};
let m=load('DS1302时钟模块');run(m,1300000);assert.equal(display(m),'13-59-51');run(m,8900000);assert.ok(m.latch[1]&0x50);record('13:59:50→13:59:51；14:00:00 蜂鸣器与继电器开启');
m=load('DS18B20温度模块');run(m,1500000);assert.equal(display(m),'025.0C   ');m.setInput('temperature',30);run(m,8000000);assert.equal(display(m),'030.0C   ');press(m,4);run(m,700000);assert.equal(display(m),'086.0F   ');record('25.0→30.0°C；S4 切换后为 86.0°F；默认转换忙兼容策略');
m=load('EEPROM存储模块');run(m,100000);press(m,5);press(m,4);run(m,100000);assert.equal(m.snapshot().eeprom[0],5);m.reset(true);run(m,300000);assert.equal(display(m),'005  000');record('S5 选择5，S4写入；断电重启读回5');
m=load('PCF_AD与DA模块');m.setInput('analog',[0,1,0,4]);run(m,300000);assert.equal(display(m),'204  051');assert.equal(m.snapshot().dac,0.99609375);m.setInput('analog',[0,2,0,3]);run(m,1000000);assert.equal(display(m),'153  102');record('1V/4V→2V/3V：204/051→153/102，保留首字节为上一转换结果的真实流水行为');
m=load('超声波测距模块');run(m,400000);assert.equal(display(m),'0099    ');m.setInput('distance',200);run(m,700000);assert.equal(display(m),'0199    ');m.setInput('echo',false);run(m,700000);assert.equal(display(m),'0000    ');record('100cm→99，200cm→199，无回波→0（程序计时与取整）');
m=load('串口模块');run(m,100000);m.serialInput([79,75]);run(m,400000);assert.equal(String.fromCharCode(...m.snapshot().tx),'hello');press(m,4);run(m,300000);assert.match(String.fromCharCode(...m.snapshot().tx),/You pressed it 4/);record('发送OK→hello；S4→You pressed it 4');
m=firmware('大模板',templateFile);m.setInput('ultrasonicMode','pulse');m.setInput('frequencyEnabled',true);m.setInput('frequency',1234);run(m,1500000);press(m,4);run(m,400000);assert.equal(display(m),'    1230');press(m,4);run(m,500000);assert.equal(display(m),'    25.00');m.setInput('temperature',32.5);run(m,1700000);assert.equal(display(m),'    32.50');m.serialInput([79,75]);run(m,100000);assert.equal(String.fromCharCode(...m.snapshot().tx),'OK');record('pdata综合程序：测频1234Hz显示1230，25→32.5°C，串口OK回显；单脉冲兼容模型');
console.log(JSON.stringify({results},null,2));
