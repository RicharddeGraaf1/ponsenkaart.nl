#!/usr/bin/env python3
"""Genereer data/oordeel.json — de transitie-lens voor het koepelregister.

Het Omgevingsdocumentenregister (omgevingsdocumentenregister.nl) toont per
bronhouder een strook met oordelen van gespecialiseerde bronnen. Dit script
levert het oordeel van ponsenkaart: hoe ver is deze gemeente met de overgang
van Wro naar Omgevingswet.

Contract: docs/feed-contract.md in de register-repo. Kort:
  - twee index-niveaus, `bronhouders` en `documenten`
  - gesleuteld op de kale overheidscode (gm0193)
  - `dekking` verplicht, `nvt_reden` eersterangs
  - cijfers als heel getal met eenheid, geen fracties

**Het register herberekent nooit.** Daarom rekent dit script hier ook niets
nieuws uit: het gebruikt exact de score van de Combinatie-view
(`Combinatie.html`, `W = 0.5`) en dezelfde drempels. Wijzigt die view van
formule, dan moet dit script mee — anders gaat de koepel iets anders tonen
dan de site zelf.

Data komt via de eigen `/api`-proxy, niet rechtstreeks uit de OCD-API. Zo is
gegarandeerd dat de feed dezelfde getallen draagt als wat een bezoeker op
ponsenkaart.nl ziet, en is er geen API-sleutel nodig.

Draaien:  python tools/build_oordeel.py
Daarna:   ./deploy.sh
"""

from __future__ import annotations

import json
import sys
import urllib.request
from datetime import date
from pathlib import Path

BASIS = "https://ponsenkaart.nl/api"
UIT = Path(__file__).resolve().parent.parent / "data" / "oordeel.json"

# Weging uit Combinatie.html (`const W = 0.5`) — % geponst oppervlak tegen
# % afgenomen planvoorraad, ongewogen.
W = 0.5

# Drempels uit `scoreCls()` in diezelfde view. Ze worden hier bewust NIET als
# goed/matig/zwak-etiket meegegeven — zie `label_bewust_weggelaten` hieronder.
GOED, MATIG = 60, 40


def haal(pad: str):
    url = BASIS + pad
    req = urllib.request.Request(url, headers={"User-Agent": "ponsenkaart-build-oordeel"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


# BEWUST GEEN goed/matig/zwak-etiket op deze lens.
#
# De Combinatie-view gebruikt die drempels als kleur in een ranglijst, waar
# je gemeenten onderling vergelijkt. In het register staat het cijfer náást
# de naam van één gemeente, en daar leest "zwak" als een oordeel over hoe
# die gemeente het doet. Dat is niet te verdedigen: de overgang loopt tot
# 1 januari 2032 en is landelijk nauwelijks begonnen — bij de eerste run
# scoorden 342 van de 342 gemeenten onder de 40. Een gemeente die precies
# op schema ligt zou dan "zwak" heten.
#
# Het cijfer gaat ongewijzigd mee (het register herberekent niets), maar de
# duiding laten we aan de dekkingszin en aan ponsenkaart zelf.
LABEL_WEGGELATEN = (
    "geen goed/matig/zwak op deze lens: de overgang loopt tot 2032 en is "
    "landelijk nauwelijks begonnen, dus een laag cijfer betekent hier "
    "'nog niet begonnen', niet 'slecht'"
)


def main() -> int:
    print("ophalen /v1/ponsenkaart/gemeenten …", file=sys.stderr)
    pons = haal("/v1/ponsenkaart/gemeenten")
    print("ophalen /v1/planvoorraad/gemeenten …", file=sys.stderr)
    voorraad = haal("/v1/planvoorraad/gemeenten")

    # pct_af komt als fractie (0–1); de view rekent in 0–100.
    pct_af = {r["code"]: float(r.get("pct_af") or 0) * 100 for r in voorraad}
    plannen = {r["code"]: r.get("plans_nu") for r in voorraad}
    weg = {r["code"]: r.get("verdwenen") for r in voorraad}

    bronhouders: dict[str, dict] = {}
    for f in pons.get("features", []):
        p = f.get("properties") or {}
        code = p.get("overheidscode")
        if not code:
            continue
        geponst = float(p.get("pct") or 0)
        af = pct_af.get(code, 0.0)
        score = round(geponst * W + af * (1 - W))

        n_weg, n_nu = weg.get(code), plannen.get(code)
        if n_nu is None:
            dekking = f"{geponst:.0f}% van het grondgebied geponst; planvoorraad onbekend"
        else:
            dekking = (
                f"{geponst:.0f}% van het grondgebied geponst · "
                f"{n_weg or 0} van {(n_weg or 0) + n_nu} plannen weggehaald · "
                "overgang loopt tot 2032"
            )

        bronhouders[code] = {
            "cijfer": score,
            "eenheid": "/100",
            "label": None,
            "dekking": dekking,
            "link": f"https://ponsenkaart.nl/Combinatie?gemeente={code}",
            "nvt_reden": None,
        }

    feed = {
        "lens": "transitie",
        "bron": "ponsenkaart.nl",
        "peildatum": date.today().isoformat(),
        "dekking": {
            "getoetst": len(bronhouders),
            "totaal": len(bronhouders),
            "zin": (
                f"{len(bronhouders)} gemeenten; score = helft geponst grondgebied, "
                "helft afgenomen planvoorraad"
            ),
            "niet_getoetst": [],
        },
        # Alleen gemeenten. Een provincie of waterschap ponst geen
        # bestemmingsplannen weg, dus daar is deze lens niet van toepassing —
        # dat is informatie, geen ontbrekende meting.
        "geldt_voor": ["bronhouders"],
        "label_weggelaten": LABEL_WEGGELATEN,
        "nvt_buiten_index": "deze lens meet alleen gemeenten",
        "bronhouders": bronhouders,
        # Ponsenkaart oordeelt per gemeente, niet per document.
        "documenten": {},
        "nvt_documenten": "ponsenkaart meet per gemeente, niet per document",
    }

    UIT.parent.mkdir(parents=True, exist_ok=True)
    UIT.write_text(json.dumps(feed, ensure_ascii=False, indent=1), encoding="utf-8")

    scores = [b["cijfer"] for b in bronhouders.values()]
    print(
        f"geschreven: {UIT.relative_to(UIT.parent.parent)} — {len(bronhouders)} gemeenten, "
        f"gemiddelde score {sum(scores) / len(scores):.1f}, "
        f"hoogste {max(scores)}, boven de {MATIG}: {sum(s >= MATIG for s in scores)}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
