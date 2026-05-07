FROM php:8.4-fpm AS base

WORKDIR /var/www/app

# System dependencies
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
    bash \
    git \
    tzdata \
    curl \
    libfcgi-bin \
    zip \
    unzip \
    libpq-dev \
 && rm -rf /var/lib/apt/lists/*

# Install PHP extensions via mlocati
COPY --from=mlocati/php-extension-installer:latest /usr/bin/install-php-extensions /usr/local/bin/
COPY docker/php/conf/php-fpm.conf /usr/local/etc/php-fpm.conf

RUN chmod +x /usr/local/bin/install-php-extensions && \
    install-php-extensions \
        intl \
        opcache \
        pdo_pgsql \
        zip \
        redis \
        amqp \
        bcmath \
        exif \
        pcntl

# Composer
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

# PHP configs
COPY docker/php/conf/php.ini /usr/local/etc/php/conf.d/zz-app.ini


# === DEV ===
FROM base AS dev

ENV APP_ENV=dev \
    APP_DEBUG=1 \
    COMPOSER_HOME=/tmp/composer

ARG HOST_UID=1000
ARG HOST_GID=1000

# Xdebug only for dev
RUN install-php-extensions xdebug

COPY docker/php/conf/xdebug.ini /usr/local/etc/php/conf.d/xdebug.ini

# Fix permissions for local dev
RUN groupmod -o -g "${HOST_GID}" www-data \
 && usermod -o -u "${HOST_UID}" -g "${HOST_GID}" www-data \
 && mkdir -p /tmp/composer \
 && chown -R www-data:www-data /tmp/composer

USER www-data

CMD ["php-fpm"]


# === BUILD ===
FROM base AS build

ENV APP_ENV=prod \
    APP_DEBUG=0

# ВАЖНО: сначала только composer файлы (кэш слоёв)
COPY app/composer.json app/composer.lock ./

RUN composer install \
    --no-dev \
    --prefer-dist \
    --no-progress \
    --no-interaction

# Потом весь код
COPY app ./

# Laravel оптимизации
RUN composer dump-autoload --optimize --no-dev && \
    php artisan config:cache && \
    php artisan route:cache && \
    php artisan view:cache


# === PROD ===
FROM base AS prod

ENV APP_ENV=prod \
    APP_DEBUG=0

COPY --from=build /var/www/app /var/www/app

RUN chown -R www-data:www-data /var/www/app

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD SCRIPT_NAME=/ping SCRIPT_FILENAME=/ping REQUEST_METHOD=GET cgi-fcgi -bind -connect 127.0.0.1:9000 | grep -q "pong" || exit 1

USER www-data

CMD ["php-fpm"]