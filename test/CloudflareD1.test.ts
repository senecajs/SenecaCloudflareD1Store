/* Copyright © 2024 Seneca Project Contributors, MIT License. */

import { createServer, Server } from 'node:http'
import { AddressInfo } from 'node:net'

import Seneca from 'seneca'
import type {} from '@seneca/entity'
import { Miniflare } from 'miniflare'
import { build } from 'esbuild'

import CloudflareD1StoreDoc from '../src/CloudflareD1StoreDoc'
import CloudflareD1Store from '../src/CloudflareD1Store'

const REST = {
  accountId: 'acct-local',
  apiToken: 'token-local',
  databaseId: 'db-local',
}

let mf: Miniflare
let standIn: { server: Server; baseUrl: string }

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['TEST_D1', 'REST_D1'],
  })

  standIn = await startD1RestStandIn(await mf.getD1Database('REST_D1'))
})

afterAll(async () => {
  await new Promise((resolve) => standIn.server.close(resolve))
  await mf.dispose()
})

describe('CloudflareD1Store', () => {
  let seneca: any

  beforeAll(async () => {
    seneca = await makeSeneca('binding')
  })

  test('load-plugin', () => {
    expect(CloudflareD1Store).toBeDefined()
    expect(CloudflareD1StoreDoc).toBeDefined()
    expect(seneca.export('CloudflareD1Store/native')).toBeDefined()
    expect(seneca.export('CloudflareD1Store/native')().client).toBeDefined()
  })

  test('utils.entityTable', async () => {
    const { entityTable } = CloudflareD1Store['utils']
    const s = Seneca({ legacy: false }).test().use('@seneca/entity')
    await s.ready()

    expect(entityTable(s.make('foo'))).toEqual('foo')
    expect(entityTable(s.make('foo/bar'))).toEqual('foo_bar')
    expect(entityTable(s.make('zone/base/name'))).toEqual('base_name')

    // A canon that is not an identifier never reaches the SQL text.
    const fake = (canon: any) => ({ canon$: () => canon })
    expect(() =>
      entityTable(fake({ name: 'x" (id TEXT); DROP TABLE foo; --' })),
    ).toThrow('invalid table name')
    expect(() => entityTable(fake({ base: 'a b', name: 'c' }))).toThrow(
      'invalid table name',
    )
  })

  test('utils.buildWhere', () => {
    const { buildWhere } = CloudflareD1Store['utils']

    expect(buildWhere({})).toEqual({ where: '', params: [] })
    expect(buildWhere({ a: 1, b: 'x' })).toEqual({
      where: ' WHERE json_extract(data, ?) = ? AND json_extract(data, ?) = ?',
      params: ['$.a', 1, '$.b', 'x'],
    })
    expect(buildWhere({ id: '1', limit$: 5 })).toEqual({
      where: ' WHERE json_extract(data, ?) = ?',
      params: ['$.id', '1'],
    })
  })

  test('utils.buildOrder', () => {
    const { buildOrder } = CloudflareD1Store['utils']

    expect(buildOrder({})).toEqual({ order: '', params: [] })
    expect(buildOrder({ sort$: { a: 1, b: -1 } })).toEqual({
      order: ' ORDER BY json_extract(data, ?) ASC, json_extract(data, ?) DESC',
      params: ['$.a', '$.b'],
    })
  })

  test('generate_id option', async () => {
    let n = 0
    const s = await makeSeneca('binding', {
      generate_id: (ent: any) =>
        'item' === ent.canon$({ object: true }).name ? 'gen-' + ++n : undefined,
    })

    const a = await s.entity('gen/item').data$({ x: 1 }).save$()
    expect(a.id).toEqual('gen-1')

    // undefined from the option: the entity plugin generates the id.
    const b = await s.entity('gen/other').data$({ x: 2 }).save$()
    expect(typeof b.id).toEqual('string')
    expect(b.id.length).toBeGreaterThan(0)
    expect(b.id).not.toMatch(/^gen-/)
  })

  test('invalid options are rejected', async () => {
    for (const bad of [{ generate_id: 'not-a-function' }, { bad: 1 }]) {
      const errs: any[] = []
      const s = Seneca({ legacy: false, debug: { undead: true } })
        .test((err: any) => errs.push(err), 'silent')
        .use('@seneca/entity')
        .use(CloudflareD1Store, bad)
      await s.ready()
      expect(errs.map((err: any) => err.code)).toEqual([
        'invalid_plugin_option',
      ])
      await s.close()
    }
  })

  test('d1.binding reaches the plugin unchanged', async () => {
    const binding = wrapBinding(await mf.getD1Database('TEST_D1'))
    const s = await makeSeneca('binding', { d1: { binding } })
    expect(s.export('CloudflareD1Store/native')().client).toBeDefined()
    const ent = await s.entity('same/binding').data$({ x: 1 }).save$()
    expect(ent.x).toEqual(1)
  })
})

