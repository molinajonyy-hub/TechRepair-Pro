import { Fragment, useState, useEffect, useRef } from 'react'
import {
  Package,
  Search,
  X,
  Plus,
  Edit,
  Trash2,
  AlertTriangle,
  Download,
  Upload,
  DollarSign,
  ChevronDown,
  ChevronRight,
  Copy,
  Loader2
} from 'lucide-react'
import { useInventory } from '../hooks/useInventory'
import { useAuth } from '../contexts/AuthContext'
import { currencyService } from '../services/currencyService'
import { calcularPrecioLocal, convertirMoneda, calcularRentabilidad } from '../utils/priceCalculator'
import { useLoading } from '../contexts/LoadingContext'
import { ModalImportExcel } from '../components/ModalImportExcel'
import { ExcelService, ExcelRow } from '../services/excelService'
import { supabase } from '../lib/supabase'

const CATEGORIES = [
  'Pantallas',
  'Baterías',
  'Conectores',
  'Cámaras',
  'Botones',
  'Altavoces',
  'Micrófonos',
  'Flex',
  'Herramientas',
  'Accesorios',
  'Servicios',
  'Otros'
]

type StockStatusFilter = 'all' | 'low' | 'out'
const VARIANT_PARENT_PREFIX = 'variant_parent:'

const buildVariantParentReference = (parentId: string) => `${VARIANT_PARENT_PREFIX}${parentId}`

const getVariantParentId = (item: any) => {
  const supplierCode = item?.supplier_code || ''

  if (typeof supplierCode === 'string' && supplierCode.startsWith(VARIANT_PARENT_PREFIX)) {
    return supplierCode.slice(VARIANT_PARENT_PREFIX.length)
  }

  return null
}

const isVariantItem = (item: any) => Boolean(getVariantParentId(item))

// Round ARS price upward to nearest 500
const roundUpTo500 = (value: number): number => Math.ceil(value / 500) * 500

