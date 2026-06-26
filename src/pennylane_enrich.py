#!/usr/bin/env python3
"""
pennylane_enrich.py
====================

Complete un export Pennylane "Export des fournisseurs" (CSV ;-separated, encodage UTF-8)
en allant chercher SIRET / adresse / code postal / ville / pays a partir du numero de TVA,
via deux API officielles et gratuites :

  - France  : recherche-entreprises.api.gouv.fr (donnees Sirene/INSEE, memes donnees
              que celles affichees par Pappers)
  - Europe  : VIES (ec.europa.eu/taxation_customs/vies), le systeme officiel de
              validation des numeros de TVA intracommunautaires de la Commission
              Europeenne. Pour certains pays (FR, IE, BE... ) il renvoie aussi le
              nom et l'adresse de l'entreprise. D'autres pays (DE, ES, NL...) ne
              renvoient que la validite du numero, pas le detail : c'est une
              limite de VIES elle-meme (politique nationale), pas du script.

Logique :
  1. Pour chaque ligne, le code pays est extrait des 2 premieres lettres du numero
     de TVA.
  2. Si TVA francaise (FR + 2 chiffres de cle + 9 chiffres de SIREN) : le SIREN est
     extrait directement (fiable, pas de recherche par nom) puis interroge sur
     l'API gouv pour SIRET + adresse + code postal + ville.
  3. Si TVA d'un autre pays europeen : interrogation de VIES. Si le pays transmet
     le detail, l'adresse est recuperee (eclatee en best-effort sur code
     postal / ville quand c'est possible, sinon mise telle quelle dans Adresse).
  4. Les numeros de TVA mal formates (espaces, tirets, points) sont normalises.
  5. Si une ligne n'a AUCUN numero de TVA, une recherche stricte par raison
     sociale est tentee sur l'API gouv (France) : completion automatique
     UNIQUEMENT si un seul candidat actif correspond exactement au nom (apres
     normalisation accents/casse/forme juridique). Le numero de TVA francais
     est alors reconstruit a partir du SIREN trouve (cle de controle officielle,
     fiable a 100%). En cas d'ambiguite (plusieurs candidats ou aucun match
     exact), la ligne n'est PAS modifiee automatiquement : les candidats
     possibles sont listes dans le rapport pour verification manuelle.

  Le PAYS est toujours recalcule a partir de la TVA (l'export Pennylane met
  souvent "FR" par defaut meme pour des fournisseurs etrangers : c'est l'erreur
  a corriger).

Sortie : DEUX fichiers CSV au lieu d'un seul OUTPUT.csv (passe en argument 2) :
  - OUTPUT.traites.csv    -> uniquement les lignes ou au moins SIRET (FR) ou
                             une donnee d'adresse a ete trouvee, pretes a etre
                             reimportees dans Pennylane.
  - OUTPUT.a_traiter.csv  -> tout le reste (libelles generiques, lignes sans TVA,
                             SIREN introuvable/inactif, fournisseur en diffusion
                             partielle, pays VIES sans detail) : a traiter
                             manuellement ou a la prochaine iteration.
  - OUTPUT.report.txt     -> recapitulatif chiffre + listes nominatives.

Reprise apres une 1ere execution (idempotence) :
  Si OUTPUT.traites.csv existe deja (d'une execution precedente sur ce meme
  fichier de sortie), le script charge les fournisseurs deja completes
  (cle = Nom + Numero TVA d'origine) et NE LES RE-INTERROGE PAS : leur ligne est
  recopiee telle quelle dans le nouveau fichier .traites.csv. Cela permet de
  relancer le script sur un export mis a jour (nouvelles lignes ajoutees) sans
  re-taper toutes les requetes API deja faites pour ce client.

Usage:
    python3 pennylane_enrich.py INPUT.csv [OUTPUT.csv] [--generic NOM1,NOM2,...]

    INPUT.csv  : export Pennylane original. Peut etre dans un sous-dossier
                 (ex: "Lecabou/PENNYLANE_LECABOU_Export_des_fournisseurs.csv").

    OUTPUT.csv : optionnel. Base de nom pour les fichiers de sortie
                 (OUTPUT.traites.csv, OUTPUT.a_traiter.csv, OUTPUT.report.txt).
                 Si omis, derive automatiquement du nom du fichier d'entree,
                 dans le MEME dossier que l'entree : le prefixe "PENNYLANE_"
                 et le suffixe "_Export_des_fournisseurs"/"_export" sont
                 retires s'ils sont presents.
                 Ex: "Lecabou/PENNYLANE_LECABOU_Export_des_fournisseurs.csv"
                     -> "Lecabou/LECABOU_fournisseurs.traites.csv" etc.

    --generic  : liste optionnelle (separee par des virgules) de noms a NE PAS
                 chercher car ce sont des libelles generiques (ex: "Hotels,Taxi").
                 Si omis, une liste par defaut de libelles generiques courants
                 est utilisee (voir DEFAULT_GENERIC_NAMES ci-dessous). Pour
                 desactiver completement le filtrage generique, utiliser
                 --generic "" (chaine vide).

Limites de debit : ~150ms entre chaque appel (FR ou VIES), donc quelques
minutes pour plusieurs centaines de fournisseurs.
"""

