export interface BusinessSettings {
  logo_url?: string;
  nombre_empresa: string;
  direccion: string;
  telefono: string;
  email: string;
  cuit?: string;
  ticket_width?: 58 | 80; // 58mm o 80mm para ticket térmico
  mostrar_precios: boolean;
  mostrar_diagnostico: boolean;
  mostrar_firma: boolean;
  mostrar_qr: boolean;
}

export const defaultBusinessSettings: BusinessSettings = {
  nombre_empresa: 'TechRepair',
  direccion: 'Av. Principal 123',
  telefono: '+54 11 1234-5678',
  email: 'info@techrepair.com',
  cuit: '20-12345678-9',
  ticket_width: 58,
  mostrar_precios: true,
  mostrar_diagnostico: true,
  mostrar_firma: true,
  mostrar_qr: false
};

export const getBusinessSettings = (): BusinessSettings => {
  // En producción, esto vendría de Supabase
  // Por ahora usamos valores por defecto
  return defaultBusinessSettings;
};

export const updateBusinessSettings = (settings: Partial<BusinessSettings>): void => {
  // En producción, esto guardaría en Supabase
  console.log('Actualizando configuración del negocio:', settings);
};
