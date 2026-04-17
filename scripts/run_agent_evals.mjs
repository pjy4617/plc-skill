#!/usr/bin/env node
/**
 * run_agent_evals.mjs — Layer 2 에이전트 품질 회귀
 *
 * Layer 1(run_evals.mjs)이 "고정 tool_calls → 런타임"을 검증하는 반면,
 * Layer 2는 "자연어 prompt → writer 에이전트 → tool_calls → 런타임"을 돌려
 * 에이전트가 요구사항을 얼마나 정확히 tool_call로 번역하는지 본다.
 *
 * 실행 요구:
 *   - `claude` CLI (Claude Code) 가 PATH 에 있어야 함
 *   - ANTHROPIC_API_KEY 가 환경 또는 ~/.claude 설정에 있어야 함
 *   - 네트워크 연결
 *
 * 동작:
 *   1. agents/ladder-writer.md 의 본문(프론트매터 제외)을 system prompt 로 사용
 *   2. 각 eval의 prompt 를 `claude -p` 에 투입하여 텍스트 응답 수신
 *   3. 응답에서 첫 ```json ... ``` 블록을 추출(= tool_calls 배열)
 *   4. 추출된 tool_calls + eval.scenario 로 pipeline.mjs 실행
 *   5. assertions 평가 (Layer 1 과 동일 규칙)
 *
 * 사용법:
 *   node scripts/run_agent_evals.mjs [--filter self-hold] [--model sonnet]
 *                                    [--runtime /path/eplc_runtime] [--out /tmp/layer2.json]
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const a = { runtime: null, filter: null, out: null, model: 'sonnet', maxBudget: '2.00' };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--runtime') a.runtime = argv[++i];
    else if (k === '--filter') a.filter = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--model') a.model = argv[++i];
    else if (k === '--max-budget-usd') a.maxBudget = argv[++i];
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

/** 프론트매터(--- ... ---) 제거 후 본문만 반환 */
function loadAgentBody(agentFile) {
  const raw = fs.readFileSync(agentFile, 'utf8');
  const m = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return m ? m[1].trim() : raw.trim();
}

/** writer 응답에서 첫 ```json ... ``` 코드 펜스 안의 내용을 JSON으로 파싱 */
function extractToolCalls(text) {
  const fenceRegex = /```(?:json)?\s*\n([\s\S]*?)```/g;
  let m;
  while ((m = fenceRegex.exec(text)) !== null) {
    const body = m[1].trim();
    if (!body.startsWith('[')) continue;
    try {
      const parsed = JSON.parse(body);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed[0]?.name) return parsed;
    } catch { /* 다음 블록 시도 */ }
  }
  return null;
}

function getByPath(obj, p) {
  return p.split('.').reduce((a, k) => (a == null ? a : a[k]), obj);
}

function compare(actual, op, expected) {
  const lhs = Number(actual), rhs = Number(expected);
  let passed = false;
  if (op === '==') passed = actual == expected;
  else if (op === '!=') passed = actual != expected;
  else if (op === '>=') passed = lhs >= rhs;
  else if (op === '<=') passed = lhs <= rhs;
  else if (op === '>')  passed = lhs > rhs;
  else if (op === '<')  passed = lhs < rhs;
  return { passed, actual, expected, op };
}

function evalAssertion(a, report) {
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  switch (a.type) {
    case 'project_metric': {
      const actual = getByPath(report, a.path);
      return compare(actual, a.op ?? '==', a.value);
    }
    case 'il_contains': {
      const il = norm(report.il);
      const needle = norm(a.value);
      return { passed: il.includes(needle), actual: il.includes(needle), expected: true };
    }
    case 'sim_pass_rate': {
      const sim = report.sim;
      if (!sim || sim.total === 0) return { passed: false, actual: null, expected: a.value, note: 'no sim' };
      return compare(sim.passed / sim.total, a.op ?? '>=', a.value);
    }
    default:
      return { passed: false, note: `unknown assertion type: ${a.type}` };
  }
}

