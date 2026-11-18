import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const nonce = `KCODE-${randomUUID().slice(0, 12)}`;
const expectedText = `${nonce} 中文🌟\n第二行`;
const submitted = [];
let maximumScroll = 0;

const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>KCode CUA Browser Fixture</title>
<style>
body{font:18px system-ui;color:#172034;max-width:720px;margin:32px auto;padding:0 24px}
label{display:block;margin:20px 0}input,textarea,button{font:inherit}
input[type=text],textarea{width:100%;padding:8px;box-sizing:border-box}
button{padding:10px 14px}output{display:block;margin-top:12px}
</style>
<h1>KCode CUA Browser Fixture</h1>
<label>验收标记 <input type="text" id="nonce" autocomplete="off"></label>
<label>多行内容 <textarea id="text" rows="4"></textarea></label>
<label><input type="checkbox" id="confirmed"> 确认提交验收</label>
<div style="height:180vh" aria-hidden="true"></div>
<button id="submit">提交验收</button><output aria-live="polite">尚未提交</output>
<script>
const report = (path, body) => fetch(path, {
  method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body)
}).then(response => response.json());
let timer;
window.addEventListener("scroll", () => {
  clearTimeout(timer);
  timer = setTimeout(() => void report("/scroll", { y: scrollY }), 80);
});
document.querySelector("#submit").addEventListener("click", async () => {
  const result = await report("/submit", {
    nonce: document.querySelector("#nonce").value,
    text: document.querySelector("#text").value,
    checked: document.querySelector("#confirmed").checked,
    y: scrollY, viewport: innerHeight, height: document.documentElement.scrollHeight
  });
  document.querySelector("output").textContent = result.ok ? "验收通过" : "验收失败";
});
</script></html>`;

function json(res, body, status = 200) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(page);
    return;
  }
  if (req.method === "GET" && req.url === "/state") {
    json(res, { maximumScroll, submissions: submitted.length, last: submitted.at(-1) ?? null });
    return;
  }
  if (req.method !== "POST" || !["/submit", "/scroll"].includes(req.url)) {
    json(res, { ok: false }, 404);
    return;
  }
  try {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 8192) {
        json(res, { ok: false }, 413);
        return;
      }
    }
    const data = JSON.parse(body);
    if (!Number.isFinite(data.y) || data.y < 0) throw new Error("Invalid scroll position");
    maximumScroll = Math.max(maximumScroll, data.y);
    if (req.url === "/scroll") {
      json(res, { ok: true });
      return;
    }
    const matchNonce = data.nonce === nonce;
    const matchText = data.text === expectedText;
    const checked = data.checked === true;
    const geometry =
      Number.isFinite(data.viewport) && data.viewport > 0 && Number.isFinite(data.height);
    const scrolled = geometry && maximumScroll >= data.viewport / 2;
    const bottom = geometry && Math.abs(data.height - data.viewport - data.y) <= 2;
    const ok = matchNonce && matchText && checked && scrolled && bottom && submitted.length === 0;
    // 只记录验收结果和几何，避免测试误填的真实文本进入证据。
    submitted.push({
      ok,
      matchNonce,
      matchText,
      checked,
      scrolled,
      bottom,
      y: data.y,
      viewport: data.viewport,
    });
    json(res, { ok });
  } catch {
    json(res, { ok: false }, 400);
  }
});

server.listen(Number(process.argv[2] ?? 19439), "127.0.0.1", () => {
  console.log(
    JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/`, nonce, expectedText }),
  );
});
