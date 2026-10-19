# Handoff — 2026-10-19 (сессии 15–19.10)

Для следующей сессии в Claude Code на Маке, в корне репозитория. Прочитай
целиком, потом `CLAUDE.md`, потом [`docs/REVIEW-2026-10-15.md`](REVIEW-2026-10-15.md)
§8 (список работ ревью со статусами — закрыто почти всё). Секретов здесь нет:
ключи в `.env.local` и в GitHub Secrets. Предыдущие handoff — в git-истории
этого файла (`a88e8df` от 06.10, `cbf382d` от 14.10, `0da3014` от 15.10).

Всё в `main`, синхронизировано с origin, рабочее дерево чистое. Последний
коммит перед этим handoff — `5771b3a`. Тесты: `node --import tsx --test
"src/**/*.test.ts"` — **541 зелёных, 6 пропущенных** (пропущенные — тесты
против локального Postgres, см. §6). Typecheck чистый (`rm -rf .next`, если
ругается на `.next/types`). CI (`ci.yml`) гоняет то же на каждый пуш.

Оператор (Suleiman) пишет по-русски; код, коммиты и документация — по-английски.
Клиент — Med-Estates (Mark Voncken, `ai@med-estates.com`); приложение клиента
делает Tomaz (`brain.med-estates.com`), оно читает наш `/api/v1`. Решение
оператора: ничего не поручать Tomaz — всё, что видит приложение, решаем на
своей стороне в API.

---

## 0. ПЕРВЫМ ДЕЛОМ (следующая сессия)

1. **Ночная сводка.** Артефакт `nightly-<run_id>` в Actions → `summary.txt`.
   Три последние ночи (16→17, 17→18, 18→19) прошли полностью, 43–62 мин,
   `1–2 with warnings` (Etreproprio 2–3 страницы без JSON-LD, LuxuryEstate
   редкие 403 от CloudFront — оба ожидаемы). Красная ночь теперь сама откроет
   issue `nightly-failure` и придёт письмом (`report-failure` в `collect.yml`).
2. **Строка `duplicate audit:` в той же сводке.** На 19.10: `0 pair(s) the
   resolve itself would merge yet still apart; 42 … kept apart by the cluster
   guard; 11 … welded`. **Первая цифра (аномалии) должна оставаться ~0.**
   Если выросла — что-то сломалось в склейке, смотреть сразу
   (`npm run dedup:audit`). 42 и 11 — см. §5, пункт 1.
3. **V1 (Stream.Estate, платный):** за период с 14.10 потрачено **6 048 из
   15 000** (наш стоп на 14 000), ~150 items за ночь. Сверить с кабинетом
   (console.stream.estate → API Usage): 15.10 наша цифра совпала с их до
   штуки (5 454). `npm run stream:history -- --ledger`.
4. Ответить Mark в Slack про Facebook Business / WhatsApp — это не этот
   проект; оператор ответит сам.

---

## 1. Источники сейчас (`npm run source`)

| Источник | Вкл | Что даёт |
|---|---|---|
| vizzit | on | свой; **чужие объявления в индексе помечаются и не качаются** (§4) |
| bienici | on | свой, API-записи; ~450 «новых» каждую ночь — известная проблема (§5) |
| green-acres | on | свой |
| etreproprio | on | свой, browser |
| luxuryestate | on | свой, browser, по разрешению; CloudFront иногда 403, сессия перезапускается по договорённости |
| **stream-estate** (V2) | on | бесплатная бета; SeLoger, Leboncoin, Belles Demeures, Idealista, PAP, Rightmove, SMC, сайты агентств |
| **stream-estate-v1** | on | **платный**, клиентский; склад взят 15.10, дальше только изменения (~150/ночь) |
| figaro, figaro-immobilier, jamesedition, superimmo, smc, zoopla-overseas | OFF | данные лежат, клиенту не отдаются; их порталы приходят через V1/V2 |

В базе 6 936 активных объектов, 30 134 активных объявлений; **клиенту через
API отдаётся 6 062** (только то, что несёт хотя бы один включённый источник,
и только по подписке клиента в `client_sources`).

---

## 2. Решения оператора и клиента (не пересматривать без них)

- **Правило склейки, согласовано с Mark и Tomaz 15.10:** цена совпадает до
  евро, та же коммуна, **площадь дома ±20%, участок ±20%, если указан у
  обоих**; участок не указан — не мешает. Только для домов: квартиры на
  допуске Carrez, голые участки и коммерция — нет. Реализация:
  `matching/score.ts`, `AREA_TOLERANCE_SAME_PRICE`, `sameHouseBand`.
