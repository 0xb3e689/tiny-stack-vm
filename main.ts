// Pebblestack: a tiny stack VM for make.fun's tiny-stack-vm-01 bounty — the full tiny stack ISA: 32-bit
// wrapping arithmetic, a 256-value data stack, a 64-frame call stack, 256 words of memory, IN/OUT, all ten
// traps with their own exit codes, and the step and output limits. Each step is checked in the order the
// reference VM checks it — step limit, pc bounds, opcode, immediate fit, stack underflow, stack overflow,
// then the instruction's own traps — and a trap keeps the output written before it.
// One run answers a whole set: /input/<id>/program.bin runs on /input/<id>/input.bin and writes
// /output/<id>/stdout.bin (the bytes written) plus /output/<id>/exit.txt (the exit code, traps included).
// MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR override the two roots for a local run.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Opcode facts packed one byte per opcode (imm | pops<<3 | pushes<<5; 255 = no opcode), from 3 chars each:
// two hex digits of the opcode, then its fact + 32 as one char (so the table is plain ASCII text).
const F = new Uint8Array(256).fill(255);
const S = '00 01A02D03(04h05p06\x9007\x9810P11P12P13P14P15P16P17H18P19P1aP1bH1cP1dP1eP20P21P22P30"31*32*33"34 40H41050(51(52@53(';
for (let i = 0; i < 111; i += 3) F[parseInt(S.slice(i, i + 2), 16)] = S.charCodeAt(i + 2) - 32;
const enc = new TextEncoder;

function run(P, z) {
 const n = P.length, D = new Int32Array(256), C = new Int32Array(64), M = new Int32Array(256), o = new Uint8Array(65536);
 let sp = 0, cp = 0, ol = 0, ip = 0, pc = 0, st = 0;
 const e = c => [o.subarray(0, ol), c];
 for (;;) {
  if (st === 1e6) return e(10);
  if (pc < 0 || pc >= n) return e(9);
  const w = P[pc], f = F[w];
  if (f === 255) return e(5);
  if (pc + (f & 7) >= n) return e(9);
  st++;
  const q = pc + 1 + (f & 7), y = (f >> 3) & 3, u = f >> 5;
  if (sp < y) return e(2);
  if (sp - y + u > 256) return e(3);
  pc = q;
  switch (w) {
   case 0: return e(0);
   case 1: D[sp++] = P[q - 1] << 24 >> 24; break;
   case 2: D[sp++] = P[q - 4] | P[q - 3] << 8 | P[q - 2] << 16 | P[q - 1] << 24; break;
   case 3: sp--; break;
   case 4: D[sp] = D[sp - 1]; sp++; break;
   case 5: { const t = D[sp - 1]; D[sp - 1] = D[sp - 2]; D[sp - 2] = t; break }
   case 6: D[sp] = D[sp - 2]; sp++; break;
   case 7: { const t = D[sp - 3]; D[sp - 3] = D[sp - 2]; D[sp - 2] = D[sp - 1]; D[sp - 1] = t; break }
   case 23: D[sp - 1] = -D[sp - 1] | 0; break;
   case 27: D[sp - 1] = ~D[sp - 1]; break;
   case 51:
    if (cp === 64) return e(7);
    C[cp++] = q;
    pc = P[q - 2] | P[q - 1] << 8;
    break;
   case 52:
    if (cp === 0) return e(8);
    pc = C[--cp];
    break;
   case 64: { const a = D[sp - 1]; if (a < 0 || a > 255) return e(6); D[sp - 1] = M[a]; break }
   case 65: { const a = D[sp - 1]; if (a < 0 || a > 255) return e(6); sp -= 2; M[a] = D[sp]; break }
   case 80: {
    const b = enc.encode(D[sp - 1] + '');
    if (ol + b.length > 65536) return e(11);
    sp--;
    o.set(b, ol);
    ol += b.length;
    break;
   }
   case 81: if (ol === 65536) return e(11); o[ol++] = D[--sp] & 255; break;
   case 82: D[sp++] = ip < z.length ? z[ip++] : -1; break;
   case 83: return e(D[--sp] & 255);
   case 48: case 49: case 50: {
    const r = (P[q - 2] | P[q - 1] << 8) << 16 >> 16;
    let k = w === 48;
    if (!k) { const t = D[--sp]; k = w === 49 ? t === 0 : t !== 0; }
    if (k) pc = q + r;
    break;
   }
   default: {
    const b = D[sp - 1], a = D[sp - 2];
    let r;
    switch (w) {
     case 16: r = a + b | 0; break;
     case 17: r = a - b | 0; break;
     case 18: r = Math.imul(a, b); break;
     case 19: if (b === 0) return e(4); r = a / b | 0; break;
     case 20: if (b === 0) return e(4); r = a % b | 0; break;
     case 21: if (b === 0) return e(4); r = (a >>> 0) / (b >>> 0) | 0; break;
     case 22: if (b === 0) return e(4); r = (a >>> 0) % (b >>> 0) | 0; break;
     case 24: r = a & b; break;
     case 25: r = a | b; break;
     case 26: r = a ^ b; break;
     case 28: r = a << (b & 31); break;
     case 29: r = a >> (b & 31); break;
     case 30: r = a >>> (b & 31) | 0; break;
     case 32: r = a === b ? 1 : 0; break;
     case 33: r = a < b ? 1 : 0; break;
     default: r = (a >>> 0) < (b >>> 0) ? 1 : 0;
    }
    sp -= 2;
    D[sp++] = r;
   }
  }
 }
}

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input', O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const d of readdirSync(I).sort()) {
 const [b, c] = run(readFileSync(join(I, d, 'program.bin')), readFileSync(join(I, d, 'input.bin')));
 mkdirSync(join(O, d), { recursive: !0 });
 writeFileSync(join(O, d, 'stdout.bin'), b);
 writeFileSync(join(O, d, 'exit.txt'), c + '\n');
}
