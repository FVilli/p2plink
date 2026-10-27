import { chromium } from "@playwright/test";

const browser = await chromium.launch({
  ...(process.env.P2PLINK_CHROME_PATH ? { executablePath: process.env.P2PLINK_CHROME_PATH } : {}),
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
page.on("console", (message) => {
  const type = message.type();
  if (type === "error" || type === "warning") console.log(`[browser:${type}]`, message.text());
  else console.log(`[browser:${type}]`, message.text());
});
page.on("requestfailed", (request) =>
  console.log("[requestfailed]", request.url(), request.failure()?.errorText),
);
page.on("pageerror", (error) => console.log("[browser:pageerror]", error.message));
await page.goto("http://127.0.0.1:5173/", { waitUntil: "networkidle" });

const badge = page.locator("#status-badge");
const waitStatus = async (status, timeout = 30000) => {
  await page.waitForFunction(
    (expected) => document.querySelector("#status-badge")?.getAttribute("data-status") === expected,
    status,
    { timeout },
  );
};

try {
  await waitStatus("p2p", 30000);
  console.log("1. connected over P2P");
  await page.click("#refresh");
  await page.waitForFunction(() => document.querySelectorAll("#items li").length >= 2);
  console.log("2. RPC over P2P returned items");

  await page.click("#drop-p2p");
  await waitStatus("mqtt", 15000);
  console.log("3. fallback to MQTT after simulated P2P failure");
  await page.click("#refresh");
  await page.waitForTimeout(500);
  console.log("4. RPC succeeded over MQTT");

  await waitStatus("p2p", 30000);
  console.log("5. P2P restored automatically");
  await page.click("#refresh");
  await page.waitForTimeout(500);

  await page.click("#suspend");
  await waitStatus("offline", 10000);
  console.log("6. network suspension -> offline");
  await page.click("#resume");
  await waitStatus("p2p", 30000);
  console.log("7. resume -> new authenticated session over P2P");

  await page.screenshot({ path: "/tmp/p2plink-browser-demo.png", fullPage: true });
  const log = await page.locator("#log").innerText();
  console.log("--- UI log ---\n" + log.split("\n").slice(0, 25).join("\n"));
  console.log("BROWSER E2E: SUCCESS");
} catch (error) {
  console.log("BROWSER E2E: FAILED", error.message);
  console.log("status:", await badge.getAttribute("data-status"));
  console.log("log:", await page.locator("#log").innerText());
  await page.screenshot({ path: "/tmp/p2plink-browser-demo-failure.png", fullPage: true });
  process.exitCode = 1;
} finally {
  await browser.close();
}
