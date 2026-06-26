# Conception & choix techniques

Ce document trace les décisions techniques et de conception du projet, leurs
raisons, et les compromis acceptés, pour qu'il reste compréhensible et
maintenable dans le temps. Pour l'utilisation, voir le [README](README.md).

## Sommaire

- [VIES est-il le bon choix pour l'Europe ?](#vies-est-il-le-bon-choix-pour-leurope-)
- [Dépendances](#dépendances)
- [Choix structurants (et pourquoi)](#choix-structurants-et-pourquoi)
- [Contraintes](#contraintes)

---

## VIES est-il le bon choix pour l'Europe ?

**Oui, pour notre besoin précis (numéro de TVA → identité/adresse), VIES reste
la meilleure option gratuite.** C'est la **seule source officielle** qui se
requête directement par numéro de TVA intracommunautaire à l'échelle de l'UE.
La quasi-totalité des « alternatives » commerciales (VAT Sense, vatlayer,
vatnode, EuroValidate…) ne font qu'**envelopper VIES** en ajoutant du cache et
des fallbacks — la donnée d'origine vient toujours de VIES.

Sa limite n'est pas technique mais **politique** : certains pays (Allemagne,
Espagne, Pays-Bas, Italie…) **ne transmettent pas** le nom/adresse via VIES,
seulement la validité. Aucun autre service gratuit ne comble entièrement ce
trou de façon automatique. Les compléments possibles, par ordre d'intérêt :

- **GLEIF / LEI** ([gleif.org](https://www.gleif.org/en/lei-data/gleif-api)) —
  API gratuite, sans clé, donne l'adresse légale vérifiée. **Mais** ne couvre
  que les entités disposant d'un identifiant LEI (grandes entreprises et acteurs
  financiers surtout) ; la majorité des PME fournisseurs n'en ont pas. Utile en
  *fallback* pour les gros fournisseurs étrangers.
- **Registres nationaux** (Handelsregister/Unternehmensregister DE, Brønnøysund
  NO, Companies House UK, etc.) — exhaustifs et gratuits, mais **un par pays**,
  formats et accès hétérogènes : lourd à intégrer.
- **BRIS** (Business Registers Interconnection System, via le portail e-Justice
  européen) — interconnecte les registres nationaux, mais conçu pour la
  consultation humaine, sans API propre exploitable simplement.

**Conclusion** : on garde VIES comme moteur principal pour l'UE. Si le besoin
de compléter les pays « muets » (DE, ES, NL…) devient prioritaire, le meilleur
ajout serait **GLEIF en fallback** (gratuit, sans clé) pour les fournisseurs qui
ont un LEI, puis le recours manuel au registre national pour le reste.

---

## Dépendances

- **Python 3 + bibliothèque standard uniquement** (`csv`, `json`, `urllib`,
  `re`, `unicodedata`, `argparse`). **Aucune librairie tierce** (pas de
  `requests`, pas de `pandas`). → installation nulle, le script tourne tel quel
  sur n'importe quel macOS/Linux avec Python 3.
- **macOS** pour le lanceur `.command` (Terminal natif). Le script `.py` lui est
  multiplateforme.
- **APIs externes** : recherche-entreprises.api.gouv.fr (Sirene/INSEE) et VIES.
  Pas de clé, pas de compte.

## Choix structurants (et pourquoi)

| Choix | Raison | Compromis accepté |
|---|---|---|
| **Python plutôt que shell POSIX / `jq`** | Python gère JSON + CSV + Unicode + HTTP en standard, sans rien installer. `jq` n'est **pas** préinstallé sur macOS → un portage shell ajouterait une dépendance (Homebrew + jq), donc *plus* de friction. | Suppose Python 3 présent (proposé en 1 clic par macOS au 1ᵉʳ lancement). |
| **Lanceur `.command` glisser-déposer plutôt que réécriture** | Le vrai frein pour un non-développeur n'est pas le langage mais *ouvrir un terminal et taper un chemin*. Un double-clic + glisser-déposer supprime ce frein sans toucher à la logique. | Spécifique macOS ; averti par Gatekeeper au 1ᵉʳ lancement (clic droit → Ouvrir). |
| **SIREN extrait directement de la TVA FR** | La TVA française contient le SIREN ; l'extraction est déterministe et fiable à 100 %, sans recherche floue. | Aucun (c'est la méthode la plus sûre). |
| **TVA FR reconstruite par la formule officielle de la clé** `(12 + 3×(SIREN mod 97)) mod 97` | Permet de remplir la TVA à partir d'un SIREN trouvé par nom, sans appel supplémentaire et sans estimation. | Aucun (formule officielle). |
| **Recherche par nom volontairement stricte** (complétion *seulement* si 1 seul match exact actif) | Éviter d'écrire un mauvais SIRET dans Pennylane (risque de confondre deux sociétés homonymes) est prioritaire sur le taux d'automatisation. | Moins de lignes complétées automatiquement ; les cas ambigus partent en traitement manuel (avec liens de vérification). |
| **VIES comme moteur UE** | Seule source officielle gratuite requêtable par numéro de TVA à l'échelle UE. | Certains pays ne renvoient pas l'adresse (limite politique, voir plus haut). |
| **Code pays toujours recalculé depuis la TVA** | Pennylane met « FR » par défaut à tort sur des fournisseurs étrangers ; c'est précisément l'erreur à corriger. | Écrase la valeur d'entrée du champ Pays (volontaire). |
| **Deux fichiers de sortie (`traites` / `a_traiter`)** | Séparer ce qui est réimportable tout de suite de ce qui demande une action humaine. | Deux fichiers à gérer au lieu d'un. |
| **Liens de vérification dans le `report.txt`, pas dans le CSV** | Le CSV doit rester au format attendu par l'import Pennylane ; ajouter une colonne casserait la réimport. | Le lien n'est pas « à côté » de la ligne dans le CSV, mais dans le rapport. |
| **Reprise idempotente par cache fichier** (`Nom + TVA`) | Ne pas refaire des centaines d'appels API à chaque relance sur un export mis à jour. | Clé imparfaite : une ligne complétée *par nom* (TVA reconstruite) peut être ré-interrogée au run suivant (sans gravité, voir Limites du README). |
| **Débit ~150 ms entre appels** | Rester sous les limites de taux des API publiques (≈7 req/s côté Sirene). | ~1–2 min pour ~220 fournisseurs (acceptable pour un usage par lot). |
| **`.gitignore` excluant les `.csv` et `.report.txt`** | Les exports contiennent des données fournisseurs réelles (RGPD/confidentialité) : on ne versionne que le code. | Le dépôt ne contient aucun jeu de données d'exemple (à anonymiser si besoin un jour). |

## Contraintes

- **Données personnelles / confidentialité** : les exports listent des
  fournisseurs réels → jamais versionnés (voir `.gitignore`).
- **Dépendance réseau** : sans accès aux deux APIs, le script ne complète rien
  (mais ne corrompt rien : tout part en `a_traiter`).
- **Disponibilité de VIES** : service parfois lent ou indisponible côté
  Commission européenne ; pas de SLA.
- **Pas d'authentification GitHub dans l'environnement d'édition** : le `push`
  initial doit être lancé manuellement (voir README / Terminal).
