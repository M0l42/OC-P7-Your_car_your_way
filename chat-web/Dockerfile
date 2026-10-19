# syntax=docker/dockerfile:1
# Build context: chat-web/.
# The final image is nginx 1.28 serving the SPA. In compose it is also the load balancer:
# infra/nginx.conf is mounted over the default server config.

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.28-alpine
COPY --chown=nginx:nginx nginx-spa.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/chat-web/browser/ /usr/share/nginx/html/
USER nginx
EXPOSE 8080
HEALTHCHECK --interval=5s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/nginx-health >/dev/null || exit 1
