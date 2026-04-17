---
name: e-plc-ladder
description: e-plc 웹 에디터(OpenPLC + EtherCAT + CM5 기반, 미쯔비시 MELSEC 스타일)의 래더 프로그램을 자연어 요구사항에서 생성-시뮬레이션-수정 루프로 완성한다. ladder-writer가 tool_call JSON을 생성하고, ladder-simulator가 e-plc-runtime 바이너리를 실제로 구동해 시나리오를 검증하며, ladder-reviewer가 실패를 진단해 수정 지시를 만드는 3-agent 오케스트레이션. "래더 작성", "PLC 래더", "ladder program", "자기유지 회로", "타이머 지연", "모터 제어", "시퀀스 제어", "PLC 시뮬레이션", "래더 테스트" 등 요청에 반드시 자동 적용한다. 이 스킬은 Mitsubishi GX Works 스타일 니모닉을 이해하되, 실제 실행은 e-plc-runtime의 지원 opcode(LD/LDI/AND/ANI/OR/ORI/ORB/ANB/OUT/SET/RST/END + TMR/CNT)로 한정한다.
---

# e-plc Ladder Program Skill

OpenPLC 기반 e-plc 웹 에디터용 래더 프로그램을 **작성 → 시뮬레이션 → 수정 → 완료** 루프로 완성하는 스킬. 3개의 전문 에이전트(`ladder-writer`, `ladder-simulator`, `ladder-reviewer`)를 순차 호출한다.

## 언제 사용하는가

사용자 요청이 다음 중 하나에 해당하면 반드시 이 스킬을 발동한다:

- 래더 회로 설계 요청 (자기유지, 타이머, 카운터, 병렬 OR, 인터록 등)
- 모터 제어, 컨베이어 제어, 램프 점등 시퀀스 등 전형적 PLC 과제
- 기존 래더에 새 Rung 추가
- "시뮬레이션 돌려줘", "테스트해줘" (래더 문맥)
- "MELSEC IL로 변환해줘"

## 전제 환경

- 실행 대상 런타임: **`/home/pjy4617/Repos/raspberrypi-ec/Program/e-plc-runtime/build/eplc_runtime`** (CMake 빌드 산출물)
- 에디터 프로젝트: `/home/pjy4617/Repos/raspberrypi-ec/Program/e-plc/`
- 스킬 루트: `/home/pjy4617/Repos/plc-skill/`
- Node.js **22+** (내장 WebSocket 사용)

## 스킬 디렉토리 구조

```
plc-skill/
├── SKILL.md                       ← 본 파일
├── USAGE.md                       ← 사용자용 상세 가이드(테스트 전략 포함)
├── agents/
│   ├── ladder-writer.md           ← 요구사항 → tool_call JSON
│   ├── ladder-simulator.md        ← tool_call → IL → 런타임 시뮬
│   └── ladder-reviewer.md         ← 실패 진단 + 수정 지시
├── scripts/
│   ├── apply_tools.mjs            ← tool_call → LadderProject
│   ├── compile_il.mjs             ← LadderProject → MELSEC IL + 정적검증
│   ├── run_sim.mjs                ← IL + 시나리오 → WS 검증
│   ├── pipeline.mjs               ← 위 3개를 묶는 오케스트레이터 CLI
│   ├── run_evals.mjs              ← Layer 1 회귀 (fixture → pipeline → assertion)
│   └── run_agent_evals.mjs        ← Layer 2 회귀 (writer 에이전트 호출 → pipeline)
├── references/
│   ├── ladder-tools-api.md        ← 7개 도구 스펙(insert_rung 등)
│   ├── supported-opcodes.md       ← 런타임 지원 12 opcode + TMR/CNT
│   ├── ws-protocol.md             ← e-plc-runtime WS 프로토콜
│   └── ladder-grid-rules.md       ← 11열 배치·병렬 규칙
└── evals/
    ├── evals.json                 ← 테스트 시나리오 메타(prompt·scenario·assertions)
    └── fixtures/                  ← Layer 1용 golden tool_calls 배열
        ├── self-hold-motor.json
        ├── timer-3s-delay.json
        └── parallel-or.json
```

## 핵심 제약 (반드시 준수)