// The same entity tests run through the Workers binding and through the
// REST client. The REST client talks to a local stand-in for the D1 REST
// API that runs each statement on a Miniflare D1 database.
describe.each(['binding', 'rest'] as const)('crud (%s)', (mode) => {
  let seneca: any

  beforeAll(async () => {
    seneca = await makeSeneca(mode)
  })

  test('save and load by id', async () => {
    const ent = await seneca
      .entity('foo/bar')
      .data$({ x: 1, y: 'hello' })
      .save$()

    expect(ent.id).toBeDefined()
    expect(ent).toMatchObject({ x: 1, y: 'hello' })

    const loaded = await seneca.entity('foo/bar').load$(ent.id)
    expect(loaded).toMatchObject({ id: ent.id, x: 1, y: 'hello' })
  })

  test('save with id$', async () => {
    const ent = await seneca
      .entity('foo/bar')
      .data$({ id$: 'fixed-' + mode, x: 7 })
      .save$()
    expect(ent.id).toEqual('fixed-' + mode)

    const loaded = await seneca.entity('foo/bar').load$({ x: 7 })
    expect(loaded).toMatchObject({ id: 'fixed-' + mode, x: 7 })
  })

  test('load missing returns null', async () => {
    const loaded = await seneca.entity('foo/bar').load$('no-such-id')
    expect(loaded).toEqual(null)

    const byQuery = await seneca.entity('foo/bar').load$({ x: -1 })
    expect(byQuery).toEqual(null)
  })

  test('list all', async () => {
    const s = await makeSeneca(mode)

    await s.entity('list/item').data$({ n: 1 }).save$()
    await s.entity('list/item').data$({ n: 2 }).save$()
    await s.entity('list/item').data$({ n: 3 }).save$()

    const list = await s.entity('list/item').list$({})
    expect(list.length).toBeGreaterThanOrEqual(3)
  })

  test('list with field filter', async () => {
    const s = await makeSeneca(mode)

    await s.entity('filter/item').data$({ color: 'red', v: 1 }).save$()
    await s.entity('filter/item').data$({ color: 'blue', v: 2 }).save$()
    await s.entity('filter/item').data$({ color: 'red', v: 3 }).save$()

    const list = await s.entity('filter/item').list$({ color: 'red' })
    expect(list.length).toEqual(2)
    expect(list.every((e: any) => e.color === 'red')).toBe(true)
  })

  test('list with sort$', async () => {
    const s = await makeSeneca(mode)

    await s.entity('sort/item').data$({ n: 3 }).save$()
    await s.entity('sort/item').data$({ n: 1 }).save$()
    await s.entity('sort/item').data$({ n: 2 }).save$()

    const asc = await s.entity('sort/item').list$({ sort$: { n: 1 } })
    const vals = asc.map((e: any) => e.n)
    expect(vals).toEqual([1, 2, 3])

    const desc = await s.entity('sort/item').list$({ sort$: { n: -1 } })
    const valsDesc = desc.map((e: any) => e.n)
    expect(valsDesc).toEqual([3, 2, 1])
  })

  test('list with limit$ and skip$', async () => {
    const s = await makeSeneca(mode)

    for (let i = 0; i < 5; i++) {
      await s.entity('page/item').data$({ i }).save$()
    }

    const page = await s
      .entity('page/item')
      .list$({ sort$: { i: 1 }, limit$: 2, skip$: 1 })
    expect(page.map((e: any) => e.i)).toEqual([1, 2])
  })

  test('list with fields$', async () => {
    const ent = await seneca.entity('foo/bar').data$({ a: 1, b: 2 }).save$()

    const list = await seneca
      .entity('foo/bar')
      .list$({ id: ent.id, fields$: ['a'] })

    expect(list[0].a).toEqual(1)
    expect(list[0].b).toBeUndefined()
  })

  test('remove by id', async () => {
    const ent = await seneca.entity('foo/bar').data$({ x: 99 }).save$()

    await seneca.entity('foo/bar').remove$(ent.id)

    const loaded = await seneca.entity('foo/bar').load$(ent.id)
    expect(loaded).toEqual(null)
  })

  test('remove first match', async () => {
    const s = await makeSeneca(mode)

    await s.entity('first/item').data$({ tag: 'z' }).save$()
    await s.entity('first/item').data$({ tag: 'z' }).save$()

    await s.entity('first/item').remove$({ tag: 'z' })

    const remaining = await s.entity('first/item').list$({ tag: 'z' })
    expect(remaining.length).toEqual(1)
  })

  test('remove with all$', async () => {
    const s = await makeSeneca(mode)

    await s.entity('del/item').data$({ tag: 'x' }).save$()
    await s.entity('del/item').data$({ tag: 'x' }).save$()
    await s.entity('del/item').data$({ tag: 'y' }).save$()

    await s.entity('del/item').remove$({ tag: 'x', all$: true })

    const remaining = await s.entity('del/item').list$({})
    expect(remaining.length).toEqual(1)
    expect(remaining.every((e: any) => e.tag !== 'x')).toBe(true)
  })

  test('update existing entity', async () => {
    const ent = await seneca.entity('foo/bar').data$({ x: 1 }).save$()

    ent.x = 2
    const updated = await ent.save$()
    expect(updated.x).toEqual(2)

    const loaded = await seneca.entity('foo/bar').load$(ent.id)
    expect(loaded.x).toEqual(2)
  })

  // Regression test: make$({id}).save$(patch) is seneca-entity's own
  // idiom for a partial update — the entity instance passed to save$
  // only ever carries {id, ...patch}, never the row's other fields. A
  // save implementation that just re-serializes that instance (rather
  // than merging onto the existing row first) silently drops every
  // column the caller didn't name. Deliberately a *different* code path
  // than the 'update existing entity' test above, which reuses the same
  // in-memory entity instance across both save$ calls and so never
  // exercises the partial-object case at all.
  test('partial update via make$({id}).save$(patch) preserves untouched fields', async () => {
    const created = await seneca
      .entity('foo/partial')
      .data$({ a: 1, b: 'keep-me', c: true })
      .save$()

    const updated = await seneca
      .entity('foo/partial')
      .make$({ id: created.id })
      .save$({ a: 2 })

    expect(updated.a).toEqual(2)
    expect(updated.b).toEqual('keep-me')
    expect(updated.c).toEqual(true)

    const loaded = await seneca.entity('foo/partial').load$(created.id)
    expect(loaded.a).toEqual(2)
    expect(loaded.b).toEqual('keep-me')
    expect(loaded.c).toEqual(true)
  })

  test('SQL keyword or leading digit as entity name', async () => {
    const ent = await seneca.entity('order').data$({ total: 5 }).save$()
    const loaded = await seneca.entity('order').load$(ent.id)
    expect(loaded.total).toEqual(5)

    const ent1 = await seneca.entity('1st/item').data$({ total: 6 }).save$()
    const loaded1 = await seneca.entity('1st/item').load$(ent1.id)
    expect(loaded1.total).toEqual(6)
  })

  // Query and sort$ field names are bound parameters, so a field name
  // cannot change the SQL statement.
  test('field names cannot inject SQL', async () => {
    const s = await makeSeneca(mode)

    await s.entity('inject/item').data$({ a: 1 }).save$()
    await s.entity('inject/item').data$({ a: 2 }).save$()

    const evil = "a') = 0 OR 1=1 OR json_extract(data, '$.a"
    const list = await s.entity('inject/item').list$({ [evil]: 1 })
    expect(list).toEqual([])

    const sorted = await s
      .entity('inject/item')
      .list$({ sort$: { ["a') ASC; DROP TABLE inject_item; --"]: 1 } })
    expect(sorted.length).toEqual(2)

    await s.entity('inject/item').remove$({ [evil]: 1, all$: true })
    const remaining = await s.entity('inject/item').list$({})
    expect(remaining.length).toEqual(2)
  })
})

