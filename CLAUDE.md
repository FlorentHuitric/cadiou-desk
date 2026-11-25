# Cadiou Desk

Guichet à file d'attente virtuelle : nginx (front statique + proxy), API FastAPI, Redis. Comportement exact, routes et cas limites : voir [SPEC.md](SPEC.md). En cas de doute, SPEC.md fait foi ; si le code doit s'en écarter, modifier SPEC.md d'abord.

## Organisation
- `api/app/` : API. Les règles de la file (position, priorité, appel, fermeture, no-show, estimation) vivent dans `queue.py` (scripts Lua inclus), pas dans les routes (`main.py`).
- `api/tests/` : pytest.
- `web/` : front statique (`index.html`, `app.js`, `style.css`) et `nginx.conf.template`.
- `k8s/` : manifestes du jalon J2.
- `scripts/smoke.sh` : test de bout en bout par curl.

## Règles de conception
- Redis est la seule source de vérité. Aucun état de file en mémoire dans l'API, sauf la tâche de balayage no-show qui relit `called`.
- Les transitions qui touchent plusieurs clés passent par un script Lua atomique.
- Un même code pour compose et Kubernetes : seules `REDIS_URL` et `API_UPSTREAM` changent.
- Une seule réplique d'API.
- Secrets : `DESK_KEY` vient de `.env` (compose) ou du Secret k8s. Jamais dans le code ni dans un fichier versionné.

## Commandes
Tout passe par Docker, rien ne s'installe sur le poste (règles globales). Depuis la racine du projet :

```bash
docker compose up --build -d
```
```bash
docker compose ps
```
```bash
docker compose logs --tail=50
```
```bash
docker compose run --rm api pytest
```
```bash
sh scripts/smoke.sh http://localhost:8080
```
Kubernetes (J2) :
```bash
kubectl apply -f k8s/
```
```bash
kubectl get pods
```
```bash
kubectl logs deploy/cadiou-desk -c api --tail=50
```
```bash
sh scripts/smoke.sh http://localhost:30080
```

## Avant de dire « fini »
- Compose : `docker compose ps` montre les trois services `running`, `docker compose logs --tail=50` sans erreur, pytest et smoke verts.
- Kubernetes : pod `Running` et `3/3` Ready, logs de chaque conteneur sans erreur, smoke vert sur `localhost:30080`. Après un build, charger les images dans le nœud (voir SPEC.md §9) avant `kubectl apply`.
- `Exited`, `Restarting` ou `CrashLoopBackOff` = échec.
- Vérifier le code de retour de chaque commande, pas seulement sa sortie.

## Interdits
- Pas de `docker volume rm`, `docker system prune` ni `kubectl delete pvc` sans avoir montré ce qui part et obtenu l'accord : le volume `redis-data` contient la file.
- Pas de `:latest`. Images épinglées : `python:3.12-slim`, `nginx:1.27-alpine`, `redis:7.4-alpine`.
- Pas de redémarrage de Docker Desktop sans accord.
- Pas de passe sémantique graphify sans accord. Après une modification du code : `~/.local/bin/graphify update .`.
- Pas de `git init` ni de commit sans demande.
