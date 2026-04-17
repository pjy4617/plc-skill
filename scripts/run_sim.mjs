#!/usr/bin/env node
/**
 * run_sim.mjs — e-plc-runtime을 WS로 구동해 시나리오 검증
 *
 * 입력: IL 텍스트(파일 또는 stdin) + 시나리오 JSON
 *   scenario 스키마:
 *   {
 *     "name": "자기유지",
 *     "cycleMs": 10,
 *     "settleMs": 200,            // 각 step 입력 적용 후 관찰까지 대기(ms)
 *     "steps": [
 *       { "inputs": {"X0": 1, "X1": 0}, "expect": {"Y0": 1, "M0": 1}, "waitMs": 250 },
 *       { "inputs": {"X0": 0},          "expect": {"Y0": 1} },       // 자기유지 유지
 *       { "inputs": {"X1": 1},          "expect": {"Y0": 0} }
 *     ]
 *   }
 *
 * 출력: JSON 리포트
 *   {
 *     "uploadOk": true,
 *     "passed": 2, "failed": 1, "total": 3,
 *     "steps": [ { index, inputs, expect, observed, pass, diff } ... ],
 *     "rawError": null
 *   }
 *
 * 사용법:
 *   node run_sim.mjs --il program.il --scenario sc.json --runtime /path/eplc_runtime [--port 8765]
 *   (--runtime 생략 시 스크립트 자신이 cwd의 Program/e-plc-runtime/build/eplc_runtime을 탐색)
 */

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import process from 'node:process';
import path from 'node:path';

/** ws 패키지 우선(프로토콜 호환성 더 좋음), 없으면 내장 WebSocket 폴백 */
let WS;
try {
  WS = (await import('ws')).default;
} catch {
  WS = globalThis.WebSocket;
}
if (!WS) {
  console.error('[run_sim] WebSocket 구현을 찾을 수 없습니다. `npm i ws` 또는 Node 22+ 필요.');
  process.exit(1);
}

function parseArgs(argv) {
  const a = { il: null, scenario: null, runtime: null, port: 8765, cwd: null, keepRuntime: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--il') a.il = argv[++i];
    else if (k === '--scenario') a.scenario = argv[++i];
    else if (k === '--runtime') a.runtime = argv[++i];
    else if (k === '--cwd') a.cwd = argv[++i];
    else if (k === '--port') a.port = Number(argv[++i]);
    else if (k === '--keep-runtime') a.keepRuntime = true;
  }
  return a;
}

async function readFileOrStdin(p) {
  if (p && p !== '-') return fs.readFileSync(p, 'utf-8');
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf-8');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function ensureRuntime(args) {
  if (args.runtime && fs.existsSync(args.runtime)) return { path: args.runtime, alreadyBuilt: true };
  // 휴리스틱 탐색
  const candidates = [
    'Program/e-plc-runtime/build/eplc_runtime',
    '../e-plc-runtime/build/eplc_runtime',
    '../../e-plc-runtime/build/eplc_runtime',
  ];
  const baseDirs = [args.cwd, process.cwd(), path.resolve(process.cwd(), '..')].filter(Boolean);
  for (const base of baseDirs) {
    for (const c of candidates) {
      const p = path.resolve(base, c);
      if (fs.existsSync(p)) return { path: p, alreadyBuilt: true };
    }
  }
  throw new Error('eplc_runtime 바이너리를 찾을 수 없습니다. --runtime <경로>로 지정하세요.');
}

