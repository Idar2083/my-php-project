const amount = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
export const formatAmount = value => amount.format(Number(value))
export const totalAmount = (items = []) => items.reduce(
  (sum, item) => sum + Math.round(Number(item.product.price) * 100) * item.quantity, 0,
) / 100
export const orderStatuses = {
  created: 'Создан', paid: 'Оплачен', in_process: 'Готовится', delivering: 'Доставляется',
  completed: 'Завершён', cancelled: 'Отменён',
}
