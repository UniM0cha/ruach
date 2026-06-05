import express from "express";
import cors from "cors";
import { appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import { buildSessionConfig } from "./session-config.js";

// cwd와 무관하게 프로젝트 루트의 .env를 읽는다.
// (npm workspace 스크립트는 cwd를 server/로 바꾸므로 dotenv 자동로딩에 의존하면 안 됨)
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
loadEnv({ path: resolve(rootDir, ".env") });

const PORT = Number(process.env.PORT ?? 8787);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REALTIME_MODEL = process.env.RUACH_REALTIME_MODEL ?? "gpt-realtime-2";
const TOKEN_TTL = Number(process.env.RUACH_TOKEN_TTL_SECONDS ?? 600);

if (!OPENAI_API_KEY) {
  console.error("[ruach] OPENAI_API_KEY가 없습니다. .env를 확인하세요.");
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json());

/**
 * 브라우저가 WebRTC 직결에 쓸 단기 토큰(ephemeral client secret)을 발급한다.
 * 메인 API 키는 절대 브라우저로 내려가지 않는다.
 */
app.post("/api/session", async (_req, res) => {
  try {
    const session = await buildSessionConfig(REALTIME_MODEL);
    const upstream = await fetch(
      "https://api.openai.com/v1/realtime/client_secrets",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          expires_after: { anchor: "created_at", seconds: TOKEN_TTL },
          session,
        }),
      },
    );

    if (!upstream.ok) {
      const detail = await upstream.text();
      console.error("[ruach] client_secrets 발급 실패:", upstream.status, detail);
      return res.status(502).json({ error: "token_mint_failed", detail });
    }

    const data = (await upstream.json()) as {
      value?: string;
      client_secret?: string | { value?: string };
      expires_at?: number;
    };
    // 현재 API는 토큰을 최상위 `value`로 반환한다. 구버전 `client_secret`(문자열/객체)도 방어적으로 처리.
    const token =
      data.value ??
      (typeof data.client_secret === "string"
        ? data.client_secret
        : data.client_secret?.value);

    if (!token) {
      console.error("[ruach] 응답에 client_secret이 없습니다:", data);
      return res.status(502).json({ error: "no_client_secret" });
    }

    // 페르소나/음성도 함께 내려 클라이언트의 RealtimeAgent가 같은 설정으로 뜨게 한다.
    res.json({
      client_secret: token,
      expires_at: data.expires_at,
      model: REALTIME_MODEL,
      instructions: session.instructions,
      voice: session.audio.output.voice,
    });
  } catch (err) {
    console.error("[ruach] /api/session 오류:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

/**
 * 서버측 행동(agent action)의 최소 데모: 대화 중 "기억해줘" → 브라우저 tool이 여기로
 * POST → 서버가 notes.jsonl에 영속화. Hermes 스타일 "툴은 서버에서 실행" 경로의 씨앗.
 */
app.post("/api/remember", async (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text) return res.status(400).json({ error: "empty_text" });
  try {
    const line = JSON.stringify({ text, ts: new Date().toISOString() }) + "\n";
    await appendFile(resolve(rootDir, "notes.jsonl"), line);
    res.json({ ok: true });
  } catch (err) {
    console.error("[ruach] /api/remember 쓰기 실패:", err);
    res.status(500).json({ error: "write_failed" });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, model: REALTIME_MODEL });
});

app.listen(PORT, () => {
  console.log(`[ruach] server on http://localhost:${PORT}  (model: ${REALTIME_MODEL})`);
});