import csv
import sys
import re
import time
import json
import argparse
import urllib.request
import urllib.error
import urllib.parse

FR_API_BASE = "https://recherche-entreprises.api.gouv.fr/search"
VIES_API_BASE = "https://ec.europa.eu/taxation_customs/vies/rest-api/ms"
# Page web publique (officielle, donnees Sirene/INSEE) consultable a l'oeil nu
# pour verifier une entreprise par son SIREN. Sert a generer un lien de
# verification dans le rapport pour les completions faites par recherche de nom.
ANNUAIRE_BASE = "https://annuaire-entreprises.data.gouv.fr/entreprise/"
SLEEP_BETWEEN_CALLS = 0.15  # secondes, marge de securite sous la limite de taux des API

# Libelles generiques courants (non identifiables comme une vraie entreprise)
# rencontres dans les exports Pennylane de plusieurs clients. Utilise par
# defaut si --generic n'est pas precise. Completable au cas par cas via
# --generic si un client a des libelles specifiques supplementaires.
DEFAULT_GENERIC_NAMES = [
    "Hôtels", "Hotels", "Parking", "Restaurants", "Taxi", "Taxis", "Transport",
    "Transports", "Autre", "Autres", "FOURNISSEURS DIVERS", "DIVERS - FR",
    "DIVERS", "Frais bancaires", "Frais de mission", "Notes de frais",
    "Péage", "Peage", "Carburant", "Essence", "Pourboire", "Pourboires",
]


def derive_output_base(input_csv: str) -> str:
    """Derive le nom de base des fichiers de sortie a partir du fichier
    d'entree, dans le MEME dossier que celui-ci. Retire le prefixe
    'PENNYLANE_' et le suffixe '_Export_des_fournisseurs' (ou variantes)
    s'ils sont presents, pour obtenir un nom de sortie plus court et lisible."""
    import os
    folder, filename = os.path.split(input_csv)
    name, _ext = os.path.splitext(filename)
    name = re.sub(r"^PENNYLANE_", "", name, flags=re.IGNORECASE)
    name = re.sub(r"_Export[_ ]?des[_ ]?fournisseurs$", "", name, flags=re.IGNORECASE)
    name = re.sub(r"_export$", "", name, flags=re.IGNORECASE)
    if not name.lower().endswith("fournisseurs"):
        name = f"{name}_fournisseurs"
    return os.path.join(folder, name) if folder else name


# ---------------------------------------------------------------------------
# Fonctions utilitaires pures (testables sans reseau)
# ---------------------------------------------------------------------------

def clean_vat(vat: str) -> str:
    """Normalise un numero de TVA : supprime espaces, tirets, points."""
    return vat.strip().replace(" ", "").replace("-", "").replace(".", "")


