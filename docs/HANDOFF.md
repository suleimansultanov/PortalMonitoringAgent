# Handoff — 2026-10-07 (сессия 07.10)

Для следующей сессии в Claude Code на Маке, в корне репозитория. Прочитай
целиком, потом `CLAUDE.md`. Секретов здесь нет: ключи в `.env.local` и в
GitHub Secrets. Предыдущий handoff (06.10) заменён этим; его содержание —
в git-истории этого файла (`a88e8df`) и в Obsidian (`PMA — Handoff.md`,
раздел 4–7 October).

Всё в `main`. Не закоммичены только чужие правки: `scripts/dump-data.sh`
(оператора, не трогать).

---

## 0. ПЕРВЫМ ДЕЛОМ

1. **Решение оператора: куда вести ссылку у объявлений «без источника»**
   (Stream.Estate, `takeUnnamed`). У них **нет URL вообще**, а
   `portal_listings.url` — NOT NULL, поэтому сейчас объекты, у которых ТОЛЬКО
   безымянные объявления (~44% отложенных, ~1 400 объектов — вероятно SeLoger
   и Figaro), не берутся даже при `takeUnnamed: true`. Варианты, см. §3:
   - (a) не брать — как сейчас;
   - (b) хранить служебный URL `https://api-v2.stream.estate/properties/<id>`
     + `raw.noPublicUrl: true`, в UI и в `/api/v1` вместо ссылки писать «нет
     публичной страницы (Stream.Estate)». **Моя рекомендация** — объект с
     ценой, фото, агентством и мандатом полезен и без ссылки, а ссылка на
     API честно говорит, откуда он;
   - (c) сделать `url` nullable — миграция + все места, где он рендерится.
   Без решения не делать.
2. **Decodo**: если ещё не отменён — отменить (срок был ~07.10, $11,25).
   Сменить пароль прокси. **Из `.env.local` убрать две строки** —
   комментарий `# Decodo trial …` и `PMA_RESIDENTIAL_PROXY=…` — я не смог:
   песочница не даёт править `.env.local`. Секрет в GitHub тоже удалить.
3. Старый ключ Stream.Estate **V1** (`ca7…`): удалить в их кабинете; после
   этого строки `STREAM_ESTATE_API_KEY` (две, одна закомментирована) в
   `.env.local` мёртвые — убрать.
4. **Проверить ночной проход 07→08.10 у `stream-estate`**: Leboncoin теперь
   берётся (`heldBack: []` применён в базе 07.10). Ожидание — до ~1 800
   новых записей (56% от 3 229 отложенных), склейка (resolve) заметно
   длиннее обычных 1 мин. `npm run source` и таблица ниже.
5. Решить: **выключить jamesedition** (`npm run source -- --disable=jamesedition`)
   — 403 каждую ночь с 16.09, в т.ч. 07.10. Я за.

---

## 1. Источники сейчас (проход в ночь 06→07.10, `portal_runs`)

| Источник | Вкл | Как | Ночь 06→07.10 | Состояние |
|---|---|---|---|---|
| luxuryestate | on | GitHub, browser | 1 999 seen, 22 new, 82 gone, 15 мин | ок |
| etreproprio | on | GitHub, browser | 1 335 seen, 40 new, 38 gone | ок |
| green-acres | on | GitHub, plain | 2 735 seen, 44 new, 34 gone, 610 fetched | ок; старые записи без цены ждут reparse (§5) |
| bienici | on | GitHub, API-записи | 2 840 seen, «471 new», 54 gone | ок; «471 new» — не новые, см. §4 |
| vizzit | on | GitHub, plain | 3 904 seen, 1 143 new, **158 fetched, 985 failed**, 23 мин | работает, но ~1 000 отказов каждую ночь, см. §4 |
| stream-estate | on | GitHub, API V2 beta | 614 seen, 11 new, 3 gone, 1 мин | ок; с 08.10 + Leboncoin |
| jamesedition | on | GitHub | 12 seen, 403 («refused 3 times in a row») | **выключить** (§0) |
| superimmo | on | свой workflow | — | медленно (429) + Turnstile; путь — партнёрство Med-Estates |
| figaro (Propriétés) | OFF | — | — | Cloudflare; прокси не помогает |
| figaro-immobilier | OFF | — | — | адаптер готов; Cloudflare после 1-й страницы |
| zoopla-overseas | OFF | — | — | адаптер готов; то же |
| smc | OFF | — | — | Cloudflare всем; письмо (разрешение от 25.08 есть) |

