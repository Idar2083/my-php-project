FROM php:8.4-fpm AS base

WORKDIR /var/www/app

# System dependencies
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
    bash \
    git \
    tzdata \
    curl \
    ca-certificates \
    libfcgi-bin \
    zip \
    unzip \
    libicu-dev \
    libpq-dev \
    libzip-dev \
    librabbitmq-dev \
 && rm -rf /var/lib/apt/lists/*

# PHP extensions
RUN docker-php-ext-install \
        intl \
        opcache \
        pdo_pgsql \
        zip \
        sockets

# PECL extensions
COPY docker/php/extensions/redis-6.3.0.tgz /tmp/redis-6.3.0.tgz
COPY docker/php/extensions/amqp-2.2.0.tgz /tmp/amqp-2.2.0.tgz

RUN pecl install /tmp/redis-6.3.0.tgz \
 && pecl install /tmp/amqp-2.2.0.tgz \
 && echo "extension=redis.so" > /usr/local/etc/php/conf.d/redis.ini \
 && echo "extension=amqp.so" > /usr/local/etc/php/conf.d/amqp.ini \
 && rm -f \
        /tmp/redis-6.3.0.tgz \
        /tmp/amqp-2.2.0.tgz

# Copy Composer binary from official image
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

# Default PHP-FPM configuration (can be overridden with volumes)
COPY docker/php/conf/php-fpm.conf /usr/local/etc/php-fpm.conf
COPY docker/php/conf/php.ini /usr/local/etc/php/conf.d/zz-app.ini
COPY docker/php/conf/www.conf /usr/local/etc/php-fpm.d/www.conf


# === DEV ===
FROM base AS dev

ENV APP_ENV=dev \
APP_DEBUG=1 \
COMPOSER_HOME=/tmp/composer

ARG HOST_UID=1000
ARG HOST_GID=1000

# Xdebug only for dev
COPY docker/php/extensions/xdebug-3.5.3.tgz /tmp/xdebug-3.5.3.tgz

RUN pecl install /tmp/xdebug-3.5.3.tgz \
 && docker-php-ext-enable xdebug \
 && rm -f /tmp/xdebug-3.5.3.tgz

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

ENV APP_ENV=prod APP_DEBUG=0

COPY app/composer.json app/composer.lock ./
RUN composer install --no-dev --prefer-dist --no-progress --no-interaction --no-scripts

COPY app .

# Laravel optimization
RUN composer dump-autoload --optimize --no-dev
RUN php artisan package:discover --ansi


# === PROD ===
FROM base AS prod

ENV APP_ENV=production APP_DEBUG=0

COPY --from=build /var/www/app /var/www/app
COPY docker/php/entrypoint.prod.sh /usr/local/bin/entrypoint.prod.sh
COPY docker/php/entrypoint.worker.sh /usr/local/bin/entrypoint.worker.sh

RUN chmod +x \
        /usr/local/bin/entrypoint.prod.sh \
        /usr/local/bin/entrypoint.worker.sh \
 && chown -R www-data:www-data /var/www/app

USER www-data

ENTRYPOINT ["/usr/local/bin/entrypoint.prod.sh"]

CMD ["php-fpm"]


# === CI ===
FROM base AS ci

ENV APP_ENV=testing \
    APP_DEBUG=1 \
    COMPOSER_HOME=/tmp/composer

COPY app/composer.json app/composer.lock ./

RUN mkdir -p /tmp/composer \
 && composer install \
        --prefer-dist \
        --no-progress \
        --no-interaction \
        --no-scripts

COPY app ./