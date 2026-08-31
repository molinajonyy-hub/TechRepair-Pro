/** Retired merchant integration panel. No active route mounts this component.
 * Keep the export inert so an accidental legacy mount cannot initiate requests.
 * Manual POS payments remain in ComprobanteProModal and comprobanteService.
 */
interface Props {
  comprobanteId: string;
  totalBruto: number;
  saldoPendiente: number;
  onPaymentRegistered?: () => void;
}

export function PaymentButtonsPanel(_props: Props) {
  return null;
}
