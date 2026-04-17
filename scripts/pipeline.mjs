#!/usr/bin/env node
/**
 * pipeline.mjs — 전체 오케스트레이션 (tool_calls + scenario → 시뮬 리포트)
 *
 * tool_calls JSON과 scenario JSON을 받아:
 *   1) apply_tools로 LadderProject 구성
 *   2) staticValidate로 정적 검증
 *   3) compile으로 IL 생성
 *   4) run_sim으로 런타임 시뮬 + 시나리오 비교
 * 최종 JSON 리포트를 반환. writer → simulator → reviewer 루프에서 simulator가 호출.
 *
 * 사용법:
 *   node pipeline.mjs --tools tool_calls.json --scenario sc.json [--runtime /path/eplc_runtime]
 *   node pipeline.mjs --tools tool_calls.json --project-only    # IL까지만, 시뮬 없이
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { applyAll, emptyProject } from './apply_tools.mjs';
import { compile, staticValidate } from './compile_il.mjs';
import { runSimulation } from './run_sim.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const a = { tools: null, scenario: null, runtime: null, port: 8765, projectOnly: false, out: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--tools') a.tools = argv[++i];
    else if (k === '--scenario') a.scenario = argv[++i];
    else if (k === '--runtime') a.runtime = argv[++i];
    else if (k === '--port') a.port = Number(argv[++i]);
    else if (k === '--project-only') a.projectOnly = true;
    else if (k === '--out') a.out = argv[++i];
  }
  return a;
}

async function findRuntime(provided) {
  if (provided && fs.existsSync(provided)) return provided;
  const candidates = [
    path.resolve(__dirname, '../../../Repos/raspberrypi-ec/Program/e-plc-runtime/build/eplc_runtime'),
    path.resolve('/home/pjy4617/Repos/raspberrypi-ec/Program/e-plc-runtime/build/eplc_runtime'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.tools) { console.error('usage: pipeline.mjs --tools tool_calls.json [--scenario sc.json] [--runtime <bin>]'); process.exit(2); }

  const calls = JSON.parse(fs.readFileSync(args.tools, 'utf-8'));
  const report = {
    stage: 'apply',
    applyResults: null,
    project: null,
    staticIssues: null,
    compileErrors: null,
    il: null,
    sim: null,
    verdict: 'unknown',
    summary: '',
  };

  // 1) apply_tools
  const { project, results } = applyAll(calls, emptyProject('ai-writer-output'));
  report.applyResults = results.map(r => ({
    tool: r.call.name, input: r.call.input, success: r.result.success, message: r.result.message
  }));
  report.project = project;
  const applyFailures = results.filter(r => !r.result.success);
  if (applyFailures.length) {
    report.stage = 'apply';
    report.verdict = 'failed';
    report.summary = `tool_call 적용 실패 ${applyFailures.length}건. reviewer가 호출 순서/파라미터를 수정해야 함.`;
    finish(report, args);
    return;
  }

  // 2) staticValidate
  const issues = staticValidate(project);
  report.staticIssues = issues;
  const staticErrors = issues.filter(i => i.severity === 'error');
  if (staticErrors.length) {
    report.stage = 'static';
    report.verdict = 'failed';
    report.summary = `정적 검증 오류 ${staticErrors.length}건: ${staticErrors.map(e => e.code).join(', ')}`;
    finish(report, args);
    return;
  }

  // 3) compile
  const { il, errors: compileErrors } = compile(project);
  report.il = il;
  report.compileErrors = compileErrors;
  if (compileErrors.length) {
    report.stage = 'compile';
    report.verdict = 'failed';
    report.summary = `IL 컴파일 오류 ${compileErrors.length}건`;
    finish(report, args);
    return;
  }

  if (args.projectOnly || !args.scenario) {
    report.stage = 'compile';
    report.verdict = 'partial';
    report.summary = 'IL 생성 완료. 시나리오 미지정으로 런타임 시뮬 생략.';
    finish(report, args);
    return;
  }

  // 4) runSim
  const scenario = JSON.parse(fs.readFileSync(args.scenario, 'utf-8'));
  const runtimePath = await findRuntime(args.runtime);
  if (!runtimePath) {
    report.stage = 'sim';
    report.verdict = 'blocked';
    report.summary = 'eplc_runtime 바이너리를 찾지 못했습니다. --runtime <경로> 지정하거나 build 먼저 수행하세요.';
    finish(report, args);
    return;
  }
  const sim = await runSimulation({ il, scenario, runtimePath, port: args.port });
  report.sim = sim;
  report.stage = 'sim';
  if (sim.rawError || !sim.uploadOk) {
    report.verdict = 'failed';
    report.summary = `런타임 오류: ${sim.rawError ?? '업로드 실패'}`;
  } else if (sim.failed > 0) {
    report.verdict = 'failed';
    report.summary = `시나리오 ${sim.failed}/${sim.total} 스텝 실패.`;
  } else {
    report.verdict = 'passed';
    report.summary = `시나리오 ${sim.passed}/${sim.total} 스텝 모두 통과.`;
  }
  finish(report, args);
}

function finish(report, args) {
  const out = JSON.stringify(report, null, 2);
  if (args.out) fs.writeFileSync(args.out, out);
  else process.stdout.write(out + '\n');
  process.exit(report.verdict === 'passed' || report.verdict === 'partial' ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