Активных объектов по заливу: **6 621** (07.10; 06.10 было 6 726 — ночные
делистинги + 1 удалённая аренда).

Stream.Estate в базе: 617 объявлений, 7 без объекта (в прошлом handoff
писал 13), 0 без коммуны.

---

## 2. Сделано за сессию (коммиты по порядку)

- `160c8a2` **Stream.Estate берёт Leboncoin** — `heldBack: []` в `seed.ts`,
  `npm run db:seed` выполнен, в базе проверено. `permissionNote` источника
  теперь говорит, на чём основано: *решение оператора 06.10 без письменного
  подтверждения Stream.Estate; Thomas на вопрос о лицензии (05.10) не
  ответил; заменить абзац его ответом, когда придёт*. `takeUnnamed` остаётся
  `false` — причина в §0.1. Там же: **Les Issambres по частям** — «Val
  d'Esquières» и «San Peïre» добавлены во фрагменты `communes.ts` и в
  `localities` Stream.Estate (La Garonnette — нет, она на границе с
  Sainte-Maxime). Тест `communes.test.ts`.
- `f9a6818` **«On request» только когда портал так говорит** (5.iv).
  Было: 228 активных объектов без цены, все подписаны «on request»; на
  самом деле флаг `raw.priceOnRequest` стоял у 58, остальные 170 — цены,
  которые парсер не прочитал (Green-Acres в долларах — 107, luxuryestate 43,
  figaro 42, superimmo 38). Теперь `priceOnRequest` на карточке, в деталях и
  в `/api/v1` (поле `priceOnRequest`); непрочитанная цена подписана «price
  not read». Там же **5.ii**: в `/api/v1/properties` и `/events` у объекта
  поле `lastPriceChange { at, priceFrom, priceTo, source }` — последнее
  `price_changed` по любому порталу объекта. **Серверной сортировки нет**
  (курсор по id ради полноты обхода) — Tomaz сортирует свою копию по
  `lastPriceChange.at`. Документировано в `docs/API.md` и OpenAPI; в
  `CLAUDE.md` — gotcha про null-цену.
- `2b2ab15` **JamesEdition: галерея со страницы, а не один `image` из
  JSON-LD.** Верхняя галерея (`je2-top-gallery`) — 5 фото в нескольких
  размерах; лента похожих (`ListingCard`, миниатюры `507x312xc`) — чужие
  дома, отсекается. Для 627 хранимых объявлений нужен reparse (§5, ~140 МБ).
- **Удалена аренда JamesEdition** (5.iii): объявление `da0451bd…`
  (`for-rent-exclusive-sea-view-retreat…-17557981`, 8,9 млн, Ramatuelle),
  1 событие и объект `eb0cb636…` (одно объявление, матчей нет). Прямым SQL
  в транзакции, проверено после. Фильтр аренды в адаптере был написан после
  того, как эта запись уже лежала в базе.

Тесты: **394 зелёные**, typecheck чистый.

---

## 3. Stream.Estate — всё, что известно

- **Биллинг V1 (письменно от Thomas, 05.10):** item = каждый возвращённый
  результат, повторный возврат — снова item; каждая доставка вебхука — item;
  `itemsPerPage=0` бесплатно; остаток не переносится; сверх 15 000 — €0,003.
- **V2 beta:** бесплатно на время беты, 500 запросов/мин, «keep volume
  reasonable». Ключ `STREAM_ESTATE_V2_API_KEY` (`se_…`) в `.env.local` и GitHub
  Secrets. Документация: https://next.docs.stream.estate. Ответы API сохранены в
  `.pages/stream-estate-v2/2026-10-06/`.
