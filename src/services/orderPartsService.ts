import { inventoryService } from './inventoryService';

export interface OrderPart {
  id: string;
  order_id: string;
  inventory_item_id?: string;
  description: string;
  quantity: number;
  unit_price?: number;
  subtotal?: number;
  created_at: string;
}

/**
 * Servicio para manejar partes/repuestos en órdenes de servicio
 */
export const orderPartsService = {
  /**
   * Agregar repuesto a orden y descontar stock
   */
  async addPartToOrder(
    orderId: string,
    inventoryItemId: string,
    quantity: number,
    _description: string,
    _unitPrice?: number,
    businessId?: string,
    userId?: string
  ): Promise<void> {
    if (quantity <= 0) {
      throw new Error('La cantidad debe ser mayor a 0');
    }

    // Verificar disponibilidad
    const available = await inventoryService.checkAvailability(inventoryItemId, quantity, businessId || '');
    if (!available) {
      throw new Error('Stock insuficiente para este repuesto');
    }

    // Descontar stock
    await inventoryService.decreaseStockFromOrder(
      inventoryItemId,
      quantity,
      orderId,
      businessId || '',
      userId || ''
    );

    // Aquí se agregaría la lógica para guardar el repuesto en la tabla order_parts
    // (depende de la estructura actual de la base de datos)
  },

  /**
   * Eliminar repuesto de orden y restaurar stock
   */
  async removePartFromOrder(
    orderId: string,
    inventoryItemId: string,
    quantity: number,
    businessId?: string,
    userId?: string
  ): Promise<void> {
    if (quantity <= 0) {
      throw new Error('La cantidad debe ser mayor a 0');
    }

    // Restaurar stock
    await inventoryService.restoreStockFromOrderRemoval(
      inventoryItemId,
      quantity,
      orderId,
      businessId || '',
      userId || ''
    );

    // Aquí se agregaría la lógica para eliminar el repuesto de la tabla order_parts
  },

  /**
   * Actualizar cantidad de repuesto en orden
   */
  async updatePartQuantity(
    orderId: string,
    inventoryItemId: string,
    oldQuantity: number,
    newQuantity: number,
    businessId?: string,
    userId?: string
  ): Promise<void> {
    const difference = newQuantity - oldQuantity;

    if (difference === 0) {
      return; // No hay cambio
    }

    if (difference > 0) {
      // Aumentar cantidad descontando stock adicional
      await inventoryService.decreaseStockFromOrder(
        inventoryItemId,
        difference,
        orderId,
        businessId || '',
        userId || ''
      );
    } else {
      // Disminuir cantidad restaurando stock
      await inventoryService.restoreStockFromOrderRemoval(
        inventoryItemId,
        Math.abs(difference),
        orderId,
        businessId || '',
        userId || ''
      );
    }
  },

  /**
   * Verificar disponibilidad de repuestos para orden
   */
  async checkPartsAvailability(
    parts: Array<{ inventory_item_id: string; quantity: number }>,
    businessId: string
  ): Promise<Record<string, boolean>> {
    const availability: Record<string, boolean> = {};

    for (const part of parts) {
      availability[part.inventory_item_id] = await inventoryService.checkAvailability(
        part.inventory_item_id,
        part.quantity,
        businessId
      );
    }

    return availability;
  },
};
