import http from "node:http";

const port = Number(process.env.PORT || 8787);
const apiKey = process.env.DOUBAO_API_KEY || "";
const modelName = process.env.DOUBAO_MODEL || "doubao-seed-2-0-mini-260215";
const doubaoEndpoint = process.env.DOUBAO_ENDPOINT || "https://ark.cn-beijing.volces.com/api/v3/responses";

function sendJSON(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.end(JSON.stringify(payload));
}

function buildPrompt(userInput) {
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
3. 每天只安排 3-5 个核心景点或地点，不要写酒店办理入住、休息、出发、返回、抵达机场车站等内容
4. 不要输出具体几点几分，不需要 time 字段
5. 每个景点都要有真实具体的游玩描述
6. 除了当天最后一个景点外，其余景点都要补充到下一个景点的路程和用时
7. 如果是步行就写步行时间，如果较远可写打车或地铁的大致时间
8. 只输出 JSON，不要输出任何解释文字

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
              text: buildPrompt(userInput),
            },
          ],
        },
      ],
    }),
  });

  const rawText = await upstreamResponse.text();
  if (!upstreamResponse.ok) {
    sendJSON(res, upstreamResponse.status, { error: rawText || "Upstream request failed." });
    return;
  }

  let upstreamJSON;
  try {
    upstreamJSON = JSON.parse(rawText);
  } catch {
    sendJSON(res, 502, { error: "Upstream returned non-JSON response.", raw: rawText });
    return;
  }

  const result = extractText(upstreamJSON)
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .trim();

  if (!result) {
    sendJSON(res, 502, { error: "Upstream returned empty result.", raw: rawText });
    return;
  }

  sendJSON(res, 200, { result });
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
