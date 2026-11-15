const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const KEY = process.env.GROQ_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY; // for creating and editing images
const MODEL = "openai/gpt-oss-120b";
const VISION_MODEL = "qwen/qwen3.8-27b"; // used when a photo is attached
const IMAGE_MODEL = "gemini-2.5-flash-image";

const DAILY_LIMIT = 1000; // chat messages per person per day
const IMAGE_LIMIT = 25;   // images per person per day

const usage = new Map();
const imgUsage = new Map();
const today = () => new Date().toISOString().slice(0, 10);
const clientIp = req => (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function readBody(req, cb, max) {
  let body = "";
  req.on("data", c => {
    body += c;
    if (body.length > (max || 500000)) req.destroy();
  });
  req.on("end", () => cb(body));
}

const TOOL_NOTE = "You can create new images and edit the user's photo with the tools you have. When the user asks for that (in any language, including Tamil), call the right tool instead of saying you cannot. For edits, write the instruction in English and say to keep the person's face and everything else unchanged.";

const CREATE_TOOL = { type: "function", function: {
  name: "create_image",
  description: "Create a brand new image from a text description. Use when the user asks you to draw, generate or create a picture.",
  parameters: { type: "object", properties: { prompt: { type: "string", description: "Detailed English description of the image" } }, required: ["prompt"] }
} };

const EDIT_TOOL = { type: "function", function: {
  name: "edit_photo",
  description: "Edit the photo the user attached or the last image in the chat: add, remove or change things, background, style or colors, keeping the person recognizable. Use when the user asks to modify that photo.",
  parameters: { type: "object", properties: { instruction: { type: "string", description: "Clear English edit instruction, for example: Add a red hat. Keep the face and everything else exactly the same." } }, required: ["instruction"] }
} };

async function geminiImage(prompt, photo) {
  try {
    const parts = [{ text: prompt }];
    if (photo) {
      const m = /^data:(image\/[\w+.-]+);base64,(.+)$/.exec(photo);
      if (!m) return { error: "Invalid photo." };
      parts.push({ inline_data: { mime_type: m[1], data: m[2] } });
    }
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + IMAGE_MODEL + ":generateContent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
      body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseModalities: ["TEXT", "IMAGE"] } })
    });
    const data = await r.json().catch(() => ({}));
    const cand = data && data.candidates && data.candidates[0];
    const ps = (cand && cand.content && cand.content.parts) || [];
    for (const p of ps) {
      const d = p.inlineData || p.inline_data;
      if (d && d.data) return { image: "data:" + (d.mimeType || d.mime_type || "image/png") + ";base64," + d.data };
    }
    const err = data && data.error && data.error.message;
    const txt = ps.map(p => p.text).filter(Boolean).join(" ");
    return { error: String(err || txt || "No image came back (code " + r.status + ").").slice(0, 200) };
  } catch (e) {
    return { error: "Could not reach the image service." };
  }
}

async function callGroq(payload) {
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + KEY },
    body: JSON.stringify(payload)
  });
  const data = await r.json().catch(() => ({}));
  return { r, data };
}

http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/chat") {
    const id = clientIp(req);
    let entry = usage.get(id);
    if (!entry || entry.day !== today()) entry = { day: today(), n: 0 };
    if (entry.n >= DAILY_LIMIT) {
      return sendJson(res, 429, { error: { message: "You have reached today's message limit. Please come back tomorrow." } });
    }
    readBody(req, async body => {
      try {
        const { messages, photo } = JSON.parse(body);
        if (!Array.isArray(messages)) throw new Error("bad request");
        let images = 0;
        messages.forEach(m => {
          if (Array.isArray(m.content)) m.content.forEach(p => { if (p.type === "image_url") images++; });
        });
        if (images > 3) return sendJson(res, 400, { error: { message: "Too many photos in one message." } });

        const usable = typeof photo === "string" && photo.startsWith("data:image/") && photo.length < 3000000;
        const tools = [];
        if (GEMINI_KEY) { tools.push(CREATE_TOOL); if (usable) tools.push(EDIT_TOOL); }

        const msgs = messages.map(m => Object.assign({}, m));
        if (tools.length && msgs[0] && msgs[0].role === "system" && typeof msgs[0].content === "string") {
          msgs[0].content += " " + TOOL_NOTE;
        }
        const base = { model: images ? VISION_MODEL : MODEL, messages: msgs };
        if (images) base.reasoning_format = "hidden";

        entry.n += 1;
        usage.set(id, entry);

        let out = await callGroq(tools.length ? Object.assign({}, base, { tools, tool_choice: "auto" }) : base);
        if (!out.r.ok && tools.length) out = await callGroq(base);

        const msg = out.data && out.data.choices && out.data.choices[0] && out.data.choices[0].message;
        const call = msg && msg.tool_calls && msg.tool_calls[0];
        if (call && call.function) {
          let args = {};
          try { args = JSON.parse(call.function.arguments || "{}"); } catch (e) {}
          const isEdit = call.function.name === "edit_photo";
          const text = String((isEdit ? args.instruction : args.prompt) || "").slice(0, 800);
          let ie = imgUsage.get(id);
          if (!ie || ie.day !== today()) ie = { day: today(), n: 0 };
          let reply;
          if (ie.n >= IMAGE_LIMIT) {
            reply = "You have reached today's image limit (" + IMAGE_LIMIT + "). Please come back tomorrow.";
          } else if (!text) {
            reply = "Please tell me what image to make.";
          } else {
            const g = await geminiImage(text, isEdit ? photo : null);
            if (g.image) {
              ie.n += 1;
              imgUsage.set(id, ie);
              return sendJson(res, 200, { image: g.image, model: out.data.model });
            }
            reply = "Sorry, I could not make that image. " + g.error;
          }
          return sendJson(res, 200, { model: out.data.model, choices: [{ message: { role: "assistant", content: reply } }] });
        }
        sendJson(res, out.r.status, out.data);
      } catch (e) {
        sendJson(res, 500, { error: { message: "Server error" } });
      }
    }, 4000000);
    return;
  }

  fs.readFile(path.join(__dirname, "index.html"), (err, html) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });
}).listen(PORT, () => console.log("Wander AI running on " + PORT));
