# plc-skill — e-plc 래더 프로그램 작성·시뮬 스킬

e-plc 웹 에디터(OpenPLC + EtherCAT + CM5 기반) 용 래더 프로그램을 **자연어 요구사항 → tool_call JSON → MELSEC IL → 런타임 시뮬** 파이프라인으로 작성·검증하는 Claude Code 스킬.

미쯔비시 GX Works 스타일 니모닉을 이해하되, 실행 대상은 `Program/e-plc-runtime` C++ 인터프리터. 지원 범위는 `LD, LDI, AND, ANI, OR, ORI, ORB, ANB, OUT, SET, RST, END` + `TMR`/`CNT` (K1 = 100ms).

## 구성

| 경로 | 역할 |
|---|---|
| `SKILL.md` | 오케스트레이터 (writer → simulator → reviewer 루프) |
| `agents/ladder-writer.md` | 요구사항 → tool_call JSON 배열 |
| `agents/ladder-simulator.md` | tool_call → IL → 런타임 시뮬 리포트 |
| `agents/ladder-reviewer.md` | 실패 진단 + writer에 전달할 수정 지시 |
| `scripts/pipeline.mjs` | CLI 오케스트레이터 (apply_tools + compile_il + run_sim) |
| `scripts/apply_tools.mjs` | tool_call → LadderProject |
| `scripts/compile_il.mjs` | LadderProject → MELSEC IL (+ 정적 검증) |
| `scripts/run_sim.mjs` | WS 클라이언트로 e-plc-runtime 구동·검증 |
| `references/` | 배치 규칙·도구 스펙·WS 프로토콜·지원 opcode |
| `evals/evals.json` | 자기유지 / 타이머 / 병렬 OR 테스트 시나리오 |

## 설치 상태

- 스킬 원본: `/home/pjy4617/Repos/plc-skill/`
- 로컬 설치됨:
  - `/home/pjy4617/Repos/raspberrypi-ec/.claude/agents/ladder-{writer,simulator,reviewer}.md`
  - `/home/pjy4617/Repos/raspberrypi-ec/.claude/skills/e-plc-ladder/`

raspberrypi-ec 프로젝트 안에서 Claude Code로 "자기유지 회로 만들어줘" 같은 요청을 하면 SKILL.md 트리거와 서브에이전트가 동작한다.

## 수동 사용법

```bash
# writer 출력을 파일로 저장한 뒤:
node scripts/pipeline.mjs \
  --tools /tmp/tool_calls.json \
  --scenario /tmp/scenario.json \
  --runtime /home/pjy4617/Repos/raspberrypi-ec/Program/e-plc-runtime/build/eplc_runtime

# IL만 확인(시뮬 없이):
node scripts/pipeline.mjs --tools /tmp/tool_calls.json --project-only
```

## 필수 환경

- **Node.js 22+** (내장 WebSocket)
- **CMake 3.16+ + g++ 17** (런타임 빌드용)
- 런타임 빌드: `cd Program/e-plc-runtime && mkdir -p build && cd build && cmake .. && make -j4`

## 알려진 제약

- 런타임은 현재 비트 논리 + TMR/CNT만. MOV/CMP/MC/에지 명령 등 미지원(`Program/docs/plc-simulation-plan.md` Phase 로드맵 참조)
- `run_sim.mjs`는 Node 22+ 내장 WebSocket 가정. 구버전 환경에서는 `npm install ws` 후 import 수정 필요
- sim HAL 전용. 실 EtherCAT 하드웨어 연동은 스코프 외

## 파일 근거

핵심 참조 파일(로직·규칙 출처):

- `Program/e-plc/lib/ai/ladder-tools.ts` — 7개 도구 실행기
- `Program/e-plc/lib/compiler/path-tracer.ts` — 병렬/직렬 구조 추적
- `Program/e-plc/lib/compiler/melsec-generator.ts` — IL 생성
- `Program/e-plc/lib/validator/ladder-validator.ts` — 정적 검증 규칙
- `Program/e-plc-runtime/README.md` — WS 프로토콜 / 지원 opcode
- `Program/e-plc-runtime/src/il_executor.cpp` — 실행기 구현
