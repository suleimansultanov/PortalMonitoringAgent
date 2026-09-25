#!/usr/bin/env node
/**
 * JamesEdition — сбор через Playwright, отдельно от конвейера.
 *
 *   node scripts/jamesedition-collect.mjs --communes=ramatuelle-france --limit=10
 *   node scripts/jamesedition-collect.mjs --headful
 *   node scripts/jamesedition-collect.mjs --out=./je-pages
 *
 * Перед запуском:
 *   export CRAWLER_USER_AGENT="$(grep '^CRAWLER_USER_AGENT=' .env.local | cut -d= -f2- | tr -d '"')"
 *
 * ЗАЧЕМ ОН, ЕСЛИ АДАПТЕР РАБОТАЕТ. Для регулярного сбора он и не нужен:
 * `npm run collect -- --source=jamesedition` с машины оператора 16 сентября взял
 * 581 страницу подряд без единого отказа. Этот скрипт — чтобы ПРОВЕРИТЬ МАШИНУ:
 * поставить его на VPS или на домашнюю коробочку и узнать, пускают ли оттуда,
 * не таща туда доступ к базе и S3. Пять страниц отвечают на вопрос, за который
 * иначе платят за год вперёд.
 *
 * ЧТО МЫ ПРО НИХ ЗНАЕМ. Плоскому HTTP-клиенту отвечают 403 на всех путях,
 * браузеру с нашим собственным user-agent — 200. Проверено 30 августа, 10 и 16
 * сентября. С адреса GitHub Actions — 403 даже браузеру: это про адрес, а не
 * про нас. Поэтому здесь Playwright без вариантов, а не по выбору.
 *
 * ЧЕГО В НЁМ НЕТ: подмены user-agent, патчей navigator.webdriver, подделки
 * отпечатка. robots.txt прочитан 10 сентября: `/real_estate/` открыт, закрыты
 * /admin, /auth, /login, /member, /seller, /buyer, /ajax, /search/suggestions,
 * а также /real_estate/map? и show_more_nearby_listings — ни один из них
 * здесь не используется. Крawl-delay они не заявляют, 4 секунды ниже наши.
 */

import fs from "node:fs/promises";
import path from "node:path";

const UA =
  process.env.CRAWLER_USER_AGENT?.trim() ||
  process.env.COLLECTOR_USER_AGENT?.trim() ||
  "PortalMonitoringAgent/1.0 (+https://leadestate.com; suleiman@leadestate.com)";

const HOST = "https://www.jamesedition.com";
const DELAY_MS = 4_000;
const MAX_PAGES = 30;

/**
 * Слаги областей, прочитанные с их же блока соседних областей 10 сентября.
 *
 * La Môle (83079) здесь нет намеренно. `la-mole-france` — очевидная догадка, и
 * 15 сентября она была проверена: отдаёт HTTP 200 с заголовком «Luxury Homes
 * for Sale in France» и стоком всей страны. Не 404, не редирект. Поэтому ниже
 * есть проверка заголовка — она ловит и этот случай, и день, когда они
 * переименуют область, которой мы ПОЛЬЗУЕМСЯ.
 */
const COMMUNES = [
  ["saint-tropez-france", "Saint-Tropez"],
  ["ramatuelle-france", "Ramatuelle"],
  ["gassin-france", "Gassin"],
  ["grimaud-france", "Grimaud"],
  ["sainte-maxime-france", "Sainte-Maxime"],
  ["cogolin-france", "Cogolin"],
  ["cavalaire-sur-mer-france", "Cavalaire-sur-Mer"],
  ["la-croix-valmer-france", "La Croix-Valmer"],
  ["la-garde-freinet-france", "La Garde-Freinet"],
  ["le-plan-de-la-tour-france", "Le Plan-de-la-Tour"],
  ["roquebrune-sur-argens-france", "Roquebrune-sur-Argens"],
];

const LISTING_HREF = /href="(\/real_estate\/[a-z0-9-]+\/[a-z0-9-]+-(\d{6,}))"/gi;
const AREA_HEADING = /<h1[^>]*>([^<]{3,200})<\/h1>/i;
const STATED_TOTAL = /([\d,]+)\s*listings/i;

const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");
const flag = (n) => process.argv.includes(`--${n}`);

