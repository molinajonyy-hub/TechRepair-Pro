// ─────────────────────────────────────────────────────────────────────────────
// P0-A — Armado de los ítems del comprobante a partir de una orden.
//
// PROBLEMA QUE RESUELVE (P0 contable 2026-07-29):
// El COGS del modelo canónico existe SOLO como snapshot en
// `comprobante_items.costo_total` (v_finance_sales_ledger → v_finance_pnl).
// El armado anterior excluía del comprobante toda línea de repuesto con
// `cliente_paga_repuesto = false` — el 100 % de los repuestos productivos — así
// que el repuesto consumido no generaba ninguna línea y por lo tanto NINGÚN
// costo, mientras el ingreso se reconocía completo (el servicio se cotiza
// incluyendo el repuesto). Facturación − 0 = ganancia.
//
// DECISIONES CONTABLES APLICADAS (autorizadas por el dueño del producto):
//   · El COGS se reconoce en el MISMO evento y fecha económica que el ingreso:
//     la creación del comprobante. No en la fecha física del descuento de stock.
//   · Un repuesto consumido es COGS aunque `cliente_paga_repuesto = false`, no
//     tenga precio separado y esté incluido en el precio del servicio.
//   · `cliente_paga_repuesto` controla PRESENTACIÓN y PRECIO al cliente, nunca
//     el reconocimiento del costo.
//
// ESTRATEGIA "A" (plegado): el costo del repuesto absorbido se incorpora al
// `costo_total` de la línea de servicio correspondiente. NO se emite una línea
// interna de costo, porque `comprobante_items` no tiene forma de distinguir una
// línea interna y aparecería como un producto gratuito en el comprobante
// impreso, la factura fiscal, el PDF, WhatsApp y el portal del cliente.
//
// Trazabilidad por repuesto: se preserva en la ORDEN, que es la fuente
// inmutable del snapshot (`order_items` / `order_parts`), vinculada al
// comprobante por `comprobantes.order_id`. `absorbedParts` expone el desglose
// para auditoría y para el detector canónico de huecos.
//
// INVARIANTES QUE SOSTIENE ESTE MÓDULO:
//   1. `inventory_id` SIEMPRE ausente en las líneas derivadas de la orden. El
//      stock ya salió al agregar el repuesto (trigger adjust_stock_on_order_item).
//      Con `inventory_id` el checkout descontaría stock una SEGUNDA vez y además
//      resolvería el costo del inventario VIVO en lugar del snapshot histórico.
//   2. El ingreso al cliente no cambia: el predicado de facturación sigue siendo
//      `cliente_paga_repuesto !== false`, idéntico al anterior.
//   3. El costo se reconoce EXACTAMENTE UNA VEZ: un repuesto facturado aparte
//      lleva su costo en su propia línea; uno absorbido, plegado en el servicio.
//      Nunca en las dos.
// ─────────────────────────────────────────────────────────────────────────────

/** Ítem de trabajo de la orden (`order_items`) — fuente autoritativa. */
export interface OrderBillingItem {
  tipo: string
  descripcion: string
  cantidad: number
  precio_unitario: number
  /** Snapshot del costo unitario capturado al consumir. ARS. */
  costo_unitario: number
  cliente_paga_repuesto: boolean | null
  product_id?: string | null
}

/** Repuesto de `order_parts` (espejo financiero / repuestos sin vínculo a inventario). */
export interface OrderBillingPart {
  name: string
  quantity: number
  sale_price: number
  /** Snapshot del costo interno. ARS. */
  internal_cost: number
  cliente_paga_repuesto?: boolean | null
  status?: string | null
}

/** Línea lista para `initialItems` de ComprobanteProModal. */
export interface ComprobanteLineDraft {
  descripcion: string
  cantidad: number
  precio_unitario: number
  currency: 'ARS'
  tipo_linea: 'servicio' | 'repuesto'
  costo_unitario: number
}

