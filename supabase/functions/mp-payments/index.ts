/** MP POS API (including legacy manual transport and webhook) is POST-BETA.
 * Current manual POS uses comprobanteService; SaaS Billing uses mp-subscription/mp-webhook.
 */
import { mpPosBetaDisabled } from '../_shared/mpPosBetaDisabled.ts'

Deno.serve(mpPosBetaDisabled)
