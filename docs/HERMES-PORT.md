# Ruach 설계 문서 — Hermes 방법론의 실시간 음성 이식

> 대상: Ruach (TypeScript / Node, OpenAI Realtime API, speech-to-speech, `@openai/agents`)
> 출처: Hermes (Python 에이전트 프레임워크)의 8개 서브시스템 적응 결정 합성
> 마일스톤 범위: M2(두뇌 코어) · M3(메모리·스킬) · M4(채널 확장)

---

## 1. TL;DR

Hermes의 가치는 **"무엇을 조립하고, 어떻게 위임하고, 무엇을 안전하게 거르는가"라는 방법론**에 있지, 그 방법론을 구현한 Python 런타임 메커니즘(턴 루프, 매 메시지 프롬프트 재조립, 크레덴셜 풀 로테이션, 인라인 멀티스텝 툴 루프, AST 플러그인 디스커버리, 스레드락)에 있지 않다. Ruach로의 이식의 핵심은 **카덴스의 반전(inversion of cadence)**이다. Realtime 모델이 VAD·턴테이킹·barge-in·오디오 스트리밍·"턴" 자체를 네이티브로 소유하므로, Hermes가 *매 턴* 수행하던 모든 것(프롬프트 조립, 메모리 prefetch, 컨텍스트 압축, 멀티스텝 dispatch)은 Ruach에서 **세션 시작 1회(mint 시점)** 또는 **통화 밖 비동기 작업(off-call)**으로 옮겨가야 한다. 따라서 Ruach는 라이브 오디오 경로에 결코 느린 작업을 놓지 않는 **두 개의 시간 축**으로 재설계된다 — (1) `/api/session` mint에서 1회 조립되어 세션 수명 동안 동결되는 instructions, (2) 통화 턴에서는 빠른 ack만 반환하고 결과는 나중에 surface하는 비동기 잡 엔진. Hermes의 인라인 multi-step 두뇌는 이 비동기 축의 *백엔드*로만 살아남는다.

---

## 2. 핵심 결정 — Reimplement vs Bridge vs Hybrid

### 권고: **(c) 하이브리드** — 네이티브 TS 실시간 두뇌 + 무거운 작업의 비동기 Hermes 위임

| 옵션 | 평가 |
|---|---|
| (a) Hermes 두뇌를 TS로 전면 재구현 | 라이브 경로에는 **필수**지만, Hermes 전체(109+ provider 카탈로그, 크레덴셜 풀, 컨텍스트 압축기, 멀티스텝 planner, 배치 러너, SWE 하니스)를 TS로 옮기는 것은 단일 provider 음성 토이에 대한 막대한 과잉 구현이며 대부분 dead code가 된다. |
| (b) 기존 Hermes Python 에이전트에 전량 브리지 | 라이브 통화에 **치명적**. Hermes는 턴 루프를 소유하므로 Realtime SDK와 싸우고 오디오 경로에 Python RTT 지연을 주입한다. VAD/barge-in과 desync 위험. |
| **(c) 하이브리드** ✅ | 실시간 임계 두뇌(세션 mint, instructions 조립, 빠른 네이티브 TS 툴, 이벤트 핸들링, 툴 레지스트리)는 **TS 네이티브**. 진짜 무거운/자율 멀티스텝 작업(리서치, 멀티스텝 파일 작업, 자율 planning)은 **비동기 잡 엔진의 한 백엔드로서 Hermes 에이전트에 위임**. |

**근거**
- **지연**: 음성 턴은 저지연(<수십 ms ack)이어야 한다. Python 두뇌를 턴 경로에 두면 즉시 dead air. 라이브 경로는 무조건 TS 네이티브.
- **SDK 소유권**: Realtime + `@openai/agents`가 턴/VAD/barge-in/툴콜 emission을 소유한다. 여기에 별도 오케스트레이터를 끼우면 SDK와 충돌 → 재구현 금지.
- **유지보수**: 단일 provider·단일 키·작은 툴 표면. Hermes의 멀티 provider/크레덴셜 풀/api_mode 검출 machinery는 구현할 implementor가 하나도 없는 speculative generality.
- **재사용**: Hermes는 통화 밖에서 도는 무거운 자율 작업에 진짜 강하다. 그 강점은 latency가 무관한 off-call 잡 백엔드에서 그대로 활용한다. `delegate_task` 잡 한 종류가 "Hermes에게 넘김"이면 된다.

이 하이브리드는 본 문서 전체의 단일 척추다: **라이브 = 네이티브 TS, 빠르고 동결됨. 무거움 = 비동기, ack-then-surface, 선택적 Hermes 백엔드.**

---

## 3. 실시간 적응 원칙 (가로지르는 규칙)

이 7개 규칙은 모든 서브시스템 결정에서 반복적으로 도출된 불변식이다. M2부터 코드/리뷰 규칙으로 강제한다.

1. **턴 경량화 (TurnSafetyBudget)** — 모델이 통화 중 부르는 툴은 빠른 경로만 허용. 모든 툴은 `latencyClass: 'fast' | 'async'`를 일급 속성으로 가지며, `fast`가 예산(수십 ms, 로컬/서브-50ms 서버콜만) 초과 시 dev-time 경고. 네트워크/파일/DB/멀티스텝은 `async`로 강제.
2. **async 위임 (ack-then-async)** — 무거운 작업: 잡 시작 → 즉시 jobId + 짧은 음성 ack(`"알아보고 다시 말씀드릴게요"`) 반환 → 결과는 후속 발화/UI로 나중에 surface. Hermes의 인라인 sequential re-plan 루프는 **금지** (재도입 = dead air).
3. **세션 시작 1회 주입 (mint-time freeze)** — instructions(SOUL + 툴 가이던스 + 스킬 인덱스 + 메모리 스냅샷)는 `/api/session` mint에서 1회 조립되어 세션 수명 동안 동결. **매 턴 프롬프트 재조립·매 턴 메모리 prefetch 금지.** 신선도가 필요하면 프롬프트 재조립이 아니라 **`recall` 빠른 툴의 in-band 결과**로 얻는다.
4. **browser/server 분리 (where 계약)** — 파일/DB/시크릿/네트워크를 만지는 툴은 `where: 'server'`. 브라우저 툴의 `execute()`는 백엔드를 `fetch`하는 얇은 stub. OPENAI_API_KEY는 절대 브라우저에 노출 안 됨.
5. **모델 네이티브 기능 재사용** — VAD·턴테이킹·barge-in·TTS·STT는 Realtime이 네이티브 제공. 재구현 절대 금지(PTT 녹음, TTS provider 레지스트리, STT abstraction, MessageEvent 정규화, 메시지 배칭/큐잉 전부 drop).
6. **off-call 하우스키핑** — 트랜스크립트 영속화, 메모리 sync, 컨텍스트 압축, 큐레이션, 텔레메트리 flush는 전부 fire-and-forget / 타이머 / 세션 종료 후 / `activeSessionCount === 0` 게이트. 오디오 teardown은 절대 await하지 않음.
7. **서버 보유 컨텍스트 불변식** — Realtime 서버가 라이브 대화 윈도우를 소유한다. Ruach는 그것을 (a) mint-time instructions, (b) 주입된 conversation item(`session.sendMessage`/`sendEvent`), (c) 툴 결과 — 이 세 경로로만 영향을 준다. **in-flight 컨텍스트를 prune/compress/rewrite할 수 없다.** 모든 trim/summarize/redact는 Ruach 자신의 SQLite 사본과 *다음* 세션의 시작 컨텍스트에만 작용.

