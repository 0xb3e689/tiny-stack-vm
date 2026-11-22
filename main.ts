// Pebblestack — a tiny stack VM for make.fun's tiny-stack-vm-01 bounty.
//
// Interprets the full tiny stack ISA (generator/subject/ISA.md in the kit): 32-bit wrapping arithmetic, a
// 256-value data stack, a 64-frame call stack, 256 words of memory, input/output, all ten traps with their
// own exit codes, and the step and output limits. The reference VM, generator/subject/vm.mjs, is the rule:
// every check below runs in the order that file runs them — step limit, pc bounds, opcode, immediate fit,
// stack underflow, stack overflow, then the instruction's own traps — and a trap keeps the output written
// before it while the trapping instruction writes nothing.
//
// One run answers a whole set: for every <id> under /input it runs <id>/program.bin on <id>/input.bin and
// writes /output/<id>/stdout.bin (the bytes the program wrote) and /output/<id>/exit.txt (its exit code).
// MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR override the two roots for a local run.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Per-opcode facts. IMM holds the immediate's byte count (9 = no such opcode); PP packs the stack effect as
// pops | pushes << 8 — the low byte is what it pops, the high byte what it pushes.
const IMM = new Uint8Array(256).fill(9);
const PP = new Uint16Array(256);
for (const [b, i, pp] of [
  [0x00, 0, 0x000], // HALT: pops 0, pushes 0
  [0x01, 1, 0x100], // PUSH8: pops 0, pushes 1
  [0x02, 4, 0x100], // PUSH32
  [0x03, 0, 0x001], // POP: pops 1, pushes 0
  [0x04, 0, 0x201], // DUP: pops 1, pushes 2
  [0x05, 0, 0x202], // SWAP
  [0x06, 0, 0x302], // OVER: pops 2, pushes 3
  [0x07, 0, 0x303], // ROT: pops 3, pushes 3
  [0x10, 0, 0x102], [0x11, 0, 0x102], [0x12, 0, 0x102], [0x13, 0, 0x102], [0x14, 0, 0x102],
  [0x15, 0, 0x102], [0x16, 0, 0x102], [0x18, 0, 0x102], [0x19, 0, 0x102], [0x1a, 0, 0x102],
  [0x1c, 0, 0x102], [0x1d, 0, 0x102], [0x1e, 0, 0x102], [0x20, 0, 0x102], [0x21, 0, 0x102],
  [0x22, 0, 0x102], // the two-operand arithmetic / logic group: pops 2, pushes 1
  [0x17, 0, 0x101], // NEG: pops 1, pushes 1
  [0x1b, 0, 0x101], // NOT
  [0x30, 2, 0x000], // JMP
  [0x31, 2, 0x001], // JZ: pops 1
  [0x32, 2, 0x001], // JNZ
  [0x33, 2, 0x000], // CALL
  [0x34, 0, 0x000], // RET
  [0x40, 0, 0x101], // LOAD
  [0x41, 0, 0x200], // STORE: pops 2
  [0x50, 0, 0x001], // PRINT: pops 1
  [0x51, 0, 0x001], // PUTC
  [0x52, 0, 0x100], // IN: pushes 1
  [0x53, 0, 0x001], // EXIT: pops 1
]) {
  IMM[b] = i;
  PP[b] = pp;
}

const enc = new TextEncoder();

