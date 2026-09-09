/**
 * Traducción de fallos a texto para el usuario, compartida por todas las
 * superficies de Tareas.
 *
 * Vive acá y no en la página para que los diálogos no tengan que importar desde
 * `pages/` (import circular) ni recrear su propia versión.
 */
import { isTaskServiceError } from '../../services/taskService'
import { isFeatureError, getFeatureErrorMessage } from '../../utils/requireFeature'

/** Genérico cuando el fallo no viene tipado desde el servicio. */
export const FALLBACK_ERROR = 'No pudimos guardar el cambio.'

export function toUserMessage(e: unknown, fallback: string = FALLBACK_ERROR): string {
  if (isTaskServiceError(e)) return e.message
  if (isFeatureError(e))     return getFeatureErrorMessage(e)
  return fallback
}
