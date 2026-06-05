import { RealtimeAgent, RealtimeSession, tool } from "@openai/agents/realtime";
import { z } from "zod";

// --- DOM ---
const talkBtn = document.getElementById("talk") as HTMLButtonElement;
const labelEl = talkBtn.querySelector(".label") as HTMLElement;
const statusEl = document.getElementById("status") as HTMLElement;
const transcriptEl = document.getElementById("transcript") as HTMLElement;

let session: RealtimeSession | null = null;
let live = false;

type UiState = "idle" | "connecting" | "live";
function setState(state: UiState) {
  talkBtn.dataset.state = state;
  labelEl.textContent =
    state === "live" ? "통화 종료" : state === "connecting" ? "연결 중…" : "통화 시작";
}
function setStatus(message: string) {
  statusEl.textContent = message;
}

// --- 대화 중 실행되는 툴 (agent action) ---
const getCurrentTime = tool({
  name: "get_current_time",
  description:
    "Get the current local date and time. Use when the user asks what time or date it is.",
  parameters: z.object({}),
  execute: async () =>
    new Date().toLocaleString("ko-KR", { dateStyle: "full", timeStyle: "short" }),
});

const remember = tool({
  name: "remember",
  description:
    "Save a short note for the user to recall later. Use when they ask you to remember or note something.",
  parameters: z.object({
    text: z.string().describe("The note to remember, in the user's own words."),
  }),
  execute: async ({ text }) => {
    const r = await fetch("/api/remember", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    return r.ok ? "기억해 뒀어요." : "메모를 저장하지 못했어요.";
  },
});

// --- 트랜스크립트 렌더 ---
interface ContentPart {
  text?: string;
  transcript?: string | null;
}
interface HistoryItem {
  type: string;
  role?: string;
  content?: ContentPart[];
}

function renderHistory(history: HistoryItem[]) {
  transcriptEl.replaceChildren();
  for (const item of history) {
    if (item.type !== "message" || item.role === "system") continue;
    const text = (item.content ?? [])
      .map((p) => p.text ?? p.transcript ?? "")
      .join(" ")
      .trim();
    if (!text) continue;

    const line = document.createElement("div");
    line.className = `line ${item.role === "user" ? "user" : "ruach"}`;
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = item.role === "user" ? "나" : "Ruach";
    line.append(who, document.createTextNode(text));
    transcriptEl.append(line);
  }
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

// --- 연결 / 종료 ---
async function start() {
  setState("connecting");
  setStatus("토큰 발급 중…");
  try {
    const res = await fetch("/api/session", { method: "POST" });
    if (!res.ok) throw new Error(`session ${res.status}`);
    const { client_secret, model, instructions, voice } = await res.json();

    const agent = new RealtimeAgent({
      name: "Ruach",
      instructions,
      voice,
      tools: [getCurrentTime, remember],
    });
    session = new RealtimeSession(agent, { model });

    session.on("history_updated", (history) =>
      renderHistory(history as unknown as HistoryItem[]),
    );
    session.on("audio_interrupted", () => setStatus("(끼어듦) 듣고 있어요…"));
    session.on("error", (err) => {
      console.error("[ruach] session error:", err);
      setStatus("오류가 발생했어요. 콘솔을 확인하세요.");
    });

    setStatus("연결 중…");
    await session.connect({ apiKey: client_secret, model });

    live = true;
    setState("live");
    setStatus("듣고 있어요. 편하게 말해보세요.");
  } catch (err) {
    console.error("[ruach] 연결 실패:", err);
    session = null;
    setState("idle");
    setStatus("연결 실패 — 백엔드(npm run dev:server)와 .env 키를 확인하세요.");
  }
}

function stop() {
  session?.close();
  session = null;
  live = false;
  setState("idle");
  setStatus("통화 종료됨");
}

talkBtn.addEventListener("click", () => (live ? stop() : start()));
setState("idle");
