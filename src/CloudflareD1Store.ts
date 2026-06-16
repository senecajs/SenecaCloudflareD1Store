/* Copyright (c) 2024 Seneca contributors, MIT License */

import { Gubu } from 'gubu'

const { Open, Any, Skip } = Gubu

type D1Config = {
  accountId: string
  apiToken: string
  databaseId: string
  baseUrl: string
}

type Options = {
  debug: boolean
  map?: any
  generate_id?: (ent: any) => string
  cmd: {
    list: {
      size: number
      maxScan: number
    }
  }
  d1: any
}

export type CloudflareD1StoreOptions = Partial<Options>

// Minimal D1 client abstraction — satisfied by binding adapter or REST client.
type D1Client = {
  query<T = any>(sql: string, params?: any[]): Promise<T[]>
  run(sql: string, params?: any[]): Promise<void>
}

function CloudflareD1Store(this: any, options: Options) {
  const seneca: any = this

  const init = seneca.export('entity/init')
  const generate_id: (ent: any) => string =
    options.generate_id || seneca.export('entity/generate_id')

  let desc: any = 'CloudflareD1Store'
  let client: D1Client

  // Track tables that have been ensured to exist in this session.
  const knownTables = new Set<string>()

  async function ensureTable(table: string) {
    if (knownTables.has(table)) return
    await client.run(
      `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`,
    )
    knownTables.add(table)
  }

  let store = {
    name: 'CloudflareD1Store',

    save: async function (this: any, msg: any, reply: any) {
      const ent = msg.ent
      const id = '' + (ent.id || ent.id$ || generate_id(ent))
      const d = ent.data$(false)
      d.id = id

      const table = entityTable(ent)

      try {
        await ensureTable(table)
        await client.run(
          `INSERT OR REPLACE INTO ${table} (id, data) VALUES (?, ?)`,
          [id, JSON.stringify(d)],
        )
        const ento = ent.make$().data$(d)
        reply(null, ento)
      } catch (err: any) {
        reply(err)
      }
    },

    load: async function (this: any, msg: any, reply: any) {
      const qent = msg.qent
      const q = msg.q || {}
      const table = entityTable(qent)

      try {
        await ensureTable(table)

        let rows: any[]

        if (null != q.id) {
          rows = await client.query(
            `SELECT data FROM ${table} WHERE id = ?`,
            ['' + q.id],
          )
        } else {
          const { where, params } = buildWhere(q)
          const sql = `SELECT data FROM ${table}${where} LIMIT 1`
          rows = await client.query(sql, params)
        }

        if (0 === rows.length) {
          return reply(null)
        }

        const entdata = JSON.parse(rows[0].data)
        const ento = qent.make$().data$(entdata)
        reply(null, ento)
      } catch (err: any) {
        reply(err)
      }
    },

    list: async function (this: any, msg: any, reply: any) {
      const qent = msg.qent
      const q = msg.q || {}
      const table = entityTable(qent)

      try {
        await ensureTable(table)

        const { where, params } = buildWhere(q)
        const order = buildOrder(q)
        const size = options.cmd.list.size
        const limit = null == q.limit$ ? size : q.limit$
        const offset = q.skip$ || 0

        const sql = `SELECT data FROM ${table}${where}${order} LIMIT ? OFFSET ?`
        const rows = await client.query(sql, [...params, limit, offset])

        let list = rows.map((row: any) => {
          const entdata = JSON.parse(row.data)
          return qent.make$().data$(entdata)
        })

        if (Array.isArray(q.fields$)) {
          list = list.map((ento: any) => {
            const picked: any = { id: ento.id }
            for (const f of q.fields$) {
              picked[f] = ento[f]
            }
            return qent.make$().data$(picked)
          })
        }

        reply(null, list)
      } catch (err: any) {
        reply(err)
      }
    },

    remove: async function (this: any, msg: any, reply: any) {
      const qent = msg.qent
      const q = msg.q || {}
      const table = entityTable(qent)
      const all = true === q.all$

      try {
        await ensureTable(table)

        if (null != q.id) {
          await client.run(`DELETE FROM ${table} WHERE id = ?`, ['' + q.id])
          return reply()
        }

        if (all) {
          const { where, params } = buildWhere(q)
          await client.run(`DELETE FROM ${table}${where}`, params)
          return reply()
        }

        // Remove first match
        const { where, params } = buildWhere(q)
        const rows = await client.query(
          `SELECT id FROM ${table}${where} LIMIT 1`,
          params,
        )
        if (rows.length > 0) {
          await client.run(`DELETE FROM ${table} WHERE id = ?`, [rows[0].id])
        }
        reply()
      } catch (err: any) {
        reply(err)
      }
    },

    close: function (this: any, _msg: any, reply: any) {
      this.log.debug('close', desc)
      reply()
    },

    native: function (this: any, _msg: any, reply: any) {
      reply(null, { client: () => client })
    },
  }

  let meta = init(seneca, options, store)

  desc = meta.desc

  seneca.add(
    { init: store.name, tag: meta.tag },
    function (this: any, _msg: any, reply: any) {
      client = options.d1?.binding
        ? makeBindingClient(options.d1.binding)
        : makeRestClient(options.d1 as D1Config)
      reply()
    },
  )

  return {
    name: store.name,
    tag: meta.tag,
    exports: {
      native: () => ({ client }),
    },
  }
}

