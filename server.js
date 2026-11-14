const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const KEY = process.env.GROQ_API_KEY;
const MODEL = "llama-3.3-70b-versatile";

http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/api/chat") {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", async () => {
      try {
        const { messages } = JSON.parse(body);
        const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + KEY },
          body: JSON.stringify({ model: MODEL, messages })
        });
        const data = await r.json();
        res.writeHead(r.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Server error" } }));
      }
    });
    return;
  }
  fs.readFile(path.join(__dirname, "index.html"), (err, html) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
  });
}).listen(PORT, () => console.log("Wander AI running on " + PORT));
