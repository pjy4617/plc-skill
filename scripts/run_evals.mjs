#!/usr/bin/env node
/**
 * run_evals.mjs — Layer 1 회귀 러너
 *
 * evals/evals.json 의 각 테스트에 대해:
 *   1. fixtureFile 로드 (고정 tool_calls — golden fixture)
 *   2. scenario + fixture 를 pipeline.mjs 에 넣어 실제 런타임 시뮬
 *   3. assertions 평가 (project_metric / il_contains / sim_pass_rate)
 *   4. 집계 테이블 + JSON 리포트 출력
 *
 * 의도: 런타임/컴파일러/시뮬러너가 바뀌었을 때 골든 고정값으로 회귀 감지.
 * 에이전트(writer) 출력의 품질은 Layer 2(skill-creator eval-viewer)로 별도 검증.
 *
 * 사용법:
 *   node scripts/run_evals.mjs
 *   node scripts/run_evals.mjs --runtime /abs/path/eplc_runtime
 *   node scripts/run_evals.mjs --filter self-hold
 *   node scripts/run_evals.mjs --json /tmp/eval_report.json
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const a = { runtime: null, filter: null, json: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--runtime') a.runtime = argv[++i];
    else if (k === '--filter') a.filter = argv[++i];
    else if (k === '--json') a.json = argv[++i];
  }
  return a;
}

function findRuntime(provided) {
  if (provided && fs.existsSync(provided)) return provided;
  const candidates = [
    '/home/pjy4617/Repos/raspberrypi-ec/Program/e-plc-runtime/build/eplc_runtime',
    path.resolve(SKILL_ROOT, '../raspberrypi-ec/Program/e-plc-runtime/build/eplc_runtime'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

/** Nested 경로 평가: "project.rungs.length" 같은 점 표기 */
function getByPath(obj, dotPath) {
  return dotPath.split('.').reduce((a, k) => (a == null ? a : a[k]), obj);
}

function evalAssertion(assertion, ctx) {
  const { type, op = '==', value } = assertion;
  switch (type) {
    case 'project_metric': {
      const actual = getByPath(ctx.report, assertion.path);
      return compare(actual, op, value);
    }
    case 'il_contains': {
      // compile_il.mjs 는 opcode를 padEnd(4)로 정렬해 "LD  T0" 같이 출력한다.
      // 사용자 기대는 opcode+피연산자 매칭이므로 공백 시퀀스를 단일 공백으로 정규화 후 비교.
      const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
      const il = norm(ctx.report.il);
      const needle = norm(value);
      return { passed: il.includes(needle), actual: il.includes(needle), expected: true };
    }
    case 'sim_pass_rate': {
      const sim = ctx.report.sim;
      if (!sim || sim.total === 0) return { passed: false, actual: null, expected: value, note: 'no sim' };
      const rate = sim.passed / sim.total;
      return compare(rate, op, value);
    }
    default:
      return { passed: false, actual: null, expected: value, note: `unknown type: ${type}` };
  }
}

function compare(actual, op, expected) {
  const lhs = Number(actual), rhs = Number(expected);
  let passed = false;
  if (op === '==') passed = actual == expected;
  else if (op === '!=') passed = actual != expected;
  else if (op === '>=') passed = lhs >= rhs;
  else if (op === '<=') passed = lhs <= rhs;
  else if (op === '>') passed = lhs > rhs;
  else if (op === '<') passed = lhs < rhs;
  return { passed, actual, expected, op };
}