export function Inventory() {
  const {
    items,
    categories,
    error,
    refresh,
    addItem,
    updateItem,
    deleteItem
  } = useInventory()
  const { businessId } = useAuth()
  const { showLoading, hideLoading } = useLoading()

  const [searchTerm, setSearchTerm] = useState('')
  const [selectedCategory, setSelectedCategory] = useState('')
  const [stockStatusFilter, setStockStatusFilter] = useState<StockStatusFilter>('all')
  const [showModal, setShowModal] = useState(false)
  const [showImportModal, setShowImportModal] = useState(false)
  const [showProductMenu, setShowProductMenu] = useState(false)
  const [editingItem, setEditingItem] = useState<any>(null)
  const [variantParentItem, setVariantParentItem] = useState<any>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [formError, setFormError] = useState('')
  const [currencySettings, setCurrencySettings] = useState<any>(null)
  const [exchangeRates, setExchangeRates] = useState<Record<string, number>>({})
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set())
  const tableRef = useRef<HTMLDivElement | null>(null)

  const toggleExpanded = (id: string) => {
    setExpandedRows(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement
      if (showProductMenu && !target.closest('[data-product-menu]')) {
        setShowProductMenu(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showProductMenu])

  useEffect(() => {
    if (businessId) {
      loadCurrencySettings()
    }
  }, [businessId])

  const loadCurrencySettings = async () => {
    if (!businessId) return

    try {
      const settings = await currencyService.getBusinessSettings()
      if (settings) {
        setCurrencySettings(settings)
      }

      // Cargar tipo de cambio USD a ARS
      const rate = await currencyService.getCurrentExchangeRate('USD', 'ARS')
      setExchangeRates({ 'USD-ARS': rate })
    } catch (error) {
      console.error('Error loading currency settings:', error)
    }
  }

  const formatARS = (price: number) => {
    return `$${price.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }

  const formatUSD = (price?: number) => {
    if (!price || price <= 0) {
      return null
    }

    return `USD $${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }

  const [formData, setFormData] = useState({
    code: '',
    name: '',
    variant_name: '',
    description: '',
    category: '',
    newCategory: '',
    has_variants: false,
    variants: [] as any[],
    stock_quantity: 0,
    min_stock: 1,
    cost_price: 0,
    cost_price_usd: 0,
    sale_price: 0,
    location: '',
    base_currency: 'ARS',
    base_price: 0,
    exchange_rate_used: 0,
    auto_update_price: true,
    tipo: 'product' as 'product' | 'service'
  })

  // Lista combinada: categorías predefinidas + las que el usuario ya creó
  const allCategories = Array.from(new Set([...CATEGORIES, ...categories])).sort()

  const [calculatedPrice, setCalculatedPrice] = useState(0)
  const [calculatedCostARS, setCalculatedCostARS] = useState(0)
  const [userManuallyEditedSalePrice, setUserManuallyEditedSalePrice] = useState(false)
  const [userManuallyEditedCostPrice, setUserManuallyEditedCostPrice] = useState(false)

  // Handler para cuando el usuario edita manualmente el precio de venta
  const handleSalePriceChange = (value: number) => {
    setUserManuallyEditedSalePrice(true)
    setFormData(prev => ({ ...prev, sale_price: value }))
  }

  // Handler para cuando el usuario edita manualmente el precio de costo
  const handleCostPriceChange = (value: number) => {
    setUserManuallyEditedCostPrice(true)
    setFormData(prev => ({ ...prev, cost_price: value }))
  }

  // Cálculo reactivo del precio local y costo cuando cambia base_price, cost_price_usd o exchange_rate_used
  useEffect(() => {
    if (formData.base_currency === 'USD' && formData.exchange_rate_used > 0) {
      // Calcular precio de venta ARS
      if (formData.base_price > 0) {
        const calculatedSale = calcularPrecioLocal(formData.base_price, formData.exchange_rate_used)
        setCalculatedPrice(calculatedSale)
        
        // Auto-actualizar sale_price solo si checkbox activado y no editado manualmente
        if (formData.auto_update_price && !userManuallyEditedSalePrice) {
          setFormData(prev => ({
            ...prev,
            sale_price: calculatedSale
          }))
        }
      } else {
        setCalculatedPrice(0)
      }

      // Calcular costo ARS
      if (formData.cost_price_usd > 0) {
        const calculatedCost = convertirMoneda(formData.cost_price_usd, formData.exchange_rate_used)
        setCalculatedCostARS(calculatedCost)
        
        // Auto-actualizar cost_price solo si checkbox activado y no editado manualmente
        if (formData.auto_update_price && !userManuallyEditedCostPrice) {
          setFormData(prev => ({
            ...prev,
            cost_price: calculatedCost
          }))
        }
      } else {
        setCalculatedCostARS(0)
      }
    } else {
      setCalculatedPrice(0)
      setCalculatedCostARS(0)
    }
  }, [formData.base_price, formData.cost_price_usd, formData.exchange_rate_used, formData.base_currency, formData.auto_update_price, userManuallyEditedSalePrice, userManuallyEditedCostPrice])

  // Las comprobaciones de stock tienen en cuenta el stock efectivo: para un producto
  // base con variantes, el stock es la suma de sus variantes, no el del propio padre
  // (que siempre queda en 0). Esto evita que productos con variantes aparezcan como
  // "agotados" cuando en realidad tienen stock en las variantes.
  const isLowStock = (item: any) => {
    const eff = getEffectiveStock(item)
    return eff.stock_quantity > 0 && eff.stock_quantity <= eff.min_stock
  }
  const isOutOfStock = (item: any) => {
    const eff = getEffectiveStock(item)
    return eff.stock_quantity === 0
  }

  const matchesInventoryFilters = (item: any) => {
    const normalizedSearch = searchTerm.toLowerCase()
    const matchesSearch = 
      item.name.toLowerCase().includes(normalizedSearch) ||
      item.code.toLowerCase().includes(normalizedSearch) ||
      (item.description || '').toLowerCase().includes(normalizedSearch) ||
      (item.subcategory || '').toLowerCase().includes(normalizedSearch)
    const matchesCategory = !selectedCategory || item.category === selectedCategory
    const matchesStockStatus =
      stockStatusFilter === 'all' ||
      (stockStatusFilter === 'low' && isLowStock(item)) ||
      (stockStatusFilter === 'out' && isOutOfStock(item))

    return matchesSearch && matchesCategory && matchesStockStatus
  }

  const variantItems = items.filter(isVariantItem)
  const rootItems = items.filter(item => !isVariantItem(item))
  const variantsByParent = variantItems.reduce<Record<string, any[]>>((acc, item) => {
    const parentId = getVariantParentId(item)

    if (!parentId) {
      return acc
    }

    if (!acc[parentId]) {
      acc[parentId] = []
    }

    acc[parentId].push(item)
    return acc
  }, {})

  // Ordenar variantes: las más nuevas arriba
  Object.keys(variantsByParent).forEach(parentId => {
    variantsByParent[parentId].sort((a, b) => {
      const aTime = new Date(a.created_at || 0).getTime()
      const bTime = new Date(b.created_at || 0).getTime()
      return bTime - aTime
    })
  })

  // Calcula stock efectivo (suma de variantes) para un producto base
  const getEffectiveStock = (item: any) => {
    if (isVariantItem(item)) {
      return { stock_quantity: item.stock_quantity || 0, min_stock: item.min_stock || 0 }
    }
    const variants = variantsByParent[item.id] || []
    if (variants.length === 0) {
      return { stock_quantity: item.stock_quantity || 0, min_stock: item.min_stock || 0 }
    }
    const stock_quantity = variants.reduce((sum, v) => sum + (v.stock_quantity || 0), 0)
    const min_stock = variants.reduce((sum, v) => sum + (v.min_stock || 0), 0)
    return { stock_quantity, min_stock }
  }

  // Calcula precios efectivos desde variantes para un producto base con variantes
  const getEffectivePrices = (item: any): { costPrice: number; salePrice: number; isRange: boolean; minCost: number; maxCost: number; minSale: number; maxSale: number } => {
    const variants = isVariantItem(item) ? [] : (variantsByParent[item.id] || [])
    if (variants.length === 0) {
      const c = item.cost_price || 0
      const s = item.sale_price || 0
      return { costPrice: c, salePrice: s, isRange: false, minCost: c, maxCost: c, minSale: s, maxSale: s }
    }
    const costs = variants.map(v => v.cost_price || 0)
    const sales = variants.map(v => v.sale_price || 0)
    const minCost = Math.min(...costs)
    const maxCost = Math.max(...costs)
    const minSale = Math.min(...sales)
    const maxSale = Math.max(...sales)
    return {
      costPrice: minCost,
      salePrice: minSale,
      isRange: minCost !== maxCost || minSale !== maxSale,
      minCost, maxCost, minSale, maxSale
    }
  }

  const displayedItems = rootItems.filter(item => {
    const directMatch = matchesInventoryFilters(item)
    const variantMatch = (variantsByParent[item.id] || []).some(matchesInventoryFilters)
    return directMatch || variantMatch
  })

  // Listas efectivas para el banner/contador de alertas:
  //  - Incluye variantes cuyo stock propio está agotado/bajo.
  //  - Incluye productos base sin variantes cuyo stock está agotado/bajo.
  //  - EXCLUYE productos base con variantes cuando el total de variantes > 0.
  const effectiveOutOfStockItems = items.filter(item => {
    if (isVariantItem(item)) return (item.stock_quantity || 0) === 0
    const variants = variantsByParent[item.id] || []
    if (variants.length === 0) return (item.stock_quantity || 0) === 0
    return variants.reduce((sum, v) => sum + (v.stock_quantity || 0), 0) === 0
  })
  const effectiveLowStockItems = items.filter(item => {
    if (isVariantItem(item)) {
      return (item.stock_quantity || 0) > 0 && (item.stock_quantity || 0) <= (item.min_stock || 0)
    }
    const variants = variantsByParent[item.id] || []
    if (variants.length === 0) {
      return (item.stock_quantity || 0) > 0 && (item.stock_quantity || 0) <= (item.min_stock || 0)
    }
    const totalStock = variants.reduce((sum, v) => sum + (v.stock_quantity || 0), 0)
    const totalMin = variants.reduce((sum, v) => sum + (v.min_stock || 0), 0)
    return totalStock > 0 && totalStock <= totalMin
  })

  const getVariantName = (item: any, parentItem?: any) => {
    if (item?.subcategory) {
      return item.subcategory
    }

    if (parentItem?.name && item?.name?.startsWith(`${parentItem.name} - `)) {
      return item.name.slice(parentItem.name.length + 3)
    }

    return item?.name || ''
  }

  const applyStockStatusFilter = (nextFilter: StockStatusFilter) => {
    setSearchTerm('')
    setSelectedCategory('')
    setStockStatusFilter(nextFilter)

    setTimeout(() => {
      tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 0)
  }

  const closeModal = () => {
    setShowModal(false)
    setEditingItem(null)
    setVariantParentItem(null)
    setFormError('')
  }

  const openAddModal = (parentItem?: any, tipo: 'product' | 'service' = 'product') => {
    setEditingItem(null)
    setVariantParentItem(parentItem || null)
    setUserManuallyEditedSalePrice(false)
    setUserManuallyEditedCostPrice(false)

    const variantsForParent = parentItem ? variantsByParent[parentItem.id] || [] : []
    const suggestedCode = parentItem
      ? `${parentItem.code}-VAR-${String(variantsForParent.length + 1).padStart(2, '0')}`
      : ''

    setFormData({
      code: suggestedCode,
      name: parentItem?.name || '',
      variant_name: '',
      description: '',
      category: parentItem?.category || (tipo === 'service' ? 'Servicios' : ''),
      newCategory: '',
      has_variants: false,
      variants: [],
      stock_quantity: 0,
      min_stock: tipo === 'service' ? 0 : 1,
      cost_price: parentItem?.cost_price || 0,
      cost_price_usd: parentItem?.cost_price_usd || 0,
      sale_price: parentItem?.sale_price || 0,
      location: '',
      base_currency: parentItem?.base_currency || 'ARS',
      base_price: parentItem?.base_price || 0,
      exchange_rate_used: parentItem?.exchange_rate_used || exchangeRates['USD-ARS'] || 1,
      auto_update_price: true,
      tipo
    })
    setFormError('')
    setShowModal(true)
  }

  const openEditModal = (item: any) => {
    setEditingItem(item)
    const parentId = getVariantParentId(item)
    const parentItem = parentId ? items.find(currentItem => currentItem.id === parentId) : null
    const childVariants = parentItem ? [] : (variantsByParent[item.id] || [])
    setVariantParentItem(parentItem || null)
    setUserManuallyEditedSalePrice(false)
    setUserManuallyEditedCostPrice(false)
    setFormData({
      code: item.code,
      name: parentItem?.name || item.name,
      variant_name: parentItem ? getVariantName(item, parentItem) : '',
      description: item.description || '',
      category: parentItem?.category || item.category,
      newCategory: '',
      has_variants: childVariants.length > 0,
      variants: childVariants.map((variant) => ({
        id: variant.id,
        code: variant.code,
        name: getVariantName(variant, item),
        stock_quantity: variant.stock_quantity,
        sale_price: variant.sale_price,
        cost_price: variant.cost_price,
        cost_price_usd: variant.cost_price_usd,
        base_price: variant.base_price,
        base_currency: variant.base_currency,
        exchange_rate_used: variant.exchange_rate_used,
        location: variant.location
      })),
      stock_quantity: item.stock_quantity,
      min_stock: item.min_stock,
      cost_price: item.cost_price,
      cost_price_usd: item.cost_price_usd || 0,
      sale_price: item.sale_price,
      location: item.location || '',
      base_currency: item.base_currency || 'ARS',
      base_price: item.base_price || 0,
      exchange_rate_used: item.exchange_rate_used || exchangeRates['USD-ARS'] || 1,
      auto_update_price: item.auto_update_price !== undefined ? item.auto_update_price : true,
      tipo: (item.tipo as 'product' | 'service') || 'product'
    })
    setFormError('')
    setShowModal(true)
  }

  const addVariant = () => {
    setFormData(prev => ({
      ...prev,
      variants: [
        {
          name: '',
          stock_quantity: 0,
          cost_price: 0,
          cost_price_usd: 0,
          sale_price: 0,
          base_currency: 'ARS',
          base_price: 0,
          exchange_rate_used: exchangeRates['USD-ARS'] || 1,
          auto_update_price: true,
        },
        ...prev.variants,
      ]
    }))
  }

  const removeVariant = (index: number) => {
    setFormData(prev => ({
      ...prev,
      variants: prev.variants.filter((_, i) => i !== index)
    }))
  }

  const duplicateVariant = (index: number) => {
    setFormData(prev => {
      const source = prev.variants[index]
      const copy = { ...source, name: `${source.name} (copia)` }
      const newVariants = [...prev.variants]
      newVariants.splice(index + 1, 0, copy)
      return { ...prev, variants: newVariants }
    })
  }

  const updateVariant = (index: number, field: string, value: any) => {
    setFormData(prev => {
      const variant = prev.variants[index]
      let updates: any = { [field]: value }

      // Auto-calculate ARS sale_price when USD fields change
      const isUsd = field === 'base_currency' ? value === 'USD' : variant.base_currency === 'USD'
      if (isUsd) {
        if (field === 'base_price') {
          const rate = variant.exchange_rate_used || exchangeRates['USD-ARS'] || 1
          updates.sale_price = roundUpTo500(Number(value) * rate)
        }
        if (field === 'exchange_rate_used') {
          const basePx = variant.base_price || 0
          if (basePx > 0) {
            updates.sale_price = roundUpTo500(basePx * Number(value))
          }
          // Also recalculate cost_price ARS if we have a USD cost
          const costUsd = variant.cost_price_usd || 0
          if (costUsd > 0) {
            updates.cost_price = Math.round(costUsd * Number(value))
          }
        }
        if (field === 'base_currency') {
          // switching to USD: ensure exchange_rate_used is populated
          updates.exchange_rate_used = variant.exchange_rate_used || exchangeRates['USD-ARS'] || 1
        }
      }

      // Auto-calculate ARS cost_price when cost_price_usd changes
      if (field === 'cost_price_usd') {
        const rate = variant.exchange_rate_used || exchangeRates['USD-ARS'] || 1
        const usdVal = parseFloat(value) || 0
        updates.cost_price = usdVal > 0 ? Math.round(usdVal * rate) : 0
      }

      return {
        ...prev,
        variants: prev.variants.map((v, i) =>
          i === index ? { ...v, ...updates } : v
        )
      }
    })
  }

  const handleSubmit = async (e: React.FormEvent) => {
    return handleInventorySubmit(e)
    e.preventDefault()
    setIsSubmitting(true)
    setFormError('')

    try {
      const isVariantMode = Boolean(variantParentItem)
      const categoryValue = formData.category === 'NUEVA_CATEGORIA'
        ? formData.newCategory.trim()
        : formData.category.trim()

      if (!isVariantMode && !categoryValue) {
        setFormError('La categoría es requerida')
        setIsSubmitting(false)
        return
      }

      // Validar variantes si has_variants=true
      if (!isVariantMode && formData.has_variants && formData.variants.length === 0) {
        setFormError('Debe agregar al menos una variante')
        setIsSubmitting(false)
        return
      }

      if (!isVariantMode && formData.has_variants) {
        // Validar que todas las variantes tengan nombre
        const invalidVariants = formData.variants.filter(v => !v.name || v.name.trim() === '')
        if (invalidVariants.length > 0) {
          setFormError('Todas las variantes deben tener un nombre')
          setIsSubmitting(false)
          return
        }
      }

      const submitData = {
        ...formData,
        category: categoryValue,
        stock_quantity: formData.has_variants ? 0 : formData.stock_quantity,
        has_variants: formData.has_variants
      }

      if (editingItem) {
        await updateItem(editingItem.id, submitData)
      } else {
        const createdProduct = await addItem(submitData as any)

        // Si tiene variantes, crear las variantes asociadas
        if (formData.has_variants && createdProduct?.id) {
          for (const variant of formData.variants) {
            await addItem({
              name: variant.name,
              variant_name: variant.name,
              description: submitData.description,
              category: submitData.category,
              stock_quantity: variant.stock_quantity,
              min_stock: submitData.min_stock,
              cost_price: submitData.cost_price,
              cost_price_usd: submitData.cost_price_usd,
              sale_price: variant.sale_price || submitData.sale_price,
              location: submitData.location,
              base_currency: submitData.base_currency,
              base_price: submitData.base_price,
              exchange_rate_used: submitData.exchange_rate_used,
              auto_update_price: submitData.auto_update_price,
              parent_id: createdProduct.id,
              business_id: businessId
            } as any)
          }
        }
      }
      setShowModal(false)
    } catch (err: any) {
      setFormError(err.message || 'Error al guardar producto')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleInventorySubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)
    setFormError('')
    showLoading(editingItem ? 'Guardando cambios...' : 'Creando producto...')

    try {
      const isVariantMode = Boolean(variantParentItem)
      const categoryValue = formData.category === 'NUEVA_CATEGORIA'
        ? formData.newCategory.trim()
        : formData.category.trim()
      const baseName = formData.name.trim()
      const cleanedDescription = formData.description.trim()
      const cleanedLocation = formData.location.trim()
      // Auto-generate code from name (hidden from user)
      const autoCode = (editingItem?.code?.trim()) ||
        baseName
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // strip accents
          .replace(/[^a-zA-Z0-9\s]/g, '')
          .trim()
          .split(/\s+/).slice(0, 3).map(w => w.slice(0, 4).toUpperCase()).join('-')
        || 'PROD'
      const cleanedCode = formData.code.trim() || autoCode

      if (!isVariantMode && !categoryValue) {
        setFormError('La categoría es requerida')
        setIsSubmitting(false)
        return
      }

      if (isVariantMode && !variantParentItem) {
        setFormError('No se encontró el producto base para esta variante')
        setIsSubmitting(false)
        return
      }

      const isService = formData.tipo === 'service'
      const basePayload = {
        code: cleanedCode,
        description: cleanedDescription,
        category: categoryValue,
        stock_quantity: isService ? 0 : formData.stock_quantity,
        min_stock: isService ? 0 : formData.min_stock,
        cost_price: formData.cost_price,
        cost_price_usd: formData.cost_price_usd,
        sale_price: formData.sale_price,
        location: isService ? '' : cleanedLocation,
        base_currency: formData.base_currency,
        base_price: formData.base_price,
        exchange_rate_used: formData.exchange_rate_used,
        auto_update_price: formData.auto_update_price,
        tipo: formData.tipo
      }

      if (isVariantMode && variantParentItem) {
        const variantName = formData.variant_name.trim()

        if (!variantName) {
          setFormError('El nombre de la variante es requerido')
          setIsSubmitting(false)
          return
        }

        const variantPayload = {
          ...basePayload,
          name: `${variantParentItem.name} - ${variantName}`,
          category: variantParentItem.category,
          subcategory: variantName,
          supplier_code: buildVariantParentReference(variantParentItem.id)
        }

        if (editingItem) {
          await updateItem(editingItem.id, variantPayload, { skipReload: true })
        } else {
          await addItem(variantPayload as any, { skipReload: true })
        }

        await refresh({ background: true })
        closeModal()
        return
      }

      if (!baseName) {
        setFormError('El nombre es requerido')
        setIsSubmitting(false)
        return
      }

      if (formData.has_variants && formData.variants.length === 0) {
        setFormError('Debe agregar al menos una variante')
        setIsSubmitting(false)
        return
      }

      if (formData.has_variants) {
        const invalidVariants = formData.variants.filter(v => !v.name || v.name.trim() === '')
        if (invalidVariants.length > 0) {
          setFormError('Todas las variantes deben tener un nombre')
          setIsSubmitting(false)
          return
        }
      }

      // Pre-flight: validar que el código base no esté duplicado en la DB
      const otherItemsCodes = new Set(
        items
          .filter(i => i.id !== editingItem?.id)
          .map(i => (i.code || '').trim())
          .filter(Boolean)
      )
      if (cleanedCode && otherItemsCodes.has(cleanedCode)) {
        setFormError(`El código "${cleanedCode}" ya está siendo usado por otro producto. Probá con otro.`)
        setIsSubmitting(false)
        return
      }

      const productPayload = {
        ...basePayload,
        name: baseName,
        stock_quantity: formData.has_variants ? 0 : formData.stock_quantity
      }

      const existingChildVariants = editingItem ? (variantsByParent[editingItem.id] || []) : []
      let parentProductId = editingItem?.id || ''
      let parentProductCode = editingItem?.code || cleanedCode

      if (editingItem) {
        await updateItem(editingItem.id, productPayload, { skipReload: true })
      } else {
        const createdProduct = await addItem(productPayload as any, { skipReload: true })
        parentProductId = createdProduct?.id || ''
        parentProductCode = createdProduct?.code || cleanedCode
      }

      if (formData.has_variants && parentProductId) {
        const keptVariantIds = new Set<string>()

        // Códigos a evitar: los del lote actual + los de otros productos en DB
        // (excepto el padre y las variantes propias que estamos editando)
        const ownVariantIds = new Set(existingChildVariants.map(v => v.id))
        const externalCodes = new Set(
          items
            .filter(i => i.id !== parentProductId && !ownVariantIds.has(i.id))
            .map(i => (i.code || '').trim())
            .filter(Boolean)
        )
        const usedCodes = new Set<string>()

        // Helper: detecta si un error es una violación de unique constraint (409)
        const isDuplicateCodeError = (err: any) => {
          const msg = err?.message || err?.toString?.() || ''
          const code = err?.code || ''
          return code === '23505' || /duplicate key|unique|409|violates.*unique/i.test(msg)
        }

        // Helper: genera un código candidato para la variante dado el sufijo
        const buildVariantCode = (suffix: number) =>
          `${parentProductCode}-VAR-${String(suffix).padStart(2, '0')}`

        for (let index = 0; index < formData.variants.length; index++) {
          const variant = formData.variants[index]
          const variantName = variant.name.trim()
          // Si la variante ya existe (tiene id), conservar su código original.
          // Si es nueva, generar uno único basado en el código del padre.
          let variantCode = variant.code?.trim()
          let autoGeneratedSuffix = index + 1
          const isAutoGenerated = !variantCode

          if (isAutoGenerated) {
            variantCode = buildVariantCode(autoGeneratedSuffix)
            while (usedCodes.has(variantCode) || externalCodes.has(variantCode)) {
              autoGeneratedSuffix += 1
              variantCode = buildVariantCode(autoGeneratedSuffix)
            }
          } else if (!variant.id) {
            // Variante nueva con código manual: validar contra estado local
            if (externalCodes.has(variantCode) || usedCodes.has(variantCode)) {
              throw new Error(`El código "${variantCode}" de la variante "${variantName}" ya está en uso. Cambialo o dejá vacío para autogenerar.`)
            }
          }
          usedCodes.add(variantCode)

          const buildVariantPayload = (codeToUse: string) => ({
            code: codeToUse,
            name: `${baseName} - ${variantName}`,
            description: cleanedDescription,
            category: categoryValue,
            subcategory: variantName,
            stock_quantity: variant.stock_quantity || 0,
            min_stock: formData.min_stock,
            cost_price: variant.cost_price ?? formData.cost_price,
            cost_price_usd: variant.cost_price_usd ?? formData.cost_price_usd,
            sale_price: variant.sale_price || formData.sale_price,
            location: variant.location?.trim() || cleanedLocation,
            base_currency: variant.base_currency || formData.base_currency,
            base_price: variant.base_price ?? formData.base_price,
            exchange_rate_used: variant.exchange_rate_used ?? formData.exchange_rate_used,
            auto_update_price: variant.auto_update_price ?? formData.auto_update_price,
            supplier_code: buildVariantParentReference(parentProductId)
          })

          if (variant.id) {
            keptVariantIds.add(variant.id)
            await updateItem(variant.id, buildVariantPayload(variantCode), { skipReload: true })
          } else {
            // Retry en caso de 409: la constraint UNIQUE de `code` es global y no se
            // respeta `is_active`, así que un código generado puede chocar con
            // productos soft-deleteados o de otros negocios. Reintentamos incrementando
            // el sufijo hasta dar con uno libre.
            const MAX_ATTEMPTS = 50
            let attempt = 0
            let lastError: any = null
            let createdVariant: any = null
            while (attempt < MAX_ATTEMPTS) {
              try {
                createdVariant = await addItem(buildVariantPayload(variantCode) as any, { skipReload: true })
                break
              } catch (err: any) {
                lastError = err
                if (!isDuplicateCodeError(err) || !isAutoGenerated) {
                  throw err
                }
                // Código ocupado en DB: marcar como usado y regenerar
                externalCodes.add(variantCode)
                usedCodes.delete(variantCode)
                autoGeneratedSuffix += 1
                variantCode = buildVariantCode(autoGeneratedSuffix)
                while (usedCodes.has(variantCode) || externalCodes.has(variantCode)) {
                  autoGeneratedSuffix += 1
                  variantCode = buildVariantCode(autoGeneratedSuffix)
                }
                usedCodes.add(variantCode)
                attempt += 1
              }
            }
            if (!createdVariant) {
              throw lastError || new Error(`No se pudo generar un código único para la variante "${variantName}" tras ${MAX_ATTEMPTS} intentos. Probá cambiar el código base del producto.`)
            }
            if (createdVariant?.id) {
              keptVariantIds.add(createdVariant.id)
            }
          }
        }

        const removedVariants = existingChildVariants.filter(variant => !keptVariantIds.has(variant.id))
        if (removedVariants.length > 0) {
          let deleteQuery = supabase
            .from('inventory')
            .update({ is_active: false })
            .in('id', removedVariants.map(variant => variant.id))

          if (businessId) {
            deleteQuery = deleteQuery.eq('business_id', businessId)
          }

          const { error: deleteVariantsError } = await deleteQuery
          if (deleteVariantsError) {
            throw deleteVariantsError
          }
        }
      } else if (editingItem && existingChildVariants.length > 0) {
        let deleteQuery = supabase
          .from('inventory')
          .update({ is_active: false })
          .in('id', existingChildVariants.map(variant => variant.id))

        if (businessId) {
          deleteQuery = deleteQuery.eq('business_id', businessId)
        }

        const { error: deleteVariantsError } = await deleteQuery
        if (deleteVariantsError) {
          throw deleteVariantsError
        }
      }

      await refresh({ background: true })

      // Auto-expandir el padre después de guardar para que el usuario
      // vea las variantes inmediatamente sin tener que hacer click
      if (formData.has_variants && parentProductId) {
        setExpandedRows(prev => new Set([...prev, parentProductId]))
      }
      if (isVariantMode && variantParentItem?.id) {
        setExpandedRows(prev => new Set([...prev, variantParentItem.id]))
      }

      closeModal()
    } catch (err: any) {
      const rawMsg = err?.message || ''
      const friendly = /duplicate key|unique|409|violates/i.test(rawMsg)
        ? `El código ingresado ya está siendo usado por otro producto. Probá con otro.`
        : rawMsg || 'Error al guardar producto'
      setFormError(friendly)
    } finally {
      setIsSubmitting(false)
      hideLoading()
    }
  }

  const handleDuplicate = async (item: any) => {
    try {
      showLoading('Duplicando producto...')
      const isVariant = isVariantItem(item)

      const buildCopyPayload = (source: any, overrides: Record<string, any> = {}) => {
        const {
          id: _id,
          created_at: _ca,
          updated_at: _ua,
          created_by: _cb,
          business_id: _bi,
          ...rest
        } = source

        // Si el producto está vinculado al dólar, recalcular sale_price
        // con el tipo de cambio ACTUAL para que la copia no quede desactualizada
        const currentRate = exchangeRates['USD-ARS'] || rest.exchange_rate_used || 1
        let recalcPrices: Record<string, any> = {}
        if (
          rest.base_currency === 'USD' &&
          rest.base_price != null &&
          Number(rest.base_price) > 0 &&
          currentRate > 1
        ) {
          recalcPrices = {
            sale_price: roundUpTo500(Number(rest.base_price) * currentRate),
            exchange_rate_used: currentRate,
          }
        }

        return { ...rest, ...recalcPrices, ...overrides }
      }

      // Genera un código único que no colisiona con ningún producto existente
      const existingCodes = new Set(items.map(i => (i.code || '').trim()).filter(Boolean))
      const makeUniqueCode = (baseCode: string, fallbackSuffix = 'COPY') => {
        const seed = `${baseCode}-${fallbackSuffix}`
        if (!existingCodes.has(seed)) {
          existingCodes.add(seed)
          return seed
        }
        let n = 2
        while (existingCodes.has(`${seed}-${n}`)) n++
        const final = `${seed}-${n}`
        existingCodes.add(final)
        return final
      }

      // Detecta violación de unique constraint (409) del servidor
      const isDuplicateCodeError = (err: any) => {
        const msg = err?.message || err?.toString?.() || ''
        const code = err?.code || ''
        return code === '23505' || /duplicate key|unique|409|violates.*unique/i.test(msg)
      }

      // addItem con retry automático: si el servidor devuelve 409 por código
      // duplicado (contra soft-deleted o productos de otros negocios), regenera
      // el código con un sufijo incremental y reintenta.
      const addWithRetry = async (
        payload: any,
        baseCode: string,
        fallbackSuffix: string,
        maxAttempts = 50
      ) => {
        let currentPayload = payload
        let attempt = 0
        while (attempt < maxAttempts) {
          try {
            return await addItem(currentPayload, { skipReload: true })
          } catch (err: any) {
            if (!isDuplicateCodeError(err)) throw err
            // Marcar el código fallido como ocupado y generar otro
            existingCodes.add(currentPayload.code)
            const newCode = makeUniqueCode(baseCode, `${fallbackSuffix}-${attempt + 2}`)
            currentPayload = { ...currentPayload, code: newCode }
            attempt += 1
          }
        }
        throw new Error(`No se pudo generar un código único después de ${maxAttempts} intentos.`)
      }

      if (isVariant) {
        const parentId = getVariantParentId(item)
        const parentItem = parentId ? items.find(i => i.id === parentId) : null
        if (!parentItem) {
          alert('No se encontró el producto base de esta variante')
          return
        }
        const variantName = getVariantName(item, parentItem)
        const newVariantName = `${variantName} (copia)`
        const variantBaseCode = item.code || parentItem.code
        const newCode = makeUniqueCode(variantBaseCode, 'COPY')
        await addWithRetry(buildCopyPayload(item, {
          code: newCode,
          name: `${parentItem.name} - ${newVariantName}`,
          subcategory: newVariantName,
          supplier_code: buildVariantParentReference(parentItem.id)
        }), variantBaseCode, 'COPY')
      } else {
        const childVariants = variantsByParent[item.id] || []
        const newCode = makeUniqueCode(item.code, 'COPY')
        const newName = `${item.name} (copia)`
        const duplicated = await addWithRetry(buildCopyPayload(item, {
          code: newCode,
          name: newName
        }), item.code, 'COPY')

        if (duplicated?.id && childVariants.length > 0) {
          for (let i = 0; i < childVariants.length; i++) {
            const variant = childVariants[i]
            const variantName = getVariantName(variant, item)
            const variantBaseCode = `${newCode}-VAR-${String(i + 1).padStart(2, '0')}`
            const variantCode = makeUniqueCode(variantBaseCode, 'DUP')
            await addWithRetry(buildCopyPayload(variant, {
              code: variantCode,
              name: `${newName} - ${variantName}`,
              subcategory: variantName,
              supplier_code: buildVariantParentReference(duplicated.id)
            }), variantBaseCode, 'DUP')
          }
        }
      }

      await refresh({ background: true })
    } catch (err: any) {
      const rawMsg = err?.message || ''
      const friendly = /duplicate|unique|409|violates/i.test(rawMsg)
        ? 'Ya existe un producto con ese código. Cambiá el código del producto original o reintentá.'
        : rawMsg || 'Error desconocido'
      alert('Error al duplicar: ' + friendly)
    } finally {
      hideLoading()
    }
  }

  const handleInventoryDelete = async (item: any) => {
    const childVariants = isVariantItem(item) ? [] : variantsByParent[item.id] || []
    const confirmationMessage = childVariants.length > 0
      ? `¿Eliminar "${item.name}" y sus ${childVariants.length} variante${childVariants.length === 1 ? '' : 's'}?`
      : `¿Eliminar "${item.name}"?`

    if (!confirm(confirmationMessage)) return
    
    try {
      if (childVariants.length > 0) {
        const idsToDelete = [item.id, ...childVariants.map(childVariant => childVariant.id)]

        let deleteQuery = supabase
          .from('inventory')
          .update({ is_active: false })
          .in('id', idsToDelete)

        if (businessId) {
          deleteQuery = deleteQuery.eq('business_id', businessId)
        }

        const { error: deleteError } = await deleteQuery

        if (deleteError) {
          throw deleteError
        }

        await refresh()
      } else {
        await deleteItem(item.id)
      }
    } catch (err: any) {
      alert('Error al eliminar: ' + err.message)
    }
  }

  const handleExportInventory = () => {
    try {
      const exportData = items.map(item => ({
        'Código/SKU': item.code,
        'Nombre del producto': item.name,
        'Descripción': item.description || '',
        'Categoría': item.category,
        'Stock actual': item.stock_quantity,
        'Stock mínimo': item.min_stock,
        'Precio de costo (ARS)': item.cost_price,
        'Precio de costo (USD)': item.cost_price_usd || 0,
        'Precio de venta (ARS)': item.sale_price,
        'Ubicación': item.location || '',
        'Moneda base': item.base_currency || 'ARS',
        'Precio base': item.base_price || 0,
        'Tipo de cambio usado': item.exchange_rate_used || 0
      }))

      ExcelService.exportToExcel(exportData, 'inventario', 'Inventario')
      alert('Inventario exportado exitosamente')
    } catch (error) {
      alert('Error al exportar inventario: ' + (error instanceof Error ? error.message : 'Error desconocido'))
    }
  }

  const handleImportInventory = async (data: ExcelRow[]) => {
    showLoading('Importando inventario...')
    let created = 0
    let updated = 0

    try {
      for (const row of data) {
        const code = row['Código/SKU'] || row['codigo'] || row['code']
        
        if (!code) {
          console.warn('Fila sin código, saltando:', row)
          continue
        }

        // Buscar si existe por código
        const { data: existingItem } = await supabase
          .from('inventory')
          .select('*')
          .eq('code', code)
          .eq('business_id', businessId)
          .single()

        const itemData = {
          code,
          name: row['Nombre del producto'] || row['nombre'] || row['name'] || '',
          description: row['Descripción'] || row['descripcion'] || row['description'] || '',
          category: row['Categoría'] || row['categoria'] || row['category'] || '',
          stock_quantity: Number(row['Stock actual'] || row['stock'] || 0),
          min_stock: Number(row['Stock mínimo'] || row['stock_minimo'] || 1),
          cost_price: Number(row['Precio de costo (ARS)'] || row['costo'] || 0),
          cost_price_usd: Number(row['Precio de costo (USD)'] || row['costo_usd'] || 0),
          sale_price: Number(row['Precio de venta (ARS)'] || row['precio_venta'] || 0),
          location: row['Ubicación'] || row['ubicacion'] || row['location'] || '',
          base_currency: row['Moneda base'] || row['moneda'] || 'ARS',
          base_price: Number(row['Precio base'] || row['precio_base'] || 0),
          exchange_rate_used: Number(row['Tipo de cambio usado'] || row['tipo_cambio'] || 0),
          business_id: businessId
        }

        if (existingItem) {
          await supabase
            .from('inventory')
            .update(itemData)
            .eq('id', existingItem.id)
          updated++
        } else {
          await supabase
            .from('inventory')
            .insert([itemData])
          created++
        }
      }

      await refresh({ background: true })
      return { created, updated }
    } catch (error) {
      console.error('Error importando inventario:', error)
      throw error
    } finally {
      hideLoading()
    }
  }

  const handleDownloadTemplate = () => {
    const headers = [
      'Código/SKU',
      'Nombre del producto',
      'Descripción',
      'Categoría',
      'Stock actual',
      'Stock mínimo',
      'Precio de costo (ARS)',
      'Precio de costo (USD)',
      'Precio de venta (ARS)',
      'Ubicación',
      'Moneda base',
      'Precio base',
      'Tipo de cambio usado'
    ]

    const exampleData = [{
      'Código/SKU': 'SCR-IPH13',
      'Nombre del producto': 'Pantalla iPhone 13 Pro OLED',
      'Descripción': 'Pantalla original completa',
      'Categoría': 'Pantallas',
      'Stock actual': 10,
      'Stock mínimo': 1,
      'Precio de costo (ARS)': 28000,
      'Precio de costo (USD)': 50,
      'Precio de venta (ARS)': 45000,
      'Ubicación': 'Estante A',
      'Moneda base': 'ARS',
      'Precio base': 45000,
      'Tipo de cambio usado': 560
    }]

    ExcelService.createTemplate(headers, 'plantilla_inventario', exampleData)
  }

  const renderInventoryRow = (item: any, options?: { isVariant?: boolean; parentItem?: any }) => {
    const isVariant = options?.isVariant || false
    const parentItem = options?.parentItem
    const variantCount = isVariant ? 0 : (variantsByParent[item.id] || []).length
    const hasVariants = !isVariant && variantCount > 0
    const isService = item.tipo === 'service'
    const effective = getEffectiveStock(item)
    const displayStock = effective.stock_quantity
    const displayMinStock = effective.min_stock
    const effectiveOutOfStock = !isService && displayStock === 0
    const effectiveLowStock = !isService && displayStock > 0 && displayStock <= displayMinStock
    const isExpanded = hasVariants && expandedRows.has(item.id)
    const effectivePrices = getEffectivePrices(item)
    const costPrice = effectivePrices.costPrice
    const salePrice = effectivePrices.salePrice
    const isPriceRange = effectivePrices.isRange
    const margin = salePrice - costPrice
    const marginPercent = costPrice > 0 ? ((margin / costPrice) * 100).toFixed(1) : '0'
    const costPriceUSD = !hasVariants && item.base_currency === 'USD' ? formatUSD(item.cost_price_usd) : null
    const salePriceUSD = !hasVariants && item.base_currency === 'USD' ? formatUSD(item.base_price) : null
    const productName = isVariant ? getVariantName(item, parentItem) : item.name

    return (
      <tr
        key={item.id}
        style={{
          borderBottom: '1px solid rgba(255,255,255,0.05)',
          backgroundColor: isVariant ? 'rgba(15, 23, 42, 0.55)' : 'transparent'
        }}
      >
        <td style={{ padding: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', paddingLeft: isVariant ? '1.5rem' : 0 }}>
            {isVariant && (
              <div style={{ width: '0.75rem', height: '1px', backgroundColor: 'rgba(148, 163, 184, 0.5)' }} />
            )}
            {hasVariants ? (
              <button
                onClick={() => toggleExpanded(item.id)}
                title={isExpanded ? 'Ocultar variantes' : 'Mostrar variantes'}
                style={{
                  padding: '0.25rem',
                  backgroundColor: 'rgba(56,189,248,0.1)',
                  border: '1px solid rgba(56,189,248,0.25)',
                  borderRadius: '0.375rem',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#38bdf8'
                }}
              >
                {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
            ) : null}
            <Package size={16} style={{ color: isVariant ? '#38bdf8' : '#64748b' }} />
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                <p style={{ color: '#ffffff', fontWeight: 500, margin: 0 }}>{productName}</p>
                <span style={{
                  padding: '0.2rem 0.55rem',
                  borderRadius: '9999px',
                  fontSize: '0.6875rem',
                  fontWeight: 600,
                  backgroundColor: isVariant
                    ? 'rgba(56, 189, 248, 0.12)'
                    : isService
                      ? 'rgba(99, 102, 241, 0.15)'
                      : 'rgba(79, 70, 229, 0.12)',
                  color: isVariant ? '#38bdf8' : isService ? '#818cf8' : '#a5b4fc'
                }}>
                  {isVariant ? 'Variante' : isService ? '🔧 Servicio' : 'Base'}
                </span>
                {!isVariant && variantCount > 0 && (
                  <span style={{
                    padding: '0.2rem 0.55rem',
                    borderRadius: '9999px',
                    fontSize: '0.6875rem',
                    fontWeight: 600,
                    backgroundColor: 'rgba(16, 185, 129, 0.12)',
                    color: '#34d399'
                  }}>
                    {variantCount} variante{variantCount === 1 ? '' : 's'}
                  </span>
                )}
              </div>
              {item.description && (
                <p style={{ color: '#64748b', fontSize: '0.75rem', margin: 0 }}>{item.description}</p>
              )}
              {isVariant && parentItem && (
                <p style={{ color: '#64748b', fontSize: '0.75rem', margin: 0 }}>Base: {parentItem.name}</p>
              )}
              {!isVariant && variantCount > 0 && (
                <p style={{ color: '#64748b', fontSize: '0.75rem', margin: 0 }}>
                  Cada variante maneja stock y precios propios
                </p>
              )}
            </div>
          </div>
        </td>
        <td style={{ padding: '1rem', color: '#94a3b8' }}>{parentItem?.category || item.category}</td>
        <td style={{ padding: '1rem', textAlign: 'center' }}>
          {isService ? (
            <span style={{ fontSize: '1rem', color: '#818cf8', fontWeight: 600 }} title="Sin control de stock">∞</span>
          ) : (
            <>
              <span style={{
                fontWeight: 600,
                color: effectiveOutOfStock ? '#ef4444' : effectiveLowStock ? '#fbbf24' : '#34d399'
              }}>
                {displayStock}
              </span>
              <span style={{ color: '#64748b', fontSize: '0.75rem' }}>
                /{displayMinStock}
              </span>
              {hasVariants && (
                <div style={{ color: '#64748b', fontSize: '0.6875rem', marginTop: '0.125rem' }}>
                  Total variantes
                </div>
              )}
            </>
          )}
        </td>
        <td style={{ padding: '1rem', textAlign: 'right', color: '#94a3b8' }}>
          {hasVariants && isPriceRange ? (
            <div>
              <div style={{ fontSize: '0.8125rem' }}>{formatARS(effectivePrices.minCost)}</div>
              <div style={{ fontSize: '0.75rem', color: '#64748b' }}>— {formatARS(effectivePrices.maxCost)}</div>
            </div>
          ) : (
            <div>
              <div>{formatARS(costPrice)}</div>
              {currencySettings?.show_usd_price && costPriceUSD && (
                <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '0.125rem' }}>
                  {costPriceUSD}
                </div>
              )}
            </div>
          )}
        </td>
        <td style={{ padding: '1rem', textAlign: 'right', color: '#ffffff', fontWeight: 500 }}>
          {hasVariants && isPriceRange ? (
            <div>
              <div style={{ fontSize: '0.8125rem' }}>{formatARS(effectivePrices.minSale)}</div>
              <div style={{ fontSize: '0.75rem', color: '#94a3b8', fontWeight: 400 }}>— {formatARS(effectivePrices.maxSale)}</div>
            </div>
          ) : (
            <div>
              <div>{formatARS(salePrice)}</div>
              {currencySettings?.show_usd_price && salePriceUSD && (
                <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '0.125rem' }}>
                  {salePriceUSD}
                </div>
              )}
            </div>
          )}
        </td>
        <td style={{ padding: '1rem', textAlign: 'right' }}>
          {hasVariants ? (
            <span style={{ color: '#64748b', fontSize: '0.75rem' }}>ver variantes</span>
          ) : (
            <>
              <span style={{ color: '#34d399', fontSize: '0.875rem' }}>
                +{formatARS(margin)}
              </span>
              <br />
              <span style={{ color: '#64748b', fontSize: '0.75rem' }}>
                {marginPercent}%
              </span>
            </>
          )}
        </td>
        <td style={{ padding: '1rem', textAlign: 'center' }}>
          {isService ? (
            <span style={{
              padding: '0.25rem 0.75rem',
              backgroundColor: 'rgba(99,102,241,0.1)',
              color: '#818cf8',
              borderRadius: '9999px',
              fontSize: '0.75rem',
              fontWeight: 500
            }}>
              Disponible
            </span>
          ) : effectiveOutOfStock ? (
            <span style={{
              padding: '0.25rem 0.75rem',
              backgroundColor: 'rgba(239, 68, 68, 0.1)',
              color: '#ef4444',
              borderRadius: '9999px',
              fontSize: '0.75rem',
              fontWeight: 500
            }}>
              Agotado
            </span>
          ) : effectiveLowStock ? (
            <span style={{
              padding: '0.25rem 0.75rem',
              backgroundColor: 'rgba(245, 158, 11, 0.1)',
              color: '#fbbf24',
              borderRadius: '9999px',
              fontSize: '0.75rem',
              fontWeight: 500,
              display: 'flex',
              alignItems: 'center',
              gap: '0.25rem',
              justifyContent: 'center'
            }}>
              <AlertTriangle size={12} />
              Stock Bajo
            </span>
          ) : (
            <span style={{
              padding: '0.25rem 0.75rem',
              backgroundColor: 'rgba(16, 185, 129, 0.1)',
              color: '#34d399',
              borderRadius: '9999px',
              fontSize: '0.75rem',
              fontWeight: 500
            }}>
              OK
            </span>
          )}
        </td>
        <td style={{ padding: '1rem', textAlign: 'center' }}>
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center' }}>
            {!isVariant && !isService && (
              <button
                onClick={() => openAddModal(item)}
                style={{
                  padding: '0.5rem',
                  backgroundColor: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(56,189,248,0.25)',
                  borderRadius: '0.375rem',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center'
                }}
                title="Agregar variante"
              >
                <Plus size={16} style={{ color: '#38bdf8' }} />
              </button>
            )}
            <button
              onClick={() => openEditModal(item)}
              style={{
                padding: '0.5rem',
                backgroundColor: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: '0.375rem',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center'
              }}
              title="Editar"
            >
              <Edit size={16} style={{ color: '#94a3b8' }} />
            </button>
            <button
              onClick={() => handleDuplicate(item)}
              style={{
                padding: '0.5rem',
                backgroundColor: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(139,92,246,0.25)',
                borderRadius: '0.375rem',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center'
              }}
              title="Duplicar"
            >
              <Copy size={16} style={{ color: '#a78bfa' }} />
            </button>
            <button
              onClick={() => handleInventoryDelete(item)}
              style={{
                padding: '0.5rem',
                backgroundColor: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: '0.375rem',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center'
              }}
              title="Eliminar"
            >
              <Trash2 size={16} style={{ color: '#ef4444' }} />
            </button>
          </div>
        </td>
      </tr>
    )
  }

  const isVariantModal = Boolean(variantParentItem)
  const isServiceModal = formData.tipo === 'service'
  const modalTitle = editingItem
    ? isVariantModal ? 'Editar Variante' : isServiceModal ? 'Editar Servicio' : 'Editar Producto'
    : isVariantModal ? 'Nueva Variante' : isServiceModal ? 'Nuevo Servicio' : 'Nuevo Producto'
  const modalSubmitLabel = editingItem
    ? 'Guardar Cambios'
    : isVariantModal ? 'Crear Variante' : isServiceModal ? 'Crear Servicio' : 'Crear Producto'

  if (error) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center' }}>
        <AlertTriangle size={48} style={{ color: '#ef4444' }} />
        <h3 style={{ color: '#ffffff', marginTop: '1rem' }}>Error al cargar inventario</h3>
        <p style={{ color: '#94a3b8' }}>{error}</p>
        <button onClick={() => { void refresh() }} style={{
          marginTop: '1rem',
          padding: '0.625rem 1.25rem',
          background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
          border: 'none',
          color: '#ffffff',
          borderRadius: '0.625rem',
          cursor: 'pointer',
          fontWeight: 600,
          boxShadow: '0 4px 12px rgba(99,102,241,0.35)'
        }}>
          Reintentar
        </button>
      </div>
    )
  }

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: '2rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.875rem' }}>
          <div style={{
            width: '44px', height: '44px', borderRadius: '0.75rem',
            background: 'linear-gradient(135deg, rgba(99,102,241,0.2), rgba(139,92,246,0.2))',
            border: '1px solid rgba(99,102,241,0.3)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0
          }}>
            <Package size={22} style={{ color: '#818cf8' }} />
          </div>
          <div>
            <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 800, color: '#f8fafc' }}>Inventario</h1>
            <p style={{ margin: 0, fontSize: '0.8rem', color: '#475569' }}>
              {rootItems.length} productos base · {variantItems.length} variantes · {effectiveLowStockItems.length} stock bajo · {effectiveOutOfStockItems.length} agotados
            </p>
          </div>
        </div>
          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <button onClick={handleDownloadTemplate} style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.625rem 1rem',
              backgroundColor: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.08)',
              color: '#94a3b8',
              borderRadius: '0.5rem',
              cursor: 'pointer',
              fontWeight: 500,
              fontSize: '0.875rem'
            }}>
              <Download size={16} />
              Plantilla
            </button>
            <button onClick={handleExportInventory} style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.625rem 1rem',
              backgroundColor: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.08)',
              color: '#94a3b8',
              borderRadius: '0.5rem',
              cursor: 'pointer',
              fontWeight: 500,
              fontSize: '0.875rem'
            }}>
              <Download size={16} />
              Exportar
            </button>
            <button onClick={() => setShowImportModal(true)} style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.625rem 1rem',
              backgroundColor: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.08)',
              color: '#94a3b8',
              borderRadius: '0.5rem',
              cursor: 'pointer',
              fontWeight: 500,
              fontSize: '0.875rem'
            }}>
              <Upload size={16} />
              Importar
            </button>
            <div style={{ position: 'relative' }} data-product-menu>
              <button
                onClick={() => setShowProductMenu(!showProductMenu)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  padding: '0.625rem 1.25rem',
                  background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
                  border: 'none',
                  color: '#ffffff',
                  borderRadius: '0.625rem',
                  cursor: 'pointer',
                  fontWeight: 600,
                  boxShadow: '0 4px 12px rgba(99,102,241,0.35)',
                  fontSize: '0.875rem'
                }}
              >
                <Plus size={18} />
                Nuevo Producto
                <ChevronDown size={16} />
              </button>
              {showProductMenu && (
                <div style={{
                  position: 'absolute',
                  top: '100%',
                  left: 0,
                  marginTop: '0.5rem',
                  backgroundColor: '#ffffff',
                  border: '1px solid rgba(0,0,0,0.15)',
                  borderRadius: '0.5rem',
                  zIndex: 10,
                  minWidth: '200px'
                }}>
                  <button
                    onClick={() => { setShowProductMenu(false); openAddModal(undefined, 'product'); }}
                    style={{
                      width: '100%',
                      padding: '0.875rem 1rem',
                      backgroundColor: 'transparent',
                      border: 'none',
                      color: '#1e293b',
                      textAlign: 'left',
                      cursor: 'pointer',
                      fontSize: '0.875rem',
                      fontWeight: 500,
                      borderBottom: '1px solid rgba(0,0,0,0.1)'
                    }}
                  >
                    📦 Producto simple
                  </button>
                  <button
                    onClick={() => { setShowProductMenu(false); openAddModal(); setTimeout(() => setFormData(prev => ({ ...prev, has_variants: true, tipo: 'product' })), 100); }}
                    style={{
                      width: '100%',
                      padding: '0.875rem 1rem',
                      backgroundColor: 'transparent',
                      border: 'none',
                      color: '#1e293b',
                      textAlign: 'left',
                      cursor: 'pointer',
                      fontSize: '0.875rem',
                      fontWeight: 500,
                      borderBottom: '1px solid rgba(0,0,0,0.1)'
                    }}
                  >
                    🔀 Producto con variantes
                  </button>
                  <button
                    onClick={() => { setShowProductMenu(false); openAddModal(undefined, 'service'); }}
                    style={{
                      width: '100%',
                      padding: '0.875rem 1rem',
                      backgroundColor: 'transparent',
                      border: 'none',
                      color: '#6366f1',
                      textAlign: 'left',
                      cursor: 'pointer',
                      fontSize: '0.875rem',
                      fontWeight: 600
                    }}
                  >
                    🔧 Nuevo Servicio
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

      {/* Alertas de stock bajo */}
      {(effectiveLowStockItems.length > 0 || effectiveOutOfStockItems.length > 0) && (
        <div style={{ 
          marginBottom: '1.5rem', 
          padding: '1rem', 
          backgroundColor: 'rgba(245, 158, 11, 0.1)', 
          border: '1px solid rgba(245, 158, 11, 0.3)',
          borderRadius: '0.75rem',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '0.75rem',
          flexWrap: 'wrap'
        }}>
          <AlertTriangle size={20} style={{ color: '#fbbf24' }} />
          <div style={{ flex: 1, minWidth: '240px' }}>
            <p style={{ color: '#fbbf24', fontWeight: 600, margin: 0 }}>
              {effectiveLowStockItems.length} con stock bajo · {effectiveOutOfStockItems.length} agotados
            </p>
            <p style={{ color: '#94a3b8', fontSize: '0.875rem', margin: 0 }}>
              Los productos con 1 unidad quedan en stock bajo y con 0 se marcan como agotados
            </p>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {effectiveLowStockItems.length > 0 && (
              <button
                onClick={() => applyStockStatusFilter('low')}
                style={{
                  padding: '0.5rem 0.75rem',
                  backgroundColor: stockStatusFilter === 'low' ? '#f59e0b' : 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(245, 158, 11, 0.35)',
                  borderRadius: '0.5rem',
                  color: '#ffffff',
                  cursor: 'pointer',
                  fontSize: '0.875rem',
                  fontWeight: 500
                }}
              >
                Ver stock bajo
              </button>
            )}
            {effectiveOutOfStockItems.length > 0 && (
              <button
                onClick={() => applyStockStatusFilter('out')}
                style={{
                  padding: '0.5rem 0.75rem',
                  backgroundColor: stockStatusFilter === 'out' ? '#ef4444' : 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(239, 68, 68, 0.35)',
                  borderRadius: '0.5rem',
                  color: '#ffffff',
                  cursor: 'pointer',
                  fontSize: '0.875rem',
                  fontWeight: 500
                }}
              >
                Ver agotados
              </button>
            )}
            {stockStatusFilter !== 'all' && (
              <button
                onClick={() => applyStockStatusFilter('all')}
                style={{
                  padding: '0.5rem 0.75rem',
                  backgroundColor: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: '0.5rem',
                  color: '#94a3b8',
                  cursor: 'pointer',
                  fontSize: '0.875rem',
                  fontWeight: 500
                }}
              >
                Ver todos
              </button>
            )}
          </div>
        </div>
      )}

      {/* Filtros */}
      <div style={{
        marginBottom: '1.5rem',
        padding: '1rem',
        backgroundColor: '#0f1829',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: '0.75rem',
        display: 'flex',
        gap: '1rem',
        flexWrap: 'wrap'
      }}>
        <div style={{ position: 'relative', flex: 1, minWidth: '240px' }}>
          <Search size={18} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: '#64748b' }} />
          <input
            type="text"
            placeholder="Buscar por nombre o código..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{
              width: '100%',
              padding: '0.625rem 0.75rem 0.625rem 2.5rem',
              backgroundColor: 'rgba(15,23,42,0.8)',
              border: '1px solid rgba(51,65,85,0.6)',
              borderRadius: '0.5rem',
              color: '#f1f5f9',
              outline: 'none'
            }}
          />
        </div>
        <select
          style={{
            width: 'auto',
            minWidth: '200px',
            padding: '0.625rem 0.75rem',
            backgroundColor: 'rgba(15,23,42,0.8)',
            border: '1px solid rgba(51,65,85,0.6)',
            borderRadius: '0.5rem',
            color: '#f1f5f9',
            outline: 'none'
          }}
          value={selectedCategory}
          onChange={(e) => setSelectedCategory(e.target.value)}
        >
          <option value="">Todas las categorías</option>
          {categories.map(cat => (
            <option key={cat} value={cat}>{cat}</option>
          ))}
        </select>
        {(searchTerm || selectedCategory || stockStatusFilter !== 'all') && (
          <button 
            onClick={() => {
              setSearchTerm('')
              setSelectedCategory('')
              setStockStatusFilter('all')
            }}
            style={{
              padding: '0.625rem 1rem',
              backgroundColor: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '0.5rem',
              color: '#94a3b8',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem'
            }}
          >
            <X size={16} />
            Limpiar
          </button>
        )}
      </div>

      {/* Tabla */}
      <div ref={tableRef} style={{
        backgroundColor: '#0f1829',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: '0.75rem',
        overflow: 'hidden'
      }}>
        <div style={{ padding: 0 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                <th style={{
                  padding: '1rem',
                  textAlign: 'left',
                  fontSize: '0.875rem',
                  fontWeight: 500,
                  color: '#94a3b8'
                }}>
                  Producto
                </th>
                <th style={{ 
                  padding: '1rem', 
                  textAlign: 'left', 
                  fontSize: '0.875rem', 
                  fontWeight: 500, 
                  color: '#94a3b8' 
                }}>
                  Categoría
                </th>
                <th style={{ 
                  padding: '1rem', 
                  textAlign: 'center', 
                  fontSize: '0.875rem', 
                  fontWeight: 500, 
                  color: '#94a3b8' 
                }}>
                  Stock
                </th>
                <th style={{ 
                  padding: '1rem', 
                  textAlign: 'right', 
                  fontSize: '0.875rem', 
                  fontWeight: 500, 
                  color: '#94a3b8' 
                }}>
                  Costo
                </th>
                <th style={{ 
                  padding: '1rem', 
                  textAlign: 'right', 
                  fontSize: '0.875rem', 
                  fontWeight: 500, 
                  color: '#94a3b8' 
                }}>
                  Venta
                </th>
                <th style={{ 
                  padding: '1rem', 
                  textAlign: 'right', 
                  fontSize: '0.875rem', 
                  fontWeight: 500, 
                  color: '#94a3b8' 
                }}>
                  Margen
                </th>
                <th style={{ 
                  padding: '1rem', 
                  textAlign: 'center', 
                  fontSize: '0.875rem', 
                  fontWeight: 500, 
                  color: '#94a3b8' 
                }}>
                  Estado
                </th>
                <th style={{ 
                  padding: '1rem', 
                  textAlign: 'center', 
                  fontSize: '0.875rem', 
                  fontWeight: 500, 
                  color: '#94a3b8' 
                }}>
                  Acciones
                </th>
              </tr>
            </thead>
            <tbody>
              {displayedItems.length === 0 ? (
                <tr>
                  <td colSpan={8}>
                    {rootItems.length === 0 && variantItems.length === 0 ? (
                      <div style={{ padding: '4rem 2rem', textAlign: 'center' }}>
                        <div style={{
                          width: '64px',
                          height: '64px',
                          borderRadius: '50%',
                          backgroundColor: 'rgba(15,23,42,0.8)',
                          margin: '0 auto 1.5rem',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center'
                        }}>
                          <Package size={32} style={{ color: '#64748b' }} />
                        </div>
                        <h3 style={{ fontSize: '1.25rem', fontWeight: 600, color: '#ffffff', marginBottom: '0.5rem' }}>
                          Todavía no tenés productos
                        </h3>
                        <p style={{ color: '#94a3b8', fontSize: '0.9375rem', marginBottom: '1.5rem', maxWidth: '400px', margin: '0 auto 1.5rem' }}>
                          Comenzá agregando productos al inventario para gestionar tu stock y precios.
                        </p>
                        <button onClick={openAddModal} style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '0.5rem',
                          padding: '0.75rem 1.5rem',
                          background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
                          border: 'none',
                          color: '#ffffff',
                          borderRadius: '0.625rem',
                          cursor: 'pointer',
                          fontWeight: 600,
                          fontSize: '0.875rem',
                          boxShadow: '0 4px 12px rgba(99,102,241,0.35)'
                        }}>
                          <Plus size={16} />
                          Agregar Primer Producto
                        </button>
                      </div>
                    ) : (
                      <div style={{ textAlign: 'center', padding: '3rem', color: '#64748b' }}>
                        <p>No se encontraron productos con los filtros seleccionados</p>
                      </div>
                    )}
                  </td>
                </tr>
              ) : (
                displayedItems.map((item) => {
                  const parentMatchesDirectly = matchesInventoryFilters(item)
                  const hasActiveFilters = Boolean(searchTerm) || Boolean(selectedCategory) || stockStatusFilter !== 'all'
                  const parentVariants = variantsByParent[item.id] || []
                  const filteredVariants = parentVariants.filter(matchesInventoryFilters)
                  const autoExpandForFilter = hasActiveFilters && filteredVariants.length > 0 && !parentMatchesDirectly
                  const isExpanded = expandedRows.has(item.id) || autoExpandForFilter
                  const variantsToShow = !isExpanded
                    ? []
                    : hasActiveFilters && !parentMatchesDirectly
                      ? filteredVariants
                      : parentVariants

                  return (
                    <Fragment key={item.id}>
                      {renderInventoryRow(item)}
                      {variantsToShow.map(variant => renderInventoryRow(variant, { isVariant: true, parentItem: item }))}
                    </Fragment>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modal */}
      {showModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.75)',
          backdropFilter: 'blur(8px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          padding: '1rem'
        }}>
          <div style={{
            backgroundColor: '#0b1120',
            borderRadius: '1rem',
            width: '100%',
            maxWidth: '600px',
            maxHeight: '90vh',
            overflow: 'auto',
            border: '1px solid rgba(255,255,255,0.08)'
          }}>
            <div style={{ padding: '1.5rem', borderBottom: '1px solid rgba(255,255,255,0.08)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ color: '#ffffff', margin: 0, fontSize: '1.125rem', fontWeight: 600 }}>
                {modalTitle}
              </h3>
              <button onClick={closeModal} style={{ backgroundColor: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer', padding: '0.5rem' }}>
                <X size={24} />
              </button>
            </div>
            
            <form onSubmit={handleSubmit} style={{ padding: '1.5rem' }}>
              {formError && (
                <div style={{ 
                  padding: '0.75rem', 
                  backgroundColor: 'rgba(239, 68, 68, 0.1)', 
                  borderRadius: '0.5rem', 
                  color: '#f87171', 
                  marginBottom: '1rem',
                  fontSize: '0.875rem',
                  border: '1px solid rgba(239, 68, 68, 0.2)'
                }}>
                  {formError}
                </div>
              )}

              {isVariantModal && variantParentItem && (
                <div style={{
                  marginBottom: '1rem',
                  padding: '1rem',
                  backgroundColor: 'rgba(56, 189, 248, 0.08)',
                  border: '1px solid rgba(56, 189, 248, 0.18)',
                  borderRadius: '0.75rem'
                }}>
                  <p style={{ color: '#38bdf8', fontWeight: 600, margin: '0 0 0.25rem 0' }}>
                    Variante con stock y precios propios
                  </p>
                  <p style={{ color: '#94a3b8', fontSize: '0.875rem', margin: 0 }}>
                    Producto base: {variantParentItem.name} · Categoría: {variantParentItem.category}
                  </p>
                </div>
              )}

              <div style={{ marginBottom: '1rem' }}>
                <label style={{ display: 'block', fontSize: '0.875rem', color: '#94a3b8', marginBottom: '0.5rem', fontWeight: 500 }}>Categoría *</label>
                <select
                  value={formData.category}
                  onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                  disabled={isVariantModal}
                  style={{
                    width: '100%',
                    padding: '0.625rem 0.75rem',
                    backgroundColor: 'rgba(15,23,42,0.8)',
                    border: '1px solid rgba(51,65,85,0.6)',
                    borderRadius: '0.5rem',
                    color: '#f1f5f9',
                    outline: 'none',
                    opacity: isVariantModal ? 0.7 : 1
                  }}
                  required={!isVariantModal}
                >
                  <option value="">Seleccionar...</option>
                  <option value="NUEVA_CATEGORIA">+ Nueva categoría</option>
                  {allCategories.map(cat => (
                    <option key={cat} value={cat}>{cat}</option>
                  ))}
                </select>
              </div>

              {!isVariantModal && formData.category === 'NUEVA_CATEGORIA' && (
                <div style={{ marginBottom: '1rem' }}>
                  <label style={{ display: 'block', fontSize: '0.875rem', color: '#94a3b8', marginBottom: '0.5rem', fontWeight: 500 }}>Nueva categoría *</label>
                  <input
                    type="text"
                    value={formData.category === 'NUEVA_CATEGORIA' ? formData.newCategory || '' : ''}
                    onChange={(e) => setFormData({ ...formData, newCategory: e.target.value })}
                    style={{
                      width: '100%',
                      padding: '0.625rem 0.75rem',
                      backgroundColor: 'rgba(15,23,42,0.8)',
                      border: '1px solid rgba(51,65,85,0.6)',
                      borderRadius: '0.5rem',
                      color: '#f1f5f9',
                      outline: 'none'
                    }}
                    placeholder="Nombre de la nueva categoría"
                  />
                </div>
              )}

              {/* Badge de servicio */}
              {isServiceModal && !isVariantModal && (
                <div style={{
                  marginBottom: '1rem', padding: '0.75rem 1rem',
                  backgroundColor: 'rgba(99,102,241,0.08)',
                  border: '1px solid rgba(99,102,241,0.25)',
                  borderRadius: '0.5rem',
                  display: 'flex', alignItems: 'center', gap: '0.625rem'
                }}>
                  <span style={{ fontSize: '1.125rem' }}>🔧</span>
                  <div>
                    <p style={{ color: '#a5b4fc', fontWeight: 600, margin: 0, fontSize: '0.875rem' }}>Servicio</p>
                    <p style={{ color: '#64748b', fontSize: '0.75rem', margin: 0 }}>
                      Los servicios no manejan stock. Se pueden agregar a cualquier orden.
                    </p>
                  </div>
                </div>
              )}

              {!isVariantModal && !isServiceModal && (
                <div style={{ marginBottom: '1rem', padding: '1rem', backgroundColor: 'rgba(99, 102, 241, 0.05)', border: '1px solid rgba(99, 102, 241, 0.1)', borderRadius: '0.5rem' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={formData.has_variants}
                      onChange={(e) => setFormData({ ...formData, has_variants: e.target.checked, variants: e.target.checked ? formData.variants : [] })}
                      style={{ width: '18px', height: '18px', cursor: 'pointer' }}
                    />
                    <span style={{ fontSize: '0.875rem', color: '#e2e8f0', fontWeight: 500 }}>Este producto tiene variantes</span>
                  </label>
                  <p style={{ fontSize: '0.75rem', color: '#94a3b8', margin: '0.5rem 0 0 0' }}>
                    Activa esta opción si el producto tiene diferentes tamaños, colores u otras variaciones
                  </p>
                </div>
              )}

              {isVariantModal && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.875rem', color: '#94a3b8', marginBottom: '0.5rem', fontWeight: 500 }}>Nombre de la variante *</label>
                    <input
                      type="text"
                      value={formData.variant_name}
                      onChange={(e) => setFormData({ ...formData, variant_name: e.target.value })}
                      style={{
                        width: '100%',
                        padding: '0.625rem 0.75rem',
                        backgroundColor: 'rgba(15,23,42,0.8)',
                        border: '1px solid rgba(51,65,85,0.6)',
                        borderRadius: '0.5rem',
                        color: '#f1f5f9',
                        outline: 'none'
                      }}
                      placeholder="Ej: Negro / 128GB"
                      required
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.875rem', color: '#94a3b8', marginBottom: '0.5rem', fontWeight: 500 }}>Nombre final</label>
                    <div style={{
                      width: '100%',
                      padding: '0.625rem 0.75rem',
                      backgroundColor: '#0f1829',
                      border: '1px solid rgba(255,255,255,0.06)',
                      borderRadius: '0.5rem',
                      color: '#f1f5f9'
                    }}>
                      {variantParentItem ? `${variantParentItem.name} - ${formData.variant_name || 'Variante'}` : formData.variant_name || 'Variante'}
                    </div>
                  </div>
                </div>
              )}

              {!isVariantModal && (
              <div style={{ marginBottom: '1rem' }}>
                <label style={{ display: 'block', fontSize: '0.875rem', color: '#94a3b8', marginBottom: '0.5rem', fontWeight: 500 }}>Nombre *</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  style={{
                    width: '100%',
                    padding: '0.625rem 0.75rem',
                    backgroundColor: 'rgba(15,23,42,0.8)',
                    border: '1px solid rgba(51,65,85,0.6)',
                    borderRadius: '0.5rem',
                    color: '#f1f5f9',
                    outline: 'none'
                  }}
                  placeholder="Nombre del producto"
                  required
                />
              </div>
              )}

              <div style={{ marginBottom: '1rem' }}>
                <label style={{ display: 'block', fontSize: '0.875rem', color: '#94a3b8', marginBottom: '0.5rem', fontWeight: 500 }}>Descripción</label>
                <textarea
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  style={{
                    width: '100%',
                    padding: '0.625rem 0.75rem',
                    backgroundColor: 'rgba(15,23,42,0.8)',
                    border: '1px solid rgba(51,65,85,0.6)',
                    borderRadius: '0.5rem',
                    color: '#f1f5f9',
                    outline: 'none',
                    minHeight: '80px'
                  }}
                  placeholder="Descripción opcional..."
                />
              </div>

              {!isVariantModal && !formData.has_variants && !isServiceModal && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.875rem', color: '#94a3b8', marginBottom: '0.5rem', fontWeight: 500 }}>Stock Inicial</label>
                    <input
                      type="number"
                      min="0"
                      value={formData.stock_quantity}
                      onChange={(e) => setFormData({ ...formData, stock_quantity: parseInt(e.target.value) || 0 })}
                      style={{
                        width: '100%',
                        padding: '0.625rem 0.75rem',
                        backgroundColor: 'rgba(15,23,42,0.8)',
                        border: '1px solid rgba(51,65,85,0.6)',
                        borderRadius: '0.5rem',
                        color: '#f1f5f9',
                        outline: 'none'
                      }}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.875rem', color: '#94a3b8', marginBottom: '0.5rem', fontWeight: 500 }}>Stock Mínimo</label>
                    <input
                      type="number"
                      min="0"
                      value={formData.min_stock}
                      onChange={(e) => setFormData({ ...formData, min_stock: parseInt(e.target.value) || 0 })}
                      style={{
                        width: '100%',
                        padding: '0.625rem 0.75rem',
                        backgroundColor: 'rgba(15,23,42,0.8)',
                        border: '1px solid rgba(51,65,85,0.6)',
                        borderRadius: '0.5rem',
                        color: '#f1f5f9',
                        outline: 'none'
                      }}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.875rem', color: '#94a3b8', marginBottom: '0.5rem', fontWeight: 500 }}>Ubicación</label>
                    <input
                      type="text"
                      value={formData.location}
                      onChange={(e) => setFormData({ ...formData, location: e.target.value })}
                      style={{
                        width: '100%',
                        padding: '0.625rem 0.75rem',
                        backgroundColor: 'rgba(15,23,42,0.8)',
                        border: '1px solid rgba(51,65,85,0.6)',
                        borderRadius: '0.5rem',
                        color: '#f1f5f9',
                        outline: 'none'
                      }}
                      placeholder="Estante A1"
                    />
                  </div>
                </div>
              )}

              {/* Sección de variantes - solo visible si has_variants=true y no es modal de variante */}
              {!isVariantModal && formData.has_variants && (
                <div style={{ 
                  marginBottom: '1.5rem', 
                  padding: '1.5rem', 
                  backgroundColor: 'rgba(99, 102, 241, 0.05)', 
                  borderRadius: '0.75rem',
                  border: '1px solid rgba(99, 102, 241, 0.15)'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <Package size={20} style={{ color: '#6366f1' }} />
                      <h4 style={{ color: '#ffffff', margin: 0, fontSize: '1rem', fontWeight: 600 }}>Variantes</h4>
                    </div>
                    <button
                      type="button"
                      onClick={addVariant}
                      style={{
                        padding: '0.5rem 1rem',
                        background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
                        border: 'none',
                        color: '#ffffff',
                        borderRadius: '0.625rem',
                        cursor: 'pointer',
                        fontSize: '0.875rem',
                        fontWeight: 600,
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                        boxShadow: '0 4px 12px rgba(99,102,241,0.35)'
                      }}
                    >
                      <Plus size={16} />
                      Agregar Variante
                    </button>
                  </div>

                  {formData.variants.length === 0 ? (
                    <div style={{ 
                      padding: '2rem', 
                      textAlign: 'center',
                      color: '#94a3b8',
                      border: '1px dashed rgba(99, 102, 241, 0.3)',
                      borderRadius: '0.5rem'
                    }}>
                      <p style={{ margin: 0 }}>No hay variantes agregadas</p>
                      <p style={{ fontSize: '0.75rem', margin: '0.5rem 0 0 0' }}>
                        Agrega variantes para gestionar diferentes tamaños, colores u otras variaciones
                      </p>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                      {formData.variants.map((variant, index) => (
                        <div key={index} style={{
                          padding: '1rem',
                          backgroundColor: 'rgba(15,23,42,0.8)',
                          borderRadius: '0.5rem',
                          border: '1px solid rgba(51,65,85,0.6)'
                        }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                            <span style={{ color: '#e2e8f0', fontWeight: 500 }}>Variante {index + 1}</span>
                            <div style={{ display: 'flex', gap: '0.5rem' }}>
                              <button
                                type="button"
                                onClick={() => duplicateVariant(index)}
                                style={{
                                  padding: '0.25rem 0.625rem',
                                  backgroundColor: 'rgba(99,102,241,0.15)',
                                  border: '1px solid rgba(99,102,241,0.35)',
                                  color: '#818cf8',
                                  borderRadius: '0.375rem',
                                  cursor: 'pointer',
                                  fontSize: '0.75rem',
                                  fontWeight: 500,
                                }}
                              >
                                Duplicar
                              </button>
                              <button
                                type="button"
                                onClick={() => removeVariant(index)}
                                style={{
                                  padding: '0.25rem 0.5rem',
                                  backgroundColor: 'rgba(239, 68, 68, 0.2)',
                                  border: '1px solid rgba(239, 68, 68, 0.3)',
                                  color: '#f87171',
                                  borderRadius: '0.375rem',
                                  cursor: 'pointer',
                                  fontSize: '0.75rem'
                                }}
                              >
                                Eliminar
                              </button>
                            </div>
                          </div>
                          {/* Fila 1: Nombre + Stock */}
                          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '0.75rem', marginBottom: '0.75rem' }}>
                            <div>
                              <label style={{ display: 'block', fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.375rem', fontWeight: 500 }}>Nombre *</label>
                              <input
                                type="text"
                                value={variant.name}
                                onChange={(e) => updateVariant(index, 'name', e.target.value)}
                                style={{
                                  width: '100%',
                                  padding: '0.5rem',
                                  backgroundColor: 'rgba(15,23,42,0.8)',
                                  border: '1px solid rgba(51,65,85,0.6)',
                                  borderRadius: '0.375rem',
                                  color: '#f1f5f9',
                                  outline: 'none',
                                  fontSize: '0.875rem',
                                  boxSizing: 'border-box'
                                }}
                                placeholder="Ej: Negro, 128GB"
                              />
                            </div>
                            <div>
                              <label style={{ display: 'block', fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.375rem', fontWeight: 500 }}>Stock</label>
                              <input
                                type="number"
                                min="0"
                                value={variant.stock_quantity}
                                onChange={(e) => updateVariant(index, 'stock_quantity', parseInt(e.target.value) || 0)}
                                style={{
                                  width: '100%',
                                  padding: '0.5rem',
                                  backgroundColor: 'rgba(15,23,42,0.8)',
                                  border: '1px solid rgba(51,65,85,0.6)',
                                  borderRadius: '0.375rem',
                                  color: '#f1f5f9',
                                  outline: 'none',
                                  fontSize: '0.875rem',
                                  boxSizing: 'border-box'
                                }}
                              />
                            </div>
                          </div>

                          {/* Fila 1b: Costos independientes */}
                          {(() => {
                            const rate = variant.exchange_rate_used || exchangeRates['USD-ARS'] || 1
                            const hasUsdCost = (variant.cost_price_usd || 0) > 0
                            const warnCost = variant.cost_price === 0 && !hasUsdCost
                            return (
                              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginBottom: '0.75rem' }}>
                                {/* Costo USD — se ingresa primero */}
                                <div>
                                  <label style={{ display: 'block', fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.375rem', fontWeight: 500 }}>
                                    Costo (USD)
                                  </label>
                                  <input
                                    type="number"
                                    step="0.01"
                                    min="0"
                                    value={variant.cost_price_usd || 0}
                                    onChange={(e) => updateVariant(index, 'cost_price_usd', parseFloat(e.target.value) || 0)}
                                    style={{
                                      width: '100%',
                                      padding: '0.5rem',
                                      backgroundColor: 'rgba(15,23,42,0.8)',
                                      border: '1px solid rgba(79,70,229,0.3)',
                                      borderRadius: '0.375rem',
                                      color: '#a5b4fc',
                                      outline: 'none',
                                      fontSize: '0.875rem',
                                      boxSizing: 'border-box'
                                    }}
                                    placeholder="0.00"
                                  />
                                </div>
                                {/* Costo ARS — calculado automáticamente desde USD */}
                                <div>
                                  <label style={{ display: 'block', fontSize: '0.75rem', color: warnCost ? '#f59e0b' : hasUsdCost ? '#34d399' : '#94a3b8', marginBottom: '0.375rem', fontWeight: 500 }}>
                                    Costo (ARS){hasUsdCost ? ` · TC $${Math.round(rate).toLocaleString('es-AR')}` : ''}{warnCost ? ' ⚠' : ''}
                                  </label>
                                  <input
                                    type="number"
                                    step="1"
                                    min="0"
                                    value={variant.cost_price || 0}
                                    onChange={(e) => updateVariant(index, 'cost_price', parseFloat(e.target.value) || 0)}
                                    readOnly={hasUsdCost}
                                    style={{
                                      width: '100%',
                                      padding: '0.5rem',
                                      backgroundColor: hasUsdCost ? 'rgba(52,211,153,0.07)' : warnCost ? 'rgba(245,158,11,0.08)' : 'rgba(15,23,42,0.8)',
                                      border: `1px solid ${hasUsdCost ? 'rgba(52,211,153,0.35)' : warnCost ? 'rgba(245,158,11,0.6)' : 'rgba(51,65,85,0.6)'}`,
                                      borderRadius: '0.375rem',
                                      color: hasUsdCost ? '#34d399' : '#f1f5f9',
                                      outline: 'none',
                                      fontSize: '0.875rem',
                                      boxSizing: 'border-box',
                                      cursor: hasUsdCost ? 'default' : 'auto',
                                    }}
                                    placeholder="0"
                                  />
                                  {warnCost && (
                                    <p style={{ margin: '0.25rem 0 0', fontSize: '0.7rem', color: '#f59e0b' }}>
                                      Sin costo — no aportará al capital invertido
                                    </p>
                                  )}
                                  {hasUsdCost && (
                                    <p style={{ margin: '0.25rem 0 0', fontSize: '0.7rem', color: '#34d399' }}>
                                      Calculado automáticamente desde USD
                                    </p>
                                  )}
                                </div>
                              </div>
                            )
                          })()}

                          {/* Fila 2: Moneda + Precio */}
                          <div style={{ display: 'flex', alignItems: 'flex-end', gap: '0.75rem', flexWrap: 'wrap' }}>
                            {/* Toggle ARS/USD */}
                            <div>
                              <label style={{ display: 'block', fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.375rem', fontWeight: 500 }}>Moneda</label>
                              <div style={{ display: 'flex', borderRadius: '0.375rem', overflow: 'hidden', border: '1px solid rgba(51,65,85,0.6)' }}>
                                {(['ARS', 'USD'] as const).map(cur => (
                                  <button
                                    key={cur}
                                    type="button"
                                    onClick={() => updateVariant(index, 'base_currency', cur)}
                                    style={{
                                      padding: '0.5rem 0.875rem',
                                      fontSize: '0.75rem',
                                      fontWeight: 600,
                                      border: 'none',
                                      cursor: 'pointer',
                                      backgroundColor: (variant.base_currency || 'ARS') === cur
                                        ? (cur === 'USD' ? '#4f46e5' : '#0f766e')
                                        : 'rgba(15,23,42,0.8)',
                                      color: (variant.base_currency || 'ARS') === cur ? '#fff' : '#94a3b8',
                                      transition: 'all 0.15s'
                                    }}
                                  >
                                    {cur}
                                  </button>
                                ))}
                              </div>
                            </div>

                            {(variant.base_currency || 'ARS') === 'USD' ? (
                              <>
                                {/* Precio en USD */}
                                <div>
                                  <label style={{ display: 'block', fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.375rem', fontWeight: 500 }}>Precio USD</label>
                                  <input
                                    type="number"
                                    step="0.01"
                                    min="0"
                                    value={variant.base_price || 0}
                                    onChange={(e) => updateVariant(index, 'base_price', parseFloat(e.target.value) || 0)}
                                    style={{
                                      width: '110px',
                                      padding: '0.5rem',
                                      backgroundColor: 'rgba(15,23,42,0.8)',
                                      border: '1px solid rgba(79,70,229,0.5)',
                                      borderRadius: '0.375rem',
                                      color: '#a5b4fc',
                                      outline: 'none',
                                      fontSize: '0.875rem',
                                      boxSizing: 'border-box'
                                    }}
                                    placeholder="0.00"
                                  />
                                </div>

                                {/* TC */}
                                <div>
                                  <label style={{ display: 'block', fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.375rem', fontWeight: 500 }}>T.C. (ARS)</label>
                                  <input
                                    type="number"
                                    step="1"
                                    min="1"
                                    value={variant.exchange_rate_used || exchangeRates['USD-ARS'] || 1}
                                    onChange={(e) => updateVariant(index, 'exchange_rate_used', parseFloat(e.target.value) || 1)}
                                    style={{
                                      width: '110px',
                                      padding: '0.5rem',
                                      backgroundColor: 'rgba(15,23,42,0.8)',
                                      border: '1px solid rgba(51,65,85,0.6)',
                                      borderRadius: '0.375rem',
                                      color: '#f1f5f9',
                                      outline: 'none',
                                      fontSize: '0.875rem',
                                      boxSizing: 'border-box'
                                    }}
                                  />
                                </div>

                                {/* Precio calculado en ARS (readonly) */}
                                <div>
                                  <label style={{ display: 'block', fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.375rem', fontWeight: 500 }}>Precio ARS</label>
                                  <div style={{
                                    padding: '0.5rem 0.75rem',
                                    backgroundColor: 'rgba(15,23,42,0.4)',
                                    border: '1px solid rgba(16,185,129,0.3)',
                                    borderRadius: '0.375rem',
                                    color: '#6ee7b7',
                                    fontSize: '0.875rem',
                                    fontWeight: 600,
                                    minWidth: '110px',
                                    whiteSpace: 'nowrap'
                                  }}>
                                    {formatARS(variant.sale_price || 0)}
                                  </div>
                                </div>

                                {/* Auto-actualizar */}
                                <div style={{ paddingBottom: '0.125rem' }}>
                                  <label style={{ display: 'block', fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.375rem', fontWeight: 500 }}>Auto-actualizar</label>
                                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                                    <input
                                      type="checkbox"
                                      checked={variant.auto_update_price ?? true}
                                      onChange={(e) => updateVariant(index, 'auto_update_price', e.target.checked)}
                                      style={{ width: '16px', height: '16px', accentColor: '#6366f1', cursor: 'pointer' }}
                                    />
                                    <span style={{ fontSize: '0.75rem', color: (variant.auto_update_price ?? true) ? '#a5b4fc' : '#64748b' }}>
                                      {(variant.auto_update_price ?? true) ? 'Activo' : 'Manual'}
                                    </span>
                                  </label>
                                </div>
                              </>
                            ) : (
                              /* Precio directo en ARS */
                              <div>
                                <label style={{ display: 'block', fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.375rem', fontWeight: 500 }}>Precio Venta (ARS)</label>
                                <input
                                  type="number"
                                  step="0.01"
                                  min="0"
                                  value={variant.sale_price || 0}
                                  onChange={(e) => updateVariant(index, 'sale_price', parseFloat(e.target.value) || 0)}
                                  style={{
                                    width: '150px',
                                    padding: '0.5rem',
                                    backgroundColor: 'rgba(15,23,42,0.8)',
                                    border: '1px solid rgba(51,65,85,0.6)',
                                    borderRadius: '0.375rem',
                                    color: '#f1f5f9',
                                    outline: 'none',
                                    fontSize: '0.875rem',
                                    boxSizing: 'border-box'
                                  }}
                                  placeholder="0.00"
                                />
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Multicurrency Section */}
              <div style={{ 
                marginBottom: '1.5rem', 
                padding: '1.5rem', 
                backgroundColor: 'rgba(79, 70, 229, 0.05)', 
                borderRadius: '0.75rem',
                border: '1px solid rgba(79, 70, 229, 0.15)'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1.5rem' }}>
                  <DollarSign size={20} style={{ color: '#6366f1' }} />
                  <h4 style={{ color: '#ffffff', margin: 0, fontSize: '1rem', fontWeight: 600 }}>Configuración de Moneda</h4>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.875rem', color: '#94a3b8', marginBottom: '0.5rem', fontWeight: 500 }}>Moneda Base</label>
                    <select
                      value={formData.base_currency}
                      onChange={(e) => {
                        const newCurrency = e.target.value as 'ARS' | 'USD'
                        setFormData({ 
                          ...formData, 
                          base_currency: newCurrency,
                          base_price: newCurrency === 'USD' ? formData.sale_price : formData.base_price,
                          exchange_rate_used: exchangeRates['USD-ARS'] || 1
                        })
                      }}
                      style={{
                        width: '100%',
                        padding: '0.625rem 0.75rem',
                        backgroundColor: 'rgba(15,23,42,0.8)',
                        border: '1px solid rgba(51,65,85,0.6)',
                        borderRadius: '0.5rem',
                        color: '#f1f5f9',
                        outline: 'none',
                        fontSize: '0.875rem'
                      }}
                    >
                      <option value="ARS">Pesos Argentinos (ARS)</option>
                      <option value="USD">Dólares (USD)</option>
                    </select>
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.875rem', color: '#94a3b8', marginBottom: '0.5rem', fontWeight: 500 }}>
                      {formData.base_currency === 'USD' ? 'Precio en USD' : 'Precio en ARS'}
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={formData.base_price}
                      onChange={(e) => {
                        const newBasePrice = parseFloat(e.target.value) || 0
                        setFormData({ ...formData, base_price: newBasePrice })
                      }}
                      style={{
                        width: '100%',
                        padding: '0.625rem 0.75rem',
                        backgroundColor: 'rgba(15,23,42,0.8)',
                        border: '1px solid rgba(51,65,85,0.6)',
                        borderRadius: '0.5rem',
                        color: '#f1f5f9',
                        outline: 'none',
                        fontSize: '0.875rem'
                      }}
                    />
                  </div>
                </div>

                {formData.base_currency === 'USD' && (
                  <>
                    <div style={{ 
                      padding: '1rem', 
                      backgroundColor: 'rgba(16, 185, 129, 0.05)', 
                      borderRadius: '0.5rem',
                      border: '1px solid rgba(16, 185, 129, 0.1)',
                      marginBottom: '1rem'
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
                        <DollarSign size={16} style={{ color: '#10b981' }} />
                        <span style={{ color: '#10b981', fontSize: '0.875rem', fontWeight: 600 }}>Conversión USD → ARS</span>
                      </div>

                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
                        <div>
                          <label style={{ display: 'block', fontSize: '0.8125rem', color: '#94a3b8', marginBottom: '0.375rem', fontWeight: 500 }}>Cotización USD/ARS</label>
                          <input
                            type="number"
                            step="0.0001"
                            min="0"
                            value={formData.exchange_rate_used}
                            onChange={(e) => setFormData({ ...formData, exchange_rate_used: parseFloat(e.target.value) || 1 })}
                            style={{
                              width: '100%',
                              padding: '0.5rem 0.625rem',
                              backgroundColor: 'rgba(15,23,42,0.8)',
                              border: '1px solid rgba(51,65,85,0.6)',
                              borderRadius: '0.375rem',
                              color: '#f1f5f9',
                              outline: 'none',
                              fontSize: '0.875rem'
                            }}
                          />
                        </div>
                        <div>
                          <label style={{ display: 'block', fontSize: '0.8125rem', color: '#94a3b8', marginBottom: '0.375rem', fontWeight: 500 }}>Precio en Pesos (Calculado)</label>
                          <input
                            type="text"
                            readOnly
                            value={`$${calculatedPrice.toFixed(2)}`}
                            style={{
                              width: '100%',
                              padding: '0.5rem 0.625rem',
                              backgroundColor: '#0b1120',
                              border: '1px solid rgba(16, 185, 129, 0.3)',
                              borderRadius: '0.375rem',
                              color: '#10b981',
                              outline: 'none',
                              fontWeight: 600,
                              fontSize: '1rem'
                            }}
                          />
                        </div>
                      </div>

                      {calculatedPrice > 0 && (
                        <div style={{ 
                          padding: '0.75rem', 
                          backgroundColor: 'rgba(16, 185, 129, 0.1)', 
                          borderRadius: '0.375rem',
                          border: '1px solid rgba(16, 185, 129, 0.2)'
                        }}>
                          <p style={{ color: '#10b981', margin: 0, fontSize: '0.9375rem', fontWeight: 600, textAlign: 'center' }}>
                            USD ${formData.base_price.toFixed(2)} × {formData.exchange_rate_used.toFixed(4)} = $${calculatedPrice.toFixed(2)} ARS
                          </p>
                        </div>
                      )}
                    </div>

                    <div style={{ 
                      padding: '1rem', 
                      backgroundColor: 'rgba(245, 158, 11, 0.05)', 
                      borderRadius: '0.5rem',
                      border: '1px solid rgba(245, 158, 11, 0.1)',
                      marginBottom: '1rem'
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
                        <DollarSign size={16} style={{ color: '#f59e0b' }} />
                        <span style={{ color: '#f59e0b', fontSize: '0.875rem', fontWeight: 600 }}>Costo en USD</span>
                      </div>

                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
                        <div>
                          <label style={{ display: 'block', fontSize: '0.8125rem', color: '#94a3b8', marginBottom: '0.375rem', fontWeight: 500 }}>Costo en USD</label>
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            value={formData.cost_price_usd}
                            onChange={(e) => setFormData({ ...formData, cost_price_usd: parseFloat(e.target.value) || 0 })}
                            style={{
                              width: '100%',
                              padding: '0.5rem 0.625rem',
                              backgroundColor: 'rgba(15,23,42,0.8)',
                              border: '1px solid rgba(51,65,85,0.6)',
                              borderRadius: '0.375rem',
                              color: '#f1f5f9',
                              outline: 'none',
                              fontSize: '0.875rem'
                            }}
                          />
                        </div>
                        <div>
                          <label style={{ display: 'block', fontSize: '0.8125rem', color: '#94a3b8', marginBottom: '0.375rem', fontWeight: 500 }}>Costo en Pesos (Calculado)</label>
                          <input
                            type="text"
                            readOnly
                            value={`$${calculatedCostARS.toFixed(2)}`}
                            style={{
                              width: '100%',
                              padding: '0.5rem 0.625rem',
                              backgroundColor: '#0b1120',
                              border: '1px solid rgba(245, 158, 11, 0.3)',
                              borderRadius: '0.375rem',
                              color: '#f59e0b',
                              outline: 'none',
                              fontWeight: 600,
                              fontSize: '1rem'
                            }}
                          />
                        </div>
                      </div>

                      {calculatedCostARS > 0 && (
                        <div style={{ 
                          padding: '0.75rem', 
                          backgroundColor: 'rgba(245, 158, 11, 0.1)', 
                          borderRadius: '0.375rem',
                          border: '1px solid rgba(245, 158, 11, 0.2)'
                        }}>
                          <p style={{ color: '#f59e0b', margin: 0, fontSize: '0.9375rem', fontWeight: 600, textAlign: 'center' }}>
                            USD ${formData.cost_price_usd.toFixed(2)} × {formData.exchange_rate_used.toFixed(4)} = $${calculatedCostARS.toFixed(2)} ARS
                          </p>
                        </div>
                      )}
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <input
                        type="checkbox"
                        id="autoUpdatePrice"
                        checked={formData.auto_update_price}
                        onChange={(e) => setFormData({ ...formData, auto_update_price: e.target.checked })}
                        style={{
                          width: '16px',
                          height: '16px',
                          accentColor: '#6366f1'
                        }}
                      />
                      <label htmlFor="autoUpdatePrice" style={{ color: '#94a3b8', fontSize: '0.875rem', cursor: 'pointer' }}>
                        Actualizar precios automáticamente cuando cambie la cotización
                      </label>
                    </div>
                  </>
                )}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1.5rem' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.875rem', color: '#94a3b8', marginBottom: '0.5rem', fontWeight: 500 }}>
                    {formData.base_currency === 'USD' ? 'Precio de Costo (ARS) *' : 'Precio de Costo *'}
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={formData.cost_price}
                    onChange={(e) => handleCostPriceChange(parseFloat(e.target.value) || 0)}
                    style={{
                      width: '100%',
                      padding: '0.625rem 0.75rem',
                      backgroundColor: 'rgba(15,23,42,0.8)',
                      border: '1px solid rgba(51,65,85,0.6)',
                      borderRadius: '0.5rem',
                      color: '#f1f5f9',
                      outline: 'none'
                    }}
                    required
                  />
                  {userManuallyEditedCostPrice && formData.base_currency === 'USD' && (
                    <p style={{ fontSize: '0.75rem', color: '#f59e0b', marginTop: '0.25rem' }}>
                      Editado manualmente - no se actualizará automáticamente
                    </p>
                  )}
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '0.875rem', color: '#94a3b8', marginBottom: '0.5rem', fontWeight: 500 }}>Precio de Venta (ARS) *</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={formData.sale_price}
                    onChange={(e) => handleSalePriceChange(parseFloat(e.target.value) || 0)}
                    style={{
                      width: '100%',
                      padding: '0.625rem 0.75rem',
                      backgroundColor: 'rgba(15,23,42,0.8)',
                      border: '1px solid rgba(51,65,85,0.6)',
                      borderRadius: '0.5rem',
                      color: '#f1f5f9',
                      outline: 'none'
                    }}
                    required
                  />
                  {userManuallyEditedSalePrice && formData.base_currency === 'USD' && (
                    <p style={{ fontSize: '0.75rem', color: '#f59e0b', marginTop: '0.25rem' }}>
                      Editado manualmente - no se actualizará automáticamente
                    </p>
                  )}
                </div>
              </div>

              {formData.cost_price > 0 && formData.sale_price > 0 && (
                <div style={{ 
                  marginBottom: '1.5rem', 
                  padding: '1rem', 
                  backgroundColor: 'rgba(79, 70, 229, 0.1)', 
                  borderRadius: '0.5rem',
                  border: '1px solid rgba(79, 70, 229, 0.2)'
                }}>
                  <p style={{ color: '#94a3b8', margin: '0 0 0.5rem 0', fontSize: '0.875rem' }}>
                    Análisis de rentabilidad {formData.base_currency === 'USD' ? '(en pesos)' : ''}:
                  </p>
                  <div style={{ display: 'flex', gap: '2rem' }}>
                    <div>
                      <span style={{ color: '#64748b', fontSize: '0.75rem' }}>Margen: </span>
                      <span style={{ color: '#34d399', fontWeight: 600 }}>
                        +${calcularRentabilidad(formData.cost_price, formData.sale_price).margen.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </span>
                    </div>
                    <div>
                      <span style={{ color: '#64748b', fontSize: '0.75rem' }}>Porcentaje: </span>
                      <span style={{ color: '#4f46e5', fontWeight: 600 }}>
                        {calcularRentabilidad(formData.cost_price, formData.sale_price).porcentaje.toFixed(1)}%
                      </span>
                    </div>
                  </div>
                  {formData.base_currency === 'USD' && (
                    <p style={{ color: '#64748b', margin: '0.5rem 0 0 0', fontSize: '0.75rem', fontStyle: 'italic' }}>
                      Costo: $${formData.cost_price.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ARS | Venta: $${formData.sale_price.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ARS
                    </p>
                  )}
                </div>
              )}

              <div style={{ display: 'flex', gap: '1rem', justifyContent: 'flex-end' }}>
                <button type="button" onClick={closeModal} style={{
                  padding: '0.625rem 1.25rem',
                  backgroundColor: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  color: '#94a3b8',
                  borderRadius: '0.5rem',
                  cursor: 'pointer',
                  fontWeight: 500
                }}>
                  Cancelar
                </button>
                <button type="submit" disabled={isSubmitting} style={{
                  padding: '0.625rem 1.25rem',
                  background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
                  border: 'none',
                  color: '#ffffff',
                  borderRadius: '0.625rem',
                  cursor: isSubmitting ? 'not-allowed' : 'pointer',
                  fontWeight: 600,
                  boxShadow: '0 4px 12px rgba(99,102,241,0.35)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem'
                }}>
                  {isSubmitting ? (
                    <><Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> Guardando...</>
                  ) : (
                    modalSubmitLabel
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal Importar Excel */}
      <ModalImportExcel
        isOpen={showImportModal}
        onClose={() => setShowImportModal(false)}
        onImport={handleImportInventory}
        title="Importar Inventario"
        requiredColumns={['Código/SKU', 'Nombre del producto']}
        downloadTemplate={handleDownloadTemplate}
      />
    </div>
  )
}