- **Med-Estates в ленте остаётся** (Mark, 15.10, после того как Tomaz просил
  скрыть): их объявления отдаются, а на объектах, которые продаёт Med-Estates,
  **чужие дубли (другие агентства/платформы) скрываются**. Реализация:
  `clients.own_agency_names` = `{med estates, mark voncken}` (нормализованные
  имена агентств), `notADuplicateOfOwn` в `api/v1.ts`.
- **`STREAM_ESTATE_API_KEY` = `ca7…` — это живой ключ клиента V1** (подписка
  на том же аккаунте, что и бывший пробный). Не перепроверять, не просить
  заменить, не удалять. Оператор устал отвечать на этот вопрос.
- Выключенные сборщики не отдаются через API, данные лежат. Порталы, которые
  нас не пускают, берём из Stream.Estate; `source` в API = настоящий портал,
  `via` = агрегатор. Leboncoin и SeLoger берём (риск AUP 2.6 известен).
- V1: никакого полного прохода; никаких вебхуков; почасового сбора нет.
- Предупреждать оператора перед тяжёлым по трафику (reparse).
- Ручную склейку по продакшену (`npm run resolve`) оператор одобрял дважды
  (15.10 и 18.10) — **после сухого замера** `dedup:check`. Так и делать.

---

## 3. Stream.Estate V1 — платный, как устроен

Без изменений с 15.10, см. `CLAUDE.md` и `portals/streamV1.ts`: счётчик в
`api_usage` (`reserve` до запроса, `settle` после), потолок 14 000 (план
15 000 − резерв 1 000), период с 14-го числа, состояние по коммунам в
`source_commune_state` (`stockedAt` у всех 12 коммун с 15.10). Команды:
`npm run stream:history` (план), `-- --ledger` (расход), `--pull=…`
(без `--yes` только показывает). Нельзя: полный проход; запросы мимо счётчика;
ключ в чат. Открытые вопросы к Thomas — §5.

## 3b. Stream.Estate V2 (бесплатная бета)

Без изменений: ключ `STREAM_ESTATE_V2_API_KEY`, полный проход каждую ночь,
`refreshOnChange: true`. С 15.10 **не пишет** их `createdAt` в `publishedAt`
(это дата их обнаружения; лежит в `raw.firstSeenByThem`). Старые строки с этой
датой остались — §5.

---

## 4. Что сделано за сессии 15–19.10 (45 коммитов)

**Дедупликация** — главная тема, по жалобе клиента 15.10 («одна вилла, две
карточки, 179 и 210 м²»):
- Правило 20% (`b5e84da`); представитель объекта только из включённых
  источников (`a0af82a`); выброшенные из кластера строки собираются заново, а
  не рассыпаются по одной (`7479421`); блокировка пар по цене и мемоизация
  шинглов — сухой прогон по рынку 11 с вместо часа.
- **Защита кластера переписана** (`85570d0`): допуск от медианы, тип
  «квартира» и согласие участков — большинством строк, а не одной; цепочка
  замеров одного дома держится до 30%. До этого одна строка с чужим участком
  или типом «Appartement» переключала допуск для всего кластера — 126 из 149
  дублей были из-за этого.
- **Один конвейер склейки** `clusterCandidates` для `resolve`, `dedup:check`
  и аудита (`85570d0`).
- **Аудит дублей** `npm run dedup:audit` + строка в ночной сводке (`32427f5`,
  `85570d0`): повторяет склейку по хранимым данным и отвечает, какие пары
  правила считают одним домом (аномалии / защита держит врозь / сварены).
- Склейка повторяет запрос при обрыве соединения (`80257fa`); отдельный job
  `resolve` в `collect.yml`, если сбор упал или упёрся в лимит (`a34c649`).
- **Две правки попробованы и откачены 19.10 с цифрами** (`1d4f7d8`): допуск
  10% без участка — +114 объектов; запрет «Terrain» с домом — +32 и не
  чинит. Заметки рядом с константами в `score.ts`.
- Результат: лента клиента 6 258 → 6 062 (−196 дублей при росте склада);
  аномалий 0.

**Vizzit** (`8673aed`): десять ночей «1 000 из 1 100 провалились (410)» —
это чужие объявления (Idealista, SeLoger, Rightmove, Belles Demeures…),
которые Vizzit подмешивает в индекс и не отдаёт раннеру из США. Карточка
несёт портал в блоке агентства → `portalNamed()` → `syndicatedFrom` →
раннер не качает. 404/410 на объявлении, которого мы не держали, — `unserved`,
не провал; в сводке колонки `unserved` и `elsewhere`. Ночь Vizzit: 10 мин,
0 ошибок.