def vat_country_code(vat: str):
    """Retourne les 2 premieres lettres (code pays ISO) d'un numero de TVA, ou None."""
    v = clean_vat(vat)
    m = re.match(r"^([A-Za-z]{2})", v)
    return m.group(1).upper() if m else None


def extract_french_siren(vat: str):
    """Si le numero de TVA est un numero FR valide (FR + 2 chiffres cle + 9 chiffres SIREN),
    retourne le SIREN (9 chiffres). Sinon None."""
    v = clean_vat(vat)
    m = re.match(r"^FR\d{2}(\d{9})$", v, re.IGNORECASE)
    return m.group(1) if m else None


def vat_number_without_country(vat: str, country_code: str):
    """Retourne la partie du numero de TVA apres le code pays (pour VIES)."""
    v = clean_vat(vat)
    if v.upper().startswith(country_code.upper()):
        return v[len(country_code):]
    return v


def compute_french_vat_from_siren(siren: str):
    """Reconstruit le numero de TVA intracommunautaire francais a partir d'un
    SIREN, via la formule officielle de la cle de controle :
        cle = (12 + 3 * (SIREN mod 97)) mod 97
    Le numero de TVA francais n'est pas stocke separement du SIREN : il est
    toujours derive de cette facon, donc on peut le reconstruire a 100% une
    fois le SIREN connu (aucune ambiguite sur cette etape)."""
    if not siren or not siren.isdigit() or len(siren) != 9:
        return None
    siren_int = int(siren)
    cle = (12 + 3 * (siren_int % 97)) % 97
    return f"FR{cle:02d}{siren}"


def normalize_name_for_match(name: str) -> str:
    """Normalise un nom d'entreprise pour comparaison stricte (insensible aux
    accents/casse/espaces/forme juridique courante en fin de nom)."""
    import unicodedata
    n = unicodedata.normalize("NFKD", name or "")
    n = "".join(c for c in n if not unicodedata.combining(c))
    n = n.upper()
    n = re.sub(r"[^A-Z0-9 ]", " ", n)
    n = re.sub(r"\s+", " ", n).strip()
    # formes juridiques courantes a ignorer pour la comparaison
    for suffix in [" SARL", " SAS", " SASU", " SA", " EURL", " EI", " SCI", " ASSOCIATION"]:
        if n.endswith(suffix):
            n = n[: -len(suffix)].strip()
    return n


# ---------------------------------------------------------------------------
# Appels reseau
# ---------------------------------------------------------------------------

