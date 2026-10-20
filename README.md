# URL Shortener

A tiny URL shortener: paste a long URL, get a short link back. Built with plain Node.js and its built-in SQLite — no dependencies, no build step.

## Run

Requires Node.js 22.13+ (Node 24 recommended).

```bash
npm start        # http://localhost:3000
npm run dev      # restarts on file changes
```

| Env var    | Default                  | Purpose                                                       |
|------------|--------------------------|---------------------------------------------------------------|
| `PORT`     | `3000`                   | Port to listen on                                             |
| `BASE_URL` | `http://<request host>`  | Public origin used in returned short links, e.g. `https://s.example.com` |

Links are stored in `data/links.db` (created automatically).

## Short codes

- **Generated:** leave the alias empty and you get a random 7-character code. Shortening the same URL again returns the same code.
- **Custom alias:** 3–32 letters, numbers, `-` or `_`. Aliases are case-insensitive (`Promo` and `promo` are the same), must be unused, and `api` / `public` are reserved. One URL can have several aliases.

## API

`POST /api/shorten` with `{ "url": "https://…", "alias": "optional" }`

- `201` `{ code, shortUrl }`: created
- `200` `{ code, shortUrl, existing: true }`: URL already had a generated code
- `400` `{ error, field }`: invalid URL or alias
- `409` `{ error, field: "alias" }`: alias already taken

`GET /:code` redirects (302) to the original URL and counts the click; unknown codes return a 404 page.