/** 런타임을 백그라운드로 기동. listening이 뜰 때까지 짧게 대기 */
async function startRuntime(binPath, port) {
  const proc = spawn(binPath, ['--port', String(port), '--cycle', '10', '--hal', 'sim'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let started = false;
  const logs = [];
  proc.stdout.on('data', d => { logs.push(d.toString()); if (/listening/i.test(d.toString())) started = true; });
  proc.stderr.on('data', d => { logs.push(d.toString()); });
  // stdout listening 문구가 안 뜨더라도 소켓 열림을 연결 시도로 확인
  const deadline = Date.now() + 3000;
  while (!started && Date.now() < deadline) {
    await sleep(100);
    // 연결 가능 여부로 판정
    try {
      const ok = await canConnect(`ws://127.0.0.1:${port}`);
      if (ok) { started = true; break; }
    } catch { /* ignore */ }
  }
  if (!started) {
    proc.kill('SIGKILL');
    throw new Error(`런타임이 포트 ${port}에서 리스닝하지 않습니다.\n로그:\n${logs.join('')}`);
  }
  return { proc, logs };
}

async function canConnect(url) {
  return new Promise((resolve) => {
    try {
      const ws = new WS(url);
      const t = setTimeout(() => { try { ws.close(); } catch {} resolve(false); }, 500);
      const ok  = () => { clearTimeout(t); try { ws.close(); } catch {} resolve(true); };
      const err = () => { clearTimeout(t); resolve(false); };
      if (typeof ws.on === 'function') { ws.on('open', ok); ws.on('error', err); }
      else { ws.addEventListener('open', ok); ws.addEventListener('error', err); }
    } catch { resolve(false); }
  });
}

/** ws 패키지/내장 WebSocket 양쪽 이벤트 모델을 추상화 */
function attach(ws, type, handler) {
  if (typeof ws.on === 'function') ws.on(type, handler);
  else ws.addEventListener(type, handler);
}

/** WS 연결 생성 + 메시지 큐잉 + request/response 헬퍼 */
function openWs(url) {
  const ws = new WS(url);
  const events = [];
  const pending = [];
  const onMessage = (data) => {
    const payload = typeof data === 'string' ? data : (data?.data ?? data?.toString?.());
    try {
      const obj = JSON.parse(payload);
      events.push(obj);
      if (pending.length) pending.shift()(obj);
    } catch { /* 무시 */ }
  };
  // ws 패키지: data는 Buffer/string 직접 / 내장: MessageEvent
  attach(ws, 'message', (ev) => onMessage(ev?.data ?? ev));
  function waitFor(pred, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
      const hit = events.find(pred);
      if (hit) { events.splice(events.indexOf(hit), 1); return resolve(hit); }
      const t = setTimeout(() => reject(new Error('timeout waiting for ws message')), timeoutMs);
      const push = (obj) => {
        if (pred(obj)) { clearTimeout(t); resolve(obj); }
        else { pending.push(push); }
      };
      pending.push(push);
    });
  }
  async function connected() {
    if (ws.readyState === 1) return;
    await new Promise((resolve, reject) => {
      attach(ws, 'open', () => resolve());
      attach(ws, 'error', (e) => reject(e));
    });
  }
  return {
    ws, events,
    send: (obj) => ws.send(JSON.stringify(obj)),
    waitFor, connected,
    close: () => { try { ws.close(); } catch {} },
    latestState: () => [...events].reverse().find(e => e.type === 'state') ?? null,
  };
}

function diffObserved(expect, devices) {
  const diff = {};
  let allMatch = true;
  for (const [k, v] of Object.entries(expect)) {
    const observed = devices?.[k] ?? null;
    if (Number(observed) !== Number(v)) {
      diff[k] = { expected: v, observed };
      allMatch = false;
    } else {
      diff[k] = { expected: v, observed, ok: true };
    }
  }
  return { allMatch, diff };
}

export async function runSimulation({ il, scenario, runtimePath, port = 8765, keepRuntime = false }) {
  const { proc } = await startRuntime(runtimePath, port);
  const client = openWs(`ws://127.0.0.1:${port}`);
  const report = { uploadOk: false, startedOk: false, total: 0, passed: 0, failed: 0, steps: [], rawError: null };
  try {
    await client.connected();

    // upload
    client.send({ cmd: 'upload', il });
    const upRes = await client.waitFor(e => e.type === 'ok' || e.type === 'error', 3000);
    if (upRes.type !== 'ok') {
      report.rawError = `upload 실패: ${upRes.msg}`;
      return report;
    }
    report.uploadOk = true;

    // start
    client.send({ cmd: 'start', cycle_ms: scenario.cycleMs ?? 10 });
    await client.waitFor(e => e.type === 'ok' || e.type === 'error', 2000).catch(() => null);
    report.startedOk = true;

    const settle = scenario.settleMs ?? 150;
    for (let i = 0; i < (scenario.steps ?? []).length; i++) {
      const step = scenario.steps[i];
      for (const [device, value] of Object.entries(step.inputs ?? {})) {
        client.send({ cmd: 'force', device, value: Number(value) });
      }
      await sleep(step.waitMs ?? settle);
      // **오래된 state 이벤트 제거** — force가 반영된 최신 state만 받도록
      // 큐에는 100ms마다 브로드캐스트된 과거 state가 쌓여있다. 방금 force를 적용했으므로
      // 방금 시점 이전의 state는 stale. read_all을 보내고 이후 도착하는 state 1개를 받는다.
      client.events.length = 0;
      client.send({ cmd: 'read_all' });
      const state = await client.waitFor(e => e.type === 'state', 2000).catch(() => null);
      const devices = state?.devices ?? {};
      const { allMatch, diff } = diffObserved(step.expect ?? {}, devices);
      report.steps.push({ index: i, inputs: step.inputs, expect: step.expect, observed: devices, pass: allMatch, diff });
      report.total++;
      if (allMatch) report.passed++; else report.failed++;
    }

    client.send({ cmd: 'stop' });
    await client.waitFor(e => e.type === 'ok', 1000).catch(() => null);
  } catch (e) {
    report.rawError = String(e?.stack ?? e);
  } finally {
    client.close();
    if (!keepRuntime) { try { proc.kill('SIGTERM'); } catch {} }
  }
  return report;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.scenario) { console.error('usage: run_sim.mjs --il <il> --scenario <json> [--runtime <bin>]'); process.exit(2); }
  const il = await readFileOrStdin(args.il);
  const scenario = JSON.parse(fs.readFileSync(args.scenario, 'utf-8'));
  const { path: runtimePath } = await ensureRuntime(args);
  const report = await runSimulation({ il, scenario, runtimePath, port: args.port, keepRuntime: args.keepRuntime });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (!report.uploadOk || report.failed > 0 || report.rawError) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
