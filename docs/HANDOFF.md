# Handoff — 2026-10-15 (сессия 07–15.10)

Для следующей сессии в Claude Code на Маке, в корне репозитория. Прочитай
целиком, потом `CLAUDE.md`, потом [`docs/REVIEW-2026-10-15.md`](REVIEW-2026-10-15.md)
(ревью кода с приоритетами — это список работ). Секретов здесь нет: ключи в
`.env.local` и в GitHub Secrets. Предыдущие handoff — в git-истории этого файла
(`a88e8df` от 06.10, `cbf382d` от 14.10).

Всё в `main`, синхронизировано с origin, рабочее дерево чистое. Последний
коммит `ffed7c5`. Тесты **438 зелёные**:
`node --import tsx --test "src/**/*.test.ts"` (≈2 с). Typecheck чистый, если
не считать ошибок из устаревшего `.next/types` (`rm -rf .next` их убирает).

Оператор (Suleiman) пишет по-русски; код, коммиты и документация — по-английски.
Клиент — Med-Estates (Mark, `ai@med-estates.com`). Приложение клиента делает
Tomaz (`brain.med-estates.com`), оно читает наш `/api/v1`. **Решение оператора:
ничего не поручать Tomaz — всё, что видит приложение, решаем на своей стороне
в API.**

---

## 0. ПЕРВЫМ ДЕЛОМ (утро 16.10)

1. **Проверить первую настоящую ночь Stream.Estate V1.** Оператор добавил
   GitHub Secret `STREAM_ESTATE_API_KEY` 15.10 (в ночь 14→15 его не было, V1
   упал с «is not set», ничего не потратив). Ожидание: склад 11 коммун
   (La Môle уже взят 14.10 вручную), **~5 400 items**, дальше ~200 в день.
   ```sql
   select r.status, r.seen_count, r.new_count, r.fetched_count, r.error, r.started_at, r.completed_at - r.started_at
   from portal_runs r join portal_sources s on s.id = r.source_id
   where s.key = 'stream-estate-v1' order by r.started_at desc limit 3;
   select kind, count(*), sum(items) from api_usage where source_key = 'stream-estate-v1' and at >= '2026-10-14' group by 1;
   select commune_insee, state from source_commune_state order by 1;
   ```
   и `npm run stream:history -- --ledger`. **Сверить с кабинетом Stream.Estate**
   («items used»): их цифра — счёт, наша — страховка. На 15.10 наша = **54**
   (27 сверочная страница + 27 прогон La Môle). Расхождение — сразу разбираться.
   У коммун, где склад дошёл до конца, в `source_commune_state` должен быть
   `stockedAt`; где упёрся в лимит — `stockCursor`.
2. **Проверить, что Figaro / Figaro Immobilier / Superimmo пошли клиенту.**
   В `/status` у них сейчас `error` с датой 15.10 — это статус прохода V1
   (который упал из-за ключа), а не старых адаптеров. После удачной ночи
   должны стать `done` и получить объявления. Проверка тем же способом, что в
   сессии: скрипт с `snapshot()/status()` из `src/lib/api/v1.ts` против базы
   (см. §6 «как проверять API без ключа»).
3. Остальное по ночи: `portal_runs` за ночь, `refreshOnChange` у
   `stream-estate` (сколько перечитано), длительность склейки — **должна
   резко упасть** после `7defad4` (было 15–48 мин из-за 18 000 пустых
   UPDATE). Если не упала — смотреть `resolve.ts` `sameValue`.

---

## 1. Источники сейчас (`npm run source`)

| Источник | Вкл | Что даёт |
|---|---|---|
| vizzit | on | свой сборщик; ~1 000 отказов за ночь (вероятно редиректы на Leboncoin, см. §5) |
| bienici | on | свой, API-записи |
| green-acres | on | свой |
| etreproprio | on | свой, browser |
| luxuryestate | on | свой, browser, по разрешению (`X-Collector`) |
| **stream-estate** (V2) | on | бесплатная бета; SeLoger, Leboncoin, Belles Demeures, Idealista, PAP, Rightmove, SMC (мало), сайты агентств |
| **stream-estate-v1** | on | **платный**, клиентский; + Propriétés Le Figaro, Figaro Immobilier, Superimmo, Logic-Immo, ParuVendu |
| figaro | OFF | Cloudflare; данные в базе (2 135, с 16.09), клиенту не отдаются |
| figaro-immobilier | OFF | Cloudflare |
| jamesedition | OFF (14.10) | 403 с 16.09; нет ни в V1, ни в V2 — только письмо |
| superimmo | OFF (14.10) | 429 + Turnstile; расписание `superimmo.yml` снято (cron закомментирован) |
| smc | OFF | Cloudflare с 7.09; в V2 приходят только новые объявления (~25/мес) |
| zoopla-overseas | OFF | Cloudflare; нет ни в V1, ни в V2 — только письмо |

