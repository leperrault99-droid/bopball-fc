# BOPBALL FC — Runbook

Everything needed to get the game running without help. All commands run from the
`bopball-fc` folder. Nothing here needs npm — the project has zero dependencies.

```bash
cd "C:\Users\user\Claude Cowork\AI gigs\Strike\bopball-fc"
```

---

## 1. Dev server (solo + LAN)

```bash
node server.js
```

Then open **http://localhost:8470**. Leave the terminal open — closing it stops the
server.

- Others **on your wifi** can join at `http://<your-lan-ip>:8470`
- Find your IP: `ipconfig` → the IPv4 address on your active adapter

## 2. Online server (play with people anywhere)

The game server must already be running (step 1). In a **second terminal**:

```bash
"C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:8470
```

It prints a banner a few lines in with a public URL:

```
https://<random-words>.trycloudflare.com
```

**That URL is the link you send.** Nothing else needed on their end.

> The URL is **different every single time** you start the tunnel. Old links die
> permanently the moment you stop it. Always copy the fresh one.

**How to play together:** you open the link → ONLINE → Host match → read out the
5-letter code → they open the link → ONLINE → type the code → Join → you press
START MATCH. Empty slots fill with AI.

## 3. Shutting down

- **Online only:** close the cloudflared terminal (or Ctrl+C). The game server keeps
  running for solo/LAN.
- **Everything:** close both terminals.
- **If a terminal is gone but the server is still up**, find and kill it:

```bash
powershell "Get-NetTCPConnection -LocalPort 8470 -State Listen | Select-Object -First 1 -ExpandProperty OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force }"
```

---

## Rules that will save you a headache

**Restart the server after any code change.** Node loads `server.js`, `sim.js` and
`ai.js` once at startup and keeps them in memory. Editing those files does nothing
until you restart. Browsers re-fetch `client.js` and `index.html` on every page
load, so those only need a refresh.

This has bitten us repeatedly — a feature looked broken when the code was fine and
the server was simply stale.

**Hard-refresh after updating** — `Ctrl+Shift+R`. A normal refresh can serve a
cached `client.js`, which leaves you on a mismatched build.

**Your PC is the referee.** While hosting, it runs the match for everyone. It has to
stay awake, and everyone's latency is measured to you.

---

## Testing

```bash
node test-sim.js
```

Headless AI-vs-AI: scorelines, difficulty ladder, determinism, event counts.

> The 6-seed goal average it prints **swings between ~2.2 and ~5.8 run to run.**
> It is a smoke test, not a balance signal. Treat "DETERMINISTIC ✓" and the Legend
> ladder as the real pass/fail. Anything load-bearing needs a 20–40 seed average.

```bash
node build.js
```

Rebuilds `dist/bopball-fc.html` — the whole game in one file, playable offline by
double-clicking it. Run this after editing any source file.

### Handy dev URLs

| URL | What it does |
|---|---|
| `?autotest=1&seed=42` | AI vs AI demo match |
| `...&ff=1800` | fast-forward 30 s in |
| `?weather=rain` | force a weather preset (`clear`, `golden`, `overcast`, `rain`, `snow`, `night`) |
| `?replaytest=1` | force a goal replay a few seconds in |
| `?controls=1` | open the controls screen |

---

## If something's wrong

**Port already in use** — a server is still running. Kill it with the PowerShell
line above, then start again.

**Tunnel says 530** — cloudflared is up but the game server isn't. Start `node
server.js` first.

**Friend's link doesn't work** — the tunnel was restarted, so that URL is dead. Send
them the current one.

**Changes aren't showing** — restart the server (for `server.js`/`sim.js`/`ai.js`),
then hard-refresh (for `client.js`/`index.html`).
