# Capsule

Application web self-hosted de gestion et lecture de vidéos. Organisez vos bibliothèques, partagez-les entre utilisateurs et streamez depuis n'importe quel navigateur.

## Fonctionnalités

### Bibliothèques
- Ajoutez des dossiers locaux, scan automatique des fichiers vidéo
- **Couvertures** — Thumbnail de couverture affichée sur le dashboard
- **Navigation dossier** avec compteur de vidéos par dossier
- **Vue liste/grille** avec tri par nom, date, taille ou nombre de vues
- **Filtre "non vues"** — Affiche uniquement les vidéos jamais regardées
- **File watcher** — Détection automatique des nouveaux fichiers
- **Détection de doublons** à travers les bibliothèques

### Lecteur vidéo
- Lecteur intégré (ArtPlayer) avec reprise de lecture automatique
- **Auto-play** — Enchaînement aléatoire ou alphabétique
- **Vitesse de lecture persistante** — Sauvegardée entre les sessions
- **Pistes audio multiples** — Affichage des pistes disponibles (langue, codec)
- Raccourcis clavier complets

### Organisation
- **Tags colorés** — 9 couleurs, gestion centralisée, recherche par tag
- **Playlists** — Création, réordonnancement drag & drop
- **Smart playlists** — Playlists auto-générées par critères (tag, durée, résolution, bibliothèque)
- **Lecture en continu** — Bouton "Lire tout" sur les playlists
- **Favoris, watchlist & historique** — Suivi de progression avec section "Continuer à regarder"

### Dashboard
- **Statistiques** — Total vidéos, espace disque, durée totale
- **Continuer à regarder** — Vidéos en cours avec barre de progression
- Sections favoris, watchlist, historique récent

### Multi-utilisateur
- Rôles admin/user, partage de bibliothèques (lecture / lecture+écriture)
- **Création de comptes** par l'admin
- **Désactivation de comptes** sans suppression
- **Dernière connexion** visible dans l'admin
- **Déconnexion forcée** d'un utilisateur
- **Espace disque par bibliothèque** dans le panel admin
- Journal d'audit des actions admin

### Technique
- **Thumbnails** — Génération automatique via ffmpeg
- **Worker séparé** — Traitement ffmpeg dans un processus dédié
- **Thèmes** — Mode sombre et clair
- **Docker ready** — Image multi-arch (amd64/arm64), CI/CD GitHub Actions
- Sécurité : CSRF, rate limiting, protection path traversal

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

- Créer des comptes utilisateur
- Voir la liste des utilisateurs avec dernière connexion
- Changer les rôles (admin/user)
- Activer/désactiver des comptes
- Réinitialiser les mots de passe
- Forcer la déconnexion d'un utilisateur
- Supprimer des comptes
- Voir l'espace disque par bibliothèque
- Surveiller la file d'attente des jobs ffmpeg
- Consulter le journal d'audit

## Partage de bibliothèques

Chaque utilisateur peut partager ses bibliothèques avec d'autres :

- **Lecture** — Parcourir et streamer les vidéos
- **Lecture/Écriture** — Parcourir, streamer, renommer, tagger et scanner

## Raccourcis clavier (lecteur)

| Touche | Action |
|---|---|
| `F` | Ajouter/retirer des favoris |
| `W` | Ajouter/retirer de la watchlist |
| `N` | Vidéo suivante |
| `L` | Plein écran |
| `M` | Changer le mode auto-play |
| `T` | Ajouter un tag |

## Licence

MIT