describe('makeRestClient', () => {
  const realFetch = global.fetch

  afterEach(() => {
    global.fetch = realFetch
  })

  test('query calls D1 REST API', async () => {
    const { makeRestClient } = CloudflareD1Store['utils']

    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        result: [{ results: [{ data: '{"id":"1","x":42}' }] }],
      }),
    })

    global.fetch = mockFetch as any

    const client = makeRestClient({
      accountId: 'acct',
      apiToken: 'tok',
      databaseId: 'db1',
      baseUrl: 'https://api.cloudflare.com/client/v4',
    })

    const rows = await client.query('SELECT data FROM foo WHERE id = ?', ['1'])
    expect(rows).toEqual([{ data: '{"id":"1","x":42}' }])

    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toContain('/accounts/acct/d1/database/db1/query')
    expect(JSON.parse(init.body)).toMatchObject({
      sql: 'SELECT data FROM foo WHERE id = ?',
      params: ['1'],
    })
    expect(init.headers.Authorization).toEqual('Bearer tok')
  })

  test('HTTP error from the REST API', async () => {
    const { makeRestClient } = CloudflareD1Store['utils']
    const client = makeRestClient({
      ...REST,
      apiToken: 'wrong-token',
      baseUrl: standIn.baseUrl,
    })
    await expect(client.query('SELECT 1')).rejects.toThrow(
      'CloudflareD1Store: query failed: 403',
    )
  })

  test('query error from the REST API', async () => {
    const { makeRestClient } = CloudflareD1Store['utils']

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: false,
        errors: [{ code: 7500, message: 'no such table: nope' }],
      }),
    }) as any

    const client = makeRestClient({ ...REST, baseUrl: standIn.baseUrl })
    await expect(client.run('SELECT * FROM nope')).rejects.toThrow(
      'CloudflareD1Store: query error: [{"code":7500,"message":"no such table: nope"}]',
    )
  })

  test('entity action error from the REST API', async () => {
    const s = await makeSeneca(
      'rest',
      { d1: { ...REST, apiToken: 'wrong-token', baseUrl: standIn.baseUrl } },
      'silent',
    )
    await expect(s.entity('foo/bar').data$({ x: 1 }).save$()).rejects.toThrow(
      'query failed: 403',
    )
  })
})

