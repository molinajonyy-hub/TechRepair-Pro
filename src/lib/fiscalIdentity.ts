// API canónica para frontend/servicios. La implementación pura vive en
// functions/_shared para que el mismo módulo se empaquete en afip-cae sin
// duplicar parseo, CbteTipo ni semántica de FiscalIdentity.
export * from '../../supabase/functions/_shared/fiscalIdentity.ts'