- **Их `updatedAt` двигается при каждом переобходе** → схема «только
  изменённые» на платном V1 не экономит. Экономный путь на платном — их события
  (NEW_MATCH, PRICE_CHANGE, EXPIRED).
- **SeLoger и Figaro в списке источников V2 нет вообще**; 43% объявлений в
  Сен-Тропе приходят без источника и без URL — вероятно это они.
- Конфиг источника (`seed.ts`, `stream-estate`): `ownSources` (что не берём
  повторно), `heldBack` (**пусто с 07.10**), `takeUnnamed` (false, §0.1),
  `localities` (83107 → issambres, esquieres, san peire).
- Из выборки 100 объектов Сен-Тропе по отложенным: ~56% имеют Leboncoin со
  ссылкой, ~44% — только безымянные без ссылки.
- Как работает `takeUnnamed` в адаптере (`toRecord`): даже при `true`
  объявление без URL отбрасывается (`if (!opts.takeUnnamed || !url)`), а
  `url` объявления берётся из `attributes.url`. Запись становится одним
  `portal_listings` с `url = primary(rec).url`. Для варианта (b) из §0: в
  `toRecord` пропускать безымянные без URL с пометкой, в `primary`/`discover`
  подставлять `${API}/properties/${rec.id}` (такой fallback уже есть в
  `parse`), в `raw` — `noPublicUrl: true`, и спрятать ссылку в
  `listings/[id]/page.tsx` («On these portals») и в `v1.ts` (`ListingPayload.url`).
- Первый полный проход 06.10: 39 мин (11,5 запись + ~25 склейка). Ночь
  06→07.10: 1 мин (614 seen, 11 new).

---

## 4. Найдено, не исправлено

- **Vizzit: ~1 000 отказов каждую ночь** (05.10 — 1 099, 06.10 — 1 040,
  07.10 — 985) при 3 900 на индексе и ~2 900 хранимых. Все хранимые строки
  распарсены (`parse_error` нет), значит «failed» — отказы на fetch, строки
  не создаются, и те же id каждую ночь снова «new» и снова запрашиваются:
  ~16 мин из 120-минутного бюджета. **Гипотеза:** это объявления, которые
  Vizzit редиректит на leboncoin.fr, а fetcher с `1acac0c` чужой редирект не
  следует (`FetchFailedError: redirects off-site`). Проверить по логу Actions
  (в конце прохода печатаются 5 `failureSamples`). Если так — либо помнить
  такие id (строки сегодня нет), либо принять как цену: это объявления
  Leboncoin, которые теперь приходят через Stream.Estate.
- **Bien'ici «471 new» каждую ночь** (466, 461, 473, 430, 468, 471), а строк
  добавляется ~48. Причина в `run.ts:518–528`: `known` грузится с фильтром
  `commune_insee in (коммуны прохода)`, а 444 строки Bien'ici без коммуны
  (Roquebrune вне Les Issambres) под фильтр не попадают → каждую ночь
  «added» → запись-upsert без изменений. Для Bien'ici бесплатно (записи
  приходят с индекса), но статистика прохода врёт, и для источника с
  постраничным fetch это были бы лишние запросы. Чинить: включать в `known`
  строки этого источника без коммуны, **не трогая** baseline guard'а
  (`run.ts:851`, комментарий у 887 объясняет почему).
- **Val d'Esquières** теперь матчится (§2), но уже хранимая строка Bien'ici
  (`Roquebrune-sur-Argens - Val d'Esquières - Port`, 83380) получит коммуну
  только при следующем парсе/reparse.
- **Другие строки без коммуны:** etreproprio 130, figaro 12, green-acres 4 —
  объекта не получают (property не создаётся), на экране не видны.

---

## 5. Открытые задачи

