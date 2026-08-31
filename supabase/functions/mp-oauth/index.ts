/** MP POS / Merchant Connect is POST-BETA. See docs/security-mp-pos-lote1-containment.md. */
import { mpPosBetaDisabled } from '../_shared/mpPosBetaDisabled.ts'

Deno.serve(mpPosBetaDisabled)
