export const legacyKey = 'pizza.guest-cart'
export const changeKey = 'pizza.guest-cart.changed'

export function openGuestCart(database = globalThis.indexedDB) {
  return new Promise((resolve, reject) => {
    const request = database.open('pizza-shop', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('guest-cart')
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('Хранилище корзины занято другой вкладкой.'))
    request.onsuccess = () => resolve(request.result)
  })
}

export function transact(db, change) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('guest-cart', change ? 'readwrite' : 'readonly')
    const store = transaction.objectStore('guest-cart')
    const read = store.get('cart')
    let result
    let failure
    read.onsuccess = () => {
      try {
        result = read.result ?? null
        if (change) {
          result = change(result)
          store.put(result, 'cart')
        }
      } catch (error) {
        failure = error
        transaction.abort()
      }
    }
    transaction.oncomplete = () => resolve(result)
    transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('Изменение корзины отменено.'))
  })
}
