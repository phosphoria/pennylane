#!/usr/bin/env python3
"""
Tests unitaires pour pennylane_enrich.py — bibliotheque standard uniquement
(pas de dependance a installer).

Lancer, depuis la racine du depot :

    python3 -m unittest discover -s tests -v

ou directement :

    python3 tests/test_pennylane_enrich.py

Les appels reseau sont TOUS simules (aucune requete reelle vers les API).
"""

import contextlib
import importlib.util
import io
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

# --- Chargement du module a tester (par chemin, sans installation) ----------
HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "src", "pennylane_enrich.py")
LAUNCHER = os.path.join(HERE, "..", "src", "Traiter un export Pennylane.command")

_spec = importlib.util.spec_from_file_location("pennylane_enrich", SRC)
pe = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pe)

HEADER_SIRET = ("ID source;Type d'erreur;Nom;SIRET;Numéro TVA;Adresse;"
                "Code postal;Ville;Pays;Retirer des vérifications")
HEADER_SIREN = HEADER_SIRET.replace(";SIRET;", ";SIREN;")


# ===========================================================================
# 1. Fonctions pures (aucun reseau)
# ===========================================================================

class PureFunctionTests(unittest.TestCase):

    def test_clean_vat(self):
        self.assertEqual(pe.clean_vat("  FR 40-303.265045 "), "FR40303265045")

    def test_vat_country_code(self):
        self.assertEqual(pe.vat_country_code("FR40303265045"), "FR")
        self.assertEqual(pe.vat_country_code("ie9692928f"), "IE")
        self.assertIsNone(pe.vat_country_code("123456"))

    def test_extract_french_siren(self):
        self.assertEqual(pe.extract_french_siren("FR40303265045"), "303265045")
        self.assertEqual(pe.extract_french_siren("fr 40 303265045"), "303265045")
        self.assertIsNone(pe.extract_french_siren("IE9692928F"))
        self.assertIsNone(pe.extract_french_siren("FR4030326504"))  # trop court

    def test_vat_number_without_country(self):
        self.assertEqual(pe.vat_number_without_country("IE9692928F", "IE"), "9692928F")
        self.assertEqual(pe.vat_number_without_country("9692928F", "IE"), "9692928F")

    def test_compute_french_vat_from_siren(self):
        # Cle de controle officielle : (12 + 3*(SIREN mod 97)) mod 97
        self.assertEqual(pe.compute_french_vat_from_siren("303265045"), "FR40303265045")
        self.assertIsNone(pe.compute_french_vat_from_siren("123"))       # mauvaise longueur
        self.assertIsNone(pe.compute_french_vat_from_siren("12345678X"))  # non numerique

    def test_normalize_name_for_match(self):
        # accents ignores + forme juridique courante (sans points) retiree
        self.assertEqual(pe.normalize_name_for_match("Éléctric SARL"), "ELECTRIC")
        self.assertEqual(pe.normalize_name_for_match("ACME SAS"), "ACME")
        # insensible a la casse et aux espaces multiples
        self.assertEqual(pe.normalize_name_for_match("Boulangerie Dupont"),
                         pe.normalize_name_for_match("BOULANGERIE  DUPONT"))

    def test_derive_output_base_fournisseurs(self):
        self.assertEqual(
            pe.derive_output_base("ClientA/PENNYLANE_CLIENTA_Export_des_fournisseurs.csv"),
            os.path.join("ClientA", "CLIENTA_fournisseurs"))

    def test_derive_output_base_clients(self):
        self.assertEqual(
            pe.derive_output_base("ClientB/PENNYLANE_CLIENTB_Export_des_clients.csv"),
            os.path.join("ClientB", "CLIENTB_clients"))

    def test_is_generic_name(self):
        gs = set(pe.DEFAULT_GENERIC_NAMES)
        self.assertTrue(pe.is_generic_name("Taxi", gs))                  # exact
        self.assertTrue(pe.is_generic_name("NOTE DE FRAIS - Jean", gs))  # prefixe
        self.assertTrue(pe.is_generic_name("note de frais mars", gs))    # insensible casse
        self.assertTrue(pe.is_generic_name("FRS DIVERS PARIS", gs))      # prefixe avec espace
        self.assertFalse(pe.is_generic_name("ACME", gs))


# ===========================================================================
# 2. Couleurs terminal
# ===========================================================================

class _FakeTTY(io.StringIO):
    def isatty(self):
        return True


