export class ApiError extends Error {
  constructor(status, errors = []) {
    const messages = {
      401: 'Неверные данные входа или срок сессии истёк. Войдите снова.',
      403: 'Недостаточно прав для этого действия.',
      404: 'Запрошенные данные не найдены. Обновите список.',
      409: 'Действие недоступно в текущем состоянии. Обновите данные.',
      422: 'Проверьте введённые данные и ограничения заказа.',
      429: 'Слишком много запросов. Подождите минуту и повторите попытку.',
    }
    super(messages[status] || 'Сервис недоступен. Проверьте соединение и повторите попытку.')
    this.status = status
    this.errors = errors
  }
}

// A token lives only in this instance's memory; never in URLs or browser storage.
export function createApi(onUnauthorized = () => {}) {
  let token = null
  let generation = 0
  return {
    setToken(value) { token = value; generation++ },
    async request(path, { method = 'GET', body, authenticated = true } = {}) {
      const session = generation
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15000)
      const headers = { Accept: 'application/json', 'Accept-Language': 'ru' }
      if (body !== undefined) headers['Content-Type'] = 'application/json'
      if (authenticated && token) headers.Authorization = `Bearer ${token}`
      try {
        const base = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/+$/, '')
        const response = await fetch(`${base}${path}`, {
          method, headers, body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal, cache: 'no-store', credentials: 'omit',
        })
        if (authenticated && session !== generation) throw new ApiError(401)
        if (!response.ok) {
          if (response.status === 401 && authenticated) onUnauthorized()
          let errors = []
          if (response.status === 422) {
            const data = await response.json().catch(() => null)
            errors = Object.values(data?.errors || {}).flat()
              .filter(value => typeof value === 'string').slice(0, 12).map(value => value.slice(0, 300))
          }
          throw new ApiError(response.status, errors)
        }
        if (response.status === 204) return null
        const data = await response.json()
        if (authenticated && session !== generation) throw new ApiError(401)
        return data
      } catch (error) {
        throw error instanceof ApiError ? error : new ApiError(0)
      } finally { clearTimeout(timer) }
    },
  }
}

export function resource(document) {
  if (!document?.data || typeof document.data !== 'object') throw new ApiError(0)
  return document.data
}