// Derives a safe SQL table name from an entity canon.
function entityTable(ent: any): string {
  const canon = ent.canon$({ object: true })
  const base = canon.base && '-' !== canon.base ? canon.base + '_' : ''
  return base + canon.name
}

// Builds a SQL WHERE clause from a Seneca query object.
function buildWhere(q: any): { where: string; params: any[] } {
  const conditions: string[] = []
  const params: any[] = []

  for (const [key, val] of Object.entries(q)) {
    if (key.endsWith('$') || null == val) continue
    conditions.push(`json_extract(data, '$.${key}') = ?`)
    params.push(val)
  }

  const where =
    conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : ''
  return { where, params }
}

// Builds a SQL ORDER BY clause from q.sort$.
function buildOrder(q: any): string {
  if (!q.sort$ || 'object' !== typeof q.sort$) return ''
  const parts = Object.entries(q.sort$).map(([field, dir]) => {
    return `json_extract(data, '$.${field}') ${(dir as number) < 0 ? 'DESC' : 'ASC'}`
  })
  return parts.length > 0 ? ' ORDER BY ' + parts.join(', ') : ''
}

// Adapter for a Cloudflare D1Database Workers binding.
function makeBindingClient(binding: any): D1Client {
  return {
    async query(sql, params = []) {
      const stmt = binding.prepare(sql).bind(...params)
      const result = await stmt.all()
      return result.results
    },
    async run(sql, params = []) {
      await binding.prepare(sql).bind(...params).run()
    },
  }
}

// REST client for Cloudflare D1 HTTP API, for use outside a Worker.
function makeRestClient(cf: D1Config): D1Client {
  const base = `${cf.baseUrl}/accounts/${cf.accountId}/d1/database/${cf.databaseId}`
  const headers = {
    Authorization: `Bearer ${cf.apiToken}`,
    'Content-Type': 'application/json',
  }

  async function exec(sql: string, params: any[] = []) {
    const res = await fetch(`${base}/query`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ sql, params }),
    })

    if (!res.ok) {
      throw new Error('CloudflareD1Store: query failed: ' + res.status)
    }

    const body: any = await res.json()

    if (!body.success) {
      throw new Error(
        'CloudflareD1Store: query error: ' + JSON.stringify(body.errors),
      )
    }

    return body.result[0].results as any[]
  }

  return {
    query: exec,
    async run(sql, params = []) {
      await exec(sql, params)
    },
  }
}

const defaults: Options = {
  debug: false,
  map: Any(),

  cmd: {
    list: {
      size: 11,
      maxScan: 1000,
    },
  },

  d1: Open({
    binding: Skip(Any()),
    accountId: '',
    apiToken: '',
    databaseId: '',
    baseUrl: 'https://api.cloudflare.com/client/v4',
  }),
}

Object.assign(CloudflareD1Store, {
  defaults,
  utils: { entityTable, buildWhere, makeRestClient, makeBindingClient },
})

export default CloudflareD1Store

if ('undefined' !== typeof module) {
  module.exports = CloudflareD1Store
}