export interface AbsorbedPartDetail {
  descripcion: string
  cantidad: number
  /** Costo total absorbido de este repuesto (snapshot × cantidad). ARS. */
  costoTotalArs: number
  origen: 'order_items' | 'order_parts'
}

export interface BuildOrderItemsResult {
  items: ComprobanteLineDraft[]
  /** Costo total de repuestos absorbidos que se plegó (o se intentó plegar). ARS. */
  absorbedCostArs: number
  /** Desglose por repuesto — trazabilidad para auditoría y Health Check. */
  absorbedParts: AbsorbedPartDetail[]
  /** Índice de `items` que recibió el costo absorbido; null si no había dónde plegarlo. */
  foldedIntoIndex: number | null
  /**
   * Costo consumido que NO pudo reconocerse porque la orden no tiene ninguna
   * línea facturable a la cual asociarlo. Sin evento de ingreso no hay evento
   * de reconocimiento (decisión contable 1). Lo expone el detector canónico.
   */
  unrecognizedCostArs: number
  /**
   * Residuo de redondeo del plegado, en ARS. `comprobante_items.costo_unitario`
   * es numeric(14,2) y el checkout deriva `costo_total = costo_unitario × cantidad`,
   * así que un costo absorbido no divisible por la cantidad de la línea destino
   * deja un residuo acotado por 0,005 × cantidad. Es 0 cuando la línea destino
   * tiene cantidad 1, que es el caso que este módulo prioriza.
   */
  roundingDeltaArs: number
}

