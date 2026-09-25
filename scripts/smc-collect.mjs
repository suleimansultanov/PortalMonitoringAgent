#!/usr/bin/env node
/**
 * SMC (Maisons et Appartements) — сбор через Playwright, отдельно от конвейера.
 *
 *   node scripts/smc-collect.mjs                      # все коммуны, headless
 *   node scripts/smc-collect.mjs --headful            # с окном
 *   node scripts/smc-collect.mjs --communes=ramatuelle-35951 --limit=5
 *   node scripts/smc-collect.mjs --out=./smc-pages
 *
 * Перед запуском:
 *   export CRAWLER_USER_AGENT="$(grep '^CRAWLER_USER_AGENT=' .env.local | cut -d= -f2- | tr -d '"')"
 *
 * ЧТО ОН ДЕЛАЕТ: открывает страницу подборки по коммуне, собирает ссылки на
 * объявления, открывает каждое и сохраняет HTML на диск. Пауза 10 секунд между
 * запросами — столько robots.txt SMC просит у названных краулеров.
 *
 * ЧЕГО В НЁМ НЕТ: подмены user-agent, патчей navigator.webdriver, подделки
 * отпечатка, прохождения челленджа. Мы представляемся своим именем, и нас можно
 * опознать, притормозить и отказать. На этом держится разрешение от 25 августа,
 * и то же самое написано в runner/browser.ts.
 *
 * ЕСЛИ ПРИЛЕТИТ «Just a moment…» — скрипт останавливается и печатает ray ID.
 * Это не препятствие, а ответ: исключение в их Cloudflare ещё не стоит. Ray ID
 * из вывода — то, что прикладывают к письму.
 */

import fs from "node:fs/promises";
import path from "node:path";

const UA =
  process.env.CRAWLER_USER_AGENT?.trim() ||
  process.env.COLLECTOR_USER_AGENT?.trim() ||
  "PortalMonitoringAgent/1.0 (+https://leadestate.com; suleiman@leadestate.com)";

const HOST = "https://www.maisonsetappartements.fr";
const DELAY_MS = 10_000;

/** Слаги подборок, прочитанные с их же страниц — не угаданные. */
const COMMUNES = [
  "st-tropez-35969",
  "ramatuelle-35951",
  "gassin-35915",
  "grimaud-35918",
  "port-grimaud-36005",
  "cogolin-35892",
  "marines-de-cogolin-39127",
  "ste-maxime-35965",
  "la-croix-valmer-35898",
  "cavalaire-sur-mer-35886",
  "la-mole-35929",
  "la-garde-freinet-35913",
  "le-plan-de-la-tour-35944",
  "les-issambres-36027",
];

const LISTING_HREF = /href="([^"]*annonce-vente-[a-z]+-[a-z0-9-]+-\d+\.html)"/gi;
const CHALLENGE = /Just a moment|cf-browser-verification|challenge-platform/i;
const RAY_ID = /Ray ID:\s*([0-9a-f]+)/i;

const arg = (name) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const flag = (name) => process.argv.includes(`--${name}`);

const outDir = path.resolve(arg("out") ?? "./smc-pages");
const limit = Number(arg("limit") ?? 0) || Infinity;
const communes = arg("communes")?.split(",").map((s) => s.trim()).filter(Boolean) ?? COMMUNES;
const headless = !flag("headful");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Blocked extends Error {
  constructor(url, ray) {
    super(`заблокировано на ${url}${ray ? ` (Cloudflare ray ID ${ray})` : ""}`);
    this.ray = ray;
  }
}

async function main() {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    console.error(
      "Не найден Playwright. Запускай из папки проекта, где он стоит в node_modules,\n" +
        "или поставь: npm i -D playwright && npx playwright install chromium",
    );
    process.exit(1);
  }

  await fs.mkdir(outDir, { recursive: true });

  console.log(`\nпредставляемся как: ${UA}`);
  console.log("без маскировки: собственный user-agent, немодифицированный браузер");
  console.log(`пауза ${DELAY_MS / 1000}s между запросами — столько просит их robots.txt`);
  console.log(`страницы сохраняются в ${outDir}\n`);

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    locale: "fr-FR",
    timezoneId: "Europe/Paris",
    userAgent: UA,
  });
  const page = await context.newPage();

  let fetched = 0;
  let saved = 0;
  const seen = new Set();

  /** Одна страница, с паузой перед ней и проверкой на челлендж после. */
  async function read(url) {
    if (fetched > 0) await sleep(DELAY_MS);
    fetched++;
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    const html = await page.content();
    const status = res?.status() ?? 0;

    if (CHALLENGE.test(html) || status === 403) {
      throw new Blocked(url, html.match(RAY_ID)?.[1]);
    }
    if (status >= 400) throw new Error(`HTTP ${status} на ${url}`);
    return html;
  }

  try {
    for (const slug of communes) {
      if (saved >= limit) break;
      const indexUrl = `${HOST}/fr/83/biens/vente/selection-biens-${slug}.html`;
      console.log(`── ${slug}`);

      let indexHtml;
      try {
        indexHtml = await read(indexUrl);
      } catch (err) {
        if (err instanceof Blocked) throw err;
        console.warn(`   индекс не прочитан: ${err.message}`);
        continue;
      }

      const links = [
        ...new Set(
          [...indexHtml.matchAll(LISTING_HREF)].map((m) =>
            m[1].startsWith("http") ? m[1] : `${HOST}${m[1].startsWith("/") ? "" : "/"}${m[1]}`,
          ),
        ),
      ].filter((u) => !seen.has(u));

      console.log(`   ${links.length} объявлений на странице`);

      for (const url of links) {
        if (saved >= limit) break;
        seen.add(url);
        try {
          const html = await read(url);
          const id = url.match(/-(\d+)\.html/)?.[1] ?? String(saved);
          const file = path.join(outDir, `${slug}-${id}.html`);
          await fs.writeFile(file, `<!-- ${url}\n     ${new Date().toISOString()} -->\n${html}`);
          saved++;
          if (saved % 10 === 0) console.log(`   сохранено ${saved}`);
        } catch (err) {
          if (err instanceof Blocked) throw err;
          console.warn(`   ${url} — ${err.message}`);
        }
      }
    }

    console.log(`\nготово: ${saved} страниц сохранено, ${fetched} запросов сделано\n`);
  } catch (err) {
    if (err instanceof Blocked) {
      console.error(`\nОСТАНОВЛЕНО: ${err.message}`);
      console.error(
        "\nЭто их проверка Cloudflare, а не наша ошибка. Обходить её скрипт не будет." +
          `\nЧто делать: приложить ray ID${err.ray ? ` (${err.ray})` : ""} и сегодняшнюю дату` +
          "\nк письму в SMC France и попросить исключение по user-agent или по IP.\n",
      );
      console.error(`успели сохранить: ${saved} страниц\n`);
    } else {
      console.error(`\nупало: ${err.message}\n`);
    }
    await browser.close();
    process.exit(1);
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
