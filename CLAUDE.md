# ponsenkaart.nl — projectconventies

Statische civic-tech viewer over de pons-transitie. Frontend op **Cloudflare
Pages** (project `ponsenkaart`, **direct upload — géén git-integratie**, dus
`git push` deployt niets). Backend = OCD-API op Railway via de `/api`-proxy in
`functions/`.

## Deploy — ALTIJD via `./deploy.sh`, NOOIT `wrangler pages deploy .`

`wrangler pages deploy .` uploadt de **hele map inclusief `.env`**. Dat heeft op
2026-07-01 de `CLOUDFLARE_API_TOKEN` publiek gezet op
`https://ponsenkaart.nl/.env` (token daarna geroteerd + oude leaking deployments
verwijderd). Daarom:

```bash
./deploy.sh            # deployt vanuit een schone tijdelijke map naar productie (branch main)
```

- `deploy.sh` kopieert alleen niet-dot bestanden naar een tempmap en deployt díe;
  `.env`/`.git`/`.wrangler` gaan zo nooit mee. Er zit een grep-vangnet in dat
  afbreekt als er tóch een token in de staging-map zit.
- `.assetsignore` is een tweede vangnet.
- **Na een deploy even checken:** `curl https://ponsenkaart.nl/.env` mag de token
  NIET tonen. Let op: Pages geeft overal HTTP 200 (SPA-achtige fallback) — check de
  **body**, niet de statuscode.
- De token staat lokaal in `.env` (gitignored). Nooit committen.

## Views
- `/` (index.html) — pons-kaart · `/RP-planvoorraad` · `/Combinatie`
- Combinatie.html joint `/v1/ponsenkaart/gemeenten` × `/v1/planvoorraad/gemeenten`
  op gemeentecode; `pct_af` komt als fractie (0–1) → ×100 in de view.
- Alle views praten met de OCD-API via `/api` (prod) of `http://localhost:8002`
  (lokaal dev; hostname-detectie in de HTML).