**API `/api/v1`:** только подписанные источники (`e996601`), `sourceCount` по
порталам, курсор `/events` по `created_at` (миграция 0009), Med-Estates без
чужих дублей (`0fceaf7`), rate limit 120/мин на ключ + журнал запросов
(0010), не-uuid → 404.

**Ночной прогон:** по два источника сразу (`92e210e`), `report-failure`
открывает issue, входы workflow через `env:`, CI на каждый пуш.

**Приложение (ветка C, `738b7bf`):** тенантность — каждый экран читает клиента
аккаунта; дашборд = API (6 062, не 7 392); фильтры и «Next» на странице
объявлений больше не 404; история на карточке; `PUBLIC_PATHS` один список;
Inngest удалён; CHECK на 12 статусных колонок (0011).

**Ревью-правки (агенты A и B):** ingest с повтором и атомарными событиями
(`9c5e97b`); адаптеры — незастроенная коммуна помечается `incomplete`,
`num()` понимает английские тысячи, Figaro только EUR, даты V2/LuxuryEstate
не выдаются за публикацию; скрипты — удалён `sync-to-supabase.sh`
(TRUNCATE продакшена), бэкап держит `client_api_keys`, `api_usage`,
`source_commune_state`; документация про одну базу.

**База:** миграции 0009–0011 применены вручную (Vercel не мигрирует; nightly
мигрирует перед сбором). Аккаунт оператора привязан к `med-estates`.

---

## 5. Открытые задачи

1. **Пять настоящих дублей, которые защита держит врозь**, все по одной
   схеме: третий дом по той же цене прицепился к кластеру через копию без
   участка (LuxuryEstate и V1 участок не публикуют никогда), и его строки
   перетягивают медиану/допуск. Пары: Les Issambres 2 290 000 €
   (`0d65bf7a…`/`952e3062…`), Sainte-Maxime 695 000 € (`eb214bd4…`/`70f8ac4e…`),
   850 000 € (`dd9b3354…`/`d9c96dca…`), 5 350 000 € (`ffa65ba1…`/`e5c63845…`),
   La Croix-Valmer 1 495 000 € (`7c5d8d54…` — сам сварен из 125–135/1 453 и
   155/1 030 — и `feb850e3…`). **Решение, проверенное вручную на всех пяти:**
   делить кластер на «лагеря» по участку (где участок указан хотя бы у двух
   строк и сходится в 20%), строки без участка раскидывать по лагерям по
   площади, потом проверять площадь внутри лагеря. Простые правки не годятся —
   см. `1d4f7d8`. Мерить `dedup:check` до записи. Остальные 37 из 42 пар
   «держит врозь» — по делу (мандат на несколько квартир программы, дом
   «11 м²», разные участки). 11 «сваренных» — квартиры с разбросом замеров
   7–13% при допуске 5%; посмотреть глазами.
2. **Vizzit отдаёт не больше 20 страниц (479 карточек) на коммуну.** Пять
   крупных коммун (Saint-Tropez 577, Grimaud 842, Cogolin 505, Sainte-Maxime
   1 384, Cavalaire 882 заявленных) каждую ночь `incomplete`, в них ничего не
   снимается — 741 объявление «оставлено активным вместо снятия». Резать
   коммуну на части (тип/цена), как Les Issambres у V2.
3. **Bien'ici: ~450 «новых» каждую ночь при ~48 реальных** — строки без
   коммуны выпадают из `known`. Из прошлого handoff.
4. **Европейский раннер** (`scripts/aws/README.md`): Vizzit и Green-Acres с
   европейского адреса отдадут чужие объявления (idealista, Rightmove…) и
   цены в евро. Два «но»: под каким порталом их показывать (это не Vizzit), и
   **парсер с европейской отрисовки не читает `areaM2`** (проверено с Мака
   19.10 — он писался по американской). Сначала фикстура с EU-страницы.
5. **Ошибки данных:** 9 домов с площадью < 20 м² (`sane()` без нижней
   границы), 2 строки с площадью = участку (V1 кладёт участок в площадь).
   Одна из них — дом «11 м²» в паре по мандату.
