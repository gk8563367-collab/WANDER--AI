const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const KEY = process.env.GROQ_API_KEY;
const MODEL = "openai/gpt-oss-120b";

const DAILY_LIMIT = 1000; // messages per person per day

const usage = new Map();
const today = () => new Date().toISOString().slice(0, 10);
const clientIp = req => (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/chat") {
    const id = clientIp(req);

    let entry = usage.get(id);
    if (!entry || entry.day !== today()) entry = { day: today(), n: 0 };
    if (entry.n >= DAILY_LIMIT) {
      return sendJson(res, 429, { error: { message: "You have reached today's message limit. Please come back tomorrow." } });
    }

    let body = "";
    req.on("data", c => {
      body += c;
      if (body.length > 500000) req.destroy();
    });
    req.on("end", async () => {
      try {
        const { messages } = JSON.parse(body);
        entry.n += 1;
        usage.set(id, entry);
        const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + KEY },
          body: JSON.stringify({ model: MODEL, messages })
        });
        const data = await r.json();
        sendJson(res, r.status, data);
      } catch (e) {
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
