import http from "node:http";

const port = Number(process.env.PORT || 8787);
const apiKey = process.env.DOUBAO_API_KEY || "";
const modelName = process.env.DOUBAO_MODEL || "doubao-seed-2-0-mini-260215";
const doubaoEndpoint = process.env.DOUBAO_ENDPOINT || "https://ark.cn-beijing.volces.com/api/v3/responses";
const promptStyles = ["standard", "compact"];
const upstreamTimeoutMs = Number(process.env.DOUBAO_TIMEOUT_MS || 45000);

function sendJSON(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.end(JSON.stringify(payload));
}

function buildPrompt(userInput, style = "standard", dayContext = null) {
  const extraInstruction =
    style === "compact"
      ? `

补充限制：
11. 如果内容较多，请优先缩短 detail 到 12-20 个字
12. address 尽量控制在 12 个字以内
13. 每天景点数量按游览和路程时长合理安排，通常 1-4 个`
      : style === "strictCompact"
        ? `

严格压缩模式：
11. 必须优先保证 JSON 完整，宁可内容更短
12. detail 尽量控制在 10-16 个字
13. address 尽量控制在 8-10 个字
14. 每天景点数量按游览和路程时长合理安排，通常 1-3 个
15. 如果输出即将过长，请减少描述字数，不要减少结尾括号`
        : "";

  const dayInstruction = dayContext
    ? `

本次只生成其中一天：
- 只生成第 ${dayContext.dayNumber} 天
- 总天数是 ${dayContext.totalDays} 天
- 这一天要和整趟旅行节奏一致，但只输出这一天的数据
- 返回 JSON 时，days 数组里只能有 1 个 day 对象
- 这个 day 的 title 必须以 "Day ${dayContext.dayNumber} ·" 开头`
    : "";

  return `你是专业旅行规划师。

请为用户生成旅行计划，并严格按照以下 JSON 格式输出，不要输出任何额外文字：

{
  "days": [
    {
      "title": "Day 1 · 标题",
      "items": [
        {
          "title": "景点或地点名称",
          "detail": "该景点的游玩亮点或体验描述",
          "address": "景点地址或区域",
          "transferDuration": "到下一个景点约30分钟",
          "transferDistance": "约12公里"
        }
      ]
    }
  ]
}

要求：
1. 使用中文
2. 按天安排
3. 每天安排的景点数量要根据景点游览时长和景点之间路程时长动态决定，可以是 1-5 个；不要为了凑数硬排满，也不要明显过空
4. 不要输出具体几点几分，不需要 time 字段
5. 每个景点都要有真实具体的游玩描述，但 detail 尽量控制在 18-30 个字，避免冗长
6. 除了当天最后一个景点外，其余景点都要补充到下一个景点的路程和用时
7. 如果是步行就写步行时间，如果较远可写打车或地铁的大致时间；安排时要考虑这些路程时间是否合理
8. address 只写简洁区域或简短地址，不要过长
9. JSON 必须完整闭合，必须以完整的 } 结束；如果内容较多，请优先缩短 detail 和 address，也不要截断 JSON
10. 只输出 JSON，不要输出任何解释文字
${extraInstruction}
${dayInstruction}

用户需求：
${userInput}`;
}

function extractText(json) {
  if (typeof json?.output_text === "string" && json.output_text.trim()) {
    return json.output_text;
  }

  if (Array.isArray(json?.output)) {
    for (const item of json.output) {
      if (!Array.isArray(item?.content)) continue;
      for (const block of item.content) {
        if (typeof block?.text === "string" && block.text.trim()) {
          return block.text;
        }
      }
    }
  }

  if (Array.isArray(json?.choices)) {
    const content = json.choices[0]?.message?.content;
    if (typeof content === "string" && content.trim()) {
      return content;
    }
  }

  return "";
}

async function readJSONBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const rawBody = Buffer.concat(chunks).toString("utf8");
  return rawBody ? JSON.parse(rawBody) : {};
}

function sanitizedJSONString(raw) {
  const extracted = extractJSONObject(raw) ?? raw;
  return removeTrailingCommas(extracted);
}

function extractJSONObject(raw) {
  const start = raw.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let isInsideString = false;
  let isEscaping = false;

  for (let index = start; index < raw.length; index += 1) {
    const character = raw[index];

    if (isEscaping) {
      isEscaping = false;
      continue;
    }

    if (character === "\\") {
      isEscaping = true;
      continue;
    }

    if (character === "\"") {
      isInsideString = !isInsideString;
      continue;
    }

    if (isInsideString) continue;

    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, index + 1);
      }
    }
  }

  return null;
}

function removeTrailingCommas(raw) {
  let result = "";
  let isInsideString = false;
  let isEscaping = false;

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];

    if (isEscaping) {
      result += character;
      isEscaping = false;
      continue;
    }

    if (character === "\\") {
      result += character;
      isEscaping = true;
      continue;
    }

    if (character === "\"") {
      isInsideString = !isInsideString;
      result += character;
      continue;
    }

    if (!isInsideString && character === ",") {
      let lookahead = index + 1;
      while (lookahead < raw.length && /\s/.test(raw[lookahead])) {
        lookahead += 1;
      }
      if (lookahead < raw.length && (raw[lookahead] === "}" || raw[lookahead] === "]")) {
        continue;
      }
    }

    result += character;
  }

  return result;
}

