# Changes

## 0.1.0 2026-11-21

* First release. A Seneca entity store backed by Cloudflare D1, through a Workers binding or the D1 REST API.
* Seneca 4: the peer dependencies are `seneca` `^4.0.0` and `@seneca/entity` `^29.0.0`. Node.js 24 or later (`engines.node` `>=24`).
* The option defaults are built with the validator that Seneca passes to the plugin: `defaults` is a function of `{ valid }`. Seneca 4 rejects defaults built with Gubu (`plugin_gubu_shape`), and gubu was never a declared dependency. `d1` stays open. Unknown top-level options are rejected with `invalid_plugin_option`.
* The option `generate_id` must be a function when given. The default returns `undefined`, which means that the entity plugin generates the id, as before.
* The store connects in the plugin's `init` task (`seneca.init`), not in a raw `init:CloudflareD1Store` action.
* Query and `sort$` field names reach SQLite as bound JSON path parameters, never as SQL text, so a field name in a query cannot inject SQL. Table names from the entity canon may contain only letters, digits and underscores, and are quoted, so SQL keywords such as `order` work as entity names.
* No dependency on `seneca-promisify`, `seneca-entity` or `@seneca/entity-util`. Load the entity plugin as `@seneca/entity`.
* `npm pack` and `npm publish` build `dist/` first (`prepack`).
* Releases are published from GitHub Actions with npm trusted publishing and provenance. The local `repo-tag` and `repo-publish` scripts are removed.
* Tested with Miniflare's local D1 (workerd): from Node through the Workers binding and through the REST client against a local stand-in for the D1 REST API, and inside a Miniflare Worker (`nodejs_compat`) with the `env` binding. A deployed Cloudflare Worker and the real D1 REST API were not tested on Seneca 4.