6. **Старые даты публикации** (агент B, SQL не запускался): V2 — 2 205
   активных строк с `published_at` = их `createdAt`; LuxuryEstate — 2 495 с
   `datePosted` (дата отдачи страницы). Ingest не затирает значение null-ом,
   так что только руками:
   ```sql
   update portal_listings set published_at = null where source_id = (select id from portal_sources where key='luxuryestate');
   update portal_listings l set published_at = null where source_id = (select id from portal_sources where key='stream-estate') and published_at is not null and not exists (select 1 from jsonb_array_elements(coalesce(l.raw->'listings','[]'::jsonb)) e where nullif(e->>'publishedAt','') is not null);
   ```
7. **Хвосты агентов:** `lib/reports/queries.ts` — `listReports()` без
   вызывающих, `getReport(id)` без clientId; `inngest` в `package.json` и
   `INNGEST_*` в `.env.example`; `migrate.ts` без TLS-логики `client.ts`
   (если Supabase включит «enforce SSL», ночь упадёт на миграциях);
   `openapi.ts` не описывает 429; Vercel pooler (6543, `statement_timeout`)
   не проверен; экран Sources — проверить, что предупреждение про
   `last_sync_at` убрано.
8. **Etreproprio:** 2–3 страницы каждую ночь без `Product` в JSON-LD (другой
   шаблон, в т.ч. «off-market»). Три карточки.
9. **Stream.Estate, спросить Thomas (бесплатно):** формат `includedSites`
   (все пробы вернули 0 — позволил бы брать в V1 только Figaro/Superimmo и
   экономить); фото, которые V2 не прикрепляет к объекту (обещал починить
   на неделе 13.10). История цен V1 (10 174 объекта с 2021) — с 14.11.
10. **Письма:** AVIV — черновик в §8, отвечать в переписку от 25.08; Groupe
    Figaro, JamesEdition, Zoopla, SMC — черновики в Obsidian `PMA — Portal
    Letters.md`, обновить. **Оператор.**
11. **Decodo:** проверить, что пробный период отменён, пароль сменён,
    `PMA_RESIDENTIAL_PROXY` убран из `.env.local` и Secrets. **Оператор.**
12. Reparse ради галерей Vizzit (~1,6 ГБ) и Green-Acres (~2,2 ГБ) — только
    Wi-Fi, по решению оператора.
13. Производительность из ревью §3, что осталось: `withListings` тянет весь
    `raw`; `/status` разворачивает jsonb при каждом вызове; `refreshOnChange`
    `distinct on` по всем снимкам; ingest 6–8 запросов на объявление. 191
    `as`-каст в `v1.ts` → zod (ревью §5).
14. Obsidian (`PMA — *.md`) не обновлялся с 07.10.

---

## 6. Ловушки машины и процесса

- **Трафик.** Оператор часто на мобильном интернете. Перед тяжёлым — объём.
- **База из терминала:** `psql` есть; `DATABASE_URL` из `.env.local` через
  `grep | cut`, не печатая. **Пулер режет любой запрос дольше 10 с**: выборка
  всего рынка одним запросом (29 000 строк с описаниями) умирает — грузить по
  коммунам (`dedup:check` и аудит так и делают). Запись — в транзакции,
  select после. Классификатор песочницы иногда отказывает в UPDATE по
  продакшену — тогда просить оператора.
- **Тесты против базы** (`ingest.db.test.ts`, `resolve.db.test.ts`) —
  опциональные, только localhost: как поднять throwaway-Postgres, написано в
  шапке `ingest.db.test.ts` (`initdb --locale=C`, `pg_ctl -o "-p 54329 -k ''"`,
  `PMA_TEST_DATABASE_URL=…`). На Маке 19.10 такой кластер остался запущенным
  на 54329.
- **Песочница auto mode** не даёт править `.env.local` и запускать `npm test`
  — `node --import tsx --test "src/**/*.test.ts"`. `timeout` на Маке нет —
  `perl -e 'alarm N; exec @ARGV' cmd…`. Склейку по всему рынку запускать по
  коммуне с повторами (`for c in …; do npx tsx src/lib/portals/resolveCli.ts
  --communes=$c || retry; done`), ~1 ч; `--run_in_background`.
- **`cmd | head` в цепочке с `&&` глотает код выхода `cmd`.** 19.10 из-за
  этого ушёл коммит со сломанным тестом (`1d4f7d8`, починен `5771b3a`).
  Проверять tsc и тесты без конвейера перед коммитом.