// Seneca, @seneca/entity and this store run inside workerd, in a Worker
// that Miniflare starts, with the D1Database binding of the Worker's env
// passed as the d1.binding option.
describe('inside workerd', () => {
  test('crud through env binding', async () => {
    const script = await bundleWorker(`
      import Seneca from 'seneca'
      import Entity from '@seneca/entity'
      import CloudflareD1Store from '../src/CloudflareD1Store'

      export default {
        async fetch(request, env) {
          const seneca = Seneca({ legacy: false, log: 'silent' })
            .use(Entity)
            .use(CloudflareD1Store, { d1: { binding: env.DB } })
          await seneca.ready()

          const saved = await seneca.entity('w/item').data$({ n: 1 }).save$()
          await seneca.entity('w/item').data$({ n: 2 }).save$()
          const loaded = await seneca.entity('w/item').load$(saved.id)
          const list = await seneca.entity('w/item').list$({ sort$: { n: -1 } })
          await seneca.entity('w/item').remove$(saved.id)
          const gone = await seneca.entity('w/item').load$(saved.id)
          await seneca.close()

          return Response.json({
            loaded: loaded.data$(false),
            list: list.map((e) => e.n),
            gone,
          })
        },
      }
    `)

    const worker = new Miniflare({
      modules: true,
      script,
      compatibilityDate: '2026-01-01',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['DB'],
    })

    try {
      const res = await worker.dispatchFetch('http://localhost/')
      const out: any = await res.json()
      expect(out.loaded).toMatchObject({ n: 1 })
      expect(out.list).toEqual([2, 1])
      expect(out.gone).toEqual(null)
    } finally {
      await worker.dispose()
    }
  })
})

