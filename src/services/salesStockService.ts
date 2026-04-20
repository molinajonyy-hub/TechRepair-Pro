import { inventoryService } from './inventoryService';

/**
 * Servicio para manejar stock en ventas/comprobantes
 */
export const salesStockService = {
  /**
   * Procesar venta de productos de inventario
   * @param items Array de items vendidos con inventory_item_id y cantidad
   * @param comprobanteId ID del comprobante de venta
   * @param businessId ID del negocio
   * @param userId ID del usuario
   */
  async processSale(
    items: Array<{ inventory_item_id: string; quantity: number }>,
    comprobanteId: string,
    businessId: string,
    userId: string
  ): Promise<void> {
    for (const item of items) {
      await inventoryService.decreaseStockFromSale(
        item.inventory_item_id,
        item.quantity,
        comprobanteId,
        businessId,
        userId
      );
    }
  },

  /**
   * Revertir venta (anulación de comprobante)
   * @param items Array de items vendidos con inventory_item_id y cantidad
   * @param comprobanteId ID del comprobante anulado
   * @param businessId ID del negocio
   * @param userId ID del usuario
   */
  async revertSale(
    items: Array<{ inventory_item_id: string; quantity: number }>,
    comprobanteId: string,
    businessId: string,
    userId: string
  ): Promise<void> {
    for (const item of items) {
      await inventoryService.restoreStockFromCancelledSale(
        item.inventory_item_id,
        item.quantity,
        comprobanteId,
        businessId,
        userId
      );
    }
  },

  /**
   * Procesar nota de crédito con devolución
   * @param items Array de items devueltos con inventory_item_id y cantidad
   * @param comprobanteId ID del comprobante de nota de crédito
   * @param businessId ID del negocio
   * @param userId ID del usuario
   */
  async processCreditNote(
    items: Array<{ inventory_item_id: string; quantity: number }>,
    comprobanteId: string,
    businessId: string,
    userId: string
  ): Promise<void> {
    for (const item of items) {
      await inventoryService.applyCreditNoteStock(
        item.inventory_item_id,
        item.quantity,
        comprobanteId,
        businessId,
        userId
      );
    }
  },

  /**
   * Verificar disponibilidad de stock para venta
   * @param items Array de items a verificar
   * @param businessId ID del negocio
   * @returns Objeto con disponibilidad por item
   */
  async checkSaleAvailability(
    items: Array<{ inventory_item_id: string; quantity: number }>,
    businessId: string
  ): Promise<Record<string, boolean>> {
    const availability: Record<string, boolean> = {};

    for (const item of items) {
      availability[item.inventory_item_id] = await inventoryService.checkAvailability(
        item.inventory_item_id,
        item.quantity,
        businessId
      );
    }

    return availability;
  },
};