class ColorTests(unittest.TestCase):

    def test_no_color_when_not_tty(self):
        # StringIO n'est pas un terminal -> pas de codes couleur.
        self.assertEqual(pe.paint("x", "green", stream=io.StringIO()), "x")

    def test_color_when_tty(self):
        with mock.patch.dict(os.environ, {}, clear=True):  # retire NO_COLOR
            out = pe.paint("x", "green", stream=_FakeTTY())
        self.assertEqual(out, "\033[32mx\033[0m")

    def test_no_color_env_disables(self):
        with mock.patch.dict(os.environ, {"NO_COLOR": "1"}, clear=True):
            self.assertEqual(pe.paint("x", "red", stream=_FakeTTY()), "x")


# ===========================================================================
# 3. Appels reseau simules (_http_get_json monkeypatche)
# ===========================================================================

class NetworkFunctionTests(unittest.TestCase):

    def patch_http(self, payload):
        self.addCleanup(setattr, pe, "_http_get_json", pe._http_get_json)
        pe._http_get_json = lambda url: payload

    def test_lookup_siren_ok(self):
        self.patch_http({"results": [{
            "siren": "303265045", "nom_complet": "ACME FR",
            "siege": {"siret": "30326504500017", "code_postal": "75001",
                      "libelle_commune": "PARIS", "numero_voie": "12",
                      "type_voie": "RUE", "libelle_voie": "DE TEST"},
        }]})
        info = pe.lookup_siren("303265045")
        self.assertEqual(info["siren"], "303265045")
        self.assertEqual(info["siret"], "30326504500017")
        self.assertEqual(info["adresse"], "12 RUE DE TEST")
        self.assertEqual(info["code_postal"], "75001")
        self.assertEqual(info["ville"], "PARIS")

    def test_lookup_siren_non_diffusible(self):
        self.patch_http({"results": [{
            "siren": "303265045",
            "siege": {"siret": "[NON-DIFFUSIBLE]", "code_postal": "[NON-DIFFUSIBLE]",
                      "libelle_commune": "[NON-DIFFUSIBLE]", "adresse": "[NON-DIFFUSIBLE]"},
        }]})
        info = pe.lookup_siren("303265045")
        self.assertEqual(info["siret"], "")
        self.assertEqual(info["ville"], "")

    def test_lookup_siren_no_results(self):
        self.patch_http({"results": []})
        self.assertIsNone(pe.lookup_siren("000000000"))

    def test_lookup_siren_only_other_siren(self):
        # Recherche plein texte : la reponse ne contient qu'une AUTRE entreprise.
        # Son SIRET ne doit pas etre retenu : SIREN non confirme, champs vides.
        self.patch_http({"results": [{
            "siren": "111111111", "nom_complet": "AUTRE SA",
            "siege": {"siret": "11111111100011", "code_postal": "69001",
                      "libelle_commune": "LYON", "adresse": "1 RUE Y 69001 LYON"},
        }]})
        info = pe.lookup_siren("303265045")
        self.assertTrue(info["siren_non_confirme"])
        self.assertEqual(info["siren"], "303265045")
        self.assertEqual(info["siret"], "")
        self.assertEqual(info["adresse"], "")
        self.assertEqual(info["code_postal"], "")
        self.assertEqual(info["ville"], "")

    def test_lookup_siren_exact_match_not_first(self):
        # Le resultat retenu est celui qui porte le SIREN, pas le premier.
        self.patch_http({"results": [
            {"siren": "111111111", "siege": {"siret": "11111111100011"}},
            {"siren": "303265045", "siege": {"siret": "30326504500017"}},
        ]})
        info = pe.lookup_siren("303265045")
        self.assertEqual(info["siret"], "30326504500017")
        self.assertFalse(info.get("siren_non_confirme"))

    def test_lookup_by_name_unique_match(self):
        self.patch_http({"results": [{
            "siren": "303265045", "nom_complet": "ACME", "etat_administratif": "A",
            "siege": {"siret": "30326504500017", "code_postal": "75001",
                      "libelle_commune": "PARIS"},
        }]})
        info, candidates = pe.lookup_by_name("ACME")
        self.assertIsNotNone(info)
        self.assertEqual(info["siren"], "303265045")
        self.assertEqual(len(candidates), 1)

    def test_lookup_by_name_ambiguous(self):
        self.patch_http({"results": [
            {"siren": "111111111", "nom_complet": "MARTIN", "etat_administratif": "A",
             "siege": {"libelle_commune": "PARIS"}},
            {"siren": "222222222", "nom_complet": "MARTIN", "etat_administratif": "A",
             "siege": {"libelle_commune": "LYON"}},
        ]})
        info, candidates = pe.lookup_by_name("MARTIN")
        self.assertIsNone(info)                 # ambigu -> pas de completion auto
        self.assertEqual(len(candidates), 2)

    def test_lookup_by_name_only_other_company(self):
        # Pas de repli sur le premier resultat : une reponse qui ne contient
        # qu'une autre entreprise (nom different) ne complete rien.
        self.patch_http({"results": [{
            "siren": "111111111", "nom_complet": "ACME DISTRIBUTION", "etat_administratif": "A",
            "siege": {"siret": "11111111100011", "libelle_commune": "LYON"},
        }]})
        info, candidates = pe.lookup_by_name("ACME")
        self.assertIsNone(info)
        self.assertEqual(candidates, [("ACME DISTRIBUTION", "111111111", "LYON")])

    def test_lookup_vies_parses_address(self):
        self.patch_http({"isValid": True, "name": "ACME LTD",
                         "address": "12 RUE X, 75000 PARIS"})
        info = pe.lookup_vies("FR", "40303265045")
        self.assertTrue(info["valide"])
        self.assertEqual(info["code_postal"], "75000")
        self.assertEqual(info["ville"], "PARIS")

    def test_lookup_vies_no_detail(self):
        self.patch_http({"isValid": True, "name": "---", "address": "---"})
        info = pe.lookup_vies("DE", "123456789")
        self.assertEqual(info["nom_officiel"], "")
        self.assertEqual(info["adresse"], "")