function callWriter(userPrompt, systemPrompt, { model, maxBudget }) {
  const args = [
    '-p', userPrompt,
    '--system-prompt', systemPrompt,
    '--output-format', 'text',
    '--allowedTools', '',                    // writer 는 텍스트만 출력 — 도구 필요 없음
    '--no-session-persistence',
    '--model', model,
    '--max-budget-usd', String(maxBudget),
  ];
  const res = spawnSync('claude', args, {
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    ok: res.status === 0,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    exitCode: res.status,
  };
}

function runOneEval(evalDef, opts) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `layer2-${evalDef.name}-`));
  const callRes = callWriter(evalDef.prompt, opts.systemPrompt, {
    model: opts.model, maxBudget: opts.maxBudget
  });
  const rawResponsePath = path.join(tmpDir, 'writer.txt');
  fs.writeFileSync(rawResponsePath, callRes.stdout);

  if (!callRes.ok) {
    return { name: evalDef.name, status: 'error', stage: 'writer',
      note: `claude exit=${callRes.exitCode}`, stderr: callRes.stderr.slice(-400),
      responseFile: rawResponsePath };
  }

  const toolCalls = extractToolCalls(callRes.stdout);
  if (!toolCalls) {
    return { name: evalDef.name, status: 'fail', stage: 'extract',
      note: 'writer 응답에서 tool_calls JSON 블록을 찾지 못함',
      responseFile: rawResponsePath };
  }

  const toolsPath = path.join(tmpDir, 'tools.json');
  const scenarioPath = path.join(tmpDir, 'scenario.json');
  const reportPath = path.join(tmpDir, 'report.json');
  fs.writeFileSync(toolsPath, JSON.stringify(toolCalls, null, 2));
  fs.writeFileSync(scenarioPath, JSON.stringify(evalDef.scenario ?? {}, null, 2));

  spawnSync('pkill', ['-x', 'eplc_runtime'], { stdio: 'ignore' });
  const deadline = Date.now() + 400;
  while (Date.now() < deadline) { /* busy wait */ }

  const pipeArgs = [
    path.join(SKILL_ROOT, 'scripts/pipeline.mjs'),
    '--tools', toolsPath,
    '--scenario', scenarioPath,
    '--out', reportPath,
    '--runtime', opts.runtime,
  ];
  const pipeRes = spawnSync('node', pipeArgs, { encoding: 'utf8', timeout: 60_000 });

  let report = null;
  try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')); } catch { /* ignore */ }
  if (!report) {
    return { name: evalDef.name, status: 'error', stage: 'pipeline',
      note: 'no report', stderr: (pipeRes.stderr || '').slice(-400), toolsPath };
  }

  const assertions = (evalDef.assertions ?? []).map(a => ({
    name: a.name, type: a.type, ...evalAssertion(a, report)
  }));
  const failed = assertions.filter(x => !x.passed);
  return {
    name: evalDef.name,
    status: (report.verdict === 'passed' && failed.length === 0) ? 'pass' : 'fail',
    verdict: report.verdict,
    stage: report.stage,
    summary: report.summary,
    toolCallsCount: toolCalls.length,
    il: report.il,
    sim: report.sim ? { passed: report.sim.passed, total: report.sim.total } : null,
    assertions,
    artifacts: { responseFile: rawResponsePath, toolsPath, reportPath },
  };
}

function render(results) {
  const lines = ['', '═'.repeat(72), '  Layer 2 에이전트 회귀 결과', '═'.repeat(72)];
  for (const r of results) {
    const icon = r.status === 'pass' ? '✅' : r.status === 'fail' ? '❌' : '⚠️ ';
    lines.push(`\n${icon}  ${r.name}  [${r.verdict ?? r.status}] — ${r.summary ?? r.note ?? ''}`);
    if (r.toolCallsCount != null) lines.push(`   writer가 ${r.toolCallsCount}개 tool_call 생성`);
    if (r.sim) lines.push(`   시나리오: ${r.sim.passed}/${r.sim.total} 통과`);
    for (const a of r.assertions ?? []) {
      const ic = a.passed ? '  ✓' : '  ✗';
      const detail = a.passed ? '' : ` (got ${JSON.stringify(a.actual)})`;
      lines.push(`${ic} [${a.type}] ${a.name}${detail}`);
    }
    if (r.artifacts?.responseFile) lines.push(`   응답 원문: ${r.artifacts.responseFile}`);
  }
  const p = results.filter(r => r.status === 'pass').length;
  lines.push('', '─'.repeat(72), `  합계: ${p}/${results.length} 통과`, '═'.repeat(72));
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv);
  const runtimePath = findRuntime(args.runtime);
  if (!runtimePath) { console.error('eplc_runtime 미발견. --runtime 지정'); process.exit(2); }

  const claudeCheck = spawnSync('which', ['claude'], { encoding: 'utf8' });
  if (claudeCheck.status !== 0) {
    console.error('`claude` CLI를 PATH에서 찾지 못했습니다. Claude Code 설치 후 재시도.');
    process.exit(2);
  }

  const writerBody = loadAgentBody(path.join(SKILL_ROOT, 'agents', 'ladder-writer.md'));
  const evalSet = JSON.parse(fs.readFileSync(path.join(SKILL_ROOT, 'evals/evals.json'), 'utf8'));
  let evals = evalSet.evals;
  if (args.filter) evals = evals.filter(e => e.name.includes(args.filter));
  if (!evals.length) { console.error('no evals match'); process.exit(2); }

  console.log(`[Layer 2] runtime: ${runtimePath}`);
  console.log(`[Layer 2] model: ${args.model} / max-budget: $${args.maxBudget}`);
  console.log(`[Layer 2] ${evals.length}개 테스트 (에이전트 호출 포함, 각 20~60초 소요 예상)\n`);

  const results = [];
  for (const e of evals) {
    process.stdout.write(`  ▶ ${e.name} ... `);
    const started = Date.now();
    const r = runOneEval(e, {
      systemPrompt: writerBody,
      runtime: runtimePath,
      model: args.model,
      maxBudget: args.maxBudget,
    });
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`${r.status} (${elapsed}s)`);
    results.push(r);
  }
  spawnSync('pkill', ['-x', 'eplc_runtime'], { stdio: 'ignore' });

  console.log(render(results));
  if (args.out) {
    fs.writeFileSync(args.out, JSON.stringify({
      model: args.model, runtime: runtimePath,
      timestamp: new Date().toISOString(), results
    }, null, 2));
    console.log(`\n상세 리포트: ${args.out}`);
  }

  process.exit(results.filter(r => r.status !== 'pass').length === 0 ? 0 : 1);
}

main();
