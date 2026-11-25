FROM nginx:1.27-alpine
# L'image nginx remplace ${API_UPSTREAM} dans les templates au démarrage.
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY index.html app.js style.css /usr/share/nginx/html/