### 가로지르는 중복 조정 — 정규 모듈 (canonical modules)

8개 서브시스템이 같은 원시 메커니즘을 각기 다른 이름으로 독립 발명했다. 다음으로 **단일화**한다.

| 반복 등장한 이름들 | 정규 모듈 (단일 진실) |
|---|---|
| `jobs/budget.ts`, `jobs/store.ts`, `jobs/runner.ts`, `async-broker.ts`, `AsyncJobBridge` | **`server/src/jobs/`** — `store.ts`(Job 레코드+큐), `runner.ts`(워커 실행+제한 툴셋, Hermes 위임 포함), `budget.ts`(wall-clock/step/동시성 캡). 비동기 잡 엔진은 **하나**. |
| 결과 surfacing 채널 (모든 서브시스템) | **`server/src/jobs/surface.ts` + `GET /api/session/:id/events`(SSE)** + **`web/src/agent/surface.ts`** (barge-in 게이트 주입). |
| `tools/registry.ts`(web), `packages/core` tool-registry, `server tools/registry` | **`packages/core/src/tools.ts`** — 공유 `ToolSpec` 디스크립터(name, description, params zod, where, latencyClass, handler/execute). 브라우저는 `registry.toAgentTools()`, 서버는 `POST /api/tool/:name`, 프롬프트는 `registry.toGuidance()`. **크로스 바운더리 계약**. |
| `assembleInstructions`, `buildStartupContext`, `assembleSessionContext`, `context/build.ts`, `seedForSession` | **`server/src/prompt/assemble.ts`** — `buildSessionConfig`가 mint 시 1회 호출. parts 병렬 read(`Promise.all`) + 하드 타임아웃 + 실패 시 persona-only fail-open. |
| `memory/manager.ts`, `memory/provider.ts`, `FileMemoryProvider` | **`server/src/memory/provider.ts`** (`MemoryProvider` 인터페이스) + `manager.ts`. snapshot=mint, recall=빠른 툴, remember/sync=큐잉. |
| `store/session-db.ts`, `session-state.ts`, trajectory 영속화 | **`server/src/store/session-db.ts`** (better-sqlite3, WAL, sessions+messages+FTS5) + **`server/src/session-state.ts`** (`activeSessionCount` + per-session 정책). |
| `security/scan.ts`, `threat-scan.ts`, `command-guard.ts`, `errors/classify.ts`, `sanitizeToolError` | **`server/src/security/`** (`threat-scan.ts`, `command-guard.ts`, `sanitize.ts`) + **`server/src/errors/classify.ts`**. |
| `context/compressor.ts`, trajectory compressor | **`server/src/context/compressor.ts`** — off-call 전용(idle-gap/close 트리거), aux LLM(=Realtime 아님), 구조화 템플릿, 정적 추출 fallback. |

---

## 4. Hermes 기능·방법론 → Ruach 실시간 매핑 (전체)

범례: **keep** 거의 그대로 / **adapt** 개념 유지·메커니즘 변형 / **drop** 미이식 / **add** 실시간 신규.

### 4.1 Agent Core Loop + System Prompt Assembly

| Hermes 항목 | 판정 | Ruach 설계 (1줄) | M | 노력 |
|---|---|---|---|---|
| Conversation Loop Entry Point (run_conversation) | drop | 중앙 루프 없음. `web/src/main.ts`의 이벤트 모델 유지; `web/src/agent/session.ts`가 create-agent+wire-events 래핑 | M2 | S |
| System Prompt Assembly (3-tier) | adapt | `server/src/prompt/assemble.ts` `assembleInstructions(parts)`, mint 시 1회 동기 조립 | M2 | M |
| Identity Layer (SOUL/Persona load) | keep | `server/src/persona.ts` 그대로; mtime 캐시만 추가, assemble의 첫 part | M2 | S |
| Skill Index Injection | adapt | `server/src/skills/index.ts` mint 시 compact 인덱스 주입 + 실작업은 Realtime 툴로 등록 | M3 | M |
| Context File Discovery (.hermes.md/AGENTS.md cwd scan) | drop | cwd 스캔 없음(음성 통화엔 cwd 없음). 미래 'project mode'면 정적 config 1회 read | later | S |
| Memory Prefetch & Injection (volatile tier) | adapt | mint 시 1회 snapshot을 instructions에 inline; 통화 중엔 `remember`/`recall` 툴만 | M3 | L |
| LLM API Call (provider routing/streaming) | drop | Realtime이 WebRTC로 추론 수행. Ruach는 `/api/session` mint만 호출 | M2 | S |
| Tool Call Validation & Repair | adapt | zod params로 pre-execute 검증; `execute()` try/catch → 짧은 음성-friendly 에러 문자열 | M2 | S |
| Sequential Tool Dispatch (re-plan 루프) | drop | 순차 dispatcher 없음. 멀티스텝은 ONE 비동기 잡 뒤로 캡슐화 | M2 | S |
| Concurrent Tool Dispatch (path-overlap guard) | adapt | per-resource async mutex(`memory`,`session`)로 mutating 충돌만 방지; read는 병렬 | M2 | S |
| Iteration Budget (90/agent counter) | adapt | `server/src/jobs/budget.ts` wall-clock(15s soft/hard) + step 캡 + per-session 동시 잡 캡 | M2 | M |
| Error Classification & Failover (20+ reason) | adapt | `server/src/errors/classify.ts` 소형 enum(TokenMintTransient/Auth, ToolUpstreamFailure, JobTimeout, Unknown) | M2 | S |
| Retry & Backoff (jittered) | adapt | `jitteredBackoff(attempt)` — mint 재시도 + 비동기 잡에만; 라이브 툴은 fail-fast | M2 | S |
| System Prompt Caching (SQLite turn-level) | adapt | turn 캐시는 Realtime 네이티브 prefix-cache로 redundant; 세션 단위 store만 영속(reconnect resume) | M2 | M |
| Post-Turn Hooks (memory sync, review daemon) | adapt | post-call fire-and-forget + 잡 엔진의 후속 surface. 절대 audio 경로에서 await 안 함 | M2 | M |
| Trajectory Persistence | adapt | `history_updated` 트랜스크립트를 append-only JSONL/SQLite로 async POST, `RUACH_SAVE_TRAJECTORIES` 게이트 | M2 | S |
| Self-Registering Tool Registry (방법론) | adapt | `packages/core` ToolSpec 디스크립터 1개가 `tool()`+프롬프트 가이던스 양쪽 emit | M2 | M |
| 3-Tier System Prompt (방법론) | adapt | tier 붕괴: stable(SOUL+가이던스+스킬) + session-snapshot(메모리) 둘 다 동결, volatile tier 소멸 | M2 | S |
| MemoryManager Plugin Interface (방법론) | keep | `MemoryProvider { snapshot, recall, remember }` 인터페이스 형태 유지, 카덴스만 변경 | M3 | M |
| Classified Error Recovery (방법론) | adapt | caller가 구조화 hint(`{retryable, terminal, userMessage}`)만 소비, 문자열 재파싱 금지 | M2 | S |
| Context Compression on Overflow (방법론) | drop | Realtime이 윈도우 소유 → in-place rebuild 불가. 길면 세션 길이 캡 + fresh 세션 | later | S |
| **add** — Async tool dispatch + 음성 ack | add | `startJob(kind,args)→{jobId}` 즉시 ack, 잡은 budget 하에 백그라운드(Hermes 위임 가능) | M2 | — |
| **add** — Result surfacing channel (out-of-band) | add | SSE/poll로 완료 push, 다음 턴에 자연 surface, barge-in 존중 debounce | M2 | — |
| **add** — Session-init latency budget | add | persona/skill/memory 병렬 read + 캡 + 200ms soft target, 느리면 minimal fallback | M2 | — |
| **add** — Barge-in-aware tool/result etiquette | add | 결과 문자열 하드 length 캡; 완료 push는 'user speaking' 신호에 큐잉 | M2 | — |

