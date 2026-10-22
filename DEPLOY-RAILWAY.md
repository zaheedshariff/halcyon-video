# Host Halcyon for friends on Railway

This is a private front door for an existing Plex server. Friends open the
store in a browser, type a membership password, then link **their own** Plex
account at [plex.tv/link](https://plex.tv/link). Halcyon does not hold a shared
Plex token, and the membership password never goes in the browser bundle.

The store itself still renders on each friend's device. This host only serves
the app and keeps strangers out.

## What you need

- A [Railway](https://railway.com) account
- This repository connected to a Railway service
- Plex Remote Access working, and each friend already invited to the libraries
  you want them to browse (steps below)

## Deploy

Railway reads `railway.json` and builds `Dockerfile.railway`. That image
listens on `$PORT` and answers `GET /healthz` with the text `ok`.

1. Create a new project → **Deploy from GitHub** → this repo.
2. Railway should pick the Dockerfile above. If it asks, set the config file
   path to `railway.json`.
3. Add the variables in the next section, then deploy.
4. Open the public `*.up.railway.app` URL (or your custom domain). You should
   see the membership desk, not the 3D store.

A local `npm run dev` is unchanged until you set a membership password. The
Railway image sets `HALCYON_PUBLIC_SITE=1`, so a deploy with no password stays
on the locked desk instead of publishing the store.

## Environment variables

Set these in the Railway service **Variables** tab. Do not commit them, and do
not prefix them with `VITE_`. Vite copies every `VITE_` value into the
JavaScript file visitors download.

| Variable | Required | What it does |
|---|---|---|
| `HALCYON_SITE_PASSWORD` | Yes, unless every friend has a named password | Shared membership password. At least 8 characters. A long passphrase is better than a word. |
| `HALCYON_SITE_FRIENDS` | No | Named cards, so each friend can have their own password. See below. |
| `HALCYON_SESSION_SECRET` | Recommended | Long random string (16+ characters) used to sign the session cookie. If you leave it empty, sessions are signed from the passwords and restart cleanly, but they all end when a password changes. |
| `HALCYON_SESSION_DAYS` | No | How long a browser stays signed in. Default 14. Clamped between 1 and 90. |
| `PORT` | Set by Railway | The server already uses it. Do not hard-code 1420 on Railway. |
| `HALCYON_ALLOWED_HOSTS` | Usually no | Extra hostnames, comma-separated. A leading dot matches subdomains. Railway's `*.up.railway.app` names are allowed automatically. `all` turns the host check off — leave that off on a public URL. |
| `HALCYON_COOKIE_SECURE` | No | `1` forces the `Secure` cookie flag. `0` turns it off. Leave it unset on Railway: public hosts get `Secure`, `localhost` does not, so local testing still works. |
| `HALCYON_TRUST_PROXY` | No | Set to `1` if a reverse proxy in front of the app is not Railway. Railway is detected on its own. This is what makes failed-login lockouts follow the visitor instead of the proxy. |

Named friends, either as a comma-separated list (passwords may contain colons,
not commas):

```text
HALCYON_SITE_FRIENDS=Sam:a long passphrase,Riley:another long passphrase
```

or as JSON when a password needs a comma:

```text
HALCYON_SITE_FRIENDS={"Sam":"a long passphrase","Riley":"pass, with comma"}
```

A friend with their own password types their name and that password. Anyone
can also use the shared password; the name field is optional for that. Up to
30 named cards. Shorter than 8 characters is ignored.

### Do not set these on the public site

| Variable | Why |
|---|---|
| `VITE_JELLYFIN_PASSWORD`, `VITE_JELLYFIN_USERNAME`, `VITE_*APIKEY`, `VITE_PLEX_TOKEN`, any other `VITE_` secret | Copied into the downloaded app if present at **build** time. `Dockerfile.railway` refuses to build when the usual ones are set. |
| A shared Plex token, in any variable | Each friend links their own account after they are inside. |
| `HALCYON_TRUSTED_NETWORK_CONTROLS` | Turns on local playback, on-disk feedback, and Remote Play for the network. There is no per-user login on those routes. The public image keeps them **off** even if this is `1`. |
| `HALCYON_ALLOW_TRUSTED_NETWORK_CONTROLS` | The only way to override that public-site lock. Do not set it for a friends store. |
| `HALCYON_PROXY_ALLOWED_URLS` pointing at anything you do not operate | The integration proxy is not a general HTTP proxy. It only forwards a short list of Jellyseerr and RomM catalog calls, and only to URLs you configured. |

Optional home-server integrations (`HALCYON_JELLYSEERR_URL` plus
`HALCYON_JELLYSEERR_APIKEY`, and the RomM pair) still work the way the main
README describes: the key stays on the server. On this public image the proxy
also refuses loopback, private, and link-local addresses, including cloud
metadata (`169.254.169.254`), so a configured name that resolves to one of
those is not fetched.

`HALCYON_JELLYFIN_URL` only prefills a Jellyfin address. It is not used for the
Plex flow below, and it must not include a username, password, or token.

## Sign in, then link Plex

1. Open the Railway URL. The membership desk is the whole site until the
   password matches.
2. Come in. The browser gets an `HttpOnly`, `Secure`, `SameSite=Lax` session
   cookie. JavaScript in the page cannot read it.
3. Eight wrong passwords from the same address close the desk for 15 minutes.
   A burst of failures from the proxy itself is limited too. The message is
   the same whether the name or the password was wrong.
4. Inside the store, choose **Plex** at the opening-day terminal. Halcyon
   shows a short code. Enter it at [https://plex.tv/link](https://plex.tv/link)
   while signed in to the Plex account that should see the libraries.
5. Pick the shared server. Use the secure `*.plex.direct` connection Plex
   offers. An `http://192.168.x.x` address will not load from this HTTPS site.
6. **Leave the store** (bottom-left) asks you to confirm, then signs that
   browser out. A page you did not open cannot sign you out by loading
   `/logout`.

Wrong-password attempts and the session cookie are handled only on the server.
Logging out or changing `HALCYON_SITE_PASSWORD` / `HALCYON_SESSION_SECRET`
ends existing sessions.

## Share the Plex libraries

Do this in Plex, not in Halcyon. Each friend needs a free or paid Plex account.

1. Open [app.plex.tv](https://app.plex.tv) as the library owner.
2. Go to **Settings → Manage Library Access** (older servers call this
   **Users & Sharing**).
3. Invite the friend by the email or username on their Plex account.
4. Grant the libraries they should browse. Leave the ones they should not
   see unshared. Restrictions you set in Plex (labels, content ratings,
   download) still apply, because they sign in as themselves.
5. The friend accepts the invite from their email or from Plex.

Halcyon will list that server as shared after they finish `plex.tv/link`.

## Turn on Plex Remote Access

Friends are not on your LAN. Their browsers talk to Plex directly, over the
internet, after Plex says the server is reachable.

1. On the Plex server, open **Settings → Remote Access**.
2. Enable remote access. Leave the public port at `32400` unless you have a
   reason to change it, and forward that TCP port from the router to the
   machine running Plex. UPnP can do this itself; a manual forward is more
   reliable.
3. Wait until Plex reports that the server is fully accessible from outside
   your network. "Not available outside your network" means friends will not
   be able to play anything, even if the Halcyon desk lets them in.
4. If you only see a relay connection, playback is limited and often indirect.
   Fix the port forward rather than putting a Plex token on Railway.
5. Confirm from a phone that is **not** on the home Wi-Fi: the Plex app can
   see the server and play a title.

The Railway app does not proxy video. If Remote Access works in the official
Plex app, it will work from the store.

## Security notes

- Strangers can open the membership page and `GET /healthz`. They cannot load
  the store, its scripts, `/dev-proxy`, `/__play`, `/__feedback`, or
  `/__remote/*`. Those last three also stay loopback-only after a friend
  signs in, which on Railway means they stay unreachable.
- `/healthz` and `/health` respond with `ok` and nothing else: no version, no
  configured URLs, no names.
- The session cookie is `HttpOnly`, `Secure` on the public hostname, and
  `SameSite=Lax`. It is not a Plex token.
- Login from another website is rejected, so a page you did not open cannot
  spend your attempts or set a cookie.
- The integration proxy only dials operator-configured Jellyseerr/RomM URLs,
  only for the catalog routes the store uses, and it refuses redirects. It
  will not fetch link-local or metadata addresses. On this public image it
  also will not fetch loopback or private network addresses.
- `HALCYON_TRUSTED_NETWORK_CONTROLS` stays off by default. The README is
  right that those routes have no application login of their own. Keep them
  off.
- Custom domain: add it in Railway, then the host check allows
  `RAILWAY_PUBLIC_DOMAIN` automatically. For a domain Railway does not inject,
  set `HALCYON_ALLOWED_HOSTS` to that hostname.
- This program is GPL-3.0. The `LICENSE` file stays with the source. Hosting
  it for friends does not let you drop that notice or swap in a shared Plex
  token behind their backs.

## Updating

Redeploy from the latest commit of this repo. Railway rebuilds the image.
Changing the membership password signs everyone out. Library shares and Plex
Remote Access are unchanged by a Halcyon redeploy.