| # | Задача | Кто |
|---|---|---|
| — | §0.1: решение по ссылке для безымянных; потом `takeUnnamed` | оператор → я |
| — | §0.2–0.3: Decodo, пароль, строки в `.env.local`, ключ V1 | оператор |
| — | Green-Acres reparse старых записей: **~2,2 ГБ из S3**, только Wi-Fi или AWS. Пробный прогон 04.10: 777 цен, 994 площади, 632 участка, 82 пропущенных изменения цены. `npm run reparse -- --source=green-acres` | оператор запускает, я проверяю |
| — | JamesEdition reparse ради галереи: **~140 МБ из S3** (627 × ~220 КБ). `npm run reparse -- --source=jamesedition` | оператор / Wi-Fi |
| — | Выключить jamesedition (§0.5) | оператор |
| — | Vizzit 985 отказов/ночь — проверить гипотезу по логу, решить (§4) | я |
| — | Bien'ici «471 new» — `known` без коммуны (§4) | я |
| 31 | Web-app Tomaz: домены картинок (`file.bienici.com`, `cdn.stream.estate`, `lid.zoocdn.com`, `lh3.googleusercontent.com`…) | Tomaz |
| 5.ii | Tomaz: сортировать по `lastPriceChange.at`, баннер по `priceFrom/priceTo`; `priceOnRequest` вместо «on request» по null | Tomaz |
| — | Письма: Groupe Figaro (Propriétés + Figaro Immobilier, allowlist), JamesEdition, Zoopla, SMC; Thomas — лицензия SeLoger/LBC, срок беты, распространяется ли подписка V1 на V2 | оператор |
| — | AWS-сервер (`i-04e9585c80477d9fa`, t2.medium, остановлен): для порталов не нужен; полезен как EU-раннер (склейка/reparse). Держать или удалить | оператор |
| — | Obsidian: `PMA — Portals.md`, `PMA — Parser Traps.md` не обновлялись с 04.10 (Vizzit, Zoopla, Figaro Immobilier, Stream.Estate там нет); в `PMA — Handoff.md` есть раздел 4–7 October и короткая запись за 07.10 | я |
| — | Алерт GitHub про ключ Zoopla — закрыть как «used in tests», если ещё открыт | оператор |

Задачи Tomaz (5.i–vi): i — Vizzit, Figaro Immobilier, Zoopla, Stream.Estate
сделаны (два последних портала заблокированы Cloudflare); ii — поле есть,
сортировка на его стороне; iii — фото ✅, цены Green-Acres в коде ✅, задним
числом — reparse; iv — `priceOnRequest` ✅; v — курс не зависит от адреса
раннера ✅; vi — Stream.Estate собирается на бете, с 08.10 с Leboncoin.

---

## 6. Ловушки этой машины и процесса

- **Трафик.** Оператор часто на мобильном интернете. `reparse` качает из S3
  все страницы источника — «no network» в его выводе значит «без запросов к
  порталу», не «без трафика». Перед тяжёлым — сказать объём.
- **База из терминала:** `psql` есть (`/opt/homebrew/bin/psql`),
  `DATABASE_URL` брать из `.env.local` через `grep | cut`, не печатая. 07.10
  соединение было быстрым. Писать в базу — только в транзакции и с select
  после.
- **Песочница Claude Code (auto mode)** 07.10 не дала: править `.env.local`
  и запускать `npm test`. Тесты запускаются той же командой напрямую:
  `node --import tsx --test "src/**/*.test.ts"`.
- **Связь Мак → Supabase** бывает медленной на мобильных сетях (1–10 с на
  соединение). Длинные задачи — с Wi-Fi или с сервера.
- **`gh` не установлен**, настройки репозитория и секреты меняет оператор.
- **Не вставлять ключи в чат** — дважды уже вставлялись (прокси, V1).
- Ночной сбор: GitHub Actions `collect.yml`, 21:00 UTC, воскресенье — полный
  проход (`--full`). Ручной запуск: Actions → Nightly collection → `sources`.
  `portal_runs.started_at` в выводе psql — UTC.

---

## 7. Ссылки

- Obsidian: `PortalMonitoringAgent/PMA — Handoff.md` (разделы 4–7 October и
  7 October), `PMA — Parser Traps.md` (Green-Acres 04.10), `PMA — Portals.md`
  (статус 04.10).
- Память Claude: `~/.claude/projects/…/memory/` — трафик, русский язык,
  биллинг Stream.Estate, доступ к базе и ограничения песочницы.
- `CLAUDE.md` → «Portal traps» и «Gotchas» (null-цена ≠ on request).
