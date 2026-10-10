import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const paths = {
  service: 'src/services/productService.ts', form: 'src/components/products/ProductFormModal.tsx',
  selector: 'src/components/products/VariantSelector.tsx', inventory: 'src/pages/Inventory.tsx',
  search: 'src/services/productSearchService.ts', order: 'src/components/order/ModalAgregarItem.tsx',
  wholesale: 'src/portal/services/portalService.ts',
}
const sources = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, readFileSync(path, 'utf8')]))
function check(s) {
  const errors = []
  const demand = (ok, label) => { if (!ok) errors.push(label) }
  demand(/VARIANTS_V2_ENABLED = true/.test(s.form), 'variants UI hidden')
  demand(/const resolvedTipo = initialTipo \?\? 'product'/.test(s.form), 'variants context degraded')
  demand(/const tipo = draft.tipo/.test(s.form), 'variants draft degraded')
  demand(/groupingParent: true/.test(s.service) && /has_variants:\s*context.groupingParent/.test(s.service), 'parent not grouped at birth')
  demand(/parent_id:\s*parentId/.test(s.service) && /has_variants:\s*false/.test(s.service), 'child without parent link')
  demand(/inventory_item_id:\s*invData.id/.test(s.service), 'orphan variant metadata')
  const metadataInsert = s.service.slice(s.service.indexOf('// Crear registro en product_variants'), s.service.indexOf('if (varErr)'))
  demand(!/\bstock\s*:/.test(metadataInsert), 'legacy balance written as truth')
  demand(!/\b(?:v|variant)\.stock\b/.test(s.selector) && !/stock_quantity:\s*variant\.stock/.test(s.form), 'legacy stock read as authority')
  demand(/inventory\?\.stock_quantity/.test(s.selector), 'selector not reading inventory')
  demand(/inventory_id:\s*v.inventory_item_id/.test(s.service), 'stock applied to parent')
  demand(/idempotencyKey:\s*recovery.idempotencyKey/.test(s.service), 'retry changes key')
  const retryStart = s.service.indexOf('async retryVariantInitialStock')
  const retry = s.service.slice(retryStart, s.service.indexOf('\n  },', retryStart))
  demand(!/createProduct|createVariant|\.insert\(/.test(retry), 'retry recreates family')
  demand(/if \(submittingRef.current\) return/.test(s.form), 'double submit allowed')
  demand(/validateVariantInputs\(variants\)/.test(s.service) && /skus, 'SKU'/.test(s.service), 'duplicate SKU unchecked')
  demand(/\.not\('has_variants', 'is', true\)/.test(s.search), 'sellable search offers parent')
  demand(/const wantsStockChange = !isGroupingParent\(editItem\)/.test(s.form), 'parent stock adjustable')
  demand(/getVariantParentId.*productSellability/.test(s.inventory), 'inventory ignores canonical links')
  demand(/productDisplayName\(product\)/.test(s.order), 'order loses variant identity')
  demand(/\.not\('has_variants', 'is', true\)/.test(s.wholesale), 'wholesale offers parent')
  // Metadata payloads: neither inventory insert object can include a stock field.
  for (const key of ['baseRow', 'baseInvRow']) {
    const row = s.service.slice(s.service.indexOf(`const ${key} = {`), s.service.indexOf('\n    }', s.service.indexOf(`const ${key} = {`)))
    demand(!/\b(?:stock|stock_quantity)\s*:/.test(row), `${key} writes stock directly`)
  }
  return errors
}
assert.deepEqual(check(sources), [], 'PRODUCT-VARIANTS-1 contract')
if (process.argv.includes('--self-test')) {
  const mutations = [
    ['direct stock write', 'service', 'const baseInvRow = {', 'const baseInvRow = { stock_quantity: 5,'],
    ['sell parent', 'search', ".not('has_variants', 'is', true)", ''],
    ['debit parent', 'service', 'inventory_id: v.inventory_item_id', 'inventory_id: product.id'],
    ['duplicate retry stock', 'service', 'idempotencyKey: recovery.idempotencyKey', 'idempotencyKey: crypto.randomUUID()'],
    ['recreate on retry', 'service', 'async retryVariantInitialStock(recovery:', 'async retryVariantInitialStock(recovery:'],
    ['legacy stock authority', 'selector', 'variant.inventory?.stock_quantity', 'variant.stock'],
    ['orphan metadata', 'service', 'inventory_item_id:   invData.id', 'inventory_item_id:   null'],
    ['ungrouped parent', 'service', 'groupingParent: true', 'groupingParent: false'],
    ['unlinked child', 'service', 'parent_id:           parentId', 'parent_id:           null'],
    ['duplicate SKU', 'service', "skus, 'SKU'", "new Set(), 'code'"],
    ['hide variants', 'form', 'VARIANTS_V2_ENABLED = true', 'VARIANTS_V2_ENABLED = false'],
    ['double submit', 'form', 'if (submittingRef.current) return', ''],
    ['adjust parent', 'form', '!isGroupingParent(editItem)', 'true'],
    ['wholesale parent', 'wholesale', ".not('has_variants', 'is', true)", ''],
  ]
  for (const [label, key, from, to] of mutations) {
    const changed = label === 'recreate on retry'
      ? sources[key].replace('await applyInventoryStockAdjustments({ businessId: recovery.businessId', 'await productService.createVariant(); await applyInventoryStockAdjustments({ businessId: recovery.businessId')
      : sources[key].replace(from, to)
    assert.notEqual(changed, sources[key], `mutant missing: ${label}`)
    assert.ok(check({ ...sources, [key]: changed }).length, `mutant survived: ${label}`)
    console.log(`Detected: ${label}`)
  }
}
console.log('PRODUCT-VARIANTS-1: OK')
