// Hook de la pantalla Mayorista.
//
// El acceso a Mayorista NO se decide acá: sale de `useWholesaleAccess` (autoridad
// central, PRE-BETA-3A-2). Portal Clic ya no vive acá: es una herramienta interna
// con su propia autoridad server-side (`useInternalToolAccess('portal_clic')`,
// PRE-BETA-3A-2S), que no depende de ser owner ni de wholesale_portal_enabled.

import { useWholesaleAccess, type WholesaleAccess } from './useWholesaleAccess'

export type WholesalePermissions = WholesaleAccess

export function useWholesalePermissions(): WholesalePermissions {
  return useWholesaleAccess()
}
