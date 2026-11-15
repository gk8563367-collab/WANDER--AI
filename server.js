const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const KEY = process.env.GROQ_API_KEY;
const MODEL = "openai/gpt-oss-120b";
const VISION_MODEL = "qwen/qwen3.8-27b"; // used when a photo is attached

const DAILY_LIMIT = 1000; // chat messages per person per day
const IMAGE_LIMIT = 25;   // images per person per day

const usage = new Map();
const imgUsage = new Map();
const today = () => new Date().toISOString().slice(0, 10);
const clientIp = req => (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

async function makeImage(prompt) {
  const url = "https://image.pollinations.ai/prompt/" + encodeURIComponent(prompt) +
    "?width=768&height=768&model=flux&nologo=true&seed=" + Math.floor(Math.random() * 1000000);
  for (let i = 0; i < 2; i++) {
    const r = await fetch(url);
    const type = r.headers.get("content-type") || "";
    if (r.ok && type.startsWith("image/")) {
      const buf = Buffer.from(await r.arrayBuffer());
      return "data:" + type.split(";")[0] + ";base64," + buf.toString("base64");
    }
    if (r.status === 429 && i === 0) { await sleep(16000); continue; }
    break;
  }
  return null;
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
        const { messages } = JSON.parse(body);
        if (!Array.isArray(messages)) throw new Error("bad request");
        let images = 0;
        messages.forEach(m => {
          if (Array.isArray(m.content)) m.content.forEach(p => { if (p.type === "image_url") images++; });
        });
        if (images > 3) return sendJson(res, 400, { error: { message: "Too many photos in one message." } });
        const payload = { model: images ? VISION_MODEL : MODEL, messages };
        if (images) payload.reasoning_format = "hidden";
        entry.n += 1;
        usage.set(id, entry);
        const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + KEY },
          body: JSON.stringify(payload)
        });
        const data = await r.json();
        sendJson(res, r.status, data);
      } catch (e) {
        sendJson(res, 500, { error: { message: "Server error" } });
      }
    }, 4000000);
    return;
  }

  if (req.method === "POST" && req.url === "/api/image") {
    const id = clientIp(req);
    let e = imgUsage.get(id);
    if (!e || e.day !== today()) e = { day: today(), n: 0 };
    if (e.n >= IMAGE_LIMIT) {
      return sendJson(res, 429, { error: { message: "You have reached today's image limit (" + IMAGE_LIMIT + "). Please come back tomorrow." } });
    }
    readBody(req, async body => {
      try {
        const p = String(JSON.parse(body).prompt || "").trim().slice(0, 500);
        if (!p) return sendJson(res, 400, { error: { message: "Please describe the image." } });
        const img = await makeImage(p);
        if (!img) return sendJson(res, 503, { error: { message: "The image service is busy. Please try again in a moment." } });
        e.n += 1;
        imgUsage.set(id, e);
        sendJson(res, 200, { image: img });
      } catch (err) {
        sendJson(res, 500, { error: { message: "Server error" } });
      }
    });
    return;
  }

  fs.readFile(path.join(__dirname, "index.html"), (err, html) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });
}).listen(PORT, () => console.log("Wander AI running on " + PORT));
