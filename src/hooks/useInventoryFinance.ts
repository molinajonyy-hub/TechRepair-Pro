import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

export interface InventoryFinanceItem {
  id: string
  code: string
  name: string
  category: string
  subcategory?: string
  stock_quantity: number
  cost_price: number
  sale_price: number
  capital_invertido: number
  valor_venta: number
  ganancia_potencial: number
  margen_costo: number
  margen_venta: number
  rotacion: number
  estado: 'rentable' | 'bajo_margen' | 'sin_costo' | 'inmovilizado' | 'normal'
}

export interface CategoryCapital {
  category: string
  capital_invertido: number
  valor_venta: number
  ganancia_potencial: number
  margen_promedio: number
  items: number
  porcentaje_capital: number
  color: string
}

export interface ValuationSnapshot {
  fecha: string
  capital_invertido: number
  valor_venta: number
  ganancia_potencial: number
  cantidad_total_items: number
}

export interface InventoryFinanceSummary {
  capital_invertido: number
  valor_venta: number
  ganancia_potencial: number
  margen_costo_promedio: number
  margen_venta_promedio: number
  total_items: number
  total_productos: number
  capital_growth_pct: number | null
  capital_growth_nominal: number | null
  top_capital_item: InventoryFinanceItem | null
  top_category: CategoryCapital | null
}

export interface FinanceAlert {
  type: 'warning' | 'danger' | 'info'
  title: string
  message: string
}

const CATEGORY_COLORS = [
  '#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#14b8a6'
]

