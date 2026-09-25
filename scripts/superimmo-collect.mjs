#!/usr/bin/env node
/**
 * Superimmo — сбор через обычный HTTP-клиент, отдельно от конвейера.
 *
 *   node scripts/superimmo-collect.mjs --communes=ramatuelle-83350 --limit=10
 *   node scripts/superimmo-collect.mjs --browser --limit=10    # через Playwright
 *   node scripts/superimmo-collect.mjs --browser --headful     # и с окном
 *   node scripts/superimmo-collect.mjs --budget=20        # минут, по умолчанию 40
 *   node scripts/superimmo-collect.mjs --out=./superimmo-pages
 *
 * Перед запуском:
 *   export CRAWLER_USER_AGENT="$(grep '^CRAWLER_USER_AGENT=' .env.local | cut -d= -f2- | tr -d '"')"
 *
 * ДВА КЛИЕНТА, ОДИН КОД — и это весь смысл флага `--browser`.
 *
 * Superimmo отдаёт страницы обычному HTTP-клиенту: он нам не отказывает, он
 * отвечает 429, то есть просит подождать. 403 у SMC это «нет», 429 здесь это
 * «не так часто». Поэтому конвейер ходит сюда плоским клиентом.
 *
 * Чего никто не мерил: получает ли браузерная сессия другой бюджет. Защита
 * часто режет клиентов без кук и без исполненного JS жёстче, чем браузер,
 * который прошёл обычный путь страницы. Гипотеза правдоподобная и проверяемая —
 * но проверять её надо, меняя РОВНО ОДНУ переменную, иначе получится то, за что
 * этот проект уже платил: два непохожих прогона и уверенный неверный вывод.
 *
 * Отсюда и устройство файла: одни и те же коммуны, те же паузы, тот же разбор
 * ссылок, то же соблюдение Retry-After. Разный только транспорт.
 *
 * ПОЭТОМУ ГЛАВНОЕ В ЭТОМ СКРИПТЕ — НЕ СБОР, А ТОРМОЗА:
 *   - 10 секунд между запросами: столько их robots.txt просит у названных краулеров;
 *   - Retry-After соблюдается буквально, а не заменяется своей паузой;
 *   - после каждого 429 интервал растёт и сам не опускается ниже — в пределах прохода;
 *   - шесть отказов подряд по одному адресу, и он пропускается;
 *   - весь проход ограничен бюджетом по времени, чтобы не молотить всю ночь.
 *
 * ЧЕГО ЗДЕСЬ НЕТ: смены адреса, новых сессий после отказа, обхода их CAPTCHA
 * (она у них периодически появляется — см. CLAUDE.md). Если портал перестаёт
 * отдавать, скрипт заканчивает проход, а не ищет другую дверь.
 *
 * ЧЕСТНО О ПОЛЬЗЕ: измерено 15–16 сентября, с раннера и с домашнего адреса —
 * 429 прилетает почти на каждый запрос даже при паузе в две минуты. Один проход
 * по одной коммуне дал 7 сохранённых страниц за 67 минут. Этот скрипт ведёт себя
 * вежливее конвейера, но арифметику не меняет: ответ для Superimmo — партнёрское
 * соглашение, а Med-Estates у них уже рекламируется.
 */

import fs from "node:fs/promises";
import path from "node:path";

const UA =
  process.env.CRAWLER_USER_AGENT?.trim() ||
  process.env.COLLECTOR_USER_AGENT?.trim() ||
  "PortalMonitoringAgent/1.0 (+https://leadestate.com; suleiman@leadestate.com)";

const HOST = "https://www.superimmo.com";
const BASE_DELAY_MS = 10_000;
const MAX_DELAY_MS = 120_000;
const MAX_ATTEMPTS = 6;

/**
 * Слаги и то, что идёт после них, прочитанные с их департаментской страницы
 * 2026-08-29 — не выведенные из названий. Хвост НЕ всегда почтовый индекс:
 * коммуны с несколькими индексами получают номер департамента целиком.
 * Le Plan-de-la-Tour носит 83120 Сент-Максим, La Môle делит 83310 с Коголеном.
 */
const COMMUNES = [
  "saint-tropez-83990",
  "ramatuelle-83350",
  "gassin-83580",
  "grimaud-83310",
  "cogolin-83310",
  "sainte-maxime-83120",
  "la-croix-valmer-83420",
  "cavalaire-sur-mer-83240",
  "la-mole-83310",
  "la-garde-freinet-83680",
  "le-plan-de-la-tour-83120",
];

const LISTING_HREF = /href="(\/annonces\/[a-z0-9-]+-[a-z0-9]+)(?:\?[^"]*)?"/gi;

const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");
const flag = (n) => process.argv.includes(`--${n}`);

const outDir = path.resolve(arg("out") ?? "./superimmo-pages");
const limit = Number(arg("limit") ?? 0) || Infinity;
const maxPages = Number(arg("pages") ?? 20);
const budgetMs = (Number(arg("budget") ?? 40) || 40) * 60_000;
const communes = arg("communes")?.split(",").map((s) => s.trim()).filter(Boolean) ?? COMMUNES;
const useBrowser = flag("browser") || flag("headful");
const headless = !flag("headful");

/** Их периодическая CAPTCHA. Признак — не препятствие: увидели, закончили проход. */
const CAPTCHA = /captcha|cf-browser-verification|challenge-platform|Just a moment/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const startedAt = Date.now();
const outOfTime = () => Date.now() - startedAt > budgetMs;

let delayMs = BASE_DELAY_MS;
let requests = 0;
let throttles = 0;

/**
 * Транспорт: либо `fetch`, либо страница Playwright. Оба возвращают одно и то
 * же — {status, headers, text} — чтобы всё, что выше, не знало разницы.
 */
