# `/api/v1` — the contract with client instances

One consumer: a client instance, pulling market data to run its own buyer
matching. Not a public API and not a browser client — which is why it
authenticates with a key rather than a session, and why the shape below is
narrow on purpose.

## Authentication

```
Authorization: Bearer pma_live_…
```

`X-Api-Key: pma_live_…` works too, for clients whose HTTP layer makes bearer
tokens awkward.

Issue and withdraw keys from the command line:

```bash
npm run key:create -- --client=med-estates --name="production"
npm run key:list
npm run key:revoke -- --prefix=pma_live_ab12cd
```

A key is shown **once**. Only its SHA-256 hash is stored, so a lost key is
replaced, not recovered. Rotation is two live keys at the same time: issue the
new one, deploy it, revoke the old one.

**Scope comes from the key, never from the request.** What a key may read is
`clients.commune_insee` and `client_sources` for the client it belongs to.
`?commune=` narrows within that and cannot widen it: communes outside the scope
are dropped from the filter rather than rejected, because an error would confirm
which communes exist.

Every failure — unknown key, revoked, expired, inactive client — answers the
same `401`.

## `GET /api/v1/properties` — the snapshot

For an instance starting from empty, and for periodic reconciliation.

| | |
|---|---|
| `commune` | comma-separated INSEE codes, within scope |
| `after` | `nextCursor` from the previous page |
| `limit` | 1–500, default 200 |

```json
{
  "properties": [ { "id": "…", "priceEur": 1160000, "areaM2": 85, "rooms": 3,
                    "bedrooms": 2, "communeInsee": "83119", "sourceCount": 3,
                    "listings": [ { "source": "figaro", "url": "https://…" } ] } ],
  "nextCursor": "…",
  "communes": ["83119", "…"],
  "caveat": "…"
}
```

Paged by `id`, not by date. A cursor on a mutable column skips and repeats rows
while you page, and the nightly pass mutates `updated_at` on hundreds of rows —
so a walk stays complete even if it takes an hour and collection runs during it.

Do not poll this daily once you are running. Twenty changes are not worth
re-reading the whole market, and the cost grows with the corpus.

## `GET /api/v1/events` — the delta

What *happened*, not what changed. `listed`, `price_changed`, `delisted`,
`relisted`, `availability_changed`, `updated`. Each event carries the full
property, so acting on one needs no second call.

| | |
|---|---|
| `since` | `nextCursor` from the previous response |
| `type` | comma-separated, to narrow |
| `commune` | within scope |
| `limit` | 1–500, default 200 |

The walk: call with no cursor, act on the page, keep `nextCursor`, call again
with `since=` until it comes back null.

The cursor encodes `(occurred_at, id)` — the pair. A timestamp alone steps
silently over one of two events written in the same millisecond.

A malformed `since` is a `400`, not a restart from the beginning. Silently
replaying the whole history would have an instance announce every property it
already knows as new.

**`delisted` does not mean sold.** The listing disappeared. That happens when it
sells, when the owner withdraws it, when the agency's subscription lapses, and
when it moves to a competitor. We cannot tell which, and an instance must not
supply the missing word.

## `GET /api/v1/status` — is this current?

```json
{
  "client": "med-estates",
  "lastSuccessfulCollectionAt": "2026-09-01T04:41:00.000Z",
  "properties": 7753,
  "sources": [ { "key": "figaro", "lastRunAt": "…", "lastOutcome": "done" } ]
}
```

**Pull when `lastSuccessfulCollectionAt` advances, not on a clock of your own.**
An instance on a fixed schedule eventually reads while a pass is still running,
shows an agent a half-collected market, and says nothing about it. Passes here
run long by design — the refresh budget varies with what has fallen due.

"Successful" means the pass finished. A pass whose fetching stopped part-way is
still recorded with `status = 'done'` and the reason only in `error`, so the
query behind this field excludes those explicitly.

## Dates, and what they are not

`firstListedAt` is **our first sighting**. Three portals publish a real
publication date (Figaro, Superimmo, LuxuryEstate) and the rest do not, so for
much of the corpus this is a lower bound rather than a measurement — anything
listed before we began collecting looks newer than it is. The caveat is repeated
on every response rather than left here.

## Onboarding a client

```sql
insert into clients (slug, name, commune_insee)
values ('acme', 'Acme Immobilier', array['83119','83061']);

insert into client_sources (client_id, source_id, enabled)
select c.id, s.id, true from clients c, portal_sources s
where c.slug = 'acme' and s.key in ('figaro','green-acres');
```

```bash
npm run key:create -- --client=acme --name="production"
```

A client in an area already covered adds **no crawling at all** — the collector
takes the union of every subscriber's communes, so the second client in the Gulf
of Saint-Tropez costs nothing. A client elsewhere needs the commune tokens for
each portal researched and verified first; see `PMA — Client Instances` in the
vault.
