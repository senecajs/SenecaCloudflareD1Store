![Seneca](http://senecajs.org/files/assets/seneca-logo.png)
> A [Seneca.js][] data storage plugin.

# @seneca/cloudflare-d1-store

[![npm version][npm-badge]][npm-url]
[![Build](https://github.com/senecajs/SenecaCloudflareD1Store/actions/workflows/build.yml/badge.svg)](https://github.com/senecajs/SenecaCloudflareD1Store/actions/workflows/build.yml)

| ![Voxgig](https://www.voxgig.com/res/img/vgt01r.png) | This open source module is sponsored and supported by [Voxgig](https://www.voxgig.com). |
|---|---|

## Description

`@seneca/cloudflare-d1-store` is a [Seneca](http://senecajs.org) plugin that provides an entity data store backed by [Cloudflare D1](https://developers.cloudflare.com/d1/), Cloudflare's serverless SQLite database.

Unlike KV and R2, D1 supports full SQL queries — `list$` with field filtering, sorting, pagination, and `fields$` projection all work natively via SQL `WHERE`, `ORDER BY`, and `LIMIT` clauses. Each entity type is stored in its own table, with each row holding the entity JSON in a `data` column.

## Install

```sh
npm install @seneca/cloudflare-d1-store
```

## Usage

### Worker binding mode

Pass the `D1Database` binding from your Cloudflare Worker directly:

```js
import CloudflareD1Store from '@seneca/cloudflare-d1-store'

seneca
  .use('entity')
  .use(CloudflareD1Store, {
    d1: { binding: env.MY_DB },
  })
```

> **Note:** Miniflare's D1Database is a Proxy whose descriptor traps can conflict with Seneca's option merger. If you encounter this in tests, wrap the binding first:
> ```js
> const binding = {
>   prepare: (sql) => db.prepare(sql),
>   batch: (stmts) => db.batch(stmts),
>   exec: (sql) => db.exec(sql),
> }
> ```

### REST API mode (Node / CI)

Use the Cloudflare D1 HTTP API with your account credentials:

```js
seneca
  .use('entity')
  .use(CloudflareD1Store, {
    d1: {
      accountId: 'your-account-id',
      apiToken: 'your-api-token',
      databaseId: 'your-database-id',
    },
  })
```

## Options

| Option | Default | Description |
|---|---|---|
| `d1.binding` | — | `D1Database` Workers binding (takes priority over REST client) |
| `d1.accountId` | `''` | Cloudflare account ID (for REST API) |
| `d1.apiToken` | `''` | Cloudflare API token (for REST API) |
| `d1.databaseId` | `''` | D1 database ID (for REST API) |
| `d1.baseUrl` | `'https://api.cloudflare.com/client/v4'` | Cloudflare API base URL |
| `cmd.list.size` | `11` | Default page size for `list$` |

## Table and key scheme

Each entity type maps to a SQL table derived from its canon:

| Entity canon | Table name |
|---|---|
| `foo` | `foo` |
| `foo/bar` | `foo_bar` |
| `zone/base/name` | `base_name` |

Tables are created automatically on first use (`CREATE TABLE IF NOT EXISTS`). Each table has two columns: `id TEXT PRIMARY KEY` and `data TEXT` (the entity as JSON).

## Querying

`list$` translates query fields to SQL `WHERE` conditions using SQLite's `json_extract`:

```js
// SELECT data FROM foo_bar WHERE json_extract(data,'$.color') = 'red' ORDER BY ... LIMIT 11 OFFSET 0
const list = await seneca.entity('foo/bar').list$({ color: 'red' })

// With sort, pagination and field projection
const page = await seneca.entity('foo/bar').list$({
  color: 'red',
  sort$: { name: 1 },
  limit$: 10,
  skip$: 20,
  fields$: ['id', 'name'],
})
```

## Native driver

```js
const { client } = seneca.export('CloudflareD1Store/native')()
```

Returns the active `D1Client` instance (binding adapter or REST client).

## License

Copyright (c) 2024 the Seneca Project Contributors, MIT License.

[Seneca.js]: http://senecajs.org
[npm-badge]: https://img.shields.io/npm/v/@seneca/cloudflare-d1-store.svg
[npm-url]: https://npmjs.com/package/@seneca/cloudflare-d1-store
