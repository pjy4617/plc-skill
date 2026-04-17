#!/usr/bin/env node
/**
 * compile_il.mjs — LadderProject → MELSEC IL 텍스트
 *
 * 출처: Program/e-plc/lib/compiler/path-tracer.ts::traceRung
 *       Program/e-plc/lib/compiler/melsec-generator.ts::compile
 * 규칙은 e-plc와 동일하게 유지해야 한다. 런타임은 e-plc-runtime/src/il_parser.cpp가 파싱.
 *
 * 사용법:
 *   node compile_il.mjs project.json > program.il
 *   cat project.json | node compile_il.mjs > program.il
 */

import fs from 'node:fs';
import process from 'node:process';

/** @typedef {{ id:string, type:string, row:number, col:number, device:string,
 *     functionName?:string, functionArgs?:string[] }} Element */
/** @typedef {{ id:string, type:string, fromRow:number, fromCol:number, toRow:number, toCol:number }} Connection */
/** @typedef {{ id:string, comment:string, rows:number, elements:Element[], connections:Connection[] }} Rung */

function contactToOpcode(elem, isFirst) {
  if (elem.type === 'NC_CONTACT') return isFirst ? 'LDI' : 'ANI';
  return isFirst ? 'LD' : 'AND';
}

function outputToLine(elem) {
  switch (elem.type) {
    case 'COIL':     return `OUT ${elem.device}`;
    case 'SET_COIL': return `SET ${elem.device}`;
    case 'RST_COIL': return `RST ${elem.device}`;
    case 'FUNCTION': {
      const name = elem.functionName ?? '';
      const args = elem.functionArgs ?? [];
      if (name === 'TMR' || name === 'CNT') {
        const [dev = '', preset = ''] = args;
        return `OUT ${dev} ${preset}`.trim().replace(/\s+/g, ' ');
      }
      return `${name} ${args.join(' ')}`.trim();
    }
    default: return `OUT ${elem.device}`;
  }
}

/** path-tracer.ts::traceRung 이식 */
function traceRung(rung) {
  const outputs = rung.elements.filter(e =>
    e.type === 'COIL' || e.type === 'SET_COIL' || e.type === 'RST_COIL' || e.type === 'FUNCTION'
  );
  const contacts = rung.elements.filter(e =>
    e.type === 'NO_CONTACT' || e.type === 'NC_CONTACT'
  );
  if (outputs.length === 0) return [];

  const verticalCols = Array.from(new Set(
    rung.connections.filter(c => c.type === 'VERTICAL').map(c => c.fromCol)
  )).sort((a, b) => a - b);

  const groups = [];
  for (const output of outputs) {
    if (rung.rows <= 1 || verticalCols.length === 0) {
      const all = [...contacts].sort((a, b) => a.col - b.col);
      groups.push({ paths: [{ contacts: all, output }], seriesAfter: [], output });
      continue;
    }

    const mergeCol = verticalCols[0];
    const parallelByRow = new Map();
    const seriesAfter = [];

    for (const c of contacts) {
      if (c.col < mergeCol) {
        const list = parallelByRow.get(c.row) ?? [];
        list.push(c);
        parallelByRow.set(c.row, list);
      } else {
        seriesAfter.push(c);
      }
    }
    for (const [, list] of parallelByRow) list.sort((a, b) => a.col - b.col);
    seriesAfter.sort((a, b) => a.col - b.col);

    const paths = [];
    const rowKeys = Array.from(parallelByRow.keys()).sort((a, b) => a - b);
    for (const row of rowKeys) {
      const rowElems = parallelByRow.get(row);
      if (rowElems && rowElems.length > 0) paths.push({ contacts: rowElems, output });
    }

    if (paths.length === 0 && seriesAfter.length > 0) {
      groups.push({ paths: [{ contacts: seriesAfter, output }], seriesAfter: [], output });
      continue;
    }
    if (paths.length > 0) groups.push({ paths, seriesAfter, output });
  }
  return groups;
}

function pathGroupToIL(group) {
  const lines = [];
  const { paths, seriesAfter, output } = group;
  if (paths.length === 1) {
    const contacts = paths[0].contacts;
    for (let i = 0; i < contacts.length; i++) {
      lines.push(`${contactToOpcode(contacts[i], i === 0).padEnd(4)}${contacts[i].device}`);
    }
  } else {
    for (const path of paths) {
      for (let i = 0; i < path.contacts.length; i++) {
        lines.push(`${contactToOpcode(path.contacts[i], i === 0).padEnd(4)}${path.contacts[i].device}`);
      }
    }
    for (let i = 0; i < paths.length - 1; i++) lines.push('ORB');
  }
  for (const c of seriesAfter ?? []) {
    const op = c.type === 'NC_CONTACT' ? 'ANI' : 'AND';
    lines.push(`${op.padEnd(4)}${c.device}`);
  }
  lines.push(outputToLine(output));
  return lines;
}

/** LadderProject → { il, lines, errors } */
export function compile(project) {
  const allLines = [];
  const errors = [];
  for (const rung of project.rungs) {
    if (rung.elements.length === 0) {
      errors.push({ rungId: rung.id, code: 'W001', message: 'Rung이 비어 있습니다.' });
      continue;
    }
    const hasOutput = rung.elements.some(e =>
      e.type === 'COIL' || e.type === 'SET_COIL' || e.type === 'RST_COIL' || e.type === 'FUNCTION'
    );
    if (!hasOutput) {
      errors.push({ rungId: rung.id, code: 'E020', message: 'Rung에 출력(코일/응용명령)이 없습니다.' });
      continue;
    }
    for (const group of traceRung(rung)) {
      allLines.push(...pathGroupToIL(group));
    }
  }
  allLines.push('END');
  return { il: allLines.join('\n'), lines: allLines, errors };
}

