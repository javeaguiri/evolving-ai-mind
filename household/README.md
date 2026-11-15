# household/

This household's own artifacts: content that names its domains, tables and workflows, and so
must never sit with the system seeds in `src/serv/templates/pgc/seeds/` (`CLAUDE.md`: user domain
data never appears in system artifacts). Committed so it is versioned and reviewable.

| File | Written to | By |
|---|---|---|
| `pages.json` | `PGC_Page` — the web app's Home, Money and Inventory pages (`docs/arch-web-app.md` §2.3, §4.2) | `node dev_scripts/upsert-page.mjs household/pages.json` (`--check` to validate against the live registry and write nothing) |