// Bundles a Worker module from source that imports seneca, @seneca/entity
// and the store. workerd provides the Node.js built-in modules that Seneca
// needs through the nodejs_compat flag.
async function bundleWorker(contents: string) {
  const out = await build({
    stdin: { contents, resolveDir: __dirname, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    logLevel: 'error',
    banner: {
      js:
        "import { createRequire } from 'node:module';" +
        "const require = createRequire('/');",
    },
  })
  return out.outputFiles[0].text
}

async function makeSeneca(
  mode: 'binding' | 'rest',
  options: any = {},
  log?: string,
) {
  const d1 =
    'binding' === mode
      ? { binding: wrapBinding(await mf.getD1Database('TEST_D1')) }
      : { ...REST, baseUrl: standIn.baseUrl }

  const seneca = Seneca({ legacy: false })
    .test(log)
    .use('@seneca/entity')
    .use(CloudflareD1Store, { d1, ...options })
  await seneca.ready()
  return seneca
}

// Miniflare's D1Database is a Proxy whose descriptor traps crash Seneca's
// option merger (nua). Wrapping it in a plain object avoids the issue.
function wrapBinding(db: any) {
  return {
    prepare: (sql: string) => db.prepare(sql),
    batch: (stmts: any[]) => db.batch(stmts),
    exec: (sql: string) => db.exec(sql),
  }
}

// A local stand-in for the Cloudflare D1 REST API, for the one endpoint
// that the REST client calls: POST
// /accounts/{account_id}/d1/database/{database_id}/query, with a JSON body
// {sql, params}. The response has the documented envelope
// {success, errors, messages, result: [{success, meta, results}]}. Each
// statement runs on a Miniflare D1 database. Port 0: the system picks a
// free port.
async function startD1RestStandIn(db: any) {
  const route = /^\/client\/v4\/accounts\/([^/]+)\/d1\/database\/([^/]+)\/query$/

  const server = createServer(async (req, res) => {
    const send = (status: number, body: any) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    const fail = (status: number, code: number, message: string) =>
      send(status, {
        success: false,
        errors: [{ code, message }],
        messages: [],
        result: null,
      })

    const m = route.exec(req.url || '')
    if ('POST' !== req.method || null == m) {
      return fail(404, 7003, 'No route for that URI')
    }
    if ('Bearer ' + REST.apiToken !== req.headers.authorization) {
      return fail(403, 10000, 'Authentication error')
    }
    if (REST.accountId !== m[1] || REST.databaseId !== m[2]) {
      return fail(404, 7404, 'Database not found')
    }

    let body = ''
    for await (const chunk of req) body += chunk

    try {
      const { sql, params = [] } = JSON.parse(body)
      const out = await db
        .prepare(sql)
        .bind(...params)
        .all()
      send(200, {
        success: true,
        errors: [],
        messages: [],
        result: [
          {
            success: true,
            meta: JSON.parse(JSON.stringify(out.meta || {})),
            results: out.results,
          },
        ],
      })
    } catch (err: any) {
      fail(400, 7500, err.message)
    }
  })

  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  )
  const port = (server.address() as AddressInfo).port
  return { server, baseUrl: `http://127.0.0.1:${port}/client/v4` }
}