/** Redondeo a centavos, estable frente a artefactos binarios (0.145 → 0.15). */
export function roundCents(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

/**
 * `cliente_paga_repuesto` decide únicamente si el repuesto se le factura aparte.
 * NULL se trata como facturable, igual que el default de la columna en la DB, y
 * exactamente igual que el armado anterior: el total cotizado no cambia.
 */
const esFacturable = (flag: boolean | null | undefined): boolean => flag !== false

/** Un repuesto de `order_parts` cuenta como consumido en los mismos estados que usa la UI de rentabilidad. */
const estaConsumido = (status: string | null | undefined): boolean =>
  status == null || status === 'used' || status === 'sold'

/**
 * Construye las líneas del comprobante de una orden reconociendo el costo de
 * TODO repuesto consumido, incluidos los absorbidos por el precio del servicio.
 *
 * @param orderItems `order_items` de la orden (fuente autoritativa de facturación).
 * @param orderParts `order_parts` de la orden (repuestos sin gemelo en order_items).
 */
export function buildOrderComprobanteItems(
  orderItems: OrderBillingItem[] | null | undefined,
  orderParts: OrderBillingPart[] | null | undefined,
): BuildOrderItemsResult {
  const items = orderItems ?? []
  const parts = orderParts ?? []

  const servicios = items.filter(i => i.tipo === 'servicio')
  const repuestos = items.filter(i => i.tipo === 'repuesto')

  // Nombres de repuestos ya representados en order_items: order_parts es su
  // espejo y no debe duplicar ni la línea ni el costo.
  const repuestosEnItems = new Set(repuestos.map(r => r.descripcion))

  const absorbedParts: AbsorbedPartDetail[] = []
  const lineas: ComprobanteLineDraft[] = []

  // ── 1. Servicios: siempre se facturan. Su costo_unitario es un costo interno
  //       directamente atribuible a la orden ⇒ costo directo del servicio.
  for (const s of servicios) {
    lineas.push({
      descripcion:     s.descripcion,
      cantidad:        s.cantidad,
      precio_unitario: s.precio_unitario,
      currency:        'ARS',
      tipo_linea:      'servicio',
      costo_unitario:  s.costo_unitario ?? 0,
    })
  }

  // ── 2. Repuestos de order_items ──────────────────────────────────────────
  for (const r of repuestos) {
    const costoTotal = roundCents((r.costo_unitario ?? 0) * r.cantidad)
    if (esFacturable(r.cliente_paga_repuesto)) {
      // Ingreso propio + costo propio, una sola vez. Sin inventory_id: el stock
      // ya salió al agregarlo a la orden (invariante 1).
      lineas.push({
        descripcion:     r.descripcion,
        cantidad:        r.cantidad,
        precio_unitario: r.precio_unitario,
        currency:        'ARS',
        tipo_linea:      'repuesto',
        costo_unitario:  r.costo_unitario ?? 0,
      })
    } else if (costoTotal > 0) {
      // Absorbido: sin ingreso propio, su costo se plega más abajo.
      absorbedParts.push({
        descripcion:  r.descripcion,
        cantidad:     r.cantidad,
        costoTotalArs: costoTotal,
        origen:       'order_items',
      })
    }
  }

  // ── 3. Repuestos que viven SOLO en order_parts ───────────────────────────
  for (const p of parts) {
    if (repuestosEnItems.has(p.name)) continue          // ya representado arriba
    if (!estaConsumido(p.status)) continue              // devuelto / no usado: no es COGS
    const costoTotal = roundCents((p.internal_cost ?? 0) * p.quantity)
    if (esFacturable(p.cliente_paga_repuesto) && p.sale_price > 0) {
      lineas.push({
        descripcion:     p.name,
        cantidad:        p.quantity,
        precio_unitario: p.sale_price,
        currency:        'ARS',
        tipo_linea:      'repuesto',
        costo_unitario:  p.internal_cost ?? 0,
      })
    } else if (costoTotal > 0) {
      absorbedParts.push({
        descripcion:  p.name,
        cantidad:     p.quantity,
        costoTotalArs: costoTotal,
        origen:       'order_parts',
      })
    }
  }

  const absorbedCostArs = roundCents(absorbedParts.reduce((s, a) => s + a.costoTotalArs, 0))

  if (absorbedCostArs <= 0) {
    return {
      items: lineas, absorbedCostArs: 0, absorbedParts, foldedIntoIndex: null,
      unrecognizedCostArs: 0, roundingDeltaArs: 0,
    }
  }

  // ── 4. Elegir la línea destino del plegado ───────────────────────────────
  // Preferencia determinista, pensada para que el residuo de redondeo sea 0:
  //   1º servicio con cantidad 1  → el costo total queda exacto
  //   2º primer servicio
  //   3º primera línea facturable (repuesto cobrado aparte)
  const idxServicioUnitario = lineas.findIndex(l => l.tipo_linea === 'servicio' && l.cantidad === 1)
  const idxServicio         = lineas.findIndex(l => l.tipo_linea === 'servicio')
  const target = idxServicioUnitario >= 0 ? idxServicioUnitario
               : idxServicio >= 0         ? idxServicio
               : lineas.length > 0        ? 0
               : -1

  if (target < 0) {
    // No hay ninguna línea facturable: la orden no genera evento de ingreso, así
    // que no hay evento al cual asociar el costo. Se reporta, no se inventa.
    return {
      items: lineas, absorbedCostArs, absorbedParts, foldedIntoIndex: null,
      unrecognizedCostArs: absorbedCostArs, roundingDeltaArs: 0,
    }
  }

  const destino    = lineas[target]
  const costoPropio = roundCents(destino.costo_unitario * destino.cantidad)
  const costoObjetivo = roundCents(costoPropio + absorbedCostArs)
  const nuevoUnitario = roundCents(costoObjetivo / destino.cantidad)
  lineas[target] = { ...destino, costo_unitario: nuevoUnitario }

  return {
    items: lineas,
    absorbedCostArs,
    absorbedParts,
    foldedIntoIndex: target,
    unrecognizedCostArs: 0,
    roundingDeltaArs: roundCents(costoObjetivo - roundCents(nuevoUnitario * destino.cantidad)),
  }
}
