# Cadiou Desk : spécification

## 1. Objectif
Guichet à file d'attente virtuelle, comme dans une préfecture. Un visiteur prend un ticket et suit sa position et son attente estimée en direct. Les agents ouvrent des guichets et appellent le ticket suivant.

Livraison en deux jalons :
- **J1** : `docker compose` (nginx, API FastAPI, Redis).
- **J2** : les mêmes trois conteneurs dans un seul pod du Kubernetes de Docker Desktop.

## 2. Hors périmètre (V1)
Comptes utilisateurs, notifications SMS ou email, plusieurs files, plusieurs répliques d'API, HTTPS, Ingress, sauvegarde de Redis hors volume.

## 3. Décisions
| Sujet | Choix |
|---|---|
| Stockage | Redis seul, AOF activé (`appendonly yes`), sur volume |
| Front | HTML/JS/CSS statique servi par nginx, sans build |
| Temps réel | SSE sur `/api/events` |
| Guichets | Une file, `DESK_COUNT` guichets (défaut 3), tous fermés au démarrage |
| Priorité | Score du sorted set = `classe × 10^10 + numéro`. Classe 0 = prioritaire, 1 = normal |
| Attente estimée | Moyenne des 10 derniers services × (position) ÷ guichets ouverts. Défaut 300 s sans historique |
| Abandon | Annulation par le visiteur, ou no-show après `NOSHOW_SECONDS` (défaut 60) |
| Accès agent | Header `X-Desk-Key` comparé à `DESK_KEY` |
| Réplique | Une seule instance d'API |

## 4. Modèle Redis
| Clé | Type | Contenu |
|---|---|---|
| `ticket:seq` | string | Compteur (INCR). Doit rester < 10^10 |
| `queue` | zset | Tickets `waiting`. Membre = numéro, score = voir §3 |
| `ticket:{n}` | hash | `status`, `priority` (0/1), `score`, `desk`, `created_at`, `called_at`, `started_at`, `ended_at` (epoch s) |
| `desk:{d}` | hash | `status` (`open`/`closed`), `ticket` (numéro courant ou vide) |
| `called` | zset | Tickets `called`. Score = échéance no-show (epoch s) |
| `stats:durations` | list | Durées de service en s, bornée à 10 (LPUSH + LTRIM) |
| `events` | pub/sub | Canal : un message à chaque changement d'état |

Statuts d'un ticket : `waiting` → `called` → `serving` → `done`. Sorties : `cancelled`, `no_show`.
Durée de service = `ended_at - started_at`.

## 5. API
Préfixe `/api`. `*` = header `X-Desk-Key` obligatoire (401 sinon). Réponses JSON.

| Méthode | Route | Rôle |
|---|---|---|
| POST | `/tickets` | Prendre un ticket. Retourne numéro, position, attente |
| GET | `/tickets/{n}` | État du ticket : statut, position, attente, guichet |
| DELETE | `/tickets/{n}` | Abandon par le visiteur (ticket `waiting` ou `called`) |
| POST | `/tickets/{n}/prioritize` * | Passage prioritaire |
| GET | `/queue` | Taille, prochains tickets, guichets ouverts |
| GET | `/desks` | État de chaque guichet |
| POST | `/desks/{d}/open` * | Ouvrir le guichet |
| POST | `/desks/{d}/close` * | Fermer le guichet |
| POST | `/desks/{d}/call-next` * | Appeler le suivant. 204 si file vide |
| POST | `/desks/{d}/start` * | Le visiteur appelé est là, début du service |
| POST | `/desks/{d}/finish` * | Fin du service, enregistre la durée |
| GET | `/events` | Flux SSE |
| GET | `/healthz` | `{"status":"ok"}` si Redis répond au PING |

Codes d'erreur : 404 ticket ou guichet inconnu, 409 transition interdite, 401 clé absente ou fausse.

## 6. Règles métier et cas limites
1. **Position** = `ZRANK(queue, n) + 1`. Elle n'est jamais stockée : un abandon, un no-show ou une priorité la modifient pour tous sans écriture.
2. **Appel du suivant** : script Lua atomique (`ZPOPMIN queue`, ticket → `called`, ajout dans `called` avec échéance, affectation au guichet). Deux guichets ne reçoivent jamais le même ticket. Refusé (409) si le guichet est fermé ou déjà occupé.
3. **Passage prioritaire** : le score devient `0 × 10^10 + numéro`. Le ticket passe devant tous les normaux, mais reste derrière les prioritaires arrivés avant lui. Refusé (409) si le ticket n'est pas `waiting`. Sans effet (200) s'il est déjà prioritaire.
4. **Fermeture d'un guichet** : s'il tient un ticket `called` ou `serving`, ce ticket retourne dans `queue` avec son score d'origine (même rang, même priorité), statut `waiting`. Aucune durée n'est enregistrée.
5. **Dernier guichet fermé** : l'attente estimée vaut `null`. Le front affiche « Guichets fermés ».
6. **No-show** : une tâche asyncio de l'API balaie `called` chaque seconde. Un ticket dont l'échéance est dépassée passe `no_show`, le guichet est libéré. Le ticket n'est pas remis dans la file.
7. **Annulation** : d'un ticket `waiting`, retrait de `queue`. D'un ticket `called`, retrait de `called` et libération du guichet. Un ticket `serving` ne s'annule pas (409).
8. **Attente estimée** = `moyenne(stats:durations, défaut 300) × position ÷ max(1, guichets ouverts)`, arrondie à la minute supérieure, `null` si aucun guichet ouvert. Exposée en minutes entières dans le champ `wait_minutes`. Réévaluée à chaque événement.
9. **Redémarrage** : l'état revient de l'AOF. La tâche no-show reprend sur `called`. Les guichets rouverts à la main ne sont pas rouverts seuls : un guichet `open` avant l'arrêt reste `open`.
10. **Capacité** : au-delà de 10^10 tickets le compteur casserait l'ordre des scores. Hors sujet en V1, noté comme limite.