### 4.2 Tool System (Registry + Dispatch + Catalog)

| Hermes 항목 | 판정 | Ruach 설계 (1줄) | M | 노력 |
|---|---|---|---|---|
| Self-Registering Tool Registry (AST 디스커버리) | adapt | `web/src/tools/<name>.ts` default-export `RuachTool`, `import.meta.glob` 정적 배럴(AST 없음) | M2 | M |
| OpenAI Function Schema Generation | adapt | SDK `tool()`+zod가 스키마 생성. 유지할 것은 selection/gating만, connect 시 1회 계산 | M2 | S |
| Tool Search Bridge (search/describe/call) | drop | 추가 모델 round-trip = 지연. <50 툴은 세션에 직접. 필요 시 ONE `find_skill(query)` 툴 | later | S |
| Function Call Dispatcher | adapt | (1)`web/src/tools/dispatch.ts` 브라우저 래퍼 (2)`server/src/tool-dispatch.ts` Express 핸들러, task_id=sessionId 격리 | M2 | M |
| Async Bridging (_run_async) | drop | Node async-native, 브리지할 게 없음. 하드 타임아웃만 잡 설계에 흡수 | M2 | S |
| Toolset Grouping & Aliases (TOOLSETS) | adapt | `web/src/tools/toolsets.ts` 채널별 preset + includes 재귀 확장, alias 없음 | M2 | S |
| Built-in Tool Catalog (60+) | adapt | latency class로 triage: fast(time/remember/recall) / async(web/vision/gen/delegate) / never-in-call(terminal/file write). TTS drop | M2 | L |
| Check Function Availability (check_fn TTL@30s) | adapt | `server/src/availability.ts` `getAvailabilitySnapshot()` mint 시 1회 probe, 60s 코어스 캐시 | M2 | S |
| MCP Tool Integration | adapt | `server/src/mcp/manager.ts` 부팅 시 warm pool, 모든 MCP 툴은 async class, 브라우저는 MCP 직접 접근 안 함 | M3 | L |
| Schema Sanitization (llama.cpp grammar) | drop | OpenAI Realtime은 표준 스키마 수용, sanitizer = day-one dead code | later | S |
| Dynamic Schema Overrides (mtime 캐시) | drop | 세션 tool 리스트는 connect 시 고정. config 의존 description은 connect 시 평문 계산 | later | S |
| Tool Result Size Capping (100K) | keep | `tool-dispatch.ts`에서 ~2–4K 캡(Hermes보다 타이트) + "show in UI" 컨벤션 | M2 | S |
| Plugin Tool Discovery (pip/entry-point) | drop | 파일 추가 = 툴 추가가 확장성 스토리. 플러그인 로더 없음 | later | S |
| Tool-to-Toolset Mapping & Backward Compat | adapt | `toolsets.ts`에서 grant set 역산으로 도출, legacy alias 테이블 없음 | M2 | S |
| Background Process Registry (subprocess) | adapt | subprocess 특정 부분 drop, lifecycle/tracking 개념을 `jobs/store.ts`로 일반화 | M2 | M |
| TTL Caching of Availability (방법론) | adapt | mint 시 probe + 프로세스 메모, per-turn 캐시 없음 | M2 | S |
| Generation Counter for Cache Invalidation | drop | 세션당 1회 계산, 라이브 mutation 없음 → counter 불필요 | later | S |
| Async-Sync Bridging (방법론) | drop | _run_async 중복, Node는 async-native | later | S |
| Thread-Safe Registry + RLock | drop | Node 단일 스레드, MCP refresh 시 atomic array swap | M2 | S |
| Error Sanitization & Model-Safe Messages | keep | `sanitizeToolError(err)` 양쪽 dispatch에서 사용, 경로/키 redact, 짧은 음성 메시지 | M2 | S |
| Pre/Post Tool Call Hooks | adapt | 동기 non-blocking 로깅/UI hook만; 승인 필요 툴은 async-tier로 후속 음성 확인 | M3 | S |
| Background Event Loop for MCP (daemon thread) | drop | MCP 클라이언트는 module-scope 싱글톤, SIGTERM graceful shutdown | M3 | S |
| **add** — Async Job Store + 결과 surfacing | add | `jobs/store.ts` Job{id,sessionId,status,result} + SSE/poll + conversation item 주입 | M2 | — |
| **add** — Latency-class tagging + 강제 | add | `dispatch.ts`가 latencyClass 분기, fast-tier >300ms dev 경고 | M2 | — |
| **add** — Session-init context injection budget | add | `context/build.ts` SOUL+스킬인덱스+top-N 메모리, 하드 char 캡 | M3 | — |
| **add** — Cross-boundary shared schema | add | `shared/tool-contracts.ts` zod params를 web+server 양쪽 import, tsc가 drift 차단 | M2 | — |

### 4.3 Skill System + Curator

