// End-to-end browser test against a running app seeded with SEED_SAMPLE=true (fresh database).
// Usage: BASE_URL=http://localhost:3000 node scripts/e2e.mjs [screenshotDir]
import { chromium, devices } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const SHOTS = process.argv[2];
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const results = [];
const step = async (name, fn) => {
  try { await fn(); results.push(["PASS", name]); }
  catch (e) { results.push(["FAIL", name, String(e.message).split("\n")[0]]); }
};
const shot = async (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
const stamp = Date.now().toString(36).slice(-4);

const browser = await chromium.launch();
const errors = [];
async function newPage(opts = { viewport: { width: 1440, height: 950 } }) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  return page;
}
async function login(page, email, password = "Password123") {
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(`${BASE}/`, { timeout: 30000 });
}
const api = (page, path, body, method) => page.evaluate(async ([p, b, m]) => {
  const r = await fetch(`/api${p}`, { method: m ?? (b ? "POST" : "GET"), headers: { "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
}, [path, body, method]);

const pragati = await newPage();
const dilip = await newPage();
const ritesh = await newPage();

await step("Login rejects a wrong password, then members sign in", async () => {
  await pragati.goto(`${BASE}/login`);
  await pragati.getByLabel("Email").fill("pragati@example.com");
  await pragati.getByLabel("Password", { exact: true }).fill("wrong-password1");
  await pragati.getByRole("button", { name: "Sign in" }).click();
  await pragati.getByText("That email and password don't match").waitFor();
  await login(pragati, "pragati@example.com");
  await login(dilip, "dilip@example.com");
  await login(ritesh, "ritesh@example.com");
});

await step("UI-001/002 Command Center: members see Owner → Channel → Priority counts without drill-down links", async () => {
  await pragati.goto(`${BASE}/`);
  await pragati.getByRole("heading", { name: "By owner" }).waitFor();
  const headings = await pragati.locator("h2, h3").allTextContents();
  const order = ["By owner", "By channel", "By priority"].map((h) => headings.findIndex((x) => x.includes(h)));
  assert.ok(order[0] < order[1] && order[1] < order[2], `order ${order}`);
  assert.equal(await pragati.locator('a[href*="view=team"]').count(), 0);
  await shot(pragati, "01-command-member");
});

await step("UI-003 Leadership can drill down, and lands on their own tasks by default", async () => {
  await dilip.goto(`${BASE}/`);
  await dilip.locator('a[href*="view=team&ownerId"]').first().click();
  await dilip.waitForURL(/view=team/);
  await dilip.getByRole("tab", { name: "All team" }).waitFor();
  await dilip.goto(`${BASE}/tasks`);
  await dilip.getByText("Marketplace SLA policy review").first().waitFor();
  assert.equal(await dilip.getByText("Blinkit festive banner go-live").count(), 0);
});

let otherId;
await step("UI-004 A member opening another member's task URL or API gets nothing", async () => {
  const r = await api(dilip, "/tasks?view=team&q=Myntra%20size");
  otherId = r.json[0].id;
  await pragati.goto(`${BASE}/tasks/${otherId}`);
  await pragati.getByText("Task not found").waitFor();
  assert.equal((await api(pragati, `/tasks/${otherId}`)).status, 404);
  assert.equal((await api(pragati, "/tasks?view=team")).status, 403);
  const own = await api(pragati, "/tasks?view=all&q=Myntra");
  assert.equal(own.json.length, 0);
});

let newId;
await step("UI-006/007 Add Task: pending needs POC Type and Name; custom POC saved on the task", async () => {
  await pragati.goto(`${BASE}/tasks/new`);
  await pragati.getByLabel("Task name").fill(`Blinkit price sync ${stamp}`);
  await pragati.getByLabel("Channel").selectOption({ label: "Blinkit" });
  await pragati.getByLabel("Deadline").fill(new Date(Date.now() + 4 * 864e5).toISOString().slice(0, 10));
  await pragati.getByText("Waiting on someone (Pending From)").click();
  await pragati.getByRole("button", { name: "Create task", exact: true }).click();
  await pragati.getByText("Pick a POC Type").first().waitFor();
  await pragati.getByRole("radio", { name: "External" }).click();
  await pragati.getByRole("button", { name: "Create task", exact: true }).click();
  await pragati.getByText("POC Name is required").first().waitFor();
  await pragati.getByLabel("POC Name").fill(`Blinkit KAM ${stamp}`);
  await pragati.getByRole("button", { name: "Create task", exact: true }).click();
  await pragati.waitForURL(/\/tasks\/[A-Z]{3}-\d{6}-\d{3}/);
  newId = decodeURIComponent(pragati.url().split("/tasks/")[1]);
  await pragati.getByText("Custom POC, kept on this task only").waitFor();
  await shot(pragati, "02-task-detail");
});

await step("UI-014 The pending task shows under Pending From › External, not in Escalations", async () => {
  await pragati.goto(`${BASE}/pending?type=E`);
  await pragati.getByText(`Blinkit price sync ${stamp}`).first().waitFor();
  const esc = await api(pragati, "/escalations");
  assert.ok(!esc.json.rows.some((r) => r.task.id === newId));
});

await step("Live updates: Dilip changes priority; Pragati's open page and bell update without reloading", async () => {
  await pragati.goto(`${BASE}/tasks/${newId}`);
  await pragati.getByText("Live", { exact: true }).waitFor({ timeout: 15000 });
  const before = await pragati.getByRole("button", { name: /Notifications/ }).getAttribute("aria-label");
  const t = await api(dilip, `/tasks/${newId}`);
  const r = await api(dilip, `/tasks/${newId}`, { expectedVersion: t.json.task.version, patch: { priority: 1 } }, "PATCH");
  assert.equal(r.status, 200);
  await pragati.locator('[title="Priority P1"]').first().waitFor({ timeout: 10000 });
  await pragati.waitForFunction((b) => document.querySelector('button[aria-label^="Notifications"]')?.getAttribute("aria-label") !== b, before, { timeout: 10000 });
});

await step("UI-011/012 Escalate straight to L3 with a reason; Dilip sees it assigned to him", async () => {
  await pragati.getByRole("button", { name: "Escalate" }).click();
  await pragati.getByRole("button", { name: "Escalate", exact: true }).last().click();
  await pragati.getByText("Escalate to is required").waitFor();
  await pragati.getByRole("radio", { name: /L3/ }).click();
  await pragati.getByLabel("What's blocked and what do you need?").fill("KAM unresponsive for 3 days; listing goes dark Friday");
  await pragati.getByRole("dialog").getByRole("button", { name: "Escalate" }).click();
  await pragati.getByText(/Assigned to Dilip Sir \(L3\)/).waitFor();
  await dilip.goto(`${BASE}/escalations?mine=true`);
  await dilip.getByText(`Blinkit price sync ${stamp}`).first().waitFor();
  await shot(dilip, "03-escalations");
});

await step("UI-013 L1 reassigns the escalation with a reason; history shows the path", async () => {
  await ritesh.goto(`${BASE}/tasks/${newId}`);
  await ritesh.getByRole("button", { name: "Reassign" }).click();
  await ritesh.getByRole("radio", { name: /L1/ }).click();
  await ritesh.getByLabel("Reason").fill("I can reach the Blinkit KAM directly");
  await ritesh.getByRole("dialog").getByRole("button", { name: "Reassign" }).click();
  await ritesh.getByText("Path: L3 → L1").waitFor();
});

await step("UI-015 Extension request + waiver: deadline unchanged until approved; decisions are separate", async () => {
  const dl = (await api(pragati, `/tasks/${newId}`)).json.task.deadline;
  await pragati.goto(`${BASE}/tasks/${newId}`);
  await pragati.getByRole("button", { name: "Request extension" }).click();
  await pragati.getByLabel("New deadline").fill(new Date(Date.now() + 9 * 864e5).toISOString().slice(0, 10));
  await pragati.getByRole("dialog").getByLabel("Reason").fill("Waiting on Blinkit price file");
  await pragati.getByText("Also request a penalty waiver").click();
  await pragati.getByLabel("Why should the penalty be waived?").fill("Partner-side delay");
  await pragati.getByRole("dialog").getByRole("button", { name: "Send request" }).click();
  await pragati.getByText("Extension requested").waitFor();
  assert.equal((await api(pragati, `/tasks/${newId}`)).json.task.deadline, dl);
  await dilip.goto(`${BASE}/approvals`);
  await dilip.getByText("Waiver also requested").first().waitFor();
  const ext = (await api(dilip, "/approvals")).json.extensions.find((e) => e.taskId === newId);
  assert.equal((await api(dilip, `/extensions/${ext.id}/decision`, { decision: "APPROVE" })).status, 200);
  const d = (await api(dilip, `/tasks/${newId}`)).json;
  assert.notEqual(d.task.deadline, dl);
  assert.equal(d.waivers[0].status, "PENDING");
  await shot(dilip, "04-approvals");
});

await step("UI-027 Members can't star; UI-020 can't edit the deadline directly", async () => {
  assert.equal((await api(pragati, `/tasks/${newId}/star`, { starred: true })).status, 403);
  const v = (await api(pragati, `/tasks/${newId}`)).json.task.version;
  assert.equal((await api(pragati, `/tasks/${newId}`, { expectedVersion: v, patch: { deadline: "2030-01-01" }, reason: "x" }, "PATCH")).status, 403);
});

await step("UI-023/024 Move to Bin from the task list, restore inline from the Recycle Bin", async () => {
  await dilip.goto(`${BASE}/tasks?view=team&q=${encodeURIComponent(`price sync ${stamp}`)}`);
  await dilip.getByRole("button", { name: /Actions for Blinkit price sync/ }).first().click();
  const items = await dilip.getByRole("menuitem").allTextContents();
  assert.ok(items.findIndex((x) => x.includes("Flag")) < items.findIndex((x) => x.includes("Move to Bin")), items.join("|"));
  await dilip.getByRole("menuitem", { name: "Move to Bin" }).click();
  await dilip.getByLabel("Reason").fill("Duplicate entry");
  await dilip.getByRole("dialog").getByRole("button", { name: "Move to Bin" }).click();
  await dilip.getByText("Moved to Recycle Bin").waitFor();
  await dilip.goto(`${BASE}/bin`);
  await dilip.getByText(`Blinkit price sync ${stamp}`).first().waitFor();
  assert.equal(await dilip.getByRole("button", { name: "Purge" }).count(), 0, "Leadership must not see Purge");
  await dilip.getByRole("button", { name: "Restore" }).first().click();
  await dilip.getByLabel("Reason").fill("Not a duplicate");
  await dilip.getByRole("dialog").getByRole("button", { name: "Restore" }).click();
  await dilip.getByText("Task restored").waitFor();
  assert.equal((await api(dilip, `/tasks/${newId}`)).json.task.id, newId);
});

await step("UI-025 Purge is refused for Leadership (and audited)", async () => {
  assert.equal((await api(dilip, `/tasks/${newId}/purge`, { confirmId: newId, reason: "x" })).status, 403);
});

await step("Due Soon shows reasons; Recurring pause demands a follow-up date", async () => {
  await pragati.goto(`${BASE}/due`);
  await pragati.getByText("Why it's here").first().waitFor();
  await pragati.goto(`${BASE}/recurring`);
  await pragati.getByRole("button", { name: /Actions for Daily Blinkit OOS check/ }).click();
  await pragati.getByRole("menuitem", { name: "Pause" }).click();
  await pragati.getByLabel("Reason").fill("Festive freeze");
  await pragati.getByRole("dialog").getByRole("button", { name: "Pause" }).click();
  await pragati.getByText("Resume / follow-up date is required").waitFor();
  await pragati.keyboard.press("Escape");
});

await step("Responsive: phone layout has the drawer, task cards and no horizontal scroll", async () => {
  const phone = await newPage({ ...devices["iPhone 13"] });
  await login(phone, "pragati@example.com");
  await phone.goto(`${BASE}/tasks`);
  await phone.getByRole("button", { name: "Open navigation" }).waitFor();
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `overflow ${overflow}px`);
  await phone.goto(`${BASE}/`);
  assert.ok((await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 1);
  await shot(phone, "05-phone-command");
});

await browser.close();
for (const r of results) console.log(r.join("  "));
if (errors.length) console.log("Page errors:", errors.slice(0, 5));
const failed = results.filter((r) => r[0] === "FAIL").length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed || errors.length ? 1 : 0);
