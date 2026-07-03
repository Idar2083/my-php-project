# Загружаем переменные из .env и .env.local (локальные имеет приоритет)
ifneq (,$(wildcard .env))
include .env
export
endif

ifneq (,$(wildcard .env.local))
include .env.local
export
endif

.PHONY: up down logs bash composer-install jwt-secret

up:
	docker compose --env-file .env --env-file .env.local \
    		up -d --build --remove-orphans
	$(MAKE) composer-install
	@echo "Application is available at: http://localhost:$${NGINX_PORT}/"

down:
	docker compose down

logs:
	docker compose logs -f

bash:
	docker compose exec php bash

composer-install:
	docker compose exec -T php sh -lc 'mkdir -p vendor && composer install --no-interaction --prefer-dist'

jwt_secret:
	docker compose exec -T php php artisan jwt:secret --force

up-prod:
	docker compose --env-file .env --env-file .env.local \
    	-f docker-compose.prod.yml up -d --build --remove-orphans

down-prod:
	docker compose -f docker-compose.prod.yml down -v

logs-prod:
	docker compose -f docker-compose.prod.yml logs -f