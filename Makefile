# Makefile — raccourcis pratiques pour le projet Pennylane.
# Necessite uniquement Python 3 (aucune dependance a installer).
#
#   make            -> affiche l'aide
#   make test       -> lance les tests unitaires
#   make run CSV=…   -> traite un export Pennylane
#   make zip        -> construit le zip de distribution (comme la release)
#   make clean      -> supprime les caches Python et dist/

PY       ?= python3
SCRIPT   := src/pennylane_enrich.py
LAUNCHER := src/Traiter un export Pennylane.command

.DEFAULT_GOAL := help
.PHONY: help test run zip clean clean-outputs

help:
	@echo "Cibles disponibles :"
	@echo "  make test          - lance les tests unitaires"
	@echo "  make run CSV=chemin.csv  - traite un export Pennylane"
	@echo "  make zip           - construit dist/pennylane-outil.zip (2 fichiers)"
	@echo "  make clean         - supprime les caches Python et dist/"
	@echo "  make clean-outputs - supprime les fichiers generes (.traites/.a_traiter/.report)"

test:
	$(PY) -m unittest discover -s tests -v

run:
	@test -n "$(CSV)" || { echo "Usage : make run CSV=chemin/vers/export.csv"; exit 1; }
	$(PY) "$(SCRIPT)" "$(CSV)"

zip:
	rm -rf dist
	mkdir -p dist/pennylane
	cp "$(SCRIPT)" dist/pennylane/
	cp "$(LAUNCHER)" dist/pennylane/
	cd dist && zip -r pennylane-outil.zip pennylane >/dev/null
	@echo "Cree : dist/pennylane-outil.zip"

clean:
	rm -rf dist
	find . -name '__pycache__' -type d -prune -exec rm -rf {} +
	find . -name '*.pyc' -delete
	@echo "Nettoye (caches Python, dist/)."

# Supprime les fichiers RESULTATS generes par le script (a utiliser sciemment).
clean-outputs:
	find . -name '*.traites.csv' -delete
	find . -name '*.a_traiter.csv' -delete
	find . -name '*.report.txt' -delete
	@echo "Fichiers de sortie supprimes."