/** Runs one program to its end: [the bytes it wrote, the exit code it ended with — a trap's code when it trapped]. */
function run(p: Uint8Array, inp: Uint8Array): [Uint8Array, number] {
  const n = p.length;
  const D = new Int32Array(256); // data stack
  let sp = 0;
  const C = new Int32Array(64); // return addresses
  let cp = 0;
  const M = new Int32Array(256); // memory
  const out = new Uint8Array(65536);
  let ol = 0;
  let pos = 0; // next input byte
  let pc = 0;
  let steps = 0;
  const end = (code: number): [Uint8Array, number] => [out.subarray(0, ol), code];
  for (;;) {
    if (steps === 1e6) return end(10); // 1,000,000 instructions executed and the program has not ended
    if (pc < 0 || pc >= n) return end(9); // pc outside the program: falling off the end included
    const op = p[pc];
    const imm = IMM[op];
    if (imm === 9) return end(5); // a byte no opcode names
    if (pc + imm >= n) return end(9); // the immediate does not fit before the program's end
    steps++;
    const next = pc + 1 + imm;
    const pp = PP[op];
    const pops = pp & 255;
    const pushes = pp >> 8;
    if (sp < pops) return end(2); // stack underflow
    if (sp - pops + pushes > 256) return end(3); // stack overflow
    pc = next;
    switch (op) {
      case 0x00: // HALT
        return end(0);
      case 0x01: // PUSH8, sign-extended
        D[sp++] = (p[next - 1] << 24) >> 24;
        break;
      case 0x02: // PUSH32, little-endian, signed
        D[sp++] = p[next - 4] | p[next - 3] << 8 | p[next - 2] << 16 | p[next - 1] << 24;
        break;
      case 0x03: // POP
        sp--;
        break;
      case 0x04: // DUP
        D[sp] = D[sp - 1];
        sp++;
        break;
      case 0x05: { // SWAP
        const t = D[sp - 1];
        D[sp - 1] = D[sp - 2];
        D[sp - 2] = t;
        break;
      }
      case 0x06: // OVER
        D[sp] = D[sp - 2];
        sp++;
        break;
      case 0x07: { // ROT
        const a = D[sp - 3];
        D[sp - 3] = D[sp - 2];
        D[sp - 2] = D[sp - 1];
        D[sp - 1] = a;
        break;
      }
      case 0x17: // NEG, wrapping
        D[sp - 1] = -D[sp - 1] | 0;
        break;
      case 0x1b: // NOT
        D[sp - 1] = ~D[sp - 1];
        break;
      case 0x33: // CALL: 64 return addresses held already traps
        if (cp === 64) return end(7);
        C[cp++] = next;
        pc = p[next - 2] | p[next - 1] << 8; // immediate unsigned
        break;
      case 0x34: // RET
        if (cp === 0) return end(8);
        pc = C[--cp];
        break;
      case 0x40: { // LOAD
        const a = D[sp - 1];
        if (a < 0 || a > 255) return end(6);
        D[sp - 1] = M[a];
        break;
      }
      case 0x41: { // STORE
        const a = D[sp - 1];
        const v = D[sp - 2];
        if (a < 0 || a > 255) return end(6);
        sp -= 2;
        M[a] = v;
        break;
      }
      case 0x50: { // PRINT: decimal ASCII, a leading - when negative, no padding
        const b = enc.encode(String(D[sp - 1]));
        if (ol + b.length > 65536) return end(11); // writes none of its bytes
        sp--;
        out.set(b, ol);
        ol += b.length;
        break;
      }
      case 0x51: // PUTC: one byte, v AND 255
        if (ol === 65536) return end(11);
        out[ol++] = D[--sp] & 255;
        break;
      case 0x52: // IN: -1 once the input is used up, and every time after
        D[sp++] = pos < inp.length ? inp[pos++] : -1;
        break;
      case 0x53: // EXIT: v AND 255
        return end(D[--sp] & 255);
      case 0x30:
      case 0x31:
      case 0x32: { // JMP, JZ, JNZ — the target is checked at the next step, not now
        const rel = (p[next - 2] | p[next - 1] << 8) << 16 >> 16;
        let take = true;
        if (op !== 0x30) {
          const v = D[--sp];
          take = op === 0x31 ? v === 0 : v !== 0;
        }
        if (take) pc = next + rel;
        break;
      }
      default: { // every remaining opcode: the two-operand arithmetic / logic group
        const b = D[sp - 1];
        const a = D[sp - 2];
        let r: number;
        switch (op) {
          case 0x10: r = a + b | 0; break; // ADD, wraps
          case 0x11: r = a - b | 0; break; // SUB, wraps
          case 0x12: r = Math.imul(a, b); break; // MUL: the low 32 bits of the exact product
          case 0x13: // DIV: signed, truncated toward zero
            if (b === 0) return end(4);
            r = a / b | 0; // |0 also folds -2147483648 / -1 back to -2147483648
            break;
          case 0x14: // MOD: the sign of a; b = -1 gives 0
            if (b === 0) return end(4);
            r = a % b | 0;
            break;
          case 0x15: // DIVU: unsigned quotient, read back as signed
            if (b === 0) return end(4);
            r = (a >>> 0) / (b >>> 0) | 0;
            break;
          case 0x16: // MODU: unsigned remainder, read back as signed
            if (b === 0) return end(4);
            r = (a >>> 0) % (b >>> 0) | 0;
            break;
          case 0x18: r = a & b; break;
          case 0x19: r = a | b; break;
          case 0x1a: r = a ^ b; break;
          case 0x1c: r = a << (b & 31); break; // SHL: only the low 5 bits of b count
          case 0x1d: r = a >> (b & 31); break; // SHR: arithmetic
          case 0x1e: r = (a >>> (b & 31)) | 0; break; // SHRU: logical
          case 0x20: r = a === b ? 1 : 0; break;
          case 0x21: r = a < b ? 1 : 0; break;
          default: r = (a >>> 0) < (b >>> 0) ? 1 : 0; break; // LTU
        }
        sp -= 2;
        D[sp++] = r;
      }
    }
  }
}

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const [bytes, code] = run(readFileSync(join(I, id, 'program.bin')), readFileSync(join(I, id, 'input.bin')));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'stdout.bin'), bytes);
  writeFileSync(join(O, id, 'exit.txt'), `${code}\n`);
}