1. **런타임 지원 범위**: `LD, LDI, AND, ANI, OR, ORI, ORB, ANB, OUT, SET, RST, END` + TMR/CNT만. 그 외 MOV/CMP/MC/PLS/에지 명령 등 **생성 금지**(`references/supported-opcodes.md` 참조).
2. **7개 도구만 사용**: writer의 최종 산출은 `insert_rung / add_element / add_connection / set_rung_comment / set_device_comment / delete_rung / delete_element` JSON 배열. (`references/ladder-tools-api.md`)
3. **배치 규칙**: 접점 col 0~7, FUNCTION col 8(2칸), COIL col 10. 병렬은 오른쪽 `add_connection` 하나. (`references/ladder-grid-rules.md`)
4. **디바이스 진법**: X/Y는 **8진** (X8 금지, X10이 8번째), M/T/C/D는 10진.
5. **타이머 단위**: K1 = 100ms. 3초 = K30.
6. **한국어**: 모든 설명·코멘트 한국어. 불확실은 "근거 없음" 명시.

## 워크플로 (writer → simulator → reviewer 루프)

```
┌─────────────┐     tool_calls    ┌──────────────┐
│ USER 요구    │─────────────────▶│ ladder-writer │
└─────────────┘                    └───────┬──────┘
                                           │ JSON
                                           ▼
                                  ┌──────────────────┐
                                  │ ladder-simulator │
                                  │ - apply_tools    │
                                  │ - validate       │
                                  │ - compile IL     │
                                  │ - run_sim (WS)   │
                                  └───────┬──────────┘
                                          │ report.json
                              ┌───────────┴──────────┐
                              ▼                      ▼
                           passed                 failed
                             │                      │
                             ▼                      ▼
                        USER에게 제출       ladder-reviewer
                        (최종 산출물)             │ 수정 지시
                                                   ▼
                                              ladder-writer
                                              (다음 회차)
```

### 루프 한계

- 최대 **5회** 반복. 초과 시 사용자에게 "자동 수정 한계" 고지하고 현 상태 + 실패 분석을 전달
- 동일 실패가 2회 연속 → reviewer가 사용자 개입 요청

## 오케스트레이터가 수행할 단계

1. **요구사항 파싱**: 사용자 입력에서 "무엇을 만들 것인가 + 동작 순서 + 입력/출력 장치"를 추출. 애매하면 질문 후 진행.
2. **시나리오 생성**: 검증 시나리오가 없으면 요구사항에서 추론해 표준 시나리오 구성(예: 자기유지 → "X0 누름→유지→X1로 해제").
3. **writer 호출**: `Task` 도구 또는 `ladder-writer` 서브에이전트에 요구사항 전달. tool_calls JSON 수신.
4. **simulator 호출**: tool_calls + scenario를 `scripts/pipeline.mjs`로 실행. report 수신.
5. **분기**:
   - `verdict: passed` → 사용자에게 최종 산출물 제시
   - `verdict: failed` → `ladder-reviewer` 호출, 수정 지시를 받아 writer로 회귀
   - `verdict: blocked` → 환경 점검 요청(빌드·포트·Node 버전)
   - `verdict: partial` → IL은 됐으나 시나리오 미제공. 사용자에게 시나리오 확인 요청
6. **산출물 정리**: 최종 통과 시 다음을 모두 제시
   - 요구사항 재진술 + I/O 할당표 + Rung 설계
   - tool_calls JSON (복붙용)
   - 생성된 MELSEC IL
   - 시뮬레이션 리포트 요약
   - e-plc 웹 에디터에서 이를 적용하는 절차 설명

## 실행 명령 (실제 사용)

### 단일 회차 파이프라인

```bash
cd /home/pjy4617/Repos/plc-skill

# writer 출력을 tool_calls.json에 저장했다고 가정
node scripts/pipeline.mjs \
  --tools /tmp/tool_calls.json \
  --scenario /tmp/scenario.json \
  --runtime /home/pjy4617/Repos/raspberrypi-ec/Program/e-plc-runtime/build/eplc_runtime \
  --out /tmp/report.json

echo "exit=$?"
cat /tmp/report.json | python3 -c "import sys,json; r=json.load(sys.stdin); print(r['verdict'],'-',r['summary'])"
```

### IL만 확인(시뮬 없이)

```bash
node scripts/pipeline.mjs --tools /tmp/tool_calls.json --project-only
```

### 런타임 재빌드

