# URL Shortener

A tiny self-hosted URL shortener. Paste a long URL, get a short link; visiting the short link redirects to the original. No accounts, no dependencies: it uses only Node's built-in modules and stores links in a local SQLite file.

## Run

Requires Node 22.13 or newer.

```
npm start
```

Then open http://localhost:3000. To try it from a phone, open `http://<your-computer-LAN-IP>:3000` on the same Wi-Fi.

## Configuration

| Env var    | Default           | Purpose                                                         |
|------------|-------------------|-----------------------------------------------------------------|
| `PORT`     | `3000`            | Port to listen on                                               |
| `DB_PATH`  | `data/links.db`   | SQLite file location                                            |
| `BASE_URL` | request `Host`    | Public origin used to build short links, e.g. `https://s.example.com` |

## Test

```
npm test
```