Активных объектов в базе 7 392; **клиенту через API отдаётся ~6 240**
(только то, что несёт хотя бы один включённый источник).

---

## 2. Решения оператора за сессию (не пересматривать без него)

- **Выключенные сборщики не отдаются через API, но данные лежат в базе**
  («пусть лежат»). Не снимать их объявления. Реализация: `SERVED_PROPERTY`
  в `src/lib/api/v1.ts`. Наш дашборд (`queries.ts`) этот фильтр пока **не**
  применяет — расхождение известно (REVIEW §2).
- **Порталы, которые нас не пускают, берём из Stream.Estate**, классифицируем
  по URL (`src/lib/portals/portalOf.ts`), склеиваем с остальным нашим
  резолвером. В API у объявления `source` = настоящий портал (`seloger`,
  `figaro`…), `via` = `stream-estate`/`stream-estate-v1`. Строка агрегатора
  разбивается на объявления по всем порталам, которые он несёт. Сайты
  отдельных агентств — один «портал» `agency-sites` («Agency websites»).
- **Leboncoin и SeLoger берём** (решение 06.10). Thomas письменно 08.10:
  Terms/AUP одинаковы для всех источников; письменное подтверждение для
  агентства — только Enterprise. Открытый риск — AUP 2.6 (использование для
  неавторизованной третьей стороны). Всё это в `permissionNote` источника.
- **V1 подписан** (Starter €99, 15 000 items/мес, сброс 14-го, сверх —
  €0,003 с карты Mark). Используется для ТЕКУЩИХ объявлений тех порталов,
  которых нет в V2. **История цен (10 174 объекта с 2021) отложена** на
  период с 14.11 — вместе со складом в один период не помещается.
- **Почасовой сбор — нет**: Stream.Estate сам перечитывает порталы примерно
  раз в сутки; час даст те же данные 23 раза из 24, а V1 платный.
- **Вебхуки на V1 — нет** (каждая доставка = item, возможно на каждое
  объявление, не на объект, и счётчик их не остановит). Если понадобятся —
  на V2 (бесплатно на бете).
- Предупреждать оператора перед тяжёлым по трафику (reparse качает ГБ из S3).

---

## 3. Stream.Estate V1 — платный, как устроен

- **Счётчик** `src/lib/portals/streamV1.ts` — единственное место, откуда
  можно обратиться к `api.stream.estate`. Журнал в таблице `api_usage`
  (append-only): `reserve` — до запроса, на размер страницы; `settle` —
  после, разница; незакрытый `reserve` = «в пути / неизвестно, оплачено ли».
  Потолок `monthlyItems − reserve` = **14 000**, проверяется до отправки;
  выше 15 000 только с `allowOverage`. Нечисловой потолок отклоняется.
  Без повторов платных запросов. `hydra:totalItems` обязателен в ответе.
  Бесплатный подсчёт (`itemsPerPage=0`), вернувший данные, останавливает всё.
- **Адаптер** `src/lib/portals/adapters/streamestatev1.ts`, источник
  `stream-estate-v1`, конфиг `changesOnly: true` (раннер не делает abort
  guard и не снимает «за отсутствие»; снятия — по имени через `ctx.gone`).
  **Состояние по коммунам** в `source_commune_state`:
  `stockedAt` (склад взят до конца), `stockCursor` (где лимит оборвал склад —
  следующей ночью продолжает с этого места), `changesSince` (двигается только
  когда все три обхода изменений коммуны завершились). Коммуна без
  `stockedAt` берёт склад (не expired, обновлён ≤30 дней), со — три запроса:
  created / re-priced / expired. Даты в запросах — по **Europe/Paris**.
  Les Issambres — по индексу 83380, не по INSEE Roquebrune.