| Hermes 항목 | 판정 | Ruach 설계 (1줄) | M | 노력 |
|---|---|---|---|---|
| SKILL.md Metadata Parsing & Discovery | adapt | `server/src/skills/manifest.ts`, platform gate → **channel/surface gate**, 부팅 시 스캔 | M3 | M |
| System Prompt Skill Index Injection | keep | `buildSkillIndexBlock()` compact 인덱스를 instructions에 append, mint 시 동결 | M3 | S |
| Two-Layer Caching (mtime 무효화) | adapt | `index-cache.ts` 인-프로세스 캐시 + 명시적 `POST /api/skills/reload`(mtime polling 없음) | M3 | S |
| skill_view (full body load + 템플릿) | adapt | 빠른 read-only 룩업(<100ms), 템플릿/쉘 블록 drop(보안+지연) | M3 | M |
| Usage Telemetry (.usage.json 동기 write) | adapt | `telemetry.ts` 인메모리 Map + `setInterval(60s)`/SIGTERM flush, atomic write, 턴 경로 밖 | M3 | S |
| Curator Auto Lifecycle (active→stale→archived) | adapt | `curator.ts` 상태머신 유지, 실행 게이트 = `activeSessionCount === 0` | M4 | M |
| Curator LLM Review Pass (umbrella 통합) | adapt | `curator-review.ts` cheap text 모델(=Realtime 아님), JSON 구조화 출력, off-session, dry-run 기본 | M4 | L |
| Consolidation Detection (tool call 스캔) | adapt | non-streaming JSON 위에서 결정적 post-pass(스트림 스캐너 아님) | M4 | S |
| Curator CLI (status/run/pin/archive/...) | adapt | `cli.ts` + `/api/curator/*`, Realtime 툴로 노출 안 함, pin/unpin은 M3 조기 | M4 | M |
| Skill Config Variable Discovery | adapt | `config.ts` `process.env`에서 resolve(YAML DSL 없음), 부팅 시 1회 | M4 | S |
| External Skills Dirs & Plugin Skills | adapt | external_dirs 유지(`~/.hermes/skills` 재사용 가능), plugin colon-namespace drop | M3 | S |
| Lifecycle Archive & Restore (.archive/ move) | keep | `archive.ts` rename+EXDEV fallback, skill_view가 `.archive/` fallback 해석 | M4 | S |
| Curator Backup & Rollback (tar.gz) | adapt | `backup.ts` apply 전 자동 snapshot, cron-ref 마이그레이션 drop | M4 | M |
| Atomic Sidecar I/O + File Locking | adapt | write-tmp+rename 유지, fcntl 락 drop(단일 프로세스), 실패는 best-effort | M3 | S |
| Inactivity-Triggered Orchestration | adapt | `shouldRunNow()` = enabled && !paused && **activeSessionCount===0** && interval 경과 | M4 | S |
| Seeded-on-First-Sight Clock | keep | `seedRecordIfMissing()` created_at=now, day-one mass-archive 방지 | M4 | S |
| Provenance-Based Filtering (3-channel) | adapt | bundled vs agent-created 2종으로 축소(hub 없음), 억제 리스트 유지 | M4 | S |
| Platform & Environment Gating | drop | OS gate 무의미. SkillMeta.channels/surface가 인덱스 노이즈 감소 대체 | M3 | S |
| Disabled Skills Via Config | adapt | `config.disabledSkills` 인덱스 제외, 명시 skill_view는 여전히 동작 | M3 | S |
| Memory Prefetch & Session Search 통합 | adapt | mint 시 메모리 snapshot append + 빠른 `memory_search` 툴 + skill_manage는 async 저작 | M3 | L |
| Context Threat Scanning | keep | `security/threat-scan.ts` SOUL+SKILL.md body에 load 시 스캔, 매치 시 placeholder | M3 | M |
| **add** — Async skill 실행 + ack + deferred | add | async:true 스킬은 `/api/jobs`로 시작 후 ack, 나중에 surface | M2 | — |
| **add** — activeSessionCount 게이트 (공유) | add | `session-state.ts` mint++/close--, 모든 라이브러리 mutation이 count>0이면 early-return | M2 | — |
| **add** — Frozen-index + .archive/ resolver | add | mint 시 name→path 스냅샷, view resolver는 live→.archive→snapshot fallback | M3 | — |
| **add** — Channel/surface-aware index | add | `buildSkillIndexBlock(channel)`이 채널별 필터(web vs phone, browser vs server) | M3 | — |
| **add** — Streaming-safe telemetry | add | 구조화 tool 호출 lifecycle 콜백으로 카운트, 트랜스크립트 텍스트 스크랩 안 함 | M3 | — |

### 4.4 Plugin System + Lifecycle Hooks

| Hermes 항목 | 판정 | Ruach 설계 (1줄) | M | 노력 |
|---|---|---|---|---|
| Self-Registering Plugin Pattern + Discovery | adapt | `packages/core` `RuachPlugin{name,register(ctx)}`, 정적 import 배럴(파일시스템 디스커버리 아님) | M2 | M |
| PluginContext API (700줄 god-object) | adapt | 소형 ctx: `registerTool/registerServerTool/registerHook/registerSkill/registerMemoryProvider/registerChannel` | M2 | M |
| Tool Registration (override-by-name) | adapt | ToolSpec 1개로 선언, server 툴은 `/api/tool/:name`, override-by-name 유지 | M2 | M |
| Lifecycle Hooks (pre/post_llm 등) | adapt | hook bus 유지, LLM-turn hook drop. 브라우저 hook=fire-and-forget, server hook=await 가능 | M2 | M |
| Hook Context Injection (pre_llm_call) | drop | per-turn 프롬프트 조립 지점 없음. mint-time 컨텍스트 + 비동기 `sendMessage` 주입으로 대체 | M2 | S |
| Pre-Tool-Call Blocking + whitelist | adapt | `/api/tool/:name`에서 pre_tool_call 실행, `{block,message}` 첫 매치 승. per-session config(스레드락 아님) | M2 | S |
| Session Lifecycle Hooks | adapt | `on_session_connect/close` 유지, subagent/finalize/reset drop. close 작업은 async 비차단 | M2 | M |
| Plugin Kind System (5종 gating) | drop | 2종(capability vs exclusive provider)로 축소, 타입 모듈 자체가 선언 | later | S |
| Plugin Manifest (plugin.yaml) | drop | TS 인터페이스가 manifest, `requiresEnv`는 `process.env` read | M2 | S |
| Exclusive Provider — Memory & Context | adapt | exactly-one 패턴 유지, `prefetchForSession`/`recall`/`remember` async-first | M3 | L |
| Provider Backend Plugins (TTS/STT/image/...) | drop | TTS/STT는 Realtime 네이티브. web_search만 ordinary async server 툴로 생존 | later | S |
| Auxiliary Task + Plugin LLM Facade (ctx.llm) | adapt | `packages/core/src/aux-llm.ts` 서버측 Chat/Responses API 호출, 브라우저 노출 안 함 | M2 | M |
| Tool Dispatch (dispatch_tool 동기) + inject_message | adapt | `ctx.enqueueTask→taskId` fire-and-forget + ack, `injectMessage`로 후속 surface | M3 | L |
| Plugin Command Registration (CLI/슬래시) | drop | 음성에 슬래시 없음. '명령'의 실시간 아날로그는 음성 의도 툴 | later | S |
| Plugin Skills (네임스페이스) | adapt | `registerSkill`, mint 시 namespaced 인덱스 주입, `load_skill` 빠른 async 툴 | M3 | M |
| Platform Adapter + Gateway Dispatch Hook | adapt | `ChannelAdapter{connectInboundAudio,check}`, M4 Discord/Twilio. 텍스트 rewrite → inbound-call 정책 hook | M4 | L |
| Approval Hooks (observer-only) | adapt | `on_tool_dispatched/on_tool_result_ready` observer-only, 위험 툴은 two-turn 음성 확인 | M3 | S |
| Plugin Introspection (list_plugins) | keep | `registry.list()`, dev-only `GET /api/plugins` | M2 | S |
| Plugin Enable/Disable Config | adapt | `RUACH_PLUGINS_DISABLED`, first-party 기본 ON, exclusive는 config로 1개 선택 | M2 | S |
| Plugin Debug Logging + Namespace Isolation | adapt | `RUACH_PLUGINS_DEBUG` 유지, ESM이 격리 처리 → sys.modules trickery drop | M2 | S |
| **add** — Async tool kind (delegate+ack+surface) | add | `kind:'async-server'` → enqueueTask + 즉시 ack, 핸들러는 work를 await 안 함 | M2 | — |
| **add** — Result-surfacing 사이드채널 + 다음턴 음성 주입 | add | SSE/WS + `session.sendMessage`/conversation.item.create, barge-in 비방해 | M2 | — |
| **add** — Streaming/세션 이벤트 hook | add | `SessionEventBus` (history_updated/audio_interrupted/error) → queueMicrotask observer hook | M2 | — |
| **add** — 세션 시작 컨텍스트 조립 (1회 prefetch budget) | add | `assembleSessionContext(userId)` 각 part `Promise.race` 타임아웃, persona-only fallback | M2 | — |
| **add** — per-session tool/정책 state | add | `SessionRecord{allowedTools,callerMeta,rateState}` SQLite, pre_tool_call에서 소비 | M2 | — |