const outDir = path.resolve(arg("out") ?? "./je-pages");
const limit = Number(arg("limit") ?? 0) || Infinity;
const headless = !flag("headful");
const wanted = arg("communes")?.split(",").map((s) => s.trim()).filter(Boolean);
const communes = wanted ? COMMUNES.filter(([slug]) => wanted.includes(slug)) : COMMUNES;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Плоско: без диакритики, без дефисов — их заголовок пишет «Saint Tropez». */
const flat = (s) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

async function main() {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    console.error(
      "Не найден Playwright. Поставь: npm i -D playwright && npx playwright install chromium",
    );
    process.exit(1);
  }

  await fs.mkdir(outDir, { recursive: true });

  console.log(`\nпредставляемся как: ${UA}`);
  console.log("без маскировки: собственный user-agent, немодифицированный браузер");
  console.log(`пауза ${DELAY_MS / 1000}s между запросами — наша, они её не просят`);
  console.log(`страницы в ${outDir}\n`);

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    locale: "en-GB",
    timezoneId: "Europe/Paris",
    userAgent: UA,
  });
  const page = await context.newPage();

  let requests = 0;
  let saved = 0;
  let refused = 0;
  const seen = new Set();

  async function read(url) {
    if (requests > 0) await sleep(DELAY_MS);
    requests++;
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    const status = res?.status() ?? 0;
    const html = await page.content();
    if (status === 403 || /Just a moment|challenge-platform/i.test(html.slice(0, 4000))) {
      refused++;
      throw new Error(`403 — отказано на ${url}`);
    }
    if (status >= 400) throw new Error(`HTTP ${status} на ${url}`);
    return html;
  }

  try {
    for (const [slug, label] of communes) {
      if (saved >= limit) break;
      console.log(`── ${label}`);
      const links = [];

      for (let p = 1; p <= MAX_PAGES; p++) {
        const url = p === 1 ? `${HOST}/real_estate/${slug}` : `${HOST}/real_estate/${slug}?page=${p}`;
        let html;
        try {
          html = await read(url);
        } catch (err) {
          console.warn(`   ${err.message}`);
          break;
        }

        if (p === 1) {
          /**
           * Их собственный ответ на «какая это область», до всякого содержимого.
           * Слаг, которого они не знают, отдаётся с HTTP 200 и стоком всей
           * Франции — статус-код тут не проверка.
           */
          const heading = html.match(AREA_HEADING)?.[1]?.trim();
          if (heading && !flat(heading).includes(flat(label))) {
            console.warn(
              `   просили "${slug}", а страница озаглавлена "${heading}" — это не их область,\n` +
                "   сток на ней не этой коммуны. Пропускаем.",
            );
            break;
          }
          const stated = html.match(STATED_TOTAL)?.[1];
          if (stated) console.log(`   портал заявляет ${stated} объявлений`);
        }

        const found = [
          ...new Set([...html.matchAll(LISTING_HREF)].map((m) => HOST + m[1])),
        ].filter((u) => !seen.has(u) && !links.includes(u));
        if (found.length === 0) break;
        links.push(...found);
      }

      console.log(`   ${links.length} ссылок собрано`);

      for (const url of links) {
        if (saved >= limit) break;
        seen.add(url);
        try {
          const html = await read(url);
          const id = url.match(/-(\d{6,})$/)?.[1] ?? String(saved);
          await fs.writeFile(
            path.join(outDir, `${slug}-${id}.html`),
            `<!-- ${url}\n     ${new Date().toISOString()} -->\n${html}`,
          );
          saved++;
          if (saved % 10 === 0) console.log(`   сохранено ${saved}`);
        } catch (err) {
          console.warn(`   ${err.message}`);
          if (refused >= 3) throw new Error("три отказа — дверь закрыта, проход заканчиваем");
        }
      }
    }
  } catch (err) {
    console.error(`\nОСТАНОВЛЕНО: ${err.message}`);
  }

  await browser.close();

  console.log(`\nитог: ${saved} страниц, ${requests} запросов, ${refused} отказов`);
  if (refused > 0 && saved === 0) {
    console.log(
      "\nНи одной страницы с этой машины. У JamesEdition это признак адреса, а не нас:\n" +
        "с домашнего адреса оператора тот же код 16 сентября взял 581 страницу подряд.\n" +
        "Если это VPS — его диапазон в тех же списках, что и раннеры GitHub.\n",
    );
  } else if (saved > 0) {
    console.log("\nЭта машина подходит: портал отдаёт ей страницы.\n");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