- **Их даты**: `createdAt` V1 = их первое обнаружение, не публикация
  (Thomas, 09.10). В `publishedAt` не пишем (V2 пишет — это в REVIEW §2).
- **Команды**: `npm run stream:history` (план, бесплатно),
  `-- --ledger` (расход за период из базы), `-- --pull=price-changes`
  (без `--yes` — только показывает), `-- --analyse` (по диску, бесплатно).
  `npm run source -- --disable=stream-estate-v1` — остановить.
- **Нельзя**: полный проход по V1; запросы мимо счётчика; ключ в чат.
- Цифры (бесплатные подсчёты 13.10): склад 5 455; в день ~131 новых,
  ~26 изменений цены, ~46 снятых. Первый месяц ~11 500, дальше ~6 000.
- Спросить Thomas (бесплатно): формат значений `includedSites` (все пробы
  вернули 0) — позволил бы брать только Figaro/Superimmo и экономить; он же
  обещал на неделе 13.10 починить фото, которые V2 не прикрепляет к объекту
  (пример: property `01a0eeac-24ab-71e3-b223-dd689316a5d7`, Leboncoin 2390139342).

## 3b. Stream.Estate V2 (бесплатная бета)

- Ключ `STREAM_ESTATE_V2_API_KEY`. Полный проход каждую ночь (~60 запросов).
  `refreshOnChange: true`: известные записи сравниваются по хэшу со
  снимком и перечитываются только изменившиеся (запись Stream.Estate
  стабильна: 83 из 88 идентичны через 2 дня). У Bien'ici это НЕ включать —
  его записи меняются сами каждую ночь.
- Thomas 09.10: V2 «скоро» получит больше источников, полная мощность в
  октябре–ноябре; цены после беты не опубликованы. V2 начинается с 24.06.2026.
- Их слаги источников врут для `.co.uk` (`co`) — портал всегда по URL.

---

## 4. Что сделано за сессию (коммиты по смыслу, от старых к новым)

