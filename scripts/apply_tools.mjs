#!/usr/bin/env node
/**
 * apply_tools.mjs — tool_call JSON 배열을 LadderProject로 변환
 *
 * 출처: Program/e-plc/lib/ai/ladder-tools.ts::executeLadderTool
 * 동일한 결과를 내도록 로직을 순수 함수로 이식했다(브라우저 Zustand 의존 제거).
 *
 * 사용법:
 *   node apply_tools.mjs < tool_calls.json > project.json
 *   node apply_tools.mjs tool_calls.json > project.json
 *   node apply_tools.mjs --in tool_calls.json --out project.json
 */

import fs from 'node:fs';
import process from 'node:process';

/** @typedef {{ id?: string, name: string, input: Record<string, any> }} ToolCall */
/** @typedef {{ success: boolean, message: string }} ToolResult */

let _idSeed = Date.now();
function genId(prefix = 'ai') {
  return `${prefix}-${_idSeed++}-${Math.floor(Math.random() * 9999)}`;
}

/** 빈 LadderProject 생성 */
export function emptyProject(name = 'ai-generated') {
  return {
    id: genId('proj'),
    name,
    rungs: [],
    deviceComments: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * tool_call 하나를 project에 적용. 성공/실패 객체를 반환.
 * executeLadderTool 로직과 의미론적으로 동일해야 한다.
 */
export function applyOne(project, call) {
  try {
    switch (call.name) {
      case 'insert_rung': {
        const comment = call.input.comment ?? '';
        const idx = Number(call.input.insertAfterIndex ?? -1);
        const rung = { id: genId('rung'), comment, rows: 1, elements: [], connections: [] };
        if (idx < 0 || idx >= project.rungs.length) project.rungs.push(rung);
        else project.rungs.splice(idx + 1, 0, rung);
        return { success: true, message: '성공' };
      }

      case 'add_element': {
        const { rungIndex, elementType, device } = call.input;
        const row = Number(call.input.row ?? 0);
        const col = Number(call.input.col);
        const rung = project.rungs[Number(rungIndex)];
        if (!rung) return { success: false, message: `Rung ${rungIndex} 가 존재하지 않습니다` };

        const existing = rung.elements.find(e => e.row === row && e.col === col);
        if (existing) {
          existing.type = elementType;
          existing.device = device;
          if (elementType === 'FUNCTION') {
            const parts = String(device).trim().split(/\s+/);
            existing.functionName = parts[0];
            existing.functionArgs = parts.slice(1);
            existing.device = parts[1] ?? device;
          }
        } else {
          const el = { id: genId('el'), type: elementType, device, row, col };
          if (elementType === 'FUNCTION') {
            const parts = String(device).trim().split(/\s+/);
            el.functionName = parts[0];
            el.functionArgs = parts.slice(1);
            el.device = parts[1] ?? device;
          }
          rung.elements.push(el);
        }
        if (row + 1 > rung.rows) rung.rows = row + 1;
        return { success: true, message: '성공' };
      }

      case 'add_connection': {
        const { rungIndex, fromRow, fromCol, toRow, toCol } = call.input;
        const rung = project.rungs[Number(rungIndex)];
        if (!rung) return { success: false, message: `Rung ${rungIndex} 가 존재하지 않습니다` };
        rung.connections.push({
          id: genId('conn'),
          type: 'VERTICAL',
          fromRow: Number(fromRow),
          fromCol: Number(fromCol),
          toRow: Number(toRow),
          toCol: Number(toCol),
        });
        if (Number(toRow) + 1 > rung.rows) rung.rows = Number(toRow) + 1;
        return { success: true, message: '성공' };
      }

      case 'set_rung_comment': {
        const { rungIndex, comment } = call.input;
        const rung = project.rungs[Number(rungIndex)];
        if (!rung) return { success: false, message: `Rung ${rungIndex} 가 존재하지 않습니다` };
        rung.comment = comment;
        return { success: true, message: '성공' };
      }

      case 'set_device_comment': {
        const { device, comment } = call.input;
        project.deviceComments[device] = comment;
        return { success: true, message: '성공' };
      }

      case 'delete_rung': {
        const i = Number(call.input.rungIndex);
        if (!project.rungs[i]) return { success: false, message: `Rung ${i} 가 존재하지 않습니다` };
        project.rungs.splice(i, 1);
        return { success: true, message: '성공' };
      }

      case 'delete_element': {
        const { rungIndex, row, col } = call.input;
        const rung = project.rungs[Number(rungIndex)];
        if (!rung) return { success: false, message: `Rung ${rungIndex} 가 존재하지 않습니다` };
        rung.elements = rung.elements.filter(
          e => !(e.row === Number(row) && e.col === Number(col))
        );
        return { success: true, message: '성공' };
      }

      default:
        return { success: false, message: `알 수 없는 도구: ${call.name}` };
    }
  } catch (e) {
    return { success: false, message: `오류: ${String(e)}` };
  }
}

/**
 * 전체 tool_call 배열을 순차 적용. 각 결과와 최종 project를 반환.
 */
export function applyAll(calls, baseProject = null) {
  const project = baseProject ?? emptyProject();
  const results = [];
  for (const call of calls) {
    const r = applyOne(project, call);
    results.push({ call, result: r });
  }
  project.updatedAt = new Date().toISOString();
  return { project, results };
}

// ── CLI ─────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { in: null, out: null, positional: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--in') args.in = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else args.positional.push(a);
  }
  if (!args.in && args.positional[0]) args.in = args.positional[0];
  return args;
}

async function readAll(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks).toString('utf-8');
}

async function main() {
  const args = parseArgs(process.argv);
  const raw = args.in
    ? fs.readFileSync(args.in, 'utf-8')
    : await readAll(process.stdin);
  const calls = JSON.parse(raw);
  if (!Array.isArray(calls)) {
    console.error('[apply_tools] 입력은 tool_call 배열이어야 합니다');
    process.exit(2);
  }
  const { project, results } = applyAll(calls);
  const failures = results.filter(r => !r.result.success);
  const out = { project, results, hasFailures: failures.length > 0 };
  const json = JSON.stringify(out, null, 2);
  if (args.out) fs.writeFileSync(args.out, json);
  else process.stdout.write(json + '\n');
  if (failures.length) {
    console.error(`[apply_tools] ${failures.length} 개 호출 실패:`);
    for (const f of failures) console.error(`  - ${f.call.name}: ${f.result.message}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