### 4.5 Memory + Session Persistence + Context Compression

| Hermes 항목 | 판정 | Ruach 설계 (1줄) | M | 노력 |
|---|---|---|---|---|
| SessionDB (SQLite+FTS5) | adapt | `store/session-db.ts` better-sqlite3, 동기 write는 audio 경로 밖. sessions+messages+FTS5 | M2 | M |
| Full-Text Search (FTS5 + Trigram) | adapt | `store/search.ts` unicode61 + CJK trigram(한국어), async `search_memory` 툴(ack-then-surface) | M3 | M |
| Session Lineage Chain (parent_session_id) | adapt | 트리거를 'compaction split' → 'reconnect/resume'로 repurpose, `resolveLineageRoot` | M3 | S |
| Compression Lock (atomic split) | drop | 단일 스트림, fork/review 경로 없음 → 락 불필요. 필요 시 CAS UPDATE | later | S |
| Context Compression + Session Split | drop | 라이브 압축 = dead air + 서버 보유 컨텍스트 rewrite 불가. off-call 요약기로 이전 | M3 | M |
| MemoryManager (provider orchestration) | adapt | `memory/manager.ts` start-time `buildStartupContext` + off-turn `syncAll`, per-turn rebuild 없음 | M3 | L |
| MemoryProvider ABC | adapt | `provider.ts` `{loadStartupContext, persistTurns, getToolSchemas, handleToolCall}`, per-turn hook drop | M3 | M |
| Prefetch + Sync Turn 패턴 | adapt | prefetch=세션 시작 1회(instructions), sync=백그라운드 flush. refresh는 `sendEvent` 주입 | M3 | M |
| Context Fencing (memory vs user) | adapt | `fence.ts` `<memory-context>` 래핑(mint 시), per-delta streaming scrubber drop | M3 | S |
| Lossless Retrieval (anchored views) | adapt | `retrieval.ts` `getMessagesAround(±N)` off-turn, 주로 트랜스크립트 UI 소비 | M3 | M |
| Session Search Tool (discovery/scroll/browse) | adapt | discovery=async 음성 툴, scroll/browse=REST(UI). hidden source 필터 | M3 | M |
| Compression Status Tracking | drop | 인라인 압축 제거로 govern할 대상 없음. message_count만 유지 | later | S |
| Tool Result Pruning (pre-compression) | adapt | 라이브 pruning pass drop, 짧은 음성 결과 컨벤션 + off-turn 요약기 input | M3 | S |
| WAL + Network FS Fallback | adapt | `journal_mode=WAL`, DELETE fallback. flush writer ↔ search reader 비직렬화 | M2 | S |
| Message Active Flag (soft delete) | adapt | `messages.active`, '잊어줘'/redaction 툴 `POST /api/session/:id/redact`, sync는 active=0 skip | M3 | S |
| Compression Iterative Summary Update | adapt | off-call 요약기에서 이전 summary를 컨텍스트로 update, SUMMARY_PREFIX 정규화 | later | M |
| **add** — Session id + ek_ token lifecycle binding | add | mint 시 UUID 발급, reconnect `resume_of`로 parent chain, hang-up이 진짜 end | M2 | — |
| **add** — In-memory ring buffer + timed flush | add | `flush-queue.ts` per-session 버퍼, `setInterval(~3s)`/N-watermark 1트랜잭션 drain | M2 | — |
| **add** — Async-tool envelope (ack-now/surface-later) | add | execute()가 잡 POST + 즉시 음성 ack, 결과는 sendEvent/UI | M2 | — |
| **add** — Start-time assembly (하드 타임아웃 + fail-open) | add | `Promise.race(~300ms)`, 타임아웃 시 persona-only mint | M2 | — |
| **add** — Server-held context 인식 (no silent rewrite) | add | CLAUDE.md 불변식: 라이브 컨텍스트는 모델 소유, 영향은 instructions/item/tool-output만 | M2 | — |

### 4.6 Multichannel Gateway + Voice Subsystem