// ── 추가 정적 검증(핵심만 이식) — simulator가 런타임 전에 일부 에러 조기 발견 ──
export function staticValidate(project) {
  const issues = [];
  const DEVICE_LIMITS = { X: 256, Y: 256, M: 4096, D: 8192, T: 256, C: 256 };
  const coilMap = new Map();

  for (let ri = 0; ri < project.rungs.length; ri++) {
    const rung = project.rungs[ri];
    const els = rung.elements;
    if (els.length === 0) {
      issues.push({ severity: 'warning', code: 'EMPTY_RUNG', rungIndex: ri,
        message: `Rung ${ri + 1}: 요소가 없음` });
      continue;
    }
    const contacts = els.filter(e => e.type === 'NO_CONTACT' || e.type === 'NC_CONTACT');
    const outputs  = els.filter(e => ['COIL','SET_COIL','RST_COIL','FUNCTION'].includes(e.type));
    if (outputs.length === 0) {
      issues.push({ severity: 'error', code: 'NO_OUTPUT', rungIndex: ri,
        message: `Rung ${ri + 1}: 출력 없음` });
    }
    if (contacts.length === 0 && outputs.length > 0) {
      issues.push({ severity: 'warning', code: 'NO_CONTACT', rungIndex: ri,
        message: `Rung ${ri + 1}: 입력 접점 없음(항상 ON)` });
    }
    for (const e of els) {
      if (e.type === 'FUNCTION') continue;
      if (!e.device || !String(e.device).trim()) {
        issues.push({ severity: 'error', code: 'EMPTY_DEVICE', rungIndex: ri,
          message: `Rung ${ri + 1}: 디바이스 이름 비어있음` });
        continue;
      }
      const prefix = String(e.device)[0].toUpperCase();
      const idx = parseInt(String(e.device).slice(1), 10);
      if (!(prefix in DEVICE_LIMITS) || Number.isNaN(idx)) {
        issues.push({ severity: 'error', code: 'UNKNOWN_DEVICE_TYPE', rungIndex: ri,
          message: `Rung ${ri + 1}: 알 수 없는 디바이스 '${e.device}'` });
        continue;
      }
      if (idx < 0 || idx >= DEVICE_LIMITS[prefix]) {
        issues.push({ severity: 'error', code: 'DEVICE_OUT_OF_RANGE', rungIndex: ri,
          message: `Rung ${ri + 1}: ${e.device} 범위 초과(0~${DEVICE_LIMITS[prefix] - 1})` });
      }
      if (['COIL','SET_COIL','RST_COIL'].includes(e.type) && prefix === 'X') {
        issues.push({ severity: 'error', code: 'X_AS_OUTPUT', rungIndex: ri,
          message: `Rung ${ri + 1}: 입력 X를 코일로 사용 불가` });
      }
      if (e.type === 'COIL') {
        const key = String(e.device).toUpperCase();
        coilMap.set(key, (coilMap.get(key) ?? 0) + 1);
      }
    }
    // 코일 우측에 다른 요소
    const outs = els.filter(e => ['COIL','SET_COIL','RST_COIL'].includes(e.type));
    for (const o of outs) {
      if (els.some(x => x.id !== o.id && x.row === o.row && x.col > o.col)) {
        issues.push({ severity: 'error', code: 'OUTPUT_IN_MIDDLE', rungIndex: ri,
          message: `Rung ${ri + 1}: 코일 ${o.device} 우측에 요소 존재` });
      }
    }
  }
  for (const [dev, n] of coilMap) {
    if (n > 1) issues.push({ severity: 'warning', code: 'DOUBLE_COIL', rungIndex: -1,
      message: `이중 코일: ${dev} (${n}회)` });
  }
  return issues;
}

// ── CLI ─────────────────────────────────────────────────────────────────
async function readAll(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks).toString('utf-8');
}

async function main() {
  const infile = process.argv[2];
  const raw = infile && infile !== '-' ? fs.readFileSync(infile, 'utf-8') : await readAll(process.stdin);
  const parsed = JSON.parse(raw);
  // apply_tools의 래퍼(`{project, results, ...}`)도 허용
  const project = parsed.project ?? parsed;
  const issues = staticValidate(project);
  const errors = issues.filter(i => i.severity === 'error');
  if (errors.length) {
    console.error(`[compile_il] 정적 검증 실패 (${errors.length}건):`);
    for (const i of issues) console.error(`  [${i.severity.toUpperCase()}] ${i.code}: ${i.message}`);
    process.exit(2);
  }
  const { il, errors: compileErrors } = compile(project);
  if (compileErrors.length) {
    console.error('[compile_il] 컴파일 오류:');
    for (const e of compileErrors) console.error(`  ${e.code}: ${e.message}`);
    process.exit(3);
  }
  process.stdout.write(il + '\n');
  if (issues.length) {
    for (const i of issues) console.error(`  [warn] ${i.code}: ${i.message}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
