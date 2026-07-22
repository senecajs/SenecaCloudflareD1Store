/* Copyright © 2024 Seneca Project Contributors, MIT License. */

import Seneca from 'seneca'
import { Miniflare } from 'miniflare'

import CloudflareD1StoreDoc from '../src/CloudflareD1StoreDoc'
import CloudflareD1Store from '../src/CloudflareD1Store'

describe('CloudflareD1Store', () => {
  let mf: Miniflare
  let seneca: any

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: ['TEST_D1'],
    })

    const binding = wrapBinding(await mf.getD1Database('TEST_D1'))

    seneca = Seneca({ legacy: false })
      .test()
      .use('promisify')
      .use('entity')
      .use(CloudflareD1Store, { d1: { binding } })

    await seneca.ready()
  })

  afterAll(async () => {
    await mf.dispose()
  })

  test('load-plugin', () => {
    expect(CloudflareD1Store).toBeDefined()
    expect(CloudflareD1StoreDoc).toBeDefined()
    expect(seneca.export('CloudflareD1Store/native')).toBeDefined()
  })

  test('utils.entityTable', () => {
    const { entityTable } = CloudflareD1Store['utils']
    const s = Seneca({ legacy: false }).test().use('entity')

    expect(entityTable(s.make('foo'))).toEqual('foo')
    expect(entityTable(s.make('foo/bar'))).toEqual('foo_bar')
    expect(entityTable(s.make('zone/base/name'))).toEqual('base_name')
  })

  test('utils.buildWhere', () => {
    const { buildWhere } = CloudflareD1Store['utils']

    expect(buildWhere({})).toEqual({ where: '', params: [] })
    expect(buildWhere({ a: 1, b: 'x' })).toEqual({
      where:
        " WHERE json_extract(data, '$.a') = ? AND json_extract(data, '$.b') = ?",
      params: [1, 'x'],
    })
    expect(buildWhere({ id: '1', limit$: 5 })).toEqual({
      where: " WHERE json_extract(data, '$.id') = ?",
      params: ['1'],
    })
  })

  describe('crud', () => {
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

    test('load missing returns null', async () => {
      const loaded = await seneca.entity('foo/bar').load$('no-such-id')
      expect(loaded).toEqual(null)
    })

    test('list all', async () => {
      const s = makeSenecaWithBinding(wrapBinding(await mf.getD1Database('TEST_D1')))
      await s.ready()

      await s.entity('list/item').data$({ n: 1 }).save$()
      await s.entity('list/item').data$({ n: 2 }).save$()
      await s.entity('list/item').data$({ n: 3 }).save$()

      const list = await s.entity('list/item').list$({})
      expect(list.length).toBeGreaterThanOrEqual(3)
    })

    test('list with field filter', async () => {
      const s = makeSenecaWithBinding(wrapBinding(await mf.getD1Database('TEST_D1')))
      await s.ready()

      await s.entity('filter/item').data$({ color: 'red', v: 1 }).save$()
      await s.entity('filter/item').data$({ color: 'blue', v: 2 }).save$()
      await s.entity('filter/item').data$({ color: 'red', v: 3 }).save$()

      const list = await s.entity('filter/item').list$({ color: 'red' })
      expect(list.length).toEqual(2)
      expect(list.every((e: any) => e.color === 'red')).toBe(true)
    })

    test('list with sort$', async () => {
      const s = makeSenecaWithBinding(wrapBinding(await mf.getD1Database('TEST_D1')))
      await s.ready()

      await s.entity('sort/item').data$({ n: 3 }).save$()
      await s.entity('sort/item').data$({ n: 1 }).save$()
      await s.entity('sort/item').data$({ n: 2 }).save$()

      const asc = await s.entity('sort/item').list$({ sort$: { n: 1 } })
      const vals = asc.map((e: any) => e.n)
      expect(vals).toEqual([...vals].sort((a: number, b: number) => a - b))

      const desc = await s.entity('sort/item').list$({ sort$: { n: -1 } })
      const valsDesc = desc.map((e: any) => e.n)
      expect(valsDesc).toEqual(
        [...valsDesc].sort((a: number, b: number) => b - a),
      )
    })

    test('list with limit$ and skip$', async () => {
      const s = makeSenecaWithBinding(wrapBinding(await mf.getD1Database('TEST_D1')))
      await s.ready()

      for (let i = 0; i < 5; i++) {
        await s.entity('page/item').data$({ i }).save$()
      }

      const page = await s
        .entity('page/item')
        .list$({ sort$: { i: 1 }, limit$: 2, skip$: 1 })
      expect(page.length).toEqual(2)
    })

    test('list with fields$', async () => {
      const ent = await seneca
        .entity('foo/bar')
        .data$({ a: 1, b: 2 })
        .save$()

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

    test('remove with all$', async () => {
      const s = makeSenecaWithBinding(wrapBinding(await mf.getD1Database('TEST_D1')))
      await s.ready()

      await s.entity('del/item').data$({ tag: 'x' }).save$()
      await s.entity('del/item').data$({ tag: 'x' }).save$()
      await s.entity('del/item').data$({ tag: 'y' }).save$()

      await s.entity('del/item').remove$({ tag: 'x', all$: true })

      const remaining = await s.entity('del/item').list$({})
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
  })

  describe('makeRestClient', () => {
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

      const rows = await client.query(
        'SELECT data FROM foo WHERE id = ?',
        ['1'],
      )
      expect(rows).toEqual([{ data: '{"id":"1","x":42}' }])

      const [url, init] = mockFetch.mock.calls[0]
      expect(url).toContain('/accounts/acct/d1/database/db1/query')
      expect(JSON.parse(init.body)).toMatchObject({
        sql: 'SELECT data FROM foo WHERE id = ?',
        params: ['1'],
      })
      expect(init.headers.Authorization).toEqual('Bearer tok')
    })
  })
})

function makeSenecaWithBinding(binding: any) {
  return Seneca({ legacy: false })
    .test()
    .use('promisify')
    .use('entity')
    .use(CloudflareD1Store, { d1: { binding } })
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