def _http_get_json(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": "pennylane-enrich-script/1.0"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


def lookup_siren(siren: str):
    """Interroge l'API recherche-entreprises.api.gouv.fr (France) pour un SIREN donne.
    Retourne un dict ou None si introuvable."""
    url = f"{FR_API_BASE}?q={siren}"
    try:
        data = _http_get_json(url)
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as e:
        print(f"  [!] Erreur reseau pour SIREN {siren}: {e}", file=sys.stderr)
        return None

    results = data.get("results", [])
    if not results:
        return None

    match = None
    for r in results:
        if r.get("siren") == siren:
            match = r
            break
    if match is None:
        match = results[0]

    def clean_val(v):
        """Les entreprises (EI, particuliers) ayant active le droit a la diffusion
        partielle renvoient la chaine litterale 'NON-DIFFUSIBLE' au lieu de la
        vraie valeur. On la traite comme une absence de donnee."""
        if not v or v == "[NON-DIFFUSIBLE]":
            return ""
        return v

    siege = match.get("siege") or {}
    siret = clean_val(siege.get("siret"))
    code_postal = clean_val(siege.get("code_postal"))
    ville = clean_val(siege.get("libelle_commune"))
    adresse_complete = clean_val(siege.get("adresse"))

    numero_voie = clean_val(siege.get("numero_voie"))
    type_voie = clean_val(siege.get("type_voie"))
    libelle_voie = clean_val(siege.get("libelle_voie"))
    complement = clean_val(siege.get("complement_adresse"))
    adresse_voie = " ".join(filter(None, [numero_voie, type_voie, libelle_voie])).strip()
    if complement:
        adresse_voie = f"{adresse_voie} {complement}".strip()
    if not adresse_voie:
        adresse_voie = adresse_complete

    return {
        "siret": siret,
        "adresse": adresse_voie,
        "code_postal": code_postal,
        "ville": ville,
        "nom_officiel": match.get("nom_complet") or "",
    }


def lookup_by_name(nom: str):
    """Recherche stricte d'une entreprise francaise par sa raison sociale,
    pour les lignes sans numero de TVA exploitable. Utilise par
    recherche-entreprises.api.gouv.fr (meme source que la recherche par SIREN).

    Pour eviter tout risque de mauvais matching (et donc d'ecrire un SIRET
    errone dans Pennylane), la completion automatique n'a lieu QUE si :
      - l'entreprise est active (etat_administratif == 'A')
      - le nom normalise du candidat correspond exactement (ou quasi, une
        fois formes juridiques/accents/casse ignores) au nom recherche
      - il n'y a qu'UN SEUL candidat actif qui satisfait ce critere

    Retourne un dict avec les memes champs que lookup_siren() (siret, adresse,
    code_postal, ville, nom_officiel, siren) si un match unique et sur est
    trouve, sinon None. Le 2eme element du tuple retourne est la liste des
    candidats "proches" (nom, siren, ville) pour signalement dans le rapport
    meme quand aucune completion automatique n'est faite."""
    url = f"{FR_API_BASE}?q={urllib.parse.quote(nom)}&per_page=10"
    try:
        data = _http_get_json(url)
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as e:
        print(f"  [!] Erreur reseau pour recherche par nom '{nom}': {e}", file=sys.stderr)
        return None, []

    results = data.get("results", [])
    target = normalize_name_for_match(nom)

    candidates = []
    exact_matches = []
    for r in results:
        if r.get("etat_administratif") != "A":
            continue
        r_nom = r.get("nom_complet") or r.get("nom_raison_sociale") or ""
        candidates.append((r_nom, r.get("siren") or "", (r.get("siege") or {}).get("libelle_commune") or ""))
        if normalize_name_for_match(r_nom) == target:
            exact_matches.append(r)

    if len(exact_matches) != 1:
        # Pas de match unique et certain : on ne complete pas automatiquement,
        # mais on renvoie les candidats trouves pour le rapport.
        return None, candidates[:5]

    match = exact_matches[0]
    siren = match.get("siren") or ""

    def clean_val(v):
        if not v or v == "[NON-DIFFUSIBLE]":
            return ""
        return v

    siege = match.get("siege") or {}
    siret = clean_val(siege.get("siret"))
    code_postal = clean_val(siege.get("code_postal"))
    ville = clean_val(siege.get("libelle_commune"))
    adresse_complete = clean_val(siege.get("adresse"))
    numero_voie = clean_val(siege.get("numero_voie"))
    type_voie = clean_val(siege.get("type_voie"))
    libelle_voie = clean_val(siege.get("libelle_voie"))
    complement = clean_val(siege.get("complement_adresse"))
    adresse_voie = " ".join(filter(None, [numero_voie, type_voie, libelle_voie])).strip()
    if complement:
        adresse_voie = f"{adresse_voie} {complement}".strip()
    if not adresse_voie:
        adresse_voie = adresse_complete

    return {
        "siren": siren,
        "siret": siret,
        "adresse": adresse_voie,
        "code_postal": code_postal,
        "ville": ville,
        "nom_officiel": match.get("nom_complet") or "",
    }, candidates[:5]


def lookup_vies(country_code: str, vat_number: str):
    """Interroge l'API VIES (Commission Europeenne) pour un numero de TVA europeen.
    Retourne un dict {nom, adresse, code_postal, ville, valide} ou None en cas
    d'erreur reseau. Si valide=True mais nom/adresse == '---', le pays ne transmet
    pas le detail via VIES (limite officielle, pas un echec du script)."""
    url = f"{VIES_API_BASE}/{country_code}/vat/{urllib.parse.quote(vat_number)}"
    try:
        data = _http_get_json(url)
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as e:
        print(f"  [!] Erreur reseau VIES pour {country_code}{vat_number}: {e}", file=sys.stderr)
        return None

    is_valid = data.get("isValid", False)
    name = data.get("name") or ""
    address = data.get("address") or ""
    if name in ("---", ""):
        name = ""
    if address in ("---", ""):
        address = ""

    # VIES renvoie l'adresse en un seul bloc (ex: "12 RUE X, 75000 PARIS, PARIS").
    # On tente d'isoler un code postal (4 a 6 chiffres) pour la colonne dediee ;
    # sinon on met tout dans Adresse.
    code_postal = ""
    ville = ""
    if address:
        m = re.search(r"\b(\d{4,6})\b\s*,?\s*([A-ZÀ-Ÿ' \-]+)", address)
        if m:
            code_postal = m.group(1)
            ville = m.group(2).strip().rstrip(",").strip()

    return {
        "valide": is_valid,
        "nom_officiel": name,
        "adresse": address,
        "code_postal": code_postal,
        "ville": ville,
    }


# ---------------------------------------------------------------------------
# Reprise apres execution precedente
# ---------------------------------------------------------------------------

def load_already_done(path, col_nom, col_tva, delimiter):
    """Charge un fichier .traites.csv d'une execution precedente et retourne
    un set de cles (Nom, TVA_originale) deja completees, plus les lignes
    elles-memes (pour les recopier sans re-interroger les API)."""
    import os
    if not os.path.exists(path):
        return set(), []
    try:
        with open(path, encoding="utf-8") as f:
            reader = csv.DictReader(f, delimiter=delimiter)
            rows = list(reader)
    except Exception as e:
        print(f"  [!] Impossible de relire {path} pour la reprise: {e}", file=sys.stderr)
        return set(), []

    keys = set()
    for r in rows:
        key = ((r.get(col_nom) or "").strip(), clean_vat(r.get(col_tva) or ""))
        keys.add(key)
    return keys, rows


# ---------------------------------------------------------------------------
# Programme principal
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("input_csv")
    parser.add_argument("output_csv", nargs="?", default=None,
                         help="Base de nom pour les fichiers de sortie (optionnel : derive automatiquement du fichier d'entree si omis)")
    parser.add_argument("--generic", default=None,
                         help="Noms (separes par virgules) a laisser inchanges car non identifiables (libelles generiques). "
                              "Si omis, une liste par defaut de libelles courants est utilisee. Passer --generic \"\" pour la desactiver.")
    parser.add_argument("--delimiter", default=";", help="Delimiteur CSV (par defaut ';' comme Pennylane)")
    parser.add_argument("--no-resume", action="store_true",
                         help="Ignore le fichier .traites.csv existant et refait toutes les recherches")
    args = parser.parse_args()

    if args.generic is None:
        generic_names = set(DEFAULT_GENERIC_NAMES)
        print(f"(Liste --generic par defaut utilisee : {', '.join(sorted(generic_names))})")
    else:
        generic_names = {n.strip() for n in args.generic.split(",") if n.strip()}

    output_arg = args.output_csv or derive_output_base(args.input_csv)
    if output_arg != args.output_csv:
        print(f"(Fichiers de sortie derives automatiquement : {output_arg}.*)")

    base = output_arg[:-4] if output_arg.lower().endswith(".csv") else output_arg
    out_traites_path = base + ".traites.csv"
    out_a_traiter_path = base + ".a_traiter.csv"
    report_path = base + ".report.txt"

    with open(args.input_csv, encoding="utf-8") as f:
        reader = csv.DictReader(f, delimiter=args.delimiter)
        fieldnames = reader.fieldnames
        rows = list(reader)

    def find_col(possible_names):
        for name in possible_names:
            if name in fieldnames:
                return name
        return None

    col_nom = find_col(["Nom"])
    col_siret = find_col(["SIRET"])
    col_tva = find_col(["Numéro TVA", "Numero TVA", "TVA"])
    col_adresse = find_col(["Adresse"])
    col_cp = find_col(["Code postal"])
    col_ville = find_col(["Ville"])
    col_pays = find_col(["Pays"])

    missing = [n for n, v in [("Nom", col_nom), ("SIRET", col_siret), ("TVA", col_tva),
                               ("Adresse", col_adresse), ("Code postal", col_cp),
                               ("Ville", col_ville), ("Pays", col_pays)] if v is None]
    if missing:
        print(f"ERREUR: colonnes introuvables dans le CSV: {missing}", file=sys.stderr)
        print(f"Colonnes detectees: {fieldnames}", file=sys.stderr)
        sys.exit(1)

    # --- Reprise : on recharge ce qui a deja ete traite lors d'un run precedent ---
    already_done_keys = set()
    already_done_rows_by_key = {}
    if not args.no_resume:
        already_done_keys, prev_rows = load_already_done(out_traites_path, col_nom, col_tva, args.delimiter)
        for r in prev_rows:
            key = ((r.get(col_nom) or "").strip(), clean_vat(r.get(col_tva) or ""))
            already_done_rows_by_key[key] = r
        if already_done_keys:
            print(f"Reprise : {len(already_done_keys)} fournisseur(s) deja traite(s) lors d'une execution precedente, ne seront pas re-interroges.")

    stats = {
        "deja_traites_reprise": 0,
        "completed_fr": 0,
        "completed_vies": 0,
        "completed_by_name": 0,
        "diffusion_partielle_fr": 0,
        "vies_sans_detail": 0,
        "not_found_fr": 0,
        "generic_skipped": 0,
        "unchanged_no_vat": 0,
        "no_vat_no_match": 0,
        "vat_normalized": 0,
    }
    diffusion_partielle_list = []
    not_found_list = []
    vies_sans_detail_list = []
    unchanged_list = []
    no_vat_candidates_list = []
    completed_by_name_list = []

    rows_traites = []
    rows_a_traiter = []

    siren_cache = {}
    vies_cache = {}
    name_cache = {}

    for row in rows:
        nom = (row.get(col_nom) or "").strip()
        vat_raw = (row.get(col_tva) or "").strip()
        original_key = (nom, clean_vat(vat_raw))

        # --- Reprise : deja fait precedemment, on recopie sans re-interroger ---
        if original_key in already_done_keys:
            rows_traites.append(already_done_rows_by_key[original_key])
            stats["deja_traites_reprise"] += 1
            continue

        # --- Ligne deja complete dans le fichier d'entree (ex: corrigee a la main,
        # ou export Pennylane mis a jour entre deux runs) : on ne reinterroge rien. ---
        if row.get(col_siret) and row.get(col_adresse) and row.get(col_cp) and row.get(col_ville):
            rows_traites.append(row)
            stats["deja_traites_reprise"] += 1
            continue

        if nom in generic_names:
            stats["generic_skipped"] += 1
            rows_a_traiter.append(row)
            continue

        if not vat_raw:
            # --- Pas de TVA exploitable : tentative de recherche stricte par nom ---
            if nom in name_cache:
                info, candidates = name_cache[nom]
            else:
                print(f"[NOM] Recherche par raison sociale '{nom}'...")
                info, candidates = lookup_by_name(nom)
                name_cache[nom] = (info, candidates)
                time.sleep(SLEEP_BETWEEN_CALLS)

            if info and info["siret"]:
                tva_reconstruite = compute_french_vat_from_siren(info["siren"])
                if not row.get(col_siret):
                    row[col_siret] = info["siret"]
                if not row.get(col_adresse):
                    row[col_adresse] = info["adresse"]
                if not row.get(col_cp):
                    row[col_cp] = info["code_postal"]
                if not row.get(col_ville):
                    row[col_ville] = info["ville"]
                if tva_reconstruite and not row.get(col_tva):
                    row[col_tva] = tva_reconstruite
                row[col_pays] = "FR"
                stats["completed_by_name"] += 1
                verif_url = f"{ANNUAIRE_BASE}{info['siren']}" if info.get("siren") else ""
                completed_by_name_list.append(
                    f"{nom} -> {info.get('nom_officiel') or nom} "
                    f"(SIREN {info.get('siren', '')}) : {verif_url}"
                )
                rows_traites.append(row)
            else:
                stats["no_vat_no_match"] += 1
                if candidates:
                    cand_str = "; ".join(
                        f"{c[0]} (SIREN {c[1]}, {c[2]} - {ANNUAIRE_BASE}{c[1]})"
                        for c in candidates if c[0]
                    )
                    no_vat_candidates_list.append(f"{nom} -> candidats trouves : {cand_str}")
                else:
                    unchanged_list.append(nom)
                rows_a_traiter.append(row)
            continue

        vat_clean = clean_vat(vat_raw)
        if vat_clean != vat_raw:
            row[col_tva] = vat_clean
            stats["vat_normalized"] += 1

        siren = extract_french_siren(vat_clean)

        if siren:
            # --- Fournisseur francais ---
            if siren in siren_cache:
                info = siren_cache[siren]
            else:
                print(f"[FR] Recherche SIREN {siren} ({nom})...")
                info = lookup_siren(siren)
                siren_cache[siren] = info
                time.sleep(SLEEP_BETWEEN_CALLS)

            row[col_pays] = "FR"

            if info and info["siret"]:
                if not row.get(col_siret):
                    row[col_siret] = info["siret"]
                if not row.get(col_adresse):
                    row[col_adresse] = info["adresse"]
                if not row.get(col_cp):
                    row[col_cp] = info["code_postal"]
                if not row.get(col_ville):
                    row[col_ville] = info["ville"]
                stats["completed_fr"] += 1
                rows_traites.append(row)
            elif info is not None:
                # Entreprise existante mais en diffusion partielle (EI/particulier) :
                # SIRET/adresse non disponibles publiquement.
                stats["diffusion_partielle_fr"] += 1
                diffusion_partielle_list.append(f"{nom} (SIREN {siren})")
                rows_a_traiter.append(row)
            else:
                stats["not_found_fr"] += 1
                not_found_list.append(f"{nom} (SIREN {siren})")
                rows_a_traiter.append(row)
        else:
            # --- Fournisseur etranger : code pays + tentative VIES si UE ---
            cc = vat_country_code(vat_clean)
            EU_COUNTRY_CODES = {
                "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "EL", "GR", "ES", "FI", "FR",
                "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE",
                "SI", "SK", "XI",
            }
            if cc and cc != "FR":
                row[col_pays] = cc

            if cc in EU_COUNTRY_CODES and cc != "FR":
                vat_local = vat_number_without_country(vat_clean, cc)
                vies_key = (cc, vat_local)
                if vies_key in vies_cache:
                    info = vies_cache[vies_key]
                else:
                    print(f"[VIES] Recherche {cc}{vat_local} ({nom})...")
                    info = lookup_vies(cc, vat_local)
                    vies_cache[vies_key] = info
                    time.sleep(SLEEP_BETWEEN_CALLS)

                if info and info.get("nom_officiel") and info.get("adresse"):
                    if not row.get(col_adresse):
                        row[col_adresse] = info["adresse"]
                    if not row.get(col_cp) and info.get("code_postal"):
                        row[col_cp] = info["code_postal"]
                    if not row.get(col_ville) and info.get("ville"):
                        row[col_ville] = info["ville"]
                    stats["completed_vies"] += 1
                    rows_traites.append(row)
                else:
                    # TVA valide ou non mais pas de detail transmis par ce pays via VIES
                    stats["vies_sans_detail"] += 1
                    vies_sans_detail_list.append(f"{nom} ({cc}{vat_local})")
                    rows_a_traiter.append(row)
            elif cc:
                # Pays non-UE (ex: GB post-Brexit, US...) : code pays seulement, pas de VIES
                stats["vies_sans_detail"] += 1
                vies_sans_detail_list.append(f"{nom} ({cc}, pays hors UE/VIES)")
                rows_a_traiter.append(row)
            else:
                stats["unchanged_no_vat"] += 1
                unchanged_list.append(nom)
                rows_a_traiter.append(row)

    with open(out_traites_path, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, delimiter=args.delimiter)
        writer.writeheader()
        writer.writerows(rows_traites)

    with open(out_a_traiter_path, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, delimiter=args.delimiter)
        writer.writeheader()
        writer.writerows(rows_a_traiter)

    with open(report_path, "w", encoding="utf-8") as f:
        f.write("Rapport d'enrichissement Pennylane\n")
        f.write("=" * 40 + "\n\n")
        f.write(f"Deja traites lors d'une execution precedente (repris sans re-interroger) : {stats['deja_traites_reprise']}\n")
        f.write(f"Fournisseurs francais completes (SIRET+adresse) : {stats['completed_fr']}\n")
        f.write(f"Fournisseurs europeens completes via VIES (adresse) : {stats['completed_vies']}\n")
        f.write(f"Fournisseurs completes via recherche par nom (sans TVA au depart) : {stats['completed_by_name']}\n")
        f.write(f"Fournisseurs francais en diffusion partielle (SIRET protege, EI/particulier) : {stats['diffusion_partielle_fr']}\n")
        f.write(f"Fournisseurs francais introuvables (SIREN inactif/inconnu) : {stats['not_found_fr']}\n")
        f.write(f"Fournisseurs etrangers sans detail disponible (VIES ne transmet pas, ou hors UE) : {stats['vies_sans_detail']}\n")
        f.write(f"Libelles generiques ignores : {stats['generic_skipped']}\n")
        f.write(f"Lignes sans TVA et sans nom exploitable : {stats['unchanged_no_vat']}\n")
        f.write(f"Lignes sans TVA, nom trouve mais ambigu/non confirme : {stats['no_vat_no_match']}\n")
        f.write(f"Numeros de TVA normalises (format nettoye) : {stats['vat_normalized']}\n\n")
        if completed_by_name_list:
            f.write("Fournisseurs completes par RECHERCHE DE NOM (sans TVA au depart) -\n")
            f.write("a verifier : completion automatique faite car un seul match exact\n")
            f.write("trouve, mais ouvre le lien Sirene/INSEE pour confirmer (1 clic) :\n")
            for x in completed_by_name_list:
                f.write(f"  - {x}\n")
            f.write("\n")
        if diffusion_partielle_list:
            f.write("Fournisseurs en diffusion partielle - SIRET a saisir manuellement (entreprise individuelle protegee par la loi) :\n")
            for x in diffusion_partielle_list:
                f.write(f"  - {x}\n")
            f.write("\n")
        if not_found_list:
            f.write("Fournisseurs francais introuvables :\n")
            for x in not_found_list:
                f.write(f"  - {x}\n")
            f.write("\n")
        if vies_sans_detail_list:
            f.write("Fournisseurs etrangers sans detail disponible (pays ne transmettant pas via VIES, ou hors UE) :\n")
            for x in vies_sans_detail_list:
                f.write(f"  - {x}\n")
            f.write("\n")
        if no_vat_candidates_list:
            f.write("Lignes sans TVA - candidats trouves par recherche de nom mais AMBIGUS\n")
            f.write("(plusieurs entreprises actives correspondent, ou aucune correspondance\n")
            f.write("exacte de nom : a verifier et completer a la main pour eviter une erreur) :\n")
            for x in no_vat_candidates_list:
                f.write(f"  - {x}\n")
            f.write("\n")
        if unchanged_list:
            f.write("Lignes sans numero de TVA ni correspondance trouvee par nom :\n")
            for x in unchanged_list:
                f.write(f"  - {x}\n")

    print("\n" + "=" * 40)
    print("Termine.")
    for k, v in stats.items():
        print(f"  {k}: {v}")
    print(f"\nFichier des lignes completees   : {out_traites_path}  ({len(rows_traites)} lignes)")
    print(f"Fichier des lignes a traiter    : {out_a_traiter_path}  ({len(rows_a_traiter)} lignes)")
    print(f"Rapport detaille                : {report_path}")


if __name__ == "__main__":
    main()
