export const exchangeRateService = {
  /**
   * Obtener el precio del dólar blue desde la API de Bluelytics
   */
  async getAmbitoDolarRate(): Promise<number | null> {
    try {
      const response = await fetch('https://api.bluelytics.com.ar/v2/latest');
      
      if (!response.ok) {
        throw new Error('Error al obtener el tipo de cambio');
      }

      const data = await response.json();
      
      // Usar dólar blue directamente
      const blueRate = data.blue?.value_sell;
      
      if (blueRate) {
        return blueRate;
      }

      return null;
    } catch (error) {
      console.error('Error fetching exchange rate from API:', error);
      return null;
    }
  },

  /**
   * Obtener el precio del dólar blue desde múltiples fuentes (fallback)
   */
  async getDolarRate(): Promise<number | null> {
    // Primero intentar con Bluelytics (dólar blue)
    const rate = await this.getAmbitoDolarRate();
    if (rate) return rate;

    // Fallback: usar un valor por defecto si falla la API
    console.warn('Using fallback exchange rate');
    return 1000; // Valor por defecto
  },

  /**
   * Formatear fecha de actualización
   */
  formatLastUpdate(date: Date): string {
    return date.toLocaleString('es-AR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }
};
