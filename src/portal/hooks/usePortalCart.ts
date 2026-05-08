import { useState, useCallback, useEffect } from 'react'
import type { CartItem } from '../types'

const STORAGE_KEY = 'portal_cart_v1'

interface StoredCart {
  businessId: string
  items: CartItem[]
}

function loadCart(businessId: string): CartItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const stored: StoredCart = JSON.parse(raw)
    if (stored.businessId !== businessId) return []
    return stored.items || []
  } catch {
    return []
  }
}

function saveCart(businessId: string, items: CartItem[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ businessId, items }))
}

export function usePortalCart(businessId: string) {
  const [items, setItems] = useState<CartItem[]>(() => loadCart(businessId))

  useEffect(() => {
    saveCart(businessId, items)
  }, [businessId, items])

  const addItem = useCallback((item: CartItem) => {
    setItems(prev => {
      const existing = prev.find(i => i.inventoryItemId === item.inventoryItemId)
      if (existing) {
        const newQty = Math.min(existing.quantity + item.quantity, item.stock)
        return prev.map(i =>
          i.inventoryItemId === item.inventoryItemId ? { ...i, quantity: newQty } : i
        )
      }
      return [...prev, item]
    })
  }, [])

  const updateQty = useCallback((inventoryItemId: string, quantity: number) => {
    setItems(prev =>
      quantity <= 0
        ? prev.filter(i => i.inventoryItemId !== inventoryItemId)
        : prev.map(i => i.inventoryItemId === inventoryItemId ? { ...i, quantity } : i)
    )
  }, [])

  const removeItem = useCallback((inventoryItemId: string) => {
    setItems(prev => prev.filter(i => i.inventoryItemId !== inventoryItemId))
  }, [])

  const clearCart = useCallback(() => {
    setItems([])
  }, [])

  const total = items.reduce((s, i) => s + i.unitPrice * i.quantity, 0)
  const itemCount = items.reduce((s, i) => s + i.quantity, 0)

  return { items, total, itemCount, addItem, updateQty, removeItem, clearCart }
}