```bash
cd /home/pjy4617/Repos/raspberrypi-ec/Program/e-plc-runtime
cd build && cmake .. && make -j4 eplc_runtime
```

## 에이전트 호출 방식

Claude Code의 `Task` 도구로 서브에이전트를 명시적으로 호출할 수 있다:

```
Task(subagent_type="ladder-writer", prompt="...")
Task(subagent_type="ladder-simulator", prompt="tool_calls=... scenario=...")
Task(subagent_type="ladder-reviewer", prompt="report=...")
```

로컬 설치 후(`/home/pjy4617/Repos/raspberrypi-ec/.claude/agents/`) 해당 프로젝트에서 서브에이전트로 인식된다.

## 산출물 설치 방법 (사용자용)

생성된 tool_calls JSON을 **실제로 적용**하는 방법(현재 두 가지):

1. **Node 스크립트로 LadderProject JSON 생성 후 IndexedDB import**:
   ```bash
   node scripts/apply_tools.mjs tool_calls.json > project.json
   # project.json을 e-plc 웹 UI의 프로젝트 import 기능으로 로드
   ```
   (`lib/storage/project-file.ts`의 import 포맷과 호환 확인 필요 — 필드: id, name, rungs, deviceComments)

2. **e-plc AI 채팅창에 tool_calls을 그대로 프롬프트로 투입**: 현재 AIChatPanel은 자연어 중심이므로, 이 경로는 사용자가 직접 Rung별로 재현해야 함(향후 "tool_calls import" 버튼 추가 권장).

## 실패 복구 체크리스트

| 증상 | 조치 |
|---|---|
| `eplc_runtime` 바이너리 없음 | `Program/e-plc-runtime` 빌드 |
| 포트 8765 충돌 | `pkill -f eplc_runtime; sleep 1` |
| WebSocket 미지원 | Node 22+ 확인. `node --version` |
| `upload` 응답 error | 생성된 IL을 스크린에 출력해 파싱 오류 메시지와 대조 |
| 시뮬 결과 항상 observed.Y0=undefined | 해당 디바이스가 IL에 한 번도 등장하지 않음 → tool_calls 재확인 |

## 범위 밖 (다른 스킬/도구로 위임)

- e-plc 웹 UI 자체 코드 수정 → 일반 코딩 에이전트
- C++ 런타임 opcode 확장(MOV, CMP 등) → `plc-simulation-plan.md` 참조, 펌웨어 엔지니어링 과제
- EtherCAT 슬레이브 실하드웨어 연동 → 본 스킬 범위 외 (sim HAL만 지원)
- 안전 SIL/PLr 인증 설계 → 전문 안전 엔지니어링 (소프트웨어만으로 달성 불가)

---

## 참조 파일 로딩 가이드

에이전트/사용자가 세부 규칙이 필요할 때 아래 파일을 읽는다:

- 도구 7종 스펙 → `references/ladder-tools-api.md`
- 지원 opcode/디바이스 → `references/supported-opcodes.md`
- WS 프로토콜 → `references/ws-protocol.md`
- 11열 배치 규칙 → `references/ladder-grid-rules.md`

각 파일은 500줄 이하로 유지되며, SKILL.md는 이들을 "필요할 때 로드"하는 관문이다(progressive disclosure).

## 스킬 품질 검증

스킬 자체의 회귀 방어는 **2-레이어 테스트**로 구성되어 있다. 상세 절차 및 새 케이스 추가 방법은 `USAGE.md` §13 참조.

- **Layer 1 (`scripts/run_evals.mjs`)** — 무료·10초. `evals/fixtures/*.json` 의 골든 tool_calls → `pipeline.mjs` → assertion 평가. 런타임/컴파일러/시뮬 러너 회귀 감지용. **CI 권장**.
- **Layer 2 (`scripts/run_agent_evals.mjs`)** — Claude API 과금·케이스당 ~60초. `ladder-writer.md` 본문을 system prompt 로 `claude -p` 호출 → 응답에서 tool_calls 추출 → pipeline. **writer 프롬프트/모델 변경 시** 수동 1회 실행.
- **Layer 3 (수동)** — `apply_tools.mjs` 로 project.json 만들어 e-plc 웹 UI 에 import, 육안 검토.

즉시 회귀 확인:
```bash
cd /home/pjy4617/Repos/plc-skill
node scripts/run_evals.mjs           # 0이면 전부 통과
```