function runOneEval(evalDef, opts) {
  const fixturePath = path.resolve(SKILL_ROOT, 'evals', evalDef.fixtureFile);
  if (!fs.existsSync(fixturePath)) {
    return { name: evalDef.name, status: 'error', note: `fixture not found: ${fixturePath}` };
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `eval-${evalDef.name}-`));
  const toolsPath = path.join(tmpDir, 'tools.json');
  const scenarioPath = path.join(tmpDir, 'scenario.json');
  const reportPath = path.join(tmpDir, 'report.json');

  fs.copyFileSync(fixturePath, toolsPath);
  fs.writeFileSync(scenarioPath, JSON.stringify(evalDef.scenario ?? {}, null, 2));

  // 이전 런타임 정리 (exact name, -f 금지)
  spawnSync('pkill', ['-x', 'eplc_runtime'], { stdio: 'ignore' });
  // 짧게 대기해 포트 해제
  const waitUntil = Date.now() + 400;
  while (Date.now() < waitUntil) { /* busy sleep */ }

  const args = [
    path.join(SKILL_ROOT, 'scripts/pipeline.mjs'),
    '--tools', toolsPath,
    '--scenario', scenarioPath,
    '--out', reportPath,
  ];
  if (opts.runtime) args.push('--runtime', opts.runtime);

  const res = spawnSync('node', args, {
    encoding: 'utf8',
    cwd: SKILL_ROOT,
    timeout: 60_000,
  });

  let report = null;
  try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')); } catch { /* ignore */ }

  if (!report) {
    return {
      name: evalDef.name,
      status: 'error',
      note: 'no report produced',
      stderr: (res.stderr || '').slice(-800),
      exitCode: res.status,
    };
  }

  const assertions = (evalDef.assertions ?? []).map(a => {
    const r = evalAssertion(a, { report });
    return { name: a.name, type: a.type, ...r };
  });
  const failedAssertions = assertions.filter(a => !a.passed);

  return {
    name: evalDef.name,
    status: (report.verdict === 'passed' && failedAssertions.length === 0) ? 'pass' : 'fail',
    verdict: report.verdict,
    stage: report.stage,
    summary: report.summary,
    il: report.il,
    sim: report.sim ? { passed: report.sim.passed, total: report.sim.total, steps: report.sim.steps } : null,
    assertions,
  };
}

function render(results) {
  const lines = [];
  lines.push('');
  lines.push('═'.repeat(72));
  lines.push('  Layer 1 회귀 테스트 결과');
  lines.push('═'.repeat(72));
  for (const r of results) {
    const icon = r.status === 'pass' ? '✅' : r.status === 'fail' ? '❌' : '⚠️ ';
    lines.push(`\n${icon}  ${r.name}  [${r.verdict ?? r.status}] — ${r.summary ?? r.note ?? ''}`);
    if (r.sim) {
      lines.push(`   시나리오: ${r.sim.passed}/${r.sim.total} 스텝 통과`);
    }
    if (r.assertions) {
      for (const a of r.assertions) {
        const ic = a.passed ? '  ✓' : '  ✗';
        const detail = a.passed
          ? ''
          : ` (expected ${a.op ?? ''} ${JSON.stringify(a.expected)}, got ${JSON.stringify(a.actual)})`;
        lines.push(`${ic} [${a.type}] ${a.name}${detail}`);
      }
    }
    if (r.stderr) {
      lines.push(`   stderr tail: ${r.stderr.split('\n').slice(-3).join(' | ')}`);
    }
  }
  const passed = results.filter(r => r.status === 'pass').length;
  lines.push('');
  lines.push('─'.repeat(72));
  lines.push(`  합계: ${passed}/${results.length} 통과`);
  lines.push('═'.repeat(72));
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv);
  const evalsFile = path.join(SKILL_ROOT, 'evals', 'evals.json');
  const evalSet = JSON.parse(fs.readFileSync(evalsFile, 'utf8'));
  const runtimePath = findRuntime(args.runtime);
  if (!runtimePath) {
    console.error('[run_evals] eplc_runtime 바이너리를 찾지 못했습니다. --runtime <경로>로 지정하거나 build 하세요.');
    process.exit(2);
  }

  let evals = evalSet.evals.filter(e => e.fixtureFile);
  if (args.filter) evals = evals.filter(e => e.name.includes(args.filter));
  if (!evals.length) {
    console.error('[run_evals] 실행할 테스트가 없습니다 (fixtureFile 없는 eval 또는 필터 미일치).');
    process.exit(2);
  }

  console.log(`[run_evals] runtime: ${runtimePath}`);
  console.log(`[run_evals] ${evals.length}개 테스트 실행 중...\n`);

  const results = [];
  for (const e of evals) {
    process.stdout.write(`  ▶ ${e.name} ... `);
    const started = Date.now();
    const r = runOneEval(e, { runtime: runtimePath });
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`${r.status === 'pass' ? 'pass' : r.status} (${elapsed}s)`);
    results.push(r);
  }

  // 청소
  spawnSync('pkill', ['-x', 'eplc_runtime'], { stdio: 'ignore' });

  console.log(render(results));

  if (args.json) {
    fs.writeFileSync(args.json, JSON.stringify({
      runtime: runtimePath,
      timestamp: new Date().toISOString(),
      results,
    }, null, 2));
    console.log(`\n상세 리포트 저장: ${args.json}`);
  }

  const failures = results.filter(r => r.status !== 'pass').length;
  process.exit(failures === 0 ? 0 : 1);
}

main();