- **Как проверять API без ключа:** временный `src/x.tmp.ts`, импорт
  `snapshot`/`status`/`events` из `@/lib/api/v1`, scope клиента из `clients` +
  `client_sources`; `npx tsx src/x.tmp.ts`, потом удалить. Только чтение.
- **Деплой API:** Vercel собирает с `main`, миграции не запускает —
  **миграцию применять руками до пуша кода, который её читает** (`npm run
  db:migrate` из корня, с `.env.local`). Доступа к Vercel нет.
- **`gh` не установлен**; секреты, переменные и настройки репозитория
  меняет оператор. Вручную: Actions → `collect.yml` → Run workflow (sources и
  communes пусто, parallel 2, full нет).
- **Ключи в чат не вставлять.**
- Ночной сбор: `collect.yml`, cron 21:00 UTC пн–сб, вс — `--full`; реально
  стартует 22:45–23:30 UTC. Три job: `collect` → `resolve` (если collect не
  success) → `report-failure` (если не success).
- Vizzit/Green-Acres с европейского адреса рисуют иначе (м², евро) — парсер
  под это не проверен (§5.4).

---

## 7. Ссылки и команды

- [`docs/REVIEW-2026-10-15.md`](REVIEW-2026-10-15.md) §8 — список работ со статусами.
- `CLAUDE.md` — правила проекта; «Portal traps» дополнены Vizzit.
- `docs/API.md` — контракт `/api/v1` (`source` = портал, `via`,
  `priceOnRequest`, `lastPriceChange`, подписка, 429, курсор `/events`).
- Команды дедупликации: `npm run dedup:audit [-- --communes=83115]` (отчёт по
  хранимым данным), `npm run dedup:check` (сухой прогон склейки),
  `npm run resolve -- --communes=83115` (склейка по коммуне, пишет).
- Коды коммун: Saint-Tropez 83119, Sainte-Maxime 83115, Grimaud 83068,
  La Croix-Valmer 83048, Cavalaire 83036, Ramatuelle 83101, Gassin 83065,
  Cogolin 83042, Roquebrune/Les Issambres 83107, Le Plan-de-la-Tour 83094,
  La Garde-Freinet 83063, La Môle 83079.
- Память Claude (`~/.claude/projects/…/memory/`): трафик, русский, биллинг
  Stream.Estate, доступ к базе, дедупликация как главный критерий качества.
- Obsidian: `PortalMonitoringAgent/PMA — *.md` — до 07.10.

---

## 8. Черновик письма в AVIV (не отправлено на 19.10)

Отвечать в переписку от 25.08. **Не упоминать**, что SeLoger уже приходит
через Stream.Estate. Вставить должность вместо `<FONCTION>`.

> **Objet : Re: Autorisation du 25 août — un accès technique simple, sans adresse IP fixe**
>
> Bonjour,
>
> Vous nous avez accordé le 25 août 2026 l'autorisation écrite de collecter les données d'annonces de SeLoger et Belles Demeures pour notre client Med-Estates, agence du golfe de Saint-Tropez. Merci encore. À ce jour, nous n'avons pas pu en faire usage une seule fois : vos protections refusent nos requêtes sur les deux sites, aussi bien les pages de recherche que les pages d'annonces. Mesuré en août, puis de nouveau début octobre.
>
> Nous ne cherchons pas à contourner ce refus. Nous ne déguisons pas notre trafic, c'est pourquoi nous vous écrivons. Nous vous proposons trois solutions, par ordre de préférence :
>
> 1. **Un flux, une API ou un export** des annonces du Var (83), avec la commune et la date de publication. Une lecture par jour remplacerait toute requête sur votre site.
> 2. **Une autorisation de notre robot par un en-tête d'identification.** Chaque requête porterait un en-tête dédié, dont vous choisiriez le nom et la valeur, qui vous permettrait de reconnaître notre trafic, de le limiter ou de le couper à tout moment, sans adresse IP fixe. Un autre portail a mis en place exactement ce dispositif avec nous, et il fonctionne. Notre robot s'identifie ainsi : `PortalMonitoringAgent/1.0 (+https://leadestate.com; contact@leadestate.com)`
> 3. **Un refus explicite**, que nous respecterons sans insister.
>
> Notre profil : douze communes du Var, une fois par nuit, pages d'annonces uniquement, au rythme que vous fixerez. Chaque bien présenté à notre client cite la source et renvoie vers votre annonce.
>
> Nous restons à votre disposition pour tout détail technique.
>
> Cordialement,
> Suleiman Sultanov, `<FONCTION>`
> Lead Estate — suleiman@leadestate.com
