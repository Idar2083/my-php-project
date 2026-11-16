FROM node:24-alpine AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM dependencies AS build
COPY index.html vite.config.js ./
COPY src ./src
# Production uses a same-origin API; no local env files or secrets enter the build.
ENV VITE_API_BASE_URL=/api
RUN npm run build

FROM dependencies AS dev
COPY . .
RUN chown -R node:node /app
USER node

EXPOSE 5173
CMD ["npm", "run", "dev"]

FROM nginx:1.30.5-alpine AS prod
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY laravel-api.conf /etc/nginx/laravel-api.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