# ===========================================================================
# 4. Pipeline complet main() (reseau simule, fichiers temporaires)
# ===========================================================================

class MainPipelineTests(unittest.TestCase):

    def setUp(self):
        pe.SLEEP_BETWEEN_CALLS = 0  # pas d'attente pendant les tests

    def patch(self, name, value):
        self.addCleanup(setattr, pe, name, getattr(pe, name))
        setattr(pe, name, value)

    def run_main(self, csv_text, filename, extra_args=None):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d)
        path = os.path.join(d, filename)
        with open(path, "w", encoding="utf-8") as f:
            f.write(csv_text)
        argv = ["pennylane_enrich.py", path] + (extra_args or [])
        base = pe.derive_output_base(path)
        buf, errbuf = io.StringIO(), io.StringIO()
        old = sys.argv
        sys.argv = argv
        try:
            with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(errbuf):
                pe.main()
        finally:
            sys.argv = old

        def read(suffix):
            fp = base + suffix
            if not os.path.exists(fp):
                return None
            with open(fp, encoding="utf-8") as fh:
                return fh.read()

        return {"stdout": buf.getvalue(), "traites": read(".traites.csv"),
                "a_traiter": read(".a_traiter.csv"), "report": read(".report.txt")}

    def test_fournisseurs_writes_siret(self):
        self.patch("lookup_siren", lambda s: {
            "siren": "303265045", "siret": "30326504500017",
            "adresse": "12 RUE X", "code_postal": "75001", "ville": "PARIS",
            "nom_officiel": "ACME"})
        csv = HEADER_SIRET + "\nid;e;ACME FR;;FR40303265045;;;;FR;false\n"
        out = self.run_main(csv, "PENNYLANE_T_Export_des_fournisseurs.csv")
        self.assertIn("30326504500017", out["traites"])   # SIRET 14 chiffres
        self.assertIn("PARIS", out["traites"])

    def test_clients_writes_siren(self):
        self.patch("lookup_siren", lambda s: {
            "siren": "303265045", "siret": "30326504500017",
            "adresse": "12 RUE X", "code_postal": "75001", "ville": "PARIS",
            "nom_officiel": "ACME"})
        csv = HEADER_SIREN + "\nid;e;ACME FR;;FR40303265045;;;;FR;false\n"
        out = self.run_main(csv, "PENNYLANE_T_Export_des_clients.csv")
        line = out["traites"].splitlines()[1]
        self.assertIn("303265045", line)                  # SIREN present
        self.assertNotIn("30326504500017", line)          # PAS le SIRET

    def test_missing_identifier_column_exits(self):
        # Ni SIRET ni SIREN -> alerte + sortie non nulle
        header = HEADER_SIRET.replace(";SIRET;", ";")
        csv = header + "\nid;e;ACME;FR40303265045;;;;FR;false\n"
        with self.assertRaises(SystemExit) as cm:
            self.run_main(csv, "PENNYLANE_T_Export_des_fournisseurs.csv")
        self.assertNotEqual(cm.exception.code, 0)

    def test_generic_label_skipped_without_network(self):
        def boom(*a, **k):
            raise AssertionError("aucune recherche ne doit etre faite pour un libelle generique")
        self.patch("lookup_siren", boom)
        csv = HEADER_SIRET + "\nid;e;Taxi;;FR40303265045;;;;FR;false\n"
        out = self.run_main(csv, "PENNYLANE_T_Export_des_fournisseurs.csv")
        self.assertIn("Taxi", out["a_traiter"])
        self.assertEqual(out["traites"].strip().count("\n"), 0)  # entete seule

    def test_vies_completes_foreign(self):
        self.patch("lookup_vies", lambda cc, num: {
            "valide": True, "nom_officiel": "META", "adresse": "4 GRAND CANAL",
            "code_postal": "", "ville": "DUBLIN"})
        csv = HEADER_SIRET + "\nid;e;Meta;;IE9692928F;;;;IE;false\n"
        out = self.run_main(csv, "PENNYLANE_T_Export_des_fournisseurs.csv")
        self.assertIn("4 GRAND CANAL", out["traites"])

    def test_already_complete_row_is_copied(self):
        def boom(*a, **k):
            raise AssertionError("une ligne deja complete ne doit pas etre re-interrogee")
        self.patch("lookup_siren", boom)
        row = "id;e;ACME;30326504500017;FR40303265045;12 RUE X;75001;PARIS;FR;false"
        csv = HEADER_SIRET + "\n" + row + "\n"
        out = self.run_main(csv, "PENNYLANE_T_Export_des_fournisseurs.csv")
        self.assertIn("ACME", out["traites"])

    def test_ambiguous_candidates_one_per_line(self):
        self.patch("lookup_by_name", lambda nom: (None, [
            ("MARTIN SARL", "111111111", "PARIS"),
            ("MARTIN SAS", "222222222", "LYON"),
        ]))
        csv = HEADER_SIRET + "\nid;e;MARTIN;;;;;;FR;false\n"
        out = self.run_main(csv, "PENNYLANE_T_Export_des_fournisseurs.csv")
        self.assertIn("MARTIN SARL - SIREN 111111111, PARIS - "
                      "https://annuaire-entreprises.data.gouv.fr/entreprise/111111111",
                      out["report"])
        self.assertIn("MARTIN SAS - SIREN 222222222, LYON - "
                      "https://annuaire-entreprises.data.gouv.fr/entreprise/222222222",
                      out["report"])

    def test_siren_not_confirmed_left_untouched_and_reported(self):
        # Bout en bout : l'API ne renvoie qu'une autre entreprise. Rien n'est
        # ecrit, la ligne part en a_traiter et le rapport la signale a verifier.
        self.patch("_http_get_json", lambda url: {"results": [{
            "siren": "111111111", "nom_complet": "AUTRE SA",
            "siege": {"siret": "11111111100011", "code_postal": "69001",
                      "libelle_commune": "LYON", "adresse": "1 RUE Y 69001 LYON"},
        }]})
        csv = HEADER_SIRET + "\nid;e;ACME FR;;FR40303265045;;;;FR;false\n"
        out = self.run_main(csv, "PENNYLANE_T_Export_des_fournisseurs.csv")
        written = out["traites"] + out["a_traiter"]
        self.assertNotIn("11111111100011", written)
        self.assertNotIn("LYON", written)
        self.assertEqual(out["traites"].strip().count("\n"), 0)  # entete seule
        self.assertIn("ACME FR", out["a_traiter"])
        self.assertIn("aucun resultat ne porte exactement ce SIREN) : 1", out["report"])
        self.assertIn("ACME FR (SIREN 303265045) : "
                      "https://annuaire-entreprises.data.gouv.fr/entreprise/303265045",
                      out["report"])


# ===========================================================================
# 5. Le lanceur macOS (.command) — tests boite noire
# ===========================================================================

@unittest.skipUnless(shutil.which("bash"), "bash requis")
class LauncherTests(unittest.TestCase):

    def test_syntax_valid(self):
        r = subprocess.run(["bash", "-n", LAUNCHER], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_empty_input_quits_cleanly(self):
        r = subprocess.run(["bash", LAUNCHER], input="\n",
                           capture_output=True, text=True, timeout=30)
        self.assertIn("A bientot", r.stdout)
        self.assertEqual(r.returncode, 0)

    def test_unknown_path_is_reported(self):
        r = subprocess.run(["bash", LAUNCHER], input="chemin_inexistant_zzz\n\n",
                           capture_output=True, text=True, timeout=30)
        self.assertIn("Introuvable", r.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