## 7. Temps réel (SSE)
- `GET /api/events` renvoie `text/event-stream`. À la connexion, un événement `snapshot` donne l'état complet (guichets, taille de file, prochains tickets). Ensuite un événement `update` à chaque message du canal `events`, avec le même format.
- Un commentaire `: ping` toutes les 15 s garde la connexion ouverte.
- nginx, sur `location /api/events` : `proxy_buffering off`, `proxy_read_timeout 1h`, `proxy_http_version 1.1`, `Connection ""`.
- Le front (`EventSource`) se reconnecte seul et réaffiche le `snapshot`.
- Deux écrans dans le front : visiteur (prendre un ticket, voir position, annuler) et agent (clé saisie une fois, boutons de guichet).

## 8. Configuration
| Variable | Défaut | Rôle |
|---|---|---|
| `REDIS_URL` | `redis://redis:6379` | compose : `redis://redis:6379`, pod : `redis://127.0.0.1:6379` |
| `API_UPSTREAM` | `api:8000` | lu par nginx via `/etc/nginx/templates`. Pod : `127.0.0.1:8000` |
| `DESK_KEY` | aucune, l'API refuse de démarrer sans | Clé agent |
| `DESK_COUNT` | 3 | Nombre de guichets |
| `NOSHOW_SECONDS` | 60 | Délai avant no-show |

Images épinglées : `python:3.12-slim`, `nginx:1.27-alpine`, `redis:7.4-alpine`. Jamais `:latest`.

## 9. Déploiement
**J1, compose** : `compose.yaml` avec `web` (port 8080 sur l'hôte), `api` (interne), `redis` (interne, volume nommé `redis-data`, `--appendonly yes`). `.env` (non versionné) porte `DESK_KEY`, `.env.example` est versionné.

**J2, Kubernetes** (contexte `docker-desktop`) :
- Un Deployment, 1 réplique, stratégie `Recreate`, avec 3 conteneurs : `web`, `api`, `redis`. Ils se parlent par `127.0.0.1`.
- PVC `redis-data` monté sur `/data` du conteneur redis (storage class par défaut de Docker Desktop).
- Secret `cadiou-desk` portant `DESK_KEY`. Seul `secret.example.yaml` est versionné.
- Readiness sur `/api/healthz` (via `web`), liveness sur `redis-cli ping`.
- Service NodePort `30080` → port 80 du conteneur `web`.
- Images `cadiou-desk-api:0.1.0` et `cadiou-desk-web:0.1.0` construites localement, `imagePullPolicy: IfNotPresent`. À vérifier au début de J2 : Docker Desktop en mode kubeadm (images partagées avec le moteur). Sinon, choisir un autre chemin de chargement avant d'aller plus loin.

## 10. Tests
- **pytest** : logique de la file (priorité, FIFO, abandon, no-show, fermeture de guichet, estimation, atomicité de l'appel), contre un vrai Redis lancé en conteneur par compose. Commande : `docker compose run --rm api pytest`.
- **Smoke** (`scripts/smoke.sh <base_url>`) : ouvre un guichet, prend deux tickets, passe le second en prioritaire, appelle le suivant (doit être le prioritaire), termine, vérifie `/healthz` et qu'un flux SSE envoie un `snapshot`. Lancé sur `http://localhost:8080` (J1) puis `http://localhost:30080` (J2).

## 11. Critères de réussite
**J1** : `docker compose up --build -d`, les trois services `running`/`healthy` dans `docker compose ps`, logs sans erreur, `pytest` vert, smoke vert. Après `docker compose restart`, la file est intacte.

**J2** : `kubectl apply -f k8s/`, le pod `Running` avec `3/3` Ready, smoke vert sur le NodePort. Après `kubectl delete pod`, le pod revient et la file est intacte.

## 12. Limites connues
- Une seule réplique d'API : le balayage no-show n'est pas verrouillé.
- Une seule clé partagée pour tous les agents, pas de trace de qui a agi.
- Pas de HTTPS, la clé circule en clair. Usage local uniquement.
- Aucune sauvegarde de Redis en dehors du volume.