let transport = null;

async function openBrowser() {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    console.error(
      "Не найден Playwright. Запускай из папки проекта, где он стоит в node_modules,\n" +
        "или убери --browser, чтобы пойти обычным клиентом.",
    );
    process.exit(1);
  }
  const browser = await chromium.launch({ headless });
  /**
   * Свой user-agent, немодифицированный браузер, никаких патчей. Браузер здесь —
   * это вопрос «дают ли сессии больше», а не способ спрятаться.
   */
  const context = await browser.newContext({
    locale: "fr-FR",
    timezoneId: "Europe/Paris",
    userAgent: UA,
  });
  const page = await context.newPage();
  return {
    kind: "browser",
    async get(url) {
      const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      return {
        status: res?.status() ?? 0,
        retryAfter: Number(res?.headers()?.["retry-after"]) || 0,
        text: await page.content(),
      };
    },
    close: () => browser.close(),
  };
}

function plainClient() {
  return {
    kind: "plain",
    async get(url) {
      const res = await fetch(url, {
        headers: { "user-agent": UA, "accept-language": "fr-FR,fr;q=0.9" },
        redirect: "follow",
      });
      return {
        status: res.status,
        retryAfter: Number(res.headers.get("retry-after")) || 0,
        text: res.ok ? await res.text() : "",
      };
    },
    close: async () => {},
  };
}

/**
 * Один запрос, с паузой перед ним.
 *
 * Возвращает текст или null, если портал так и не пустил. null — это законный
 * исход, а не ошибка: он означает «сейчас не отдают», и вызывающий код идёт
 * дальше, а не пробует ту же дверь другим способом.
 */
async function read(url) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (outOfTime()) return null;
    if (requests > 0) await sleep(delayMs);
    requests++;

    let res;
    try {
      res = await transport.get(url);
    } catch (err) {
      console.warn(`   сеть: ${err.message}`);
      return null;
    }

    if (res.status === 429) {
      throttles++;
      // Их число, а не наше. Заголовок в секундах; если его нет — минута.
      const after = res.retryAfter || 60;
      delayMs = Math.min(MAX_DELAY_MS, Math.max(delayMs + 30_000, BASE_DELAY_MS));
      console.warn(
        `   429 — ждём ${after}s по их Retry-After ` +
          `(интервал теперь ${delayMs / 1000}s, попытка ${attempt}/${MAX_ATTEMPTS})`,
      );
      await sleep(after * 1000);
      continue;
    }

    if (res.text && CAPTCHA.test(res.text.slice(0, 4000))) {
      console.warn("   на странице проверка — проход заканчиваем, разгадывать её скрипт не будет");
      return null;
    }

    if (res.status === 403 || res.status === 503) {
      console.warn(`   HTTP ${res.status} — портал закрыл дверь, проход заканчиваем`);
      return null;
    }
    if (res.status === 404 || res.status === 410) return null;
    if (res.status >= 400) {
      console.warn(`   HTTP ${res.status} на ${url}`);
      return null;
    }
    return res.text;
  }
  console.warn(`   ${MAX_ATTEMPTS} отказов подряд — пропускаем`);
  return null;
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });

  transport = useBrowser ? await openBrowser() : plainClient();

  console.log(`\nтранспорт: ${useBrowser ? `Playwright${headless ? "" : ", с окном"}` : "обычный HTTP-клиент"}`);
  console.log(`представляемся как: ${UA}`);
  console.log(`пауза ${BASE_DELAY_MS / 1000}s между запросами, Retry-After соблюдается буквально`);
  console.log(`бюджет прохода ${budgetMs / 60_000} минут, страницы в ${outDir}\n`);

  let saved = 0;
  const seen = new Set();

  for (const commune of communes) {
    if (saved >= limit || outOfTime()) break;
    console.log(`── ${commune}`);

    const links = [];
    for (let page = 1; page <= maxPages; page++) {
      if (outOfTime()) break;
      const url =
        page === 1
          ? `${HOST}/achat/provence-alpes-cote-d-azur/var/${commune}?sort=created_at`
          : `${HOST}/achat/provence-alpes-cote-d-azur/var/${commune}/p/${page}?sort=created_at`;

      const html = await read(url);
      if (!html) break;

      const found = [...new Set([...html.matchAll(LISTING_HREF)].map((m) => HOST + m[1]))].filter(
        (u) => !seen.has(u) && !links.includes(u),
      );
      if (found.length === 0) break;
      links.push(...found);
    }

    console.log(`   ${links.length} объявлений найдено`);

    for (const url of links) {
      if (saved >= limit || outOfTime()) break;
      seen.add(url);
      const html = await read(url);
      if (!html) continue;
      const id = url.split("-").pop();
      await fs.writeFile(
        path.join(outDir, `${commune}-${id}.html`),
        `<!-- ${url}\n     ${new Date().toISOString()} -->\n${html}`,
      );
      saved++;
      if (saved % 5 === 0) console.log(`   сохранено ${saved}`);
    }
  }

  await transport.close();

  const minutes = Math.round((Date.now() - startedAt) / 60_000);
  console.log(
    `\nготово за ${minutes} мин (${transport.kind}): ${saved} страниц, ` +
      `${requests} запросов, ${throttles} отказов 429`,
  );
  console.log(
    "Сравнивать имеет смысл только с прогоном по тем же коммунам и тому же --limit\n" +
      "другим транспортом. Одна переменная за раз.",
  );
  if (throttles > requests / 4) {
    console.log(
      "\nОтказов больше четверти от всех запросов. Это не настройка, которую можно",
      "\nподкрутить — портал просит нас так не делать. Дорога здесь через партнёрское",
      "\nсоглашение, и Med-Estates у них уже рекламируется.\n",
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