- Leboncoin + SeLoger из V2; Les Issambres по частям (Val d'Esquières, San Peïre).
- `priceOnRequest` в API и дашборде (null-цена ≠ «on request»);
  `lastPriceChange` у объекта в `/api/v1`.
- JamesEdition: галерея со страницы; Vizzit: галерея с `lb1.vizzit.com`
  (1 941 объявление было с одной обложкой).
- Портал по URL (`portalOf.ts`), разбиение агрегатора на порталы в API и на
  карточках, `/status` со строками порталов, `agency-sites`.
- V2 `refreshOnChange`. V1: счётчик, адаптер, `api_usage`,
  `source_commune_state`, `stream:history`.
- Выключены сломанные свои сборщики; API отдаёт только включённые источники.
- По ревью 15.10 (`ecb4d5a`, `c4d2fc1`, `7defad4`): события снятия снова
  отдаются в `/events`; площади в API числами; счётчик V1 (резервирование,
  валидация, водяные знаки по коммунам, время по Парижу); склейка сравнивает
  jsonb канонически (было 18 000 пустых UPDATE за ночь); очередь недельного
  обновления по `last_seen_at` (87% устаревших были ей невидимы); ingest не
  воскрешает снятое без `relisted` и не пишет фантомные `price_changed`.
- `scripts/dump-data.sh` откачен (там были случайные опечатки).

---

## 5. Открытые задачи

**Главный список — [`docs/REVIEW-2026-10-15.md`](REVIEW-2026-10-15.md), §7.**
Следующее по порядку (неделя):

1. Helper `incomplete` для 7 адаптеров, которые при убранной из конфига
   коммуне снимают весь её склад (REVIEW 1.6).
2. `dump-data.sh` — добавить `client_api_keys`, `api_usage`,
   `source_commune_state`; `sync-to-supabase.sh` — удалить или защитить
   (сейчас TRUNCATE продакшена без подтверждения) (1.7–1.8).
3. CI: `typecheck` + тесты на push; уведомление о красной ночи.
4. Дашборд = API по фильтру включённых источников; `properties.price_eur`
   брать только из обслуживаемых объявлений; `sourceCount` по порталам.
5. Склейка: эвикция по ключу корня (REVIEW §2); retry к базе в ingest.

Прочее (не из ревью):

| Задача | Кто |
|---|---|
| Сверить расход V1 с кабинетом Stream.Estate после первой ночи | я + оператор |
| Письмо в AVIV (SeLoger + Belles Demeures) — черновик в §8; адрес — ответом в переписку от 25.08 в почте оператора (публичного адреса для данных у AVIV нет) | оператор |
| Письма: Groupe Figaro (оба Figaro, разрешение на Propriétés есть), JamesEdition, Zoopla, SMC — черновики сентября в Obsidian `PMA — Portal Letters.md`, нужно обновить | я → оператор |
| Vizzit reparse ради галерей: `npm run reparse -- --source=vizzit`, **~1,6 ГБ из S3**, только Wi-Fi | оператор |
| Green-Acres reparse старых записей: **~2,2 ГБ из S3**, только Wi-Fi | оператор |
| Vizzit ~1 000 отказов каждую ночь — проверить по логу Actions (`failureSamples`): гипотеза — редиректы на leboncoin.fr | я |
| Bien'ici «~470 new» каждую ночь при ~48 реальных — 444 строки без коммуны выпадают из `known` | я |
| Объявления Leboncoin «Recherche maison…» (поиск, не продажа) попадают в пул — фильтр по заголовку | я |
| 2 объекта SeLoger записаны в Grimaud при URL в Sainte-Maxime — посчитать масштаб несовпадения коммуны Stream.Estate с URL | я |
| Тенантность дашборда и `client_sources` в `/api/v1` (латентно, пока клиент один) | потом |
| Obsidian (`PMA — Handoff/Portals/Parser Traps`) не обновлялся с 07.10 | я |
| Decodo: проверить, что пробный период отменён, пароль сменён; `PMA_RESIDENTIAL_PROXY` убрать из `.env.local` и Secrets | оператор |

**Ключи (важно, в прошлом handoff было иначе):** `STREAM_ESTATE_API_KEY` —
теперь **живой ключ клиента V1** (в `.env.local` и GitHub Secrets), НЕ
удалять. Это тот же ключ `ca7…`, что раньше был пробным: на аккаунте теперь
подписка (оператор, 15.10). Не перепроверять и не просить заменить.

---

## 6. Ловушки машины и процесса

- **Трафик.** Оператор часто на мобильном интернете. `reparse` качает из S3
  все страницы источника. Перед тяжёлым — назвать объём.
- **База из терминала:** `psql` есть; `DATABASE_URL` из `.env.local` через
  `grep | cut`, не печатая. Писать в базу — в транзакции, select после.
- **Песочница auto mode** не даёт править `.env.local` и запускать
  `npm test` — запускать `node --import tsx --test "src/**/*.test.ts"`.
  `git push` иногда блокируется классификатором, если оператор явно не
  просил; обычно проходит после явной просьбы.
- **Как проверять API без ключа:** временный файл в `src/*.tmp.ts`,
  импортирующий `snapshot`/`status`/`events` из `@/lib/api/v1`, scope
  клиента из `clients` + `client_sources`; запуск `npx tsx src/x.tmp.ts`,
  потом удалить файл. Читает базу, ничего не пишет.
- **Деплой API**: Vercel собирает с `main`. Доступа к Vercel нет —
  подтверждение деплоя только по приложению Tomaz.
- **`gh` не установлен**; секреты GitHub и настройки репозитория меняет оператор.
- **Ключи в чат не вставлять** — дважды уже было.
- Ночной сбор: `collect.yml`, cron 21:00 UTC, реально стартует в 00:30–03:30
  UTC (очередь GitHub). Воскресенье — полный проход (кроме V1: у него полного
  прохода нет никогда).

---

## 7. Ссылки

- [`docs/REVIEW-2026-10-15.md`](REVIEW-2026-10-15.md) — ревью кода, приоритеты, порядок работ.
- `CLAUDE.md` — правила проекта; «Portal traps» дополнены (Stream.Estate
  агрегатор, V1 платный и только через счётчик).
- `docs/API.md` — контракт `/api/v1` (source = портал, `via`,
  `priceOnRequest`, `lastPriceChange`, только включённые источники).
- Память Claude (`~/.claude/projects/…/memory/`): трафик, русский, биллинг
  Stream.Estate (V1 активен), доступ к базе и ограничения песочницы.
- Obsidian: `PortalMonitoringAgent/PMA — *.md` — до 07.10.

---

## 8. Черновик письма в AVIV (не отправлено на 15.10)

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