function isCompleteTripJSON(raw) {
  const sanitized = sanitizedJSONString(
    raw.replace(/```json/g, "").replace(/```/g, "").trim()
  );

  if (!sanitized.startsWith("{") || !sanitized.endsWith("}")) {
    return false;
  }

  try {
    const parsed = JSON.parse(sanitized);
    return Array.isArray(parsed?.days) && parsed.days.length > 0;
  } catch {
    return false;
  }
}

function extractTotalDays(userInput) {
  const match = userInput.match(/天数：\s*(\d+)\s*天/);
  const parsed = match ? Number(match[1]) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function parseTripDays(raw) {
  const sanitized = sanitizedJSONString(
    raw.replace(/```json/g, "").replace(/```/g, "").trim()
  );
  const parsed = JSON.parse(sanitized);
  if (!Array.isArray(parsed?.days)) {
    throw new Error("Missing days array.");
  }
  return parsed.days;
}

function isValidSingleDayResult(raw, dayNumber) {
  if (!isCompleteTripJSON(raw)) {
    return false;
  }

  try {
    const days = parseTripDays(raw);
    if (days.length !== 1) return false;
    const title = typeof days[0]?.title === "string" ? days[0].title : "";
    return title.startsWith(`Day ${dayNumber}`);
  } catch {
    return false;
  }
}

async function requestTripPlan(userInput, style, dayContext = null) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), upstreamTimeoutMs);

  try {
    const upstreamResponse = await fetch(doubaoEndpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelName,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: buildPrompt(userInput, style, dayContext),
              },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });

    const rawText = await upstreamResponse.text();
    return { upstreamResponse, rawText };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return {
        upstreamResponse: { ok: false, status: 504 },
        rawText: `Upstream request timed out after ${upstreamTimeoutMs}ms.`,
      };
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function generateSingleDay(userInput, dayNumber, totalDays) {
  let lastRawText = "";
  let lastResult = "";

  for (const style of promptStyles) {
    const { upstreamResponse, rawText } = await requestTripPlan(
      userInput,
      style,
      { dayNumber, totalDays }
    );
    lastRawText = rawText;

    if (!upstreamResponse.ok) {
      if (style === promptStyles[promptStyles.length - 1]) {
        throw new Error(rawText || `Failed to generate day ${dayNumber}.`);
      }
      continue;
    }

    let upstreamJSON;
    try {
      upstreamJSON = JSON.parse(rawText);
    } catch {
      if (style === promptStyles[promptStyles.length - 1]) {
        throw new Error(`Upstream returned non-JSON response for day ${dayNumber}.`);
      }
      continue;
    }

    const result = extractText(upstreamJSON)
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();
    lastResult = result;

    if (result && isValidSingleDayResult(result, dayNumber)) {
      return parseTripDays(result)[0];
    }
  }

  if (!lastResult) {
    throw new Error(`Day ${dayNumber} returned empty result. Raw: ${lastRawText}`);
  }

  throw new Error(`Day ${dayNumber} returned incomplete JSON after retries. Raw: ${lastResult}`);
}

async function handleGenerateTrip(req, res) {
  if (!apiKey) {
    sendJSON(res, 500, { error: "Server missing DOUBAO_API_KEY." });
    return;
  }

  let body;
  try {
    body = await readJSONBody(req);
  } catch {
    sendJSON(res, 400, { error: "Invalid JSON body." });
    return;
  }

  const userInput = typeof body.userInput === "string" ? body.userInput.trim() : "";
  if (!userInput) {
    sendJSON(res, 400, { error: "userInput is required." });
    return;
  }

  const totalDays = extractTotalDays(userInput);

  try {
    const days = [];
    for (let dayNumber = 1; dayNumber <= totalDays; dayNumber += 1) {
      const day = await generateSingleDay(userInput, dayNumber, totalDays);
      days.push(day);
    }

    sendJSON(res, 200, {
      result: JSON.stringify({ days }),
    });
  } catch (error) {
    sendJSON(res, 502, {
      error: error instanceof Error ? error.message : "Failed to generate complete itinerary.",
    });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      sendJSON(res, 204, {});
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      sendJSON(res, 200, {
        ok: true,
        model: modelName,
        hasApiKey: Boolean(apiKey),
      });
      return;
    }

    if (req.method === "POST" && req.url === "/generate-trip") {
      await handleGenerateTrip(req, res);
      return;
    }

    sendJSON(res, 404, { error: "Not found." });
  } catch (error) {
    sendJSON(res, 500, { error: error instanceof Error ? error.message : "Internal server error." });
  }
});

server.listen(port, () => {
  console.log(`Trip backend listening on http://0.0.0.0:${port}`);
});
