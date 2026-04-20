// Servicio de notificaciones - Email
// En producción, esto debería usar un backend o serverless function
// Por ahora, usamos una simulación para demostración

interface NotificationPayload {
  to: string
  subject: string
  body: string
  orderId: string
  customerName: string
  status: string
}

export const notificationService = {
  // Simular envío de email (en producción usar SendGrid/AWS SES)
  async sendStatusChangeEmail(payload: NotificationPayload): Promise<boolean> {
    // Simulación - en producción esto llamaría a una API
    console.log('📧 Email enviado:', {
      to: payload.to,
      subject: payload.subject,
      body: payload.body
    })
    
    // Simular delay de red
    await new Promise(resolve => setTimeout(resolve, 1000))
    
    // En producción real:
    // const response = await fetch('/api/send-email', {
    //   method: 'POST',
    //   body: JSON.stringify(payload)
    // })
    // return response.ok
    
    return true
  },

  // Generar mensaje según estado
  generateStatusMessage(status: string, orderId: string, customerName: string): { subject: string; body: string } {
    const messages: Record<string, { subject: string; body: string }> = {
      'ready_delivery': {
        subject: `Tu orden #${orderId} está lista para retirar 🎉`,
        body: `Hola ${customerName},\n\nTu dispositivo ha sido reparado y está listo para retirar en nuestro taller.\n\nOrden: #${orderId}\nEstado: Listo para entregar\n\nDirección: Av. Corrientes 1234, CABA\nHorario: Lunes a Viernes 9:00-18:00\n\nGracias por confiar en TechRepair Pro.`
      },
      'completed': {
        subject: `Orden #${orderId} completada ✅`,
        body: `Hola ${customerName},\n\nTu orden #${orderId} ha sido completada exitosamente.\n\nGracias por elegir TechRepair Pro. Si tenés alguna consulta, no dudes en contactarnos.\n\nSaludos,\nEl equipo de TechRepair Pro`
      },
      'repair': {
        subject: `Tu orden #${orderId} está en reparación 🔧`,
        body: `Hola ${customerName},\n\nTu dispositivo está siendo reparado por nuestros técnicos especializados.\n\nOrden: #${orderId}\nEstado: En reparación\n\nTe notificaremos cuando esté listo.\n\nSaludos,\nEl equipo de TechRepair Pro`
      }
    }

    return messages[status] || {
      subject: `Actualización de tu orden #${orderId}`,
      body: `Hola ${customerName},\n\nTu orden #${orderId} ha cambiado de estado.\n\nNuevo estado: ${status}\n\nSaludos,\nEl equipo de TechRepair Pro`
    }
  }
}
