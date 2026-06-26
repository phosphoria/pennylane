# Pennylane — enrichissement des fournisseurs & clients

Outil pour **compléter automatiquement les coordonnées manquantes** (SIRET,
adresse, code postal, ville, pays) dans les exports « fournisseurs » / « clients »
de [Pennylane](https://www.pennylane.com/).

Pennylane permet d'exporter les fiches incomplètes au format CSV, puis de
réimporter le fichier complété. Ce dépôt automatise l'étape intermédiaire : on part
du **numéro de TVA** (ou, à défaut, du **nom**) de chaque fournisseur, on
interroge des **bases de données publiques et gratuites**, et on remplit les
colonnes vides.

> Décisions techniques, dépendances et compromis : voir **[CONCEPTION.md](CONCEPTION.md)**.

---

## Sommaire

- [Ce que fait l'outil](#ce-que-fait-loutil)
- [Limites connues](#limites-connues)
- [Installation (pour débutant·e)](#installation-pour-débutante)
- [Démarrage rapide (sans compétence technique)](#démarrage-rapide-sans-compétence-technique)
- [Utilisation en ligne de commande](#utilisation-en-ligne-de-commande)
- [Fichiers produits](#fichiers-produits)
- [Sources de données](#sources-de-données)
- [Liens de vérification Sirene/INSEE](#liens-de-vérification-sireneinsee)
- [Structure du dépôt](#structure-du-dépôt)

---

## Ce que fait l'outil

Pour chaque ligne d'un export Pennylane, le script `src/pennylane_enrich.py` :

1. **TVA française** (`FR` + clé + SIREN) : extrait le SIREN et interroge l'API
   officielle Sirene/INSEE pour récupérer **SIRET, adresse, code postal, ville**.
2. **TVA d'un autre pays de l'UE** : interroge **VIES** (Commission européenne)
   pour récupérer **nom + adresse** quand le pays les transmet.
3. **Aucune TVA** : tente une **recherche stricte par raison sociale** sur l'API
   Sirene. La complétion automatique n'a lieu **que si un seul résultat actif
   correspond exactement** au nom ; le numéro de TVA français est alors
   reconstruit à partir du SIREN (formule officielle, fiable à 100 %).
4. **Corrige le code pays** (Pennylane met souvent « FR » par défaut, même pour
   des fournisseurs étrangers).
5. **Normalise** les numéros de TVA mal formatés (espaces, tirets, points).
6. **Ignore les libellés génériques** (Hôtels, Taxi, Parking…).
7. **Sépare** le résultat en deux CSV : lignes prêtes à réimporter vs lignes à
   traiter à la main, et produit un **rapport** détaillé.
8. **Reprise idempotente** : ne ré-interroge pas les fournisseurs déjà complétés
   lors d'une exécution précédente (cache par `Nom + TVA`).

Le script n'utilise **que la bibliothèque standard de Python 3** : aucune
dépendance à installer.

---

## Limites connues

- **Pays UE « muets » via VIES** (DE, ES, NL, IT…) : seul le code pays est
  corrigé ; adresse à saisir à la main.
- **Hors UE** (UK post-Brexit, US…) : VIES ne s'applique pas, code pays
  seulement.
- **Diffusion partielle** (France) : certaines entreprises individuelles
  protègent légalement leur adresse — non récupérable.
- **Découpage CP/ville depuis l'adresse VIES** : en *best-effort* (heuristique).
- **Pas de retry réseau** : un échec transitoire renvoie le fournisseur en
  « à traiter » ; la reprise le rattrape à l'exécution suivante.

Le détail des raisons et des compromis derrière ces limites est dans
[CONCEPTION.md](CONCEPTION.md).

---

## Installation (pour débutant·e)

Pas d'installation compliquée : il suffit de récupérer **deux fichiers** et de
double-cliquer. Aucune ligne de commande.

1. Cliquer sur le bouton **« ⬇ Télécharger »** de la
   [page web du projet](https://phosphoria.github.io/pennylane/) (alternative :
   télécharger `pennylane-outil.zip` depuis la dernière
   [Release GitHub](https://github.com/phosphoria/pennylane/releases/latest)).
   Le zip ne contient **que les deux fichiers nécessaires** :
   - **`pennylane_enrich.py`** — le moteur ;
   - **`Traiter un export Pennylane.command`** — le bouton à double-cliquer.
2. Décompresser le fichier téléchargé (double-clic dessus). Vous obtenez un
   dossier contenant les deux fichiers ; gardez-les **ensemble**. **Déplacez ce
   dossier dans votre dossier personnel** (l'icône maison à votre nom dans le
   Finder) — évitez **Téléchargements / Bureau / Documents**, que macOS protège
   (sinon erreur *« Operation not permitted »* à l'exécution). Vous pouvez ranger
   à côté un sous-dossier par client avec ses exports Pennylane.
3. Double-cliquer sur **`Traiter un export Pennylane.command`**. Au premier
   lancement, macOS bloque les fichiers téléchargés ; il faut l'autoriser **une
   seule fois**, en trois écrans :
   1. la fenêtre d'alerte apparaît → cliquer **« Annuler »** (jamais
      « corbeille ») ;
   2. ouvrir **menu  ▸ Réglages Système ▸ Confidentialité et sécurité**,
      descendre tout en bas, cliquer **« Ouvrir quand même »** ;
   3. à la dernière confirmation, cliquer **« Ouvrir »**. C'est mémorisé : les
      fois suivantes, un simple double-clic suffit.
4. Si une fenêtre macOS propose d'**installer Python**, acceptez (un clic),
   attendez la fin, puis relancez le lanceur. Python est simplement le **moteur
   gratuit et standard qui exécute le script** (édité par une fondation à but non
   lucratif, utilisé partout dans le monde) : rien d'inquiétant à installer.

C'est tout. L'utilisation au quotidien est décrite juste en dessous.

---

## Démarrage rapide (sans compétence technique)

Un lanceur **double-cliquable** est fourni pour macOS :
`src/Traiter un export Pennylane.command`

1. Double-cliquer sur le fichier (au tout premier lancement, voir l'étape 3 de
   l'[Installation](#installation-pour-débutante) pour autoriser l'outil).
2. Une fenêtre Terminal s'ouvre.
3. **Glisser-déposer** le CSV Pennylane (ou le dossier d'un client) dans la
   fenêtre, puis appuyer sur **Entrée**.
4. Les fichiers résultats sont créés à côté du fichier d'origine.

On peut enchaîner plusieurs fichiers ; **Entrée** à vide pour quitter. Si Python 3
n'est pas installé, le lanceur propose l'installation en un clic (Command Line
Tools d'Apple).

> Le lanceur doit rester dans le **même dossier** que `pennylane_enrich.py`.

---

## Utilisation en ligne de commande

```bash
python3 src/pennylane_enrich.py "Client/PENNYLANE_CLIENT_Export_des_fournisseurs.csv"
```

Options :

| Option | Description |
|---|---|
| `OUTPUT.csv` (2ᵉ argument) | Base de nom des fichiers de sortie. Dérivée du nom d'entrée si omise. |
| `--generic "A,B,C"` | Remplace la liste des libellés génériques à ignorer. `--generic ""` la désactive. |
| `--delimiter ";"` | Délimiteur CSV (défaut `;`, comme Pennylane). |
| `--no-resume` | Ignore la reprise et refait toutes les recherches. |

Débit : ~150 ms entre chaque appel, soit 1–2 minutes pour ~220 fournisseurs.

**Libellés génériques ignorés par défaut** (laissés inchangés car non
identifiables comme une vraie entreprise) : Hôtels, Parking, Restaurants,
Taxi(s), Transport(s), Autre(s), FOURNISSEURS DIVERS, DIVERS - FR, DIVERS,
Frais bancaires, Frais de mission, Notes de frais, Péage, Carburant, Essence,
Pourboire(s). Pour ajouter les libellés spécifiques d'un client, utilisez
`--generic` avec la **liste complète** (elle remplace celle par défaut).

---

## Fichiers produits

Pour une entrée `CLIENT_fournisseurs`, trois fichiers sont créés dans le même
dossier :

- **`*.traites.csv`** — lignes entièrement complétées, prêtes à réimporter dans
  Pennylane.
- **`*.a_traiter.csv`** — tout ce qui n'a pas pu être automatisé (libellés
  génériques, TVA introuvable, diffusion partielle, pays UE sans détail VIES,
  hors UE…).
- **`*.report.txt`** — récapitulatif chiffré + listes nominatives par catégorie,
  avec **liens de vérification** pour les complétions par nom.

---

## Sources de données

| Source | Couverture | Donne quoi | Coût |
|---|---|---|---|
| [recherche-entreprises.api.gouv.fr](https://recherche-entreprises.api.gouv.fr/) (Sirene/INSEE) | France | SIRET, adresse, CP, ville, nom officiel | Gratuit, sans clé |
| [VIES](https://ec.europa.eu/taxation_customs/vies/) (Commission européenne) | UE | Validité TVA + nom/adresse selon le pays | Gratuit, sans clé |

Ces deux API sont **officielles, publiques et gratuites**. L'API française
expose les mêmes données que Pappers (source Sirene/INSEE).

> Pourquoi VIES et pas un autre service pour l'Europe (GLEIF, registres
> nationaux, BRIS…) ? L'analyse complète est dans
> [CONCEPTION.md](CONCEPTION.md#vies-est-il-le-bon-choix-pour-leurope-).

---

## Liens de vérification Sirene/INSEE

Quand une ligne **sans TVA** est complétée par recherche de nom, le rapport
`*.report.txt` ajoute un **lien direct** vers la fiche publique de l'entreprise
sur
[annuaire-entreprises.data.gouv.fr](https://annuaire-entreprises.data.gouv.fr/)
(site officiel, données Sirene/INSEE) :

```
Fournisseurs completes par RECHERCHE DE NOM (...) - a verifier :
  - DECATHLON -> DECATHLON SE (SIREN 306138900) : https://annuaire-entreprises.data.gouv.fr/entreprise/306138900
```

Un clic suffit pour confirmer que l'entreprise retenue est la bonne. Les
**candidats ambigus** (non complétés automatiquement) sont eux aussi listés avec
le lien de chaque candidat, pour trancher à la main en quelques secondes.

---

## Structure du dépôt

```
.
├── README.md          # utilisation
├── CONCEPTION.md      # choix techniques, dépendances, contraintes, compromis
├── .github/
│   └── workflows/
│       └── release.yml  # construit le zip de release (2 fichiers) sur tag
├── docs/
│   └── index.html     # page publique (GitHub Pages), orientée utilisateur final
└── src/
    ├── pennylane_enrich.py                  # le script principal
    └── Traiter un export Pennylane.command  # lanceur double-cliquable (macOS)
```

### Publier une nouvelle version (Release)

Le zip de distribution (`pennylane-outil.zip`, **deux fichiers uniquement**) est
fabriqué automatiquement par GitHub Actions à chaque tag de version :

```bash
git tag v1.0
git push origin v1.0
```

Le workflow `.github/workflows/release.yml` crée alors la Release et y attache le
zip. Le bouton « Télécharger » de la page et le README pointent vers
`releases/latest/download/pennylane-outil.zip`, qui sert toujours la dernière
version.

> Les exports CSV des clients ne sont **pas** versionnés (données fournisseurs
> réelles) : `.gitignore` exclut tous les `.csv` et `.report.txt`.
