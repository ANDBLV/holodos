// Vercel Serverless Function: безопасный прокси к AI-провайдеру.
// Поддерживает трёх провайдеров — используется тот, чей ключ задан:
//   ANTHROPIC_API_KEY  → Claude (Anthropic)
//   GEMINI_API_KEY     → Gemini (Google, есть бесплатный тариф)
//   OPENROUTER_API_KEY → OpenRouter (агрегатор, есть бесплатные модели)
// Ключ хранится в переменных окружения и никогда не попадает в браузер.
// Фронтенд всегда шлёт запросы в формате Anthropic; для остальных
// провайдеров функция сама переводит формат туда и обратно.

const MAX_TOKENS_LIMIT = 4000;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Используйте POST" });
  }

  const { messages, max_tokens } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "Ожидается поле messages" });
  }
  const maxTokens = Math.min(Number(max_tokens) || 1500, MAX_TOKENS_LIMIT);

  try {
    if (process.env.ANTHROPIC_API_KEY) {
      return await callAnthropic(res, messages, maxTokens);
    }
    if (process.env.GEMINI_API_KEY) {
      return await callGemini(res, messages, maxTokens);
    }
    if (process.env.OPENROUTER_API_KEY) {
      return await callOpenRouter(res, messages, maxTokens);
    }
    return res.status(500).json({
      error:
        "Не задан ключ провайдера. Добавьте ANTHROPIC_API_KEY, GEMINI_API_KEY или OPENROUTER_API_KEY в Environment Variables проекта на Vercel и сделайте Redeploy.",
    });
  } catch (err) {
    console.error("AI proxy error:", err);
    return res.status(502).json({ error: "Не удалось связаться с AI-провайдером" });
  }
}

// ── Anthropic (Claude) ──────────────────────────────────────

async function callAnthropic(res, messages, maxTokens) {
  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
      max_tokens: maxTokens,
      messages,
    }),
  });
  const data = await upstream.json();
  if (!upstream.ok) console.error("Anthropic error:", JSON.stringify(data));
  return res.status(upstream.status).json(data);
}

// ── Google Gemini ───────────────────────────────────────────

function anthropicToGemini(messages) {
  return messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts:
      typeof m.content === "string"
        ? [{ text: m.content }]
        : m.content.map((block) => {
            if (block.type === "image") {
              return {
                inline_data: {
                  mime_type: block.source.media_type,
                  data: block.source.data,
                },
              };
            }
            return { text: block.text || "" };
          }),
  }));
}

async function callGemini(res, messages, maxTokens) {
  const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const upstream = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": process.env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      contents: anthropicToGemini(messages),
      generationConfig: { maxOutputTokens: maxTokens },
    }),
  });
  const data = await upstream.json();
  if (!upstream.ok) {
    console.error("Gemini error:", JSON.stringify(data));
    return res
      .status(upstream.status)
      .json({ error: data?.error?.message || "Ошибка Gemini API" });
  }

  // Переводим ответ в формат Anthropic, который ждёт фронтенд
  const raw = (data.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || "")
    .join("");
  return res.status(200).json({ content: [{ type: "text", text: extractJson(raw) }] });
}

// ── OpenRouter (агрегатор, есть бесплатные модели ":free") ──

function anthropicToOpenAI(messages) {
  return messages.map((m) => ({
    role: m.role,
    content:
      typeof m.content === "string"
        ? m.content
        : m.content.map((block) => {
            if (block.type === "image") {
              return {
                type: "image_url",
                image_url: {
                  url: `data:${block.source.media_type};base64,${block.source.data}`,
                },
              };
            }
            return { type: "text", text: block.text || "" };
          }),
  }));
}

// Reasoning-модели любят присылать размышления и текст вокруг JSON.
// Вырезаем из ответа только сам JSON-объект, чтобы фронтенд смог его разобрать.
function extractJson(text) {
  if (!text) return text;
  let t = String(text)
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```json|```/g, "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start !== -1 && end > start) t = t.slice(start, end + 1);
  return t.trim();
}

async function callOpenRouter(res, messages, maxTokens) {
  const model =
    process.env.OPENROUTER_MODEL || "openrouter/free";

  const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: anthropicToOpenAI(messages),
      // Просим не тратить время на "размышления" — нам нужен только JSON
      reasoning: { enabled: false },
    }),
  });
  const data = await upstream.json();
  if (!upstream.ok || data.error) {
    console.error("OpenRouter error:", JSON.stringify(data));
    return res
      .status(upstream.ok ? 502 : upstream.status)
      .json({ error: data?.error?.message || "Ошибка OpenRouter API" });
  }

  // Переводим ответ в формат Anthropic, который ждёт фронтенд,
  // предварительно вычистив его до чистого JSON
  const raw = data.choices?.[0]?.message?.content || "";
  return res.status(200).json({ content: [{ type: "text", text: extractJson(raw) }] });
}