| Hermes 항목 | 판정 | Ruach 설계 (1줄) | M | 노력 |
|---|---|---|---|---|
| BasePlatformAdapter (connect/disconnect/send) | adapt | `packages/core/src/channel.ts` `VoiceChannel{start,stop}`, WebRtcChannel=첫 구현, send는 별도 Surface | M4 | M |
| MessageEvent normalization | drop | Realtime은 discrete 메시지 없음. server_vad가 턴 분할, 트랜스크립트 이벤트만 소비 | later | S |
| SessionSource metadata | keep | `session-source.ts` trimmed dataclass, mint 시 1회 instructions 주입, 메모리 scope 키 | M2 | S |
| Slash command 가로채기 + access control | adapt | `tool-access.ts` 서버 tool-dispatch 경계에서 gating(utterance마다 아님), 음성 거부 메시지 | M4 | M |
| Message batching & queueing | drop | 모델이 턴테이킹 소유. 필요 큐는 비동기 결과 outbox(반대 방향)뿐 | later | S |
| Push-to-talk 녹음 | drop | WebRTC 연속 스트리밍이 대체. 'talk' 버튼은 start/stop 토글 | later | S |
| TTS provider registry | drop | Realtime이 음성 네이티브 생성. `voice` config 필드만 유지 | later | S |
| Per-channel voice mode toggle | adapt | `channel-settings.ts` `{enabled,voice,instructionsOverride}` mint 시 merge, 'realtime'=유일 모드 | M4 | S |
| Audio format handling/routing (ffmpeg) | drop | WebRTC가 코덱 처리. M4 telephony μ-law 8kHz↔24kHz는 어댑터 내 transport 작업 | M4 | M |
| Discord Realtime Voice | adapt | `DiscordVoiceChannel` M4, 서버측 RealtimeSession, Opus↔PCM 브리지, 툴 직접 서버 실행 | M4 | L |
| Stream event dispatch & rendering | adapt | `events.ts` 타입드 dispatcher over RealtimeSession 이벤트, 채널별 render, 비차단 | M2 | M |
| Cron job delivery routing (DeliveryTarget) | adapt | AsyncTaskBroker에 흡수, `DeliveryTarget{live-session,ui-surface,memory,next-session}` | M3 | M |
| Platform adapter self-registration | adapt | `channelRegistry.register`, env var 존재 시 enable, 20+ 필드 → `{id,isAvailable,create}` | M4 | S |
| STT provider abstraction | drop | speech-to-speech, STT 단계 없음. 트랜스크립트는 byproduct | later | S |
| SessionContext + system-prompt injection | adapt | `buildSessionConfig(model,source,memoryDigest)` mint 시 1회 concat, per-turn re-inject 없음 | M2 | M |
| Lazy imports for opt-in (방법론) | adapt | 채널 factory 내 `await import()` + isAvailable() env gate | M4 | S |
| Self-registering registry (방법론) | keep | `tools/tool-registry.ts` self-register, mint 시 RealtimeAgent.tools emit, where 강제 | M2 | M |
| Async-safe event loop integration (방법론) | keep | tool execute()/핸들러는 빠르게 반환 or AsyncTaskBroker로 위임 후 ack | M2 | S |
| Scope-aware access control (방법론) | adapt | `ToolAccessPolicy` scope=SessionSource.chatType, tool-time 평가 | M4 | S |
| Platform-native content negotiation | drop | 음성은 char cap 없음. UI 텍스트는 DOM append | later | S |
| Stateful session recovery/resume (offset) | drop | 라이브 통화는 offset replay 불가. 트랜스크립트 영속 + 'where we left off' digest | M2 | M |
| Channel-specific ephemeral prompts/skills | adapt | `channel-settings.ts` per-session override, mint 시 1회(per-turn ephemeral 아님) | M3 | M |
| Env-driven auto-enablement (방법론) | keep | `channelRegistry.isAvailable()` env read(DISCORD_TOKEN 등), OPENAI_API_KEY gate 일반화 | M4 | S |
| Audio environment detection (방법론) | adapt | WebRtcChannel mic-permission/ICE/token-mint 진단, SSH/Docker 로직 무관 | M2 | S |
| **add** — AsyncTaskBroker | add | sessionId-keyed 서버 잡 큐, 무거운/위험 작업 시작+ack, 결과 다음 idle gap surface | M2 | — |
| **add** — 세션 시작 prefetch (1회 off-turn) | add | `/api/session`에서 mint 전 bounded `prefetch(source)`, 느리면 토큰 먼저 mint | M2 | — |
| **add** — browser-vs-server tool placement 계약 | add | `where` 필드 일급화, secret/IO는 server 강제, browser stub은 fetch | M2 | — |
| **add** — barge-in-aware 결과 주입 게이트 | add | idle(no active turn)일 때만 주입, 아니면 hold or UI fallback | M2 | — |
| **add** — Persona/instruction hot-reload 경계 | add | instructions는 mint 시 1회 resolve, mid-session 변경은 예외적 단일 session.update | M2 | — |

### 4.7 Context Management + Sub-agent Delegation + Trajectory Compression

| Hermes 항목 | 판정 | Ruach 설계 (1줄) | M | 노력 |
|---|---|---|---|---|
| Context Compressor (aux-model 요약) | adapt | `context/compressor.ts` 세션 END/idle-gap만, cheap aux 모델, head=SOUL+초기 / tail=최근 verbatim | M2 | M |
| Context Engine (pluggable strategy) | adapt | `context/engine.ts` `{seedForSession,onSessionClose,searchMemory}`, `FileContextEngine` 기본 | M2 | S |
| Session Splitting on Compression | adapt | reconnect=물리적 fresh 세션. 이전 summary를 warm-start seed로, mid-call rebuild 없음 | M2 | M |
| Tool Output Pruning (pre-summarization) | keep | `context/prune.ts` dedupe+1줄 요약, off-path 저장본만 | M2 | S |
| Sub-agent Delegation Tool (parent 블록) | adapt | `delegate_task` **fire-and-forget**, 즉시 jobId+ack, `jobs/runner.ts` 워커(Hermes 백엔드 가능) | M2 | L |
| Sub-agent Isolation & Toolset Restriction | keep | 워커 제한 툴셋(no nested delegate, no direct send), `RUACH_JOB_AUTOAPPROVE` 기본 deny | M2 | S |
| Active Sub-agent Registry & Control | adapt | `jobs/registry.ts` Map, `GET /api/jobs`+`/cancel`, `list_jobs`/`cancel_job` 음성 툴 | M2 | M |
| Trajectory Format & Saving (from/value, <think>) | adapt | `trajectory/record.ts` 타입드 JSONL+meta, `<think>` canonicalization drop | M2 | S |
| Trajectory Compressor | adapt | Context Compressor와 ONE 모듈로 병합(라이브 컨텍스트=저장 트랜스크립트 동일) | M3 | S |
| Batch Runner (multiprocessing pool) | drop | 오프라인 train/eval 하니스, 라이브/로드맵 무관 | later | S |
| Mini SWE Runner | drop | 코드 실행 벤치마크, 음성 컴패니언과 직교. 잡 러너가 대체 | later | S |
| Memory Manager (lifecycle hooks) | adapt | `memory/manager.ts` prefetch→세션 시작만, sync→큐잉, on_pre_compress 유지 | M3 | L |
| System Prompt + Skill Index | adapt | `skills/index.ts` mint 시 1회 조립, 미드콜 rebuild 불가 → `invoke_skill` async 툴 | M3 | M |
| Toolset Registry & Self-Registration | adapt | `tools/registry.ts` `scope:'live'|'job'|'both'`, `buildLiveTools()`는 fast만 | M2 | M |
| Multi-Pass Summarization w/ Template (방법론) | keep | 구조화 템플릿 + anti-hijack preamble, seed는 "PRIOR CONTEXT (reference only)" 래핑 | M2 | S |
| Token Budget-Aware Tail Protection (방법론) | adapt | token 예산 기반 + 오디오-duration token-equivalent | M3 | S |
| Cheap Tool Output Summarization (방법론) | keep | `prune.ts` 도메인 요약 + MD5 dedupe | M2 | S |
| Anti-Thrashing Compression Backoff (방법론) | adapt | transcript 작으면 early-return, summary delta<10%면 skip, 사용자 경고 drop | M2 | S |
| Deterministic Fallback Handoff (방법론) | keep | `buildStaticFallbackSummary` LLM-free 추출, aux 실패 시 cooldown | M2 | S |
| Subagent Thread Isolation & Approval (방법론) | adapt | per-job approval 콜백, 기본 auto-deny, stdin 안 씀, 미래 음성-consent hook | M2 | S |
| Spawn Pause & Global Control (방법론) | drop | 단일 사용자, per-job cancel만 유지 | later | S |
| Trajectory Canonicalization (<think>) (방법론) | drop | train data 미생산 + Realtime CoT 미노출 | later | S |
| Progressive Trajectory Compression (방법론) | keep | `compressor.ts`에서 실현, 최근 tool-call 레코드 보존 | M3 | S |
| Batch Runner Checkpointing (방법론) | drop | dropped Batch Runner에 종속 | later | S |
| Memory Provider Lifecycle Hooks (방법론) | adapt | prefetch=세션 시작, sync=큐잉, on_delegation→`onJobDone`, single-provider 강제 | M3 | M |
| Dynamic Skill Index w/ Caching (방법론) | adapt | mtime 캐시 TTL~30s, mint 시 조립, 미드콜 시스템-프롬프트 스킬 로드 안 함 | M3 | S |
| Toolset Composition & Check Functions (방법론) | keep | includes 합성 + per-tool checkFn, live/job scoping 확장 | M2 | S |
| **add** — Async 결과 surfacing 채널 | add | `jobs/runner.ts` job-done 이벤트 → (1)UI poll (2)음성 weave-in, 턴 경계 존중 | M2 | — |
| **add** — Live-vs-job tool scoping 일급화 | add | `ToolDef.scope`, `buildLiveTools()`는 fast만, latency 예산 테스트 | M2 | — |
| **add** — Server가 라이브 tool 리스트 진실원 | add | `/api/session`이 `liveTools` schema 반환, main.ts 하드코딩 제거 | M2 | — |
| **add** — Audio-aware tail/seed budgeting | add | 브라우저가 turn duration 첨부, `contentLength()`가 token-equivalent 변환 | M3 | — |
| **add** — Voice-channel 승인/consent 콜백 | add | requiresConsent 작업은 음성 확인 발화 + `confirm_action` 툴로 resolve | M3 | — |
| **add** — Idle-gap-triggered 백그라운드 compaction | add | 마지막 append 후 N초 무음 시 `compressor.run` 백그라운드 | M2 | — |
| **add** — Streaming/partial trajectory capture | add | `{partial|final,interrupted}` 플래그로 barge-in 절단까지 충실 기록 | M2 | — |

