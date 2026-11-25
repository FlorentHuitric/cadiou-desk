# three.js est récupéré au build (version épinglée) puis servi par nginx : pas de CDN au runtime.
FROM node:22-alpine AS three
RUN npm install --prefix /v --no-audit --no-fund three@0.170.0

FROM nginx:1.27-alpine
# L'image nginx remplace ${API_UPSTREAM} dans les templates au démarrage.
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=three /v/node_modules/three/build/three.module.min.js /usr/share/nginx/html/vendor/three.module.min.js
COPY index.html app.js scene.js style.css /usr/share/nginx/html/
