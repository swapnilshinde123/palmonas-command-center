// Builds public/index.html from the app page (docs/online-version) plus shim.js.
import { readFile, writeFile } from "node:fs/promises";
const src = await readFile(new URL("../docs/online-version/palmonas-command-center.html", import.meta.url), "utf8");
const shim = await readFile(new URL("./shim.js", import.meta.url), "utf8");
const headBits = [], rest = src.replace(/^(<title>[\s\S]*?<\/title>|<meta [^>]*>|<link [^>]*>)\s*/gm, (m) => { headBits.push(m.trim()); return ""; });
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
${headBits.join("\n")}
<style>html,body{margin:0}:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}img{max-width:100%}[hidden]{display:none!important}</style>
<script>${shim}</script>
</head><body>
${rest}
</body></html>`;
await writeFile(new URL("./public/index.html", import.meta.url), html);
console.log("public/index.html", html.length, "bytes");