### 4.8 Configuration + Provider Abstraction + Security/Approvals

| Hermes 항목 | 판정 | Ruach 설계 (1줄) | M | 노력 |
|---|---|---|---|---|
| Config Version Migration (26-version) | adapt | `server/src/config.ts` zod `RuachConfigSchema`+version, 소형 `migrate()` 1–3 버전, .env=시크릿 | M2 | S |
| Config Validation + Error Recovery | adapt | try/catch+safeParse 실패 시 `.corrupt.bak` + DEFAULT_CONFIG, **mint 절대 막지 않음** | M2 | S |
| Provider Registry + Overlay (109+) | drop | 단일 transport(OpenAI Realtime). model은 단일 문자열. `RealtimeProfile` 타입만 | later | S |
| Credential Pool + Failover Strategy | adapt | 풀/로테이션 drop. **ek_ 토큰 lifecycle 리프레시**로 반전(600s 만료 전 proactive re-mint) | M2 | M |
| Custom Provider Config + Auxiliary Chain | drop | 단일 provider. 비동기 잡이 text LLM 필요 시 단일 함수, 체인 없음 | later | S |
| Runtime Provider Resolution (api_mode) | drop | 단일 고정 엔드포인트, resolve할 것 없음 | later | S |
| Threat Pattern Scanning (scope-based) | adapt | `security/threat-scan.ts`, scope 'inject'(instructions 진입)/'write'(notes.jsonl), 턴 경로 밖 | M3 | M |
| Dangerous Command Detection + Approval | adapt | `command-guard.ts` HARDLINE=즉시 동기 deny, DANGEROUS=async 잡 라우팅+ack+out-of-band 승인 | M2 | L |
| Approval Modes (manual/cron/gateway/yolo) | adapt | 'gateway'(UI 버튼+음성 ack)+'auto'+'off'만. interactive는 audio 경로에 **절대** 없음 | M3 | M |
| Context-Local Approval State (contextvars) | adapt | mint 시 sessionId 발급, 모든 tool fetch에 동반, 서버 state 키잉. 필요 시 AsyncLocalStorage | M2 | S |
| Environment Variable Denylist | adapt | config-write 경로 생기면 `_ENV_DENYLIST`(NODE_OPTIONS/LD_PRELOAD/PATH/...) write-side reject | M3 | S |
| Security Audit (OSV.dev) | drop | `npm audit`/Dependabot로 대체, 런타임 기능 아님 | later | S |
| **add** — EphemeralTokenLifecycle | add | `web/src/agent/session.ts` expires_at ~80%에서 re-mint+seamless 재적용, 무음 중 리프레시 | M2 | — |
| **add** — AsyncJobBridge | add | sessionId-keyed 잡 큐, text-LLM/파일 mutation/위험 승인 전부 off-turn | M2 | — |
| **add** — RealtimeProfile | add | `{model,voice,inputFormat,outputFormat,turnDetection{eagerness},modalities}` config-driven | M2 | — |
| **add** — TurnSafetyBudget | add | fast/async 태깅 + dev-time 타이밍 assert, '통화 턴은 가볍게' 코드화 | M2 | — |

---

## 5. 마일스톤 로드맵

### M2 — 두뇌 코어 (네이티브 TS, 라이브 경로 + 비동기 척추)
**왜 먼저**: 모든 후속(메모리, 스킬, 채널)이 (1) 툴 레지스트리·dispatch, (2) mint-time instructions 조립, (3) 비동기 잡 엔진+surfacing, (4) 세션 store·id, (5) 토큰 리프레시 위에 얹힌다. 이 척추 없이는 어떤 무거운 기능도 라이브-세이프하게 추가 불가.
- 공유 ToolSpec 레지스트리 + browser/server dispatch + 크로스 바운더리 계약
- `prompt/assemble.ts` + `session-config.ts` 통합 (SOUL + 툴 가이던스 + sessionMeta)
- 비동기 잡 엔진(`jobs/`) + budget + SSE surfacing + `delegate_task`(Hermes 백엔드 옵션)
- `store/session-db.ts`(WAL) + session id + lineage + ring-buffer flush + trajectory
- EphemeralTokenLifecycle (긴 통화 생존)
- `errors/classify.ts` + `config.ts`(zod, fail-open) + `command-guard.ts` HARDLINE
- SessionSource + per-session 정책 state + 이벤트 dispatcher/SessionEventBus
- off-call compressor(기본) + idle-gap 트리거 + 정적 fallback

### M3 — 메모리 + 스킬 (주입 컨텍스트 풍부화)
**왜 다음**: M2 척추가 "mint 시 1회 주입 / 빠른 recall 툴 / 비동기 저작"의 자리를 이미 만들었으므로, 메모리 provider와 스킬 인덱스를 그 슬롯에 끼우는 작업. 큐레이터의 위험한 라이브러리 mutation을 위한 `activeSessionCount` 게이트와 `.archive/` resolver도 여기서 완비.
- `MemoryProvider`(SQLite+FTS5/CJK trigram) + snapshot-at-mint + `recall`/`memory_search` 빠른 툴 + 큐잉 sync + redaction
- 스킬 manifest/discovery/index 주입 + `skill_view`/`load_skill` 빠른 툴 + channel/surface gate
- inline 컨텍스트(메모리/스킬 body) threat-scan + fence sanitization
- MCP warm pool(서버, async-class) + DeliveryTarget(next-session surfacing)
- Approval gateway 모드 + observer 승인 hook + 음성-consent
- anchored retrieval + 트랜스크립트 UI + off-call 요약기 통합

