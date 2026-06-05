import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// 프로젝트 루트의 SOUL.md = Ruach의 인격. 매 호출마다 새로 읽어 즉시 반영(재시작 불필요).
const SOUL_PATH = resolve(here, "../../SOUL.md");

const FALLBACK =
  "You are Ruach, a warm, present voice companion. Speak Korean (존댓말) by " +
  "default, naturally and concisely, like a real person on a call.";

/** SOUL.md를 읽어 Realtime `instructions`로 쓸 페르소나 텍스트를 반환한다. */
export async function loadPersona(): Promise<string> {
  try {
    const raw = await readFile(SOUL_PATH, "utf8");
    const body = stripFrontmatter(raw).trim();
    return body || FALLBACK;
  } catch {
    return FALLBACK;
  }
}

/** 선두의 HTML 주석 헤더와 YAML frontmatter(---) 블록을 제거한다. */
function stripFrontmatter(md: string): string {
  let s = md.replace(/^\s*<!--[\s\S]*?-->\s*/, "");
  if (s.startsWith("---")) {
    const end = s.indexOf("\n---", 3);
    if (end !== -1) {
      const after = s.indexOf("\n", end + 1);
      if (after !== -1) s = s.slice(after + 1);
    }
  }
  return s;
}
