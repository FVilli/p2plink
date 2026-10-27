import { chromium } from "@playwright/test";

const browser = await chromium.launch({
  ...(process.env.P2PLINK_CHROME_PATH ? { executablePath: process.env.P2PLINK_CHROME_PATH } : {}),
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1200, height: 950 } });
page.on("pageerror", (error) => console.log("[pageerror]", error.message));
page.on("console", (message) => {
  if (message.type() === "error" || message.type() === "warning") {
    console.log(`[browser:${message.type()}]`, message.text());
  }
});

const badge = page.locator("span.badge");
const waitStatus = async (status, timeout = 30000) => {
  await page.waitForFunction(
    (expected) => document.querySelector("span.badge")?.getAttribute("data-status") === expected,
    status,
    { timeout },
  );
};

try {
  await page.goto("http://127.0.0.1:3000/", { waitUntil: "networkidle" });
  await waitStatus("p2p", 30000);
  console.log("1. Angular app connected over P2P");

  await page.waitForFunction(() => document.querySelectorAll(".items li").length >= 2);
  console.log("2. typed RPC data.list rendered");

  const before = await page.locator(".items li").count();
  await page.getByRole("button", { name: "Aggiungi elemento" }).click();
  await page.waitForFunction(
    (count) => document.querySelectorAll(".items li").length > count,
    before,
  );
  console.log("3. data.add + data.updated event");

  await page.getByRole("button", { name: "Simula guasto P2P" }).click();
  await waitStatus("mqtt", 15000);
  await page.getByRole("button", { name: "Aggiorna dati" }).click();
  await page.waitForTimeout(500);
  console.log("4. MQTT fallback works");

  await waitStatus("p2p", 30000);
  console.log("5. P2P restored");

  await page.getByRole("button", { name: "Sospendi rete" }).click();
  await waitStatus("offline", 10000);
  console.log("6. suspend -> offline");
  await page.getByRole("button", { name: "Riconnetti" }).click();
  await waitStatus("p2p", 30000);
  console.log("7. resume -> new authenticated P2P session");

  await page.screenshot({ path: "/tmp/p2plink-angular-demo.png", fullPage: true });
  console.log("ANGULAR DEMO E2E: SUCCESS");
} catch (error) {
  console.log("ANGULAR DEMO E2E: FAILED", error.message);
  console.log("status:", await badge.getAttribute("data-status").catch(() => "n/a"));
  console.log(
    "log:",
    await page
      .locator(".log")
      .innerText()
      .catch(() => "n/a"),
  );
  await page.screenshot({ path: "/tmp/p2plink-angular-demo-failure.png", fullPage: true });
  process.exitCode = 1;
} finally {
  await browser.close();
}
