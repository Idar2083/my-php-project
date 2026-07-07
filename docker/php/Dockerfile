FROM php:8.3-fpm AS base

WORKDIR /var/www/app

COPY --from=mlocati/php-extension-installer:latest \
    /usr/bin/install-php-extensions \
    /usr/local/bin/

RUN echo 'Acquire::ForceIPv4 "true";' > /etc/apt/apt.conf.d/99force-ipv4

RUN chmod +x /usr/local/bin/install-php-extensions

# System dependencies
RUN apt-get update -o Acquire::ForceIPv4=true && \
    apt-get install -y --no-install-recommends \
    bash \
    git \
    tzdata \
    curl \
    zip \
    unzip \
    libfcgi-bin \
    librabbitmq-dev \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

RUN set -xe && install-php-extensions \
    intl \
    opcache \
    pdo_pgsql \
    zip \
    exif \
    mbstring

RUN pecl install redis && docker-php-ext-enable redis

RUN apt-get update && apt-get install -y \
    librabbitmq-dev pkg-config

RUN pecl install amqp && docker-php-ext-enable amqp

# DEV ONLY
RUN pecl install xdebug && docker-php-ext-enable xdebug

COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

COPY docker/php/conf/php-fpm.conf /usr/local/etc/php-fpm.conf
COPY docker/php/conf/php.ini /usr/local/etc/php/conf.d/zz-app.ini
COPY docker/php/conf/www.conf /usr/local/etc/php-fpm.d/www.conf


# === DEV ===
FROM base AS dev

ENV APP_ENV=dev APP_DEBUG=1 COMPOSER_HOME=/tmp/composer

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

ENV APP_ENV=prod APP_DEBUG=0

COPY app/composer.json app/composer.lock ./
RUN composer install --no-dev --prefer-dist --no-progress --no-interaction --no-scripts

COPY app .

# Laravel optimization
RUN cp .env.example .env
RUN composer clear-cache
RUN composer dump-autoload --optimize --no-dev
RUN php artisan key:generate
RUN php artisan package:discover --ansi
RUN php artisan config:cache



# === PROD ===
FROM base AS prod

ENV APP_ENV=production APP_DEBUG=0

COPY --from=build /var/www/app /var/www/app

RUN chown -R www-data:www-data /var/www/app

USER www-data

CMD ["php-fpm"]