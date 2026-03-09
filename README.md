# Capsule

Application web self-hosted de gestion et lecture de vidéos. Organisez vos bibliothèques, partagez-les entre utilisateurs et streamez depuis n'importe quel navigateur.

## Fonctionnalités

- **Bibliothèques** — Ajoutez des dossiers locaux comme bibliothèques, scannez automatiquement les fichiers vidéo
- **Lecteur intégré** — Lecteur vidéo (ArtPlayer) avec reprise de lecture, auto-play, raccourcis clavier
- **Navigation** — Vue dossiers ou liste plate, tri par nom/date/taille, grille ou tableau, recherche globale
- **Thumbnails & sprites** — Génération automatique de miniatures et sprites de preview au survol (ffmpeg)
- **Tags & playlists** — Organisez vos vidéos avec des tags colorés et des playlists ordonnées
- **Favoris & historique** — Suivi de progression, historique de lecture, favoris
- **Détection de doublons** — Identifie les fichiers identiques à travers les bibliothèques
- **Multi-utilisateur** — Rôles admin/user, partage de bibliothèques avec permissions lecture/écriture
- **Thèmes** — Mode sombre et clair
- **File watcher** — Détection automatique des nouveaux fichiers ajoutés aux bibliothèques
- **Worker séparé** — Traitement ffmpeg (thumbnails, sprites, métadonnées) dans un processus dédié
- **Docker ready** — Image Docker multi-arch (amd64/arm64), CI/CD GitHub Actions

## Stack

- **Backend** — Node.js, Express, EJS
- **Base de données** — MySQL 8
- **Frontend** — Vanilla JS/CSS, ArtPlayer
- **Infra** — Docker, GitHub Actions, GHCR

## Déploiement rapide

### 1. Cloner et configurer

```bash
git clone https://github.com/sn0walice/capsule.git
cd capsule
cp .env.example .env
```

Editez `.env` avec vos valeurs :

```env
PORT=3000
DB_HOST=mysql
DB_PORT=3306
DB_USER=capsule
DB_PASSWORD=un_mot_de_passe_fort
DB_NAME=capsule
SESSION_SECRET=une_chaine_aleatoire_longue
DISABLE_REGISTER=false
```

### 2. Lancer avec Docker Compose

**Développement (build local) :**

```bash
docker compose up -d
```

**Production (image pré-construite depuis GHCR) :**

```bash
docker compose -f docker-compose.prod.yml up -d
```

L'application est accessible sur `http://localhost:3000`.

### 3. Premier lancement

1. Ouvrez l'application dans votre navigateur
2. Créez un compte — le **premier utilisateur inscrit devient automatiquement admin**
3. Ajoutez une bibliothèque en indiquant le chemin du dossier monté (ex: `/media/films`)
4. Lancez un scan pour indexer les vidéos

## Volumes

| Chemin conteneur | Description |
|---|---|
| `/media` | Point de montage pour vos fichiers vidéo |
| `/var/lib/mysql` | Données MySQL (volume Docker) |

Montez les **mêmes volumes** sur les conteneurs `app` et `worker`. Le worker a besoin d'accéder aux fichiers pour générer les thumbnails.

Montez autant de dossiers que nécessaire, puis ajoutez-les comme bibliothèques dans l'interface :

```yaml
volumes:
  - /chemin/local/films:/media/films
  - /chemin/local/series:/media/series
```

## Variables d'environnement

| Variable | Description | Défaut |
|---|---|---|
| `PORT` | Port de l'application | `3000` |
| `DB_HOST` | Hôte MySQL | `mysql` |
| `DB_PORT` | Port MySQL | `3306` |
| `DB_USER` | Utilisateur MySQL | `capsule` |
| `DB_PASSWORD` | Mot de passe MySQL | — |
| `DB_NAME` | Nom de la base | `capsule` |
| `SESSION_SECRET` | Secret pour les sessions | — |
| `DISABLE_REGISTER` | Désactiver les inscriptions | `false` |
| `MEDIA_PATH` | Chemin local des médias (compose) | `./media` |
| `WORKER_CONCURRENCY` | Jobs ffmpeg en parallèle (worker) | `2` |
| `WORKER_POLL_INTERVAL` | Intervalle de polling du worker (ms) | `3000` |

## CI/CD

Le workflow GitHub Actions (`.github/workflows/docker.yml`) build et push automatiquement l'image Docker sur GHCR :

- **Push sur `main`** — build et push avec les tags `latest` + SHA du commit
- **Tag `v*`** — build et push avec le tag de version (ex: `v1.0.0` → `1.0.0`, `1.0`)
- **Pull request** — build uniquement (pas de push), vérifie que l'image compile
- **Multi-arch** — `linux/amd64` et `linux/arm64`

L'image est disponible sur `ghcr.io/sn0walice/capsule`.

## Architecture

```
┌─────────┐     ┌─────────┐     ┌─────────┐
│   app   │────▶│  MySQL  │◀────│ worker  │
│ (web)   │     │         │     │ (ffmpeg)│
└─────────┘     └─────────┘     └─────────┘
```

- **app** — Serveur web Express (scan, streaming, API). Ne fait aucun appel ffmpeg.
- **worker** — Processus séparé qui poll la table `jobs` et exécute les tâches ffmpeg (thumbnails, sprites, métadonnées). Si le worker crash, le serveur web continue de fonctionner.
- **MySQL** — Base partagée. La table `jobs` sert de file d'attente entre app et worker.

## Administration

Le panneau admin (`/admin`) permet de :

- Voir la liste des utilisateurs
- Changer les rôles (admin/user)
- Réinitialiser les mots de passe
- Supprimer des comptes

## Partage de bibliothèques

Chaque utilisateur peut partager ses bibliothèques avec d'autres :

- **Lecture** — Parcourir et streamer les vidéos
- **Lecture/Écriture** — Parcourir, streamer, renommer, tagger et scanner

## Raccourcis clavier (lecteur)

| Touche | Action |
|---|---|
| `F` | Ajouter/retirer des favoris |
| `N` | Vidéo suivante |
| `M` | Changer le mode auto-play |
| `T` | Ajouter un tag |

## Licence

MIT