### M4 — 채널 확장 (인터페이스 독립)
**왜 마지막**: 두번째 채널의 실제 transport(Discord Opus/Twilio μ-law 브리지)에 맞춰 `VoiceChannel` 인터페이스를 설계해야 web-only 가정을 인코딩하지 않는다. 큐레이터 전체(LLM review/backup/rollback)도 라이브러리가 충분히 자란 뒤 off-session으로 안전 실행.
- `VoiceChannel` + `channelRegistry`(env-gated) + DiscordVoiceChannel + Twilio 브리지
- `ToolAccessPolicy`(DM vs group) + per-channel settings/persona override
- Curator 전체(auto lifecycle/LLM review/CLI/backup-rollback), 전부 `activeSessionCount===0` 게이트
- 멀티-프로세스 게이트웨이 등장 시 proper-lockfile 도입

---

## 6. M2 즉시 착수 — 구체 TS 모듈 / 단계

순서대로. 각 단계는 이전 단계의 산출에 의존한다.

1. **`packages/core/src/tools.ts`** — `ToolSpec { name, description, params: ZodSchema, where: 'browser'|'server', latencyClass: 'fast'|'async', scope: 'live'|'job'|'both', execute?, handler?, maxResultChars? }` + `registry.ts`(정적 import 배럴, `toAgentTools()`, `toGuidance()`, `buildLiveTools()`).
2. **`server/src/tool-dispatch.ts`** — 일반 `POST /api/tool/:name`: zod 검증 → 핸들러 룩업 → 실행 → 결과 캡 → JSON. `security/sanitize.ts` `sanitizeToolError()` 적용. `/api/remember`를 이 dispatcher로 흡수.
3. **`web/src/agent/session.ts` + `web/src/agent/tools.ts`** — `main.ts`에서 세션 생성/이벤트 와이어링과 툴 정의를 추출. `main.ts`는 UI-only. `tools: registry.toAgentTools()`로 하드코딩 `[getCurrentTime, remember]` 제거. `dispatch.ts`가 latencyClass 분기(fast=await, async=잡 POST+ack).
4. **`server/src/prompt/assemble.ts`** — `assembleInstructions(parts)`. `server/src/session-config.ts buildSessionConfig`가 `loadPersona()` + `registry.toGuidance()` + (M3 stub) memory/skill을 `Promise.all`+`Promise.race(300ms)`로 모아 1회 concat. 실패 시 persona-only.
5. **`server/src/jobs/`** — `store.ts`(Job 레코드+큐), `runner.ts`(제한 툴셋 워커, `delegate_task`가 Hermes 위임 가능), `budget.ts`(wall-clock/step/동시성), `surface.ts` + `GET /api/session/:id/events`(SSE). `web/src/agent/surface.ts`가 완료를 받아 barge-in 게이트 후 `session.sendMessage` 주입 or UI.
6. **`server/src/store/session-db.ts`** — better-sqlite3, `PRAGMA journal_mode=WAL`, sessions+messages+FTS5. `/api/session`이 UUID `sessionId` 발급+반환. `flush-queue.ts` ring-buffer + `setInterval(~3s)`. `POST /api/session/:id/append`(fire-and-forget).
7. **`web/src/agent/session.ts` 토큰 리프레시** — `expires_at` 추적, ~80% TTL에서 `/api/session` re-mint + seamless 재적용, 무음 중에만.
8. **`server/src/errors/classify.ts` + `server/src/config.ts` + `server/src/security/command-guard.ts`** — classify enum + `RuachConfigSchema`(fail-open) + HARDLINE 즉시 deny. `session-state.ts`에 `activeSessionCount` + per-session 정책 seed.

각 단계 후 `npm run check`(또는 동등) → 변경 누적 시 `feature:code-review` 스킬. M2는 라이브 경로를 절대 블로킹하지 않는다는 단일 인수 테스트(fast 툴 latency 예산 assert)를 6단계 직후 추가.

---

## 7. 리스크 · 오픈 퀘스천

### 높은 리스크 (실시간 임계)
- **ek_ 토큰 미드콜 만료 → 오디오 스트림 사망**. 20분 통화 > 600s TTL. proactive 리프레시가 WebRTC를 teardown하지 않고 재적용해야 함. 무음 중 리프레시 강제. — *M2의 단일 최대 리스크.*
- **비동기 위임이 실수로 blocking이 되면** 음성 턴이 멈춘다(dead air). `execute()`/잡 enqueue는 ~100ms 내 반환. 서버 enqueue 엔드포인트 하드 타임아웃 + 리뷰 규칙으로 강제.
- **결과 주입이 사용자 발화 위로 talk-over**. surfacing은 idle(active turn 없음)에서만, 아니면 hold or UI fallback. barge-in은 모델 네이티브 — 우리는 싸우지 않는다.
- **mint-time 조립이 느린 I/O를 하면 통화 connect 지연**. 모든 source 병렬 + 하드 타임아웃 + persona-only fail-open. mint time 계측으로 회귀 가시화.
- **위험 명령 동기 승인 프롬프트는 통화를 동결**. HARDLINE=즉시 deny(턴-세이프), DANGEROUS=async+out-of-band 승인. interactive는 audio 경로에 절대 없음.

### 낮은~중간 리스크
- **스킬 인덱스/메모리 snapshot 비대화** → 매 오디오 토큰 비용 + first-token 지연. 인덱스는 name+1줄, 하드 char 캡, body는 절대 inline 안 함.
- **큐레이터가 라이브 세션 중 라이브러리 mutate** → frozen index가 moved 스킬 참조. `activeSessionCount===0` 게이트 + `.archive/` resolver fallback이 race 봉쇄.
- **DiscordVoiceChannel(M4)이 Node에 audio 경로 보유** → backpressure/resampling/event-loop 블로킹. 모든 느린 작업을 AsyncJobBridge로 빼냄.

### 오픈 퀘스천 (도메인 결정 필요 — 사용자 확인)
1. **Hermes 위임 백엔드의 결합 형태** — `jobs/runner.ts`가 Hermes를 (a) 로컬 subprocess, (b) HTTP RPC, (c) 큐 메시지 중 무엇으로 호출? transport·인증·배포가 갈림. M2에서 잡 인터페이스만 정의하고 첫 백엔드는 plain TS로, Hermes 위임은 M2 후반/M3에 실제 백엔드와 함께 확정 권고.
2. **메모리 provider 1순위 구현** — built-in SQLite+FTS5(자체) vs 외부(Mem0/Honcho) 우선순위. 인터페이스는 provider-agnostic이지만 첫 구현 선택이 M3 일정 좌우.
3. **트랜스크립트/trajectory 영속의 프라이버시 기본값** — `RUACH_SAVE_TRAJECTORIES` 기본 on/off, redaction 보존 정책, 음성 원문 보관 기간. 개인 음성 컴패니언이라 도메인 민감.
4. **세션 종료 판정** — 명시적 hang-up vs inactivity 타임아웃 임계(N초). lineage resume과 off-call compaction 트리거가 여기에 묶임.
5. **CJK trigram 저장 비용** — 한국어 substring 검색 vs ~2–3x 저장 증가 트레이드오프. 토이 규모에선 수용 가능하나 채널 확장 시 재검토.
