#!/bin/bash
# ============================================================================
# Traiter un export Pennylane  —  lanceur "glisser-deposer"
# ----------------------------------------------------------------------------
# UTILISATION (aucune competence technique requise) :
#   1. Double-cliquez sur ce fichier. Une fenetre noire (le Terminal) s'ouvre.
#   2. Glissez le fichier CSV exporte de Pennylane (ou le dossier d'un client)
#      DEPUIS LE FINDER directement dans cette fenetre, puis appuyez sur Entree.
#   3. C'est tout. Les fichiers .traites.csv / .a_traiter.csv / .report.txt
#      sont crees a cote du fichier d'origine.
#
# Vous pouvez traiter plusieurs fichiers a la suite : recommencez l'etape 2.
# Pour quitter : appuyez sur Entree sans rien glisser, ou fermez la fenetre.
# ============================================================================

# Se placer dans le dossier de ce lanceur (= dossier du script Python).
cd "$(dirname "$0")" || exit 1
SCRIPT_DIR="$(pwd)"
PY_SCRIPT="$SCRIPT_DIR/pennylane_enrich.py"

clear
echo "============================================================"
echo "  Enrichissement des exports fournisseurs Pennylane"
echo "============================================================"
echo

# --- Verifier que le script Python est bien la ---
if [ ! -f "$PY_SCRIPT" ]; then
  echo "  [!] Fichier introuvable : pennylane_enrich.py"
  echo "      Ce lanceur doit rester dans le MEME dossier que le script."
  echo
  echo "Appuyez sur Entree pour fermer."
  read -r _
  exit 1
fi

# --- Trouver Python 3 ---
PYBIN=""
for cand in python3 /usr/bin/python3 /usr/local/bin/python3 /opt/homebrew/bin/python3; do
  if command -v "$cand" >/dev/null 2>&1; then PYBIN="$cand"; break; fi
done
if [ -z "$PYBIN" ]; then
  echo "  [!] Python 3 n'est pas installe."
  echo "      Une fenetre macOS va te proposer de l'installer en un clic."
  echo "      Acceptez, attendez la fin, puis relancez ce lanceur."
  echo
  xcode-select --install 2>/dev/null
  echo "Appuyez sur Entree pour fermer."
  read -r _
  exit 1
fi

# Nettoie un chemin glisse-depose (enleve guillemets, antislashs d'echappement
# et espaces de debut/fin que le Finder ajoute parfois).
clean_path() {
  local p="$1"
  p="${p%\"}"; p="${p#\"}"        # guillemets doubles
  p="${p%\'}"; p="${p#\'}"        # guillemets simples
  p="${p//\\/}"                   # antislashs d'echappement
  p="${p#"${p%%[![:space:]]*}"}"  # trim debut
  p="${p%"${p##*[![:space:]]}"}"  # trim fin
  printf '%s' "$p"
}

# Traite un seul fichier CSV.
process_file() {
  local f="$1"
  echo
  echo ">>> Traitement de : $(basename "$f")"
  echo "------------------------------------------------------------"
  "$PYBIN" "$PY_SCRIPT" "$f"
  echo "------------------------------------------------------------"
}

while true; do
  echo
  echo "Glissez ici le fichier CSV Pennylane (ou le dossier d'un client),"
  echo "puis appuyez sur Entree.  (Entree seul = quitter)"
  echo
  printf "  Fichier > "
  read -r RAW
  RAW="$(clean_path "$RAW")"

  # Entree vide -> on quitte.
  if [ -z "$RAW" ]; then
    echo
    echo "A bientot."
    break
  fi

  if [ -d "$RAW" ]; then
    # Un dossier a ete glisse : on traite chaque export fournisseurs trouve.
    found=0
    while IFS= read -r f; do
      found=1
      process_file "$f"
    done < <(find "$RAW" -maxdepth 1 -type f -iname "*fournisseur*.csv" \
               ! -iname "*.traites.csv" ! -iname "*.a_traiter.csv")
    if [ "$found" -eq 0 ]; then
      echo "  [!] Aucun export fournisseurs (*.csv) trouve dans ce dossier."
    fi
  elif [ -f "$RAW" ]; then
    process_file "$RAW"
  else
    echo "  [!] Introuvable : $RAW"
    echo "      Verifiez que vous avez bien glisse un fichier ou un dossier."
  fi
done