export function useInventoryFinance(businessId?: string | null) {
  const [items, setItems] = useState<InventoryFinanceItem[]>([])
  const [categories, setCategories] = useState<CategoryCapital[]>([])
  const [summary, setSummary] = useState<InventoryFinanceSummary | null>(null)
  const [history, setHistory] = useState<ValuationSnapshot[]>([])
  const [alerts, setAlerts] = useState<FinanceAlert[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (businessId) {
      loadData()
    }
  }, [businessId])

  const loadData = async () => {
    try {
      setLoading(true)
      setError(null)

      // 1. Cargar items del inventario (incluyendo supplier_code para distinguir padres de variantes)
      const { data: inventoryData, error: invError } = await supabase
        .from('inventory')
        .select('id, code, name, category, subcategory, stock_quantity, cost_price, sale_price, supplier_code')
        .eq('business_id', businessId)
        .eq('is_active', true)

      if (invError) throw invError

      const rawInventory = inventoryData || []

      // Excluir productos-padre que tienen variantes (su stock/precio vive en las variantes)
      // Las variantes tienen supplier_code = 'VPREF-{parent_id}'
      const VARIANT_PARENT_PREFIX = 'VPREF-'
      const parentIdsWithVariants = new Set<string>()
      rawInventory.forEach((it: any) => {
        const sc = typeof it.supplier_code === 'string' ? it.supplier_code : ''
        if (sc.startsWith(VARIANT_PARENT_PREFIX)) {
          const pid = sc.slice(VARIANT_PARENT_PREFIX.length)
          if (pid) parentIdsWithVariants.add(pid)
        }
      })
      const inventory = rawInventory.filter((it: any) => !parentIdsWithVariants.has(it.id))

      // 2. Cargar movimientos de los últimos 30 días para rotación
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
      const itemIds = inventory.map(i => i.id)

      const rotationMap: Record<string, number> = {}
      if (itemIds.length > 0) {
        const { data: movementsData } = await supabase
          .from('inventory_movements')
          .select('inventory_id, quantity')
          .in('inventory_id', itemIds)
          .gte('created_at', thirtyDaysAgo)
          .in('type', ['sale', 'out', 'order_usage'])

        movementsData?.forEach(m => {
          rotationMap[m.inventory_id] = (rotationMap[m.inventory_id] || 0) + Math.abs(m.quantity)
        })
      }

      // 3. Calcular métricas por producto
      const processedItems: InventoryFinanceItem[] = inventory
        .filter(item => item.stock_quantity > 0 || item.cost_price > 0)
        .map(item => {
          const cost = item.cost_price || 0
          const sale = item.sale_price || 0
          const stock = item.stock_quantity || 0
          const capital = stock * cost
          const valor = stock * sale
          const ganancia = valor - capital
          const margenCosto = cost > 0 ? ((sale - cost) / cost) * 100 : 0
          const margenVenta = sale > 0 ? ((sale - cost) / sale) * 100 : 0
          const rotacion = rotationMap[item.id] || 0

          let estado: InventoryFinanceItem['estado'] = 'normal'
          if (cost === 0 && stock > 0) {
            estado = 'sin_costo'
          } else if (cost > 0 && margenVenta < 15) {
            estado = 'bajo_margen'
          } else if (cost > 0 && margenVenta >= 35) {
            estado = 'rentable'
          } else if (stock > 0 && rotacion === 0 && cost > 0) {
            estado = 'inmovilizado'
          }

          return {
            ...item,
            capital_invertido: capital,
            valor_venta: valor,
            ganancia_potencial: ganancia,
            margen_costo: margenCosto,
            margen_venta: margenVenta,
            rotacion,
            estado,
          }
        })

      // 4. Resumen por categoría
      const categoryMap: Record<string, Omit<CategoryCapital, 'porcentaje_capital' | 'color' | 'margen_promedio'>> = {}
      processedItems.forEach(item => {
        const cat = item.category || 'Sin categoría'
        if (!categoryMap[cat]) {
          categoryMap[cat] = { category: cat, capital_invertido: 0, valor_venta: 0, ganancia_potencial: 0, items: 0 }
        }
        categoryMap[cat].capital_invertido += item.capital_invertido
        categoryMap[cat].valor_venta += item.valor_venta
        categoryMap[cat].ganancia_potencial += item.ganancia_potencial
        categoryMap[cat].items += 1
      })

      const totalCapital = Object.values(categoryMap).reduce((s, c) => s + c.capital_invertido, 0)

      const processedCategories: CategoryCapital[] = Object.values(categoryMap)
        .map((cat, idx) => {
          const catItems = processedItems.filter(i => (i.category || 'Sin categoría') === cat.category && i.cost_price > 0)
          const margenPromedio = catItems.length > 0
            ? catItems.reduce((s, i) => s + i.margen_venta, 0) / catItems.length
            : 0
          return {
            ...cat,
            margen_promedio: margenPromedio,
            porcentaje_capital: totalCapital > 0 ? (cat.capital_invertido / totalCapital) * 100 : 0,
            color: CATEGORY_COLORS[idx % CATEGORY_COLORS.length],
          }
        })
        .sort((a, b) => b.capital_invertido - a.capital_invertido)

      // 5. Cargar historial de valuaciones
      const { data: historyData } = await supabase
        .from('inventory_valuation_history')
        .select('fecha, capital_invertido, valor_venta, ganancia_potencial, cantidad_total_items')
        .eq('business_id', businessId)
        .order('fecha', { ascending: true })
        .limit(12)

      const processedHistory: ValuationSnapshot[] = historyData || []

      // 6. Guardar snapshot de hoy si no existe
      const today = new Date().toISOString().split('T')[0]
      const hasToday = processedHistory.some(h => h.fecha === today)
      const totalValorAll = processedItems.reduce((s, i) => s + i.valor_venta, 0)
      const totalGananciaAll = totalValorAll - totalCapital
      const stockItems = processedItems.filter(i => i.stock_quantity > 0).length

      if (!hasToday && totalCapital > 0) {
        await supabase
          .from('inventory_valuation_history')
          .upsert(
            {
              business_id: businessId,
              fecha: today,
              capital_invertido: totalCapital,
              valor_venta: totalValorAll,
              ganancia_potencial: totalGananciaAll,
              cantidad_total_items: stockItems,
            },
            { onConflict: 'business_id,fecha' }
          )

        processedHistory.push({
          fecha: today,
          capital_invertido: totalCapital,
          valor_venta: totalValorAll,
          ganancia_potencial: totalGananciaAll,
          cantidad_total_items: stockItems,
        })
      }

      // 7. Calcular crecimiento del capital
      let capitalGrowthPct: number | null = null
      let capitalGrowthNominal: number | null = null
      if (processedHistory.length >= 2) {
        const prev = processedHistory[processedHistory.length - 2]
        const curr = processedHistory[processedHistory.length - 1]
        if (prev.capital_invertido > 0) {
          capitalGrowthPct = ((curr.capital_invertido - prev.capital_invertido) / prev.capital_invertido) * 100
          capitalGrowthNominal = curr.capital_invertido - prev.capital_invertido
        }
      }

      // 8. Resumen global
      const itemsWithCost = processedItems.filter(i => i.cost_price > 0)
      const margenCostoPromedio = itemsWithCost.length > 0
        ? itemsWithCost.reduce((s, i) => s + i.margen_costo, 0) / itemsWithCost.length
        : 0
      const margenVentaPromedio = itemsWithCost.length > 0
        ? itemsWithCost.reduce((s, i) => s + i.margen_venta, 0) / itemsWithCost.length
        : 0

      const topCapitalItem = [...processedItems].sort((a, b) => b.capital_invertido - a.capital_invertido)[0] ?? null
      const topCategory = processedCategories[0] ?? null

      setSummary({
        capital_invertido: totalCapital,
        valor_venta: totalValorAll,
        ganancia_potencial: totalGananciaAll,
        margen_costo_promedio: margenCostoPromedio,
        margen_venta_promedio: margenVentaPromedio,
        total_items: stockItems,
        total_productos: processedItems.length,
        capital_growth_pct: capitalGrowthPct,
        capital_growth_nominal: capitalGrowthNominal,
        top_capital_item: topCapitalItem,
        top_category: topCategory,
      })

      setItems(processedItems.sort((a, b) => b.capital_invertido - a.capital_invertido))
      setCategories(processedCategories)
      setHistory(processedHistory)

      // 9. Alertas inteligentes
      const generatedAlerts: FinanceAlert[] = []
      const fmt = (n: number) => new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(n)

      const inmovilizados = processedItems.filter(i => i.estado === 'inmovilizado')
      if (inmovilizados.length > 0) {
        const capitalInmov = inmovilizados.reduce((s, i) => s + i.capital_invertido, 0)
        generatedAlerts.push({
          type: 'warning',
          title: `${inmovilizados.length} producto${inmovilizados.length > 1 ? 's' : ''} sin movimiento en 30 días`,
          message: `Tenés ${fmt(capitalInmov)} en capital inmovilizado. Considerá liquidar o promocionar estos artículos.`,
        })
      }

      const bajosMargen = processedItems.filter(i => i.estado === 'bajo_margen')
      if (bajosMargen.length > 0) {
        generatedAlerts.push({
          type: 'danger',
          title: `${bajosMargen.length} producto${bajosMargen.length > 1 ? 's' : ''} con margen menor al 15%`,
          message: `Productos con baja rentabilidad sobre venta. Revisá precios de venta o renegociá costos con proveedores.`,
        })
      }

      if (topCategory && topCategory.porcentaje_capital > 50) {
        generatedAlerts.push({
          type: 'info',
          title: `Alta concentración en "${topCategory.category}"`,
          message: `Esta categoría concentra el ${topCategory.porcentaje_capital.toFixed(0)}% de tu capital invertido (${fmt(topCategory.capital_invertido)}). Considerá diversificar.`,
        })
      }

      const sinCosto = processedItems.filter(i => i.estado === 'sin_costo')
      if (sinCosto.length > 0) {
        generatedAlerts.push({
          type: 'warning',
          title: `${sinCosto.length} producto${sinCosto.length > 1 ? 's' : ''} sin precio de costo`,
          message: `Sin precio de costo no es posible calcular el capital invertido ni los márgenes. Actualizá los precios en el inventario.`,
        })
      }

      if (capitalGrowthPct !== null && capitalGrowthPct > 20 && totalGananciaAll / totalValorAll < 0.2) {
        generatedAlerts.push({
          type: 'warning',
          title: 'Capital creció pero el margen es bajo',
          message: `El capital invertido aumentó un ${capitalGrowthPct.toFixed(1)}% pero el margen de ganancia potencial es menor al 20%. Revisá la estrategia de precios.`,
        })
      }

      setAlerts(generatedAlerts)
    } catch (err) {
      console.error('Error loading inventory finance:', err)
      setError('Error al cargar datos financieros del inventario')
    } finally {
      setLoading(false)
    }
  }

  return { items, categories, summary, history, alerts, loading, error, refresh: loadData }
}
