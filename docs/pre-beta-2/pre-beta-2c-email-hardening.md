# PRE-BETA-2C — Resend / SMTP hardening + deliverability

**Fecha:** 2026-09-28 · **Estado:** **CLOSED** — BLK-2 **CLOSED FOR CONTROLLED BETA / deliverability
expansion pending** (§K). La expansión pendiente es **únicamente** medir un proveedor distinto de Gmail
y **no bloquea la beta controlada**.

Los únicos cambios en producción son los dos que aprobaba el lote, y los hizo el owner:

- rotación de la API key del SMTP (§D.4);
- alta QA del smoke de Gmail (§G.2).

El agente no escribió nada en Supabase, en Resend ni en el DNS.

| Dato | Valor |
|---|---|
| Base | `origin/main` = `bc7cb25fe8bd71c28c6ad82657442e0e0d14de37` (merge de #153). Verificado con `fetch` al inicio: **no avanzó**, así que no hay cambios nuevos de Auth, SMTP, Resend, plantillas, login/signup/recovery ni config que revisar. |
| Rama | `claude/pre-beta-2c-email-hardening` |
| Informe previo | `docs/pre-beta-2/pre-beta-2b-auth-production-inventory.md` (leído completo; no se repite) |
| Cambios de repo | sólo documentación (este informe + un link en el de 2B). No hizo falta código (§H). |

### Etiquetas

| Etiqueta | Significado |
|---|---|
| **CONFIRMADO EN RESEND** | leído por mí el 2026-09-28, sólo lectura, en el panel de Resend con la sesión del owner (Chrome) |
| **CONFIRMADO EN DASHBOARD** | valor del Dashboard de Supabase reportado por el owner en 2B y no releído (no hay `SUPABASE_ACCESS_TOKEN`) |
| **REPORTADO POR EL OWNER** | observado por el owner en su casilla o en los paneles durante las acciones manuales de 2C (2026-09-28) |
| **CONFIRMADO EN PROD** | medido read-only: agregados SQL sobre `auth.*`, logs de Auth y DNS público |
| **CONFIRMADO POR CÓDIGO / TEST** | `bc7cb25` |
| **FUENTE OFICIAL** | pricing y docs públicos de Resend, consultados el 2026-09-28 |

**Evidencia sin PII ni secretos.** De los correos sólo se registra fecha, estado, asunto y **dominio**
del destinatario, nunca la dirección. El token de la API key no se leyó ni se registró (ni siquiera el
prefijo que muestra el panel). No se leyeron ni se pidieron la password del SMTP ni secretos de OAuth.

---

## A. Estado del SMTP — premisas

| Premisa | Resultado | Etiqueta |
|---|---|---|
| Custom SMTP ON, `smtp.resend.com:465`, usuario `resend`, password configurada | se mantiene. Evidencia indirecta: Resend registra 5 envíos autenticados con la única key de la cuenta (§B.2, §D). **Después de 2C**, la password es la key nueva restringida (§D.4) y el smoke salió con ella. | CONFIRMADO EN DASHBOARD + EN RESEND |
| Sender `TechRepair Pro <no-reply@techrepairpro.app>` | se mantiene (§E) | CONFIRMADO EN DASHBOARD |
| Intervalo mínimo 60 s · rate limit 30 correos/h | sin cambios (§B.3) | CONFIRMADO EN DASHBOARD |
| Dominio `techrepairpro.app` **Verified** | `status verified`, `spf_status verified`, `dkim_status verified`; alta en Resend 2026-08-22; DNS en Vercel | CONFIRMADO EN RESEND |
| Región São Paulo | `region sa-east-1` | CONFIRMADO EN RESEND |
| Capacidad del dominio | `capability send`; recepción **no** habilitada (`inbound_mx_status not_started`) | CONFIRMADO EN RESEND |
| TLS de salida (Resend → MX del destinatario) | **Opportunistic** (dato nuevo). El tramo Supabase → Resend usa TLS implícito por el puerto 465 de todos modos. Se deja así: *Enforced* haría fallar la entrega a servidores sin TLS y Gmail/Outlook ya lo negocian. | CONFIRMADO EN RESEND |
| Tracking no configurado | ambos OFF (§C) | CONFIRMADO EN RESEND |
| Plan Transactional Free, 3.000/mes | Billing: *Transactional · 3,000 emails · $0/mo*; sin medio de pago cargado | CONFIRMADO EN RESEND |
| Entregas reales a Gmail | 4 *delivered* a `gmail.com` (§B.2) | CONFIRMADO EN RESEND |

---

## B. Cupo real de Resend

### B.1 Contrato vigente del plan Free

| Punto | Valor | Etiqueta |
|---|---|---|
| Plan | Transactional **Free**, $0/mes | CONFIRMADO EN RESEND |
| Límite mensual | **3.000** (panel: `0 / 3000`, envío 0, recepción 0) | CONFIRMADO EN RESEND + FUENTE OFICIAL |
| Límite diario | **100** (panel: `0 / 100`) | CONFIRMADO EN RESEND + FUENTE OFICIAL |
| Rate limit de API | 10 req/s por equipo, compartido por todas las keys. El SMTP usa el mismo límite y **cuenta para el cupo**. | CONFIRMADO EN RESEND (Usage) + FUENTE OFICIAL (docs SMTP) |
| Al superar el cupo | la API responde **429** `daily_quota_exceeded` / `monthly_quota_exceeded`; la acción documentada es subir de plan o esperar 24 h. Por SMTP Resend rechaza el mensaje; el código SMTP exacto **no está documentado y no se reprodujo** (no se agota el cupo a propósito). | FUENTE OFICIAL |
| Overage / pay-as-you-go | **No disponible en Free**: el panel lo marca *Paid feature* y no hay medio de pago. En los planes pagos existe ($0,90 cada 1.000) con tope de 5× la cuota mensual. | CONFIRMADO EN RESEND + FUENTE OFICIAL |
| Políticas de reputación | bounce < **4 %**, spam < **0,08 %**; un bounce sostenido > 4 % puede pausar el envío | FUENTE OFICIAL |
| Retención de correos | se ven envíos de hace 13 días; el pricing publica 30 días | CONFIRMADO EN RESEND + FUENTE OFICIAL |
| Marketing compartiendo la cuota | no aplica: Marketing es un plan aparte (por contactos) y está en `0 / 1000` contactos, sin broadcasts | CONFIRMADO EN RESEND |

### B.2 Uso observado (últimos 30 días)

**Resend — Emails (fuente de verdad del volumen). CONFIRMADO EN RESEND**

| Enviado (UTC) | Estado | Asunto | Dominio destino |
|---|---|---|---|
| 2026-09-15 14:24 | **bounced** (transitorio) | Reset Your Password | `techrepairpro.app` |
| 2026-09-15 14:36 | delivered | Reset Your Password | `gmail.com` |
| 2026-09-15 14:38 | delivered | Reset Your Password | `gmail.com` |
| 2026-09-15 14:49 | delivered | Reset Your Password | `gmail.com` |
| 2026-09-16 18:50 | delivered | Reset Your Password | `gmail.com` |

| Métrica | Valor |
|---|---|
| Correos en 30 días | **5**, todos de recovery. Ningún correo de alta en la ventana. |
| Ciclo mensual actual | **0 / 3.000** |
| Hoy | **0 / 100** |
| Máximo diario observado | **4** (2026-09-15) = **4 %** del cupo diario |
| Máximo horario observado | **4** (2026-09-15, 14:00–15:00 UTC) = 13 % del límite de 30/h de Supabase |
| Latencia interna de Resend (recibido → enviado) | 0,4–0,9 s. No es la latencia de punta a punta: esa se mide en §G. |
| Métricas (15 días) | 5 correos · deliverability **80 %** · **bounce rate 20 %** (1 transitorio, 0 permanentes) · quejas 0 % |
| Usos de la key del SMTP | **5 en total**: coinciden exactamente con estos 5 correos |

**Supabase — lado emisor. CONFIRMADO EN PROD (agregados, sin PII)**

| Fuente | Resultado |
|---|---|
| `auth.audit_log_entries` | **0 filas**: el audit log de GoTrue no se escribe en la DB, va al stream de logs (`auth_audit_logs`) |
| Logs de Auth (ventana disponible, ~24 h) | **0** requests a `/signup`, `/recover`, `/resend` u `/otp` |
| Altas en 30 días | 1 (vía Google) · **0 con proveedor email** |
| `confirmation_sent_at` (cota inferior: guarda sólo el último envío por usuario) | 5 en 2026-08 (último 2026-08-27), 3 en 2026-04, 0 en los últimos 30 días |
| Cuentas sin confirmar | **0** → hoy «reenviar confirmación» no dispara ningún correo |

**Lectura.** El tráfico de la ventana es compatible con pruebas internas de recovery, y no se atribuyó a
usuarios reales. **Todavía no hay volumen de beta medible.**

**Después de la medición:** el smoke de §G.2 sumó **1 correo** (2026-09-28 13:13 UTC, *delivered*,
`gmail.com`). Quedan 6 correos en la ventana, con un bounce: la tasa pasa al 17 %, que sigue siendo el
mismo rebote a `@techrepairpro.app` (§E). La decisión de capacidad no cambia.

### B.3 Decisión de capacidad

- **El cuello de botella es Resend, no Supabase.** 30/h permite hasta 720 correos/día; Resend corta a
  los **100/día**. Una ráfaga sostenida a 30/h agota el día en unas 3 h 20 min.
- **Se mantiene 30/h.** Bajarlo para que entre en 100/día (≈ 4/h) bloquearía ráfagas legítimas: una
  sesión de onboarding con 5 altas en una hora ya lo superaría. Además no protege el cupo diario mejor
  que la revisión de Usage. El rate limit de Supabase sigue cumpliendo su función: freno de ráfagas y
  anti-abuso.
- **¿Free alcanza para la beta controlada? Sí.** El pico observado es el 4 % del cupo diario y el mes
  va al 0,2 % (5 / 3.000). Margen: 96 correos/día.
- **Correos por alta (ESTIMADO, no medido):** 1 de confirmación + reenvíos (con cooldown de 60 s) +
  algún recovery ≈ **1 a 3 por usuario nuevo**.
- **Umbrales operativos**, expresados como porcentaje del cupo porque no hay volumen real para
  calibrarlos mejor:

| Nivel | Condición | Acción |
|---|---|---|
| Normal | < 50 % del diario y < 50 % del mensual | revisión semanal de Usage |
| **Vigilar** | algún día ≥ **50 %** (≥ 50 correos) o mes ≥ 50 % (≥ 1.500) | revisar Usage a diario; no programar tandas de onboarding sin mirar el cupo |
| **Pasar a Pro** antes de la próxima tanda | algún día ≥ **70 %** (≥ 70), mes ≥ 70 % (≥ 2.100), **cualquier** error de cupo, o una jornada planificada cuyo volumen esperado supere el 50 % del cupo diario (≈ **más de 15 altas el mismo día**, en el peor caso de 3 correos por alta) | upgrade (§I) |

---

## C. Tracking — OFF, confirmado

| Chequeo | Resultado | Etiqueta |
|---|---|---|
| Open tracking del dominio | `open_track: false` | CONFIRMADO EN RESEND (datos del dominio que carga el panel) |
| Click tracking del dominio | `click_track: false` | CONFIRMADO EN RESEND |
| Subdominio de tracking | ninguno (`clickTrackingDomain: null`); el panel ofrece «Enable tracking metrics → Configure» | CONFIRMADO EN RESEND |
| DNS | no hay CNAME de tracking: sólo `send.`, `resend._domainkey` y `_dmarc` | CONFIRMADO EN PROD |
| Semántica actual de Resend | tracking desactivado por defecto; **sólo está activo si el flag está ON *y* hay un subdominio de tracking verificado**; el click tracking reescribe cada link hacia ese subdominio | FUENTE OFICIAL |

**«Enable tracking metrics → Configure» significa efectivamente open OFF y click OFF.** No se habilitó
nada.

**Trampa registrada:** el asistente «New tracking subdomain» (al que lleva *Configure*) trae **«Enable
click tracking» marcado por defecto** (open viene desmarcado). Se abrió sólo para mirarlo y se salió
sin enviar. **Regla:** no configurar un subdominio de tracking para `techrepairpro.app`. Los correos de
Auth llevan links de un solo uso y el click tracking los redirigiría por Resend. Si alguna vez hiciera
falta tracking (por ejemplo, para marketing), va en un dominio de envío separado, nunca en el de Auth.

---

## D. API key del SMTP — rotada a privilegio mínimo y verificada

### D.1 Estado inicial (antes de la rotación) — CONFIRMADO EN RESEND

| Campo | Valor |
|---|---|
| Keys en la cuenta | **1** |
| Nombre | `Onboarding` |
| Permission | **Sending access** (`sending_access`) ✅ |
| Domain | **All domains** (`domain_id: null`) ❌ |
| Estado | active |
| Creada | 2026-04-25 18:03 UTC (anterior al alta del dominio, 2026-08-22) |
| Último uso | 2026-09-16 18:50 UTC |
| Usos totales | 5 |
| Token | no leído, no registrado |

**¿Es la que usa Supabase?** Sí, con alta confianza. Es la única key de la cuenta, y sus 5 usos
coinciden uno a uno con los 5 correos de Auth. Además, el repo no referencia Resend fuera del SMTP y
ninguna de las 19 edge functions desplegadas es de correo (la única de nombre ambiguo,
`submit-lead`, se revisó: notifica por Discord). **No tiene otros consumidores.**

**Evaluación.** El permiso ya es el mínimo. Falta la **restricción de dominio**. Hoy el riesgo práctico
es bajo, porque la cuenta tiene un solo dominio; pero si se agrega otro, esta credencial, guardada
fuera de nuestro control en Supabase, podría enviar como él. **No cumple** «Sending access restringida
a `techrepairpro.app`» → STOP para acción manual, **resuelto en §D.4**.

### D.2 Procedimiento de rotación — ejecutado por el owner (resultado en §D.4)

Hacerlo en una ventana sin altas reales (hoy el volumen es ~0). Entre el paso 8 y el 10, si la key
nueva fallara, las altas por email devolverían error.

1. **Resend → API Keys → Create API key.**
2. Nombre: `TechRepair Pro — Supabase Auth SMTP`.
3. Permission: **Sending access**.
4. Domain: **`techrepairpro.app`**.
5. Copiar el token **una sola vez** (Resend no lo vuelve a mostrar).
6. **Supabase → Authentication → Emails → SMTP Settings.**
7. Reemplazar **sólo** el campo *Password* con el token nuevo. No tocar host, puerto, usuario, sender
   ni intervalo.
8. Guardar.
9. **No** pegar el token en el chat, en logs, en documentación ni en la terminal.
10. **Verificar el envío** con el alta QA de §G.2 (sirve a la vez de smoke de Gmail):
    - Resend → Emails: el correo de confirmación aparece **delivered**;
    - Resend → API Keys: la key nueva muestra *Last used* = ahora y 1 uso; `Onboarding` sigue con
      último uso **2026-09-16** (prueba de que Supabase ya no la usa y de que nada más la usa).
11. Recién entonces: **Resend → API Keys → `Onboarding` → Delete/Revoke.**

**Nunca revocar `Onboarding` antes del paso 10.**

### D.3 Rollback de la rotación

El token viejo **no se puede recuperar**: Resend lo mostró una sola vez al crearlo, y el campo de
Supabase no se puede leer. Por eso, «volver atrás» no significa volver a pegar el token viejo:

- si la key nueva falla en el paso 10, no revocar nada; crear otra key (*Sending access*, y
  *All domains* sólo si la restricción de dominio fuera la causa), pegarla en el mismo campo y repetir
  el paso 10;
- si la causa fuera la restricción de dominio, documentarlo antes de aceptar *All domains*. El From es
  `no-reply@techrepairpro.app`, que coincide exactamente con el dominio restringido, así que no se
  espera ese fallo.

### D.4 Resultado de la rotación (2026-09-28)

| Chequeo | Resultado | Etiqueta |
|---|---|---|
| Keys en la cuenta | **1** | CONFIRMADO EN RESEND |
| Key nueva | `TechRepair Pro — Supabase Auth SMTP`, **active**, creada 2026-09-28 13:06:57 UTC | CONFIRMADO EN RESEND |
| Permission | **Sending access** (`sending_access`) ✅ | CONFIRMADO EN RESEND |
| Domain | **`techrepairpro.app`**: su `domain_id` coincide con el del dominio verificado ✅ | CONFIRMADO EN RESEND |
| Supabase la usa | *last used* 13:13:13.258 UTC = el `POST /emails` 200 de Resend Logs = el correo del smoke (§G.2) | CONFIRMADO EN RESEND |
| GoTrue recargó la config | reinicio de GoTrue a las 13:07:55 UTC (avisos de arranque en los logs de Auth), compatible con el guardado de SMTP Settings. Sin errores de SMTP en la ventana 12:30–14:30 UTC. | CONFIRMADO EN PROD |
| Key vieja `Onboarding` | **revocada**: ya no figura en la cuenta | CONFIRMADO EN RESEND + REPORTADO POR EL OWNER |
| Auth sigue enviando después de revocar | el owner reporta la prueba. Resend registra **un único envío** después de la rotación (13:13:13 UTC, con la key nueva) y no permite fechar la revocación. La conclusión no depende de esa hora: Supabase ya autentica con la key nueva, y la vieja no tenía otros consumidores (5 usos = los 5 correos de Auth, §D.1). | REPORTADO POR EL OWNER + CONFIRMADO EN RESEND |
| Token | nunca pasó por el chat, los logs, el repo ni la terminal | REPORTADO POR EL OWNER |

**Target cumplido:** credencial del SMTP con *Sending access*, restringida a `techrepairpro.app`.

---

## E. From y respuestas

- **Se mantiene** `TechRepair Pro <no-reply@techrepairpro.app>`. No se crea `mail.techrepairpro.app`
  ni se cambia DNS.
- **`no-reply@techrepairpro.app` no recibe correo**, y es intencional: la raíz no tiene MX (DNS
  público) y la recepción de Resend no está habilitada (`inbound_mx_status not_started`). Quien
  responda recibe un rebote de su propio proveedor.
- **Reply-To:** la configuración estándar de Custom SMTP de Supabase no tiene campo Reply-To (sender
  email, sender name, host, port, username, password e intervalo). **No se inventa ningún header.**
- **Decisión: sin Reply-To.** Requisito para **2D**: cada plantilla de Auth incluye una **línea de
  soporte visible**, como texto o `mailto:`, con el contacto canónico `CONTACTO_SOPORTE`
  (`src/config/contacto.ts`), el mismo de la política de privacidad, el pie de la landing y la ficha del
  Chrome Web Store. El owner confirma en 2D que esa casilla se monitorea. Las plantillas **no** se
  tocaron en 2C.
- **Hallazgo para 2D (P2, sin tocar):** `src/pages/SubscriptionSuspended.tsx:75` muestra
  `soporte@techrepairpro.com`. Ese dominio `.com` no es el del producto: resuelve a DNS de parking
  (NameBright) y no tiene MX, así que esa casilla no puede recibir, y no consta que el dominio sea
  nuestro. Unificarlo con `CONTACTO_SOPORTE`.
- **Hallazgo operativo:** hay **2 cuentas de Auth con email `@techrepairpro.app`**, un dominio que no
  recibe correo. Cualquier correo de Auth hacia ellas rebota: el único bounce de la ventana (§B.2) fue
  uno de esos casos y, con volumen chico, ya lleva el bounce rate al 20 %. No pedir recovery ni
  confirmaciones para esas cuentas. Si alguna necesita recibir correo, que el owner decida cambiarle
  el email; no se hace en 2C.

---

## F. SPF / DKIM / DMARC — DNS público (1.1.1.1 y 8.8.8.8, 2026-09-28) — CONFIRMADO EN PROD

| Registro | Valor | Estado en Resend |
|---|---|---|
| `send.techrepairpro.app` TXT (SPF del Return-Path) | `v=spf1 include:amazonses.com ~all` | `spf_status verified` |
| `send.techrepairpro.app` MX (feedback/bounces) | `10 feedback-smtp.sa-east-1.amazonses.com` | ídem |
| `resend._domainkey.techrepairpro.app` TXT | clave pública RSA (`p=MIGf…`) | `dkim_status verified` |
| `_dmarc.techrepairpro.app` TXT | `v=DMARC1; p=none` (sin `rua`, sin `sp`, sin `pct`) | — |
| raíz `techrepairpro.app` | **sin MX, sin TXT/SPF**; NS `ns1/ns2.vercel-dns.com` | — |

**Alineación DMARC (por diseño).** SPF: el MAIL FROM es `send.techrepairpro.app`, alineado en modo
relajado con el From `techrepairpro.app`. DKIM: firma con `d=techrepairpro.app`, alineación exacta.
Basta cualquiera de los dos para que DMARC dé PASS. La confirmación en headers reales queda para §G.

**No se crean registros:** coincide con 2B.

**DMARC:**

- `p=none` **se mantiene**. No se sube a `quarantine`/`reject` sin datos.
- **Sin `rua`:** no hay una casilla adecuada para reportes agregados (la de soporte es de personas, no
  de reportes automáticos).
- Endurecer DMARC se evalúa **después de varias semanas de tráfico real** con SPF/DKIM PASS
  observados en headers, idealmente con una casilla o un servicio de reportes. Ese mismo lote puede
  evaluar un `v=spf1 -all` en la raíz, que hoy no emite correo. Ambos son cambios de DNS y quedan fuera
  de 2C.

---

## G. Deliverability smoke

### G.1 Cobertura disponible

| Proveedor | Cuenta QA | Estado |
|---|---|---|
| Gmail | **sí** (del owner) | ✅ **PASS**: Recibidos, SPF/DKIM/DMARC PASS (§G.2). Antes: 4 *delivered* históricos (§B.2). |
| Outlook/Hotmail | **no** | no cubierto. Hay cuentas `hotmail.com` en prod, pero no consta que sean QA → no se usan. |
| Yahoo / iCloud | no | no cubierto |
| M365 con Safe Links | no | **diferido a 2E**, después de pasar recovery a `token_hash`. Hoy la plantilla de recovery es `{{ .ConfirmationURL }}` y un escáner la consume. |

Decisión del owner (2026-09-28): el smoke se hace con **alta de una cuenta QA nueva**. No hay cuentas
sin confirmar, así que «reenviar confirmación» no envía nada, y un recovery exigiría aceptar el riesgo
de la plantilla actual. **La cuenta la crea el owner**: el agente no crea cuentas en producción.

### G.2 Procedimiento y resultado — ejecutado por el owner (2026-09-28), después de D.2 paso 8

1. En `https://www.techrepairpro.app/login` → *Crear cuenta*, usar la Gmail QA con un alias
   identificable, por ejemplo `+prebeta2c` (Gmail lo entrega en la misma casilla, y así la cuenta queda
   marcada como QA para limpiarla después). Anotar la hora.
2. En Gmail, anotar: si llegó, **Recibidos o Spam**, hora de llegada, **From** visible y **asunto**.
3. **Sin hacer click**, pasar el mouse sobre el link y confirmar que apunta directo a
   `https://www.techrepairpro.app/auth/callback?token_hash=…&type=signup`, sin un dominio de tracking
   en el medio.
4. ⋮ → **Mostrar original**: anotar **sólo** `SPF: PASS/FAIL`, `DKIM: PASS/FAIL` y `DMARC: PASS/FAIL`
   (el resumen de arriba). No copiar el header completo.
5. Confirmar la cuenta haciendo click es opcional. Si se confirma, queda en onboarding sin negocio, que
   es lo esperado.
6. Seguir con D.2 paso 10 (Resend: delivered + *Last used* de la key nueva).

| Campo | Gmail | Etiqueta |
|---|---|---|
| Recibido | **sí** | REPORTADO POR EL OWNER; Resend: *delivered* a `gmail.com` (CONFIRMADO EN RESEND) |
| Bandeja / spam | **Recibidos** (no spam) | REPORTADO POR EL OWNER |
| Latencia (alta → llegada) | **~7 s** extremo a extremo. Tramos medidos: `POST /signup` 200 a las 13:13:10 UTC → Resend lo recibe 13:13:13.04 → lo entrega 13:13:13.96 | REPORTADO POR EL OWNER + CONFIRMADO EN PROD/RESEND |
| From visible | `TechRepair Pro <no-reply@techrepairpro.app>` | REPORTADO POR EL OWNER |
| Asunto | `Confirmá tu correo — TechRepair Pro` (coincide con el de Resend) | REPORTADO POR EL OWNER + CONFIRMADO EN RESEND |
| Link directo, sin tracking | `/auth/callback?token_hash=…&type=signup`: el contrato de §E de 2B, sin dominio de tracking | REPORTADO POR EL OWNER |
| Confirmación | `POST /verify` 200 a las 13:13:32 UTC; la cuenta QA quedó confirmada (única alta del día con proveedor email) | CONFIRMADO EN PROD |
| SPF | **PASS** | REPORTADO POR EL OWNER |
| DKIM | **PASS**, `d=techrepairpro.app` | REPORTADO POR EL OWNER |
| DMARC | **PASS** | REPORTADO POR EL OWNER |

**Gmail: PASS.** Confirma en un correo real la alineación de §F. Los headers completos no se copiaron,
por diseño.

---

## H. Error por cupo / rate limit — sin agotar nada

Validado con código, tests existentes y documentación oficial. **No** se lanzó ningún correo para
probar límites.

| Flujo | Rate limit de Supabase (429) | Falla de envío (cupo de Resend agotado → GoTrue 500) | ¿Revela si la cuenta existe? | Cobertura |
|---|---|---|---|---|
| Recovery (`Login` → olvidé mi contraseña) | mensaje neutro | mensaje neutro («si existe una cuenta… te enviamos instrucciones») | **no** | unit `passwordRecovery.test.ts:307`, componente `passwordRecovery.test.tsx:397` |
| Reenviar confirmación (`VerifyEmail`) | `RESEND_RATE_LIMITED`, sin texto crudo | `AUTH_ERROR` («No pudimos verificar el estado de tu cuenta…») | no | componente `emailVerification.test.tsx:341-351` |
| Reenviar desde `Login` | estado `limited` | vuelve a `idle` | no | — |
| **Alta** (`Login` → crear cuenta) | **muestra el texto crudo de GoTrue** (`Login.tsx:240`, fallback `err?.message`: «Email rate limit exceeded», en inglés) | mensaje propio «No pudimos enviar el email de confirmación…» (`Login.tsx:237`); el usuario no queda creado (medido en `scripts/e2e/ci-local.mjs`: sin mailer → 500, sin usuario) | no, por el texto | **ningún test** del mapeo de errores del registro |

**Conclusión.** No hay regresión nueva ni un P0: el texto crudo no contiene datos sensibles y ya estaba
anotado como deuda en 2B §J. Se deja como requisito de 2D: mapear el 429 del alta a un mensaje propio,
testear el mapeo de errores del registro y mejorar el copy de `AUTH_ERROR` cuando falla el reenvío.

**Impacto real de agotar el cupo diario de Resend:** el alta falla con un mensaje claro; el reenvío
muestra un error genérico; **el recovery falla en silencio**: la UI dice «te enviamos instrucciones» (a
propósito, para no revelar cuentas) y el correo no sale. Es el motivo principal de los umbrales de
§B.3.

---

## I. Free vs Pro — decisión

| Plan | Precio | Cupo | Tope diario | Overage |
|---|---|---|---|---|
| Transactional **Free** (actual) | $0 | 3.000/mes | **100/día** | no disponible |
| Transactional **Pro** | **$20/mes** | 50.000/mes | **sin tope diario** | $0,90 cada 1.000 (tope 5× cuota) |
| Transactional Pro (tramo 2) | $35/mes | 100.000/mes | sin tope | ídem |
| Scale | desde $90/mes | 100.000/mes | sin tope | ídem |

FUENTE OFICIAL (resend.com/pricing y docs de cuotas, 2026-09-28).

**Decisión: Free para la beta controlada.** Se cumplen las cuatro condiciones:

- el volumen medido tiene margen amplio (pico del 4 % del cupo diario);
- la beta es controlada;
- no hay marketing usando la cuota (Marketing en 0 contactos, sin broadcasts);
- queda definida una revisión frecuente de Usage (§J).

**Pro pasa a ser recomendado antes de abrir a más usuarios** si se cumple **cualquiera** de los
disparadores de §B.3: un día ≥ 70 % o un mes ≥ 70 %, cualquier error de cupo, o una jornada planificada
de más de ~15 altas. También si se decide eliminar por completo el riesgo del tope diario, que en Free
es duro.

**Costo/beneficio.** El beneficio real de Pro no es el volumen, sino **eliminar el tope diario**, que
es lo único que puede cortar altas y recovery. Para un producto que depende del correo para activar
cuentas, $20/mes es barato frente a una jornada de onboarding rota. Aun así, **hoy no hay datos que lo
justifiquen**, y no se compra nada automáticamente.

---

## J. Observabilidad operativa para la beta

**Frecuencia:** revisión semanal durante la beta controlada, más antes y después de cada tanda de
onboarding. Sin sistema nuevo de monitoreo.

**Resend**

| Dónde | Qué mirar |
|---|---|
| Settings → **Usage** | `Daily x / 100` y `Monthly x / 3000` contra los umbrales de §B.3 |
| **Emails** | filtrar por *bounced*, *complained*, *failed*, *suppressed*; la pestaña **Suppressions** está dentro de Emails |
| **Metrics** | bounce rate (< 4 %), complain rate (< 0,08 %), deliverability |
| **Domains** → `techrepairpro.app` | sigue **Verified** (SPF y DKIM); *Configuration* sin subdominio de tracking |
| **API keys** | una sola key de SMTP; *Last used* coherente con el tráfico. Una key nueva desconocida es una alarma. |
| **Logs** | requests con error |

**Supabase**

| Dónde | Qué mirar |
|---|---|
| Authentication → **Rate Limits** | correos: 30/h (sin cambios) |
| Authentication → Emails → **SMTP Settings** | sin cambios inesperados (host, sender, intervalo) |
| **Logs → Auth** | `status 500` en `/signup`, `/recover` y `/resend` (fallo de envío), `429` `over_email_send_rate_limit`, mensajes «Error sending … email». La retención es de ~1 día: revisar el mismo día del incidente. |

Consulta read-only que usé por MCP (logs unificados):
`select log_attributes['path'] path, log_attributes['status'] status, count(*) from logs where source = 'auth_logs' group by 1, 2`.

**Señales de alerta**

| Señal | Umbral | Acción |
|---|---|---|
| Acercamiento al cupo diario | ≥ 50 % en un día | §B.3 «Vigilar»; ≥ 70 % → Pro |
| Error de cupo (429 de Resend / SMTP rechazado) | cualquiera | Pro; avisar a quienes pidieron recovery ese día |
| Aumento de bounces | bounce rate > 4 %, o cualquier bounce **permanente** | revisar el destinatario (typo, cuenta `@techrepairpro.app` sin MX); ver Suppressions |
| Quejas de spam | > 0 | revisar contenido y destinatarios antes de seguir |
| Errores SMTP / signup o recovery con 500 | cualquiera | Logs → Auth; verificar la key (revocada, restringida) y el dominio |
| Dominio deja de estar Verified | cualquiera | revisar DNS en Vercel contra §F; no tocar nada más |

---

## K. Estado de BLK-2

| Condición de cierre | Estado |
|---|---|
| Custom SMTP operativo | ✅ 5 envíos aceptados por Resend; último 2026-09-16 |
| Dominio verificado en Resend | ✅ |
| SPF / DKIM / DMARC correctos | ✅ en DNS, en Resend y en un correo real (Gmail: PASS / PASS / PASS) |
| Tracking OFF | ✅ open y click OFF, sin subdominio; el link llegó directo |
| API key con privilegio mínimo | ✅ *Sending access* + `techrepairpro.app`; la vieja, revocada (§D.4) |
| Capacidad Free/Pro decidida | ✅ Free para la beta controlada, con disparadores de upgrade (§B.3, §I) |
| Gmail + otro proveedor | ✅ Gmail PASS; ⏳ **sin cuenta QA de un segundo proveedor** |
| Procedimiento operativo documentado | ✅ §J |

**BLK-2: CLOSED FOR CONTROLLED BETA / deliverability expansion pending.**

La expansión pendiente es **únicamente** medir la entrega en un proveedor distinto de Gmail
(Outlook/Hotmail, Yahoo o iCloud) cuando haya una cuenta QA. **No bloquea la beta controlada.** M365 con
Safe Links no forma parte de esta expansión: se mide en 2E, con recovery ya en `token_hash`.

No se marca `CLOSED` pleno sin ese segundo proveedor, para no declarar una cobertura que no se midió.

---

## L. Riesgos residuales

| # | Riesgo | Tratamiento |
|---|---|---|
| 1 | El tope diario de 100 en Free es duro (sin overage) y el recovery falla en silencio al superarlo | umbrales de §B.3 + revisión de Usage; Pro con cualquier disparador |
| 2 | Bounce rate del 17–20 % (1 de 6) por un correo a `@techrepairpro.app`, que no tiene MX; con volumen bajo, cada bounce pesa mucho frente al 4 % de Resend | no enviar correos de Auth a esas 2 cuentas; smokes sólo con casillas reales. Se diluye con tráfico real. |
| 3 | ~~La key del SMTP no está restringida al dominio~~ | **Cerrado** (§D.4) |
| 4 | Sólo Gmail medido; Outlook, Yahoo, iCloud y M365 sin medir | expansión pendiente (§K), no bloqueante; M365 en 2E |
| 5 | Recovery con `{{ .ConfirmationURL }}` consumible por escáneres (M365 Safe Links) | 2D + 2E (BLK-3) |
| 6 | DMARC `p=none` y raíz sin SPF: no hay enforcement contra la suplantación del dominio | evaluar tras semanas de tráfico (§F) |
| 7 | Texto crudo de GoTrue en el 429 del alta; `AUTH_ERROR` genérico en el reenvío | 2D |
| 8 | Contacto de soporte `@techrepairpro.com` en `SubscriptionSuspended` | 2D |
| 9 | Retención de logs de Auth de ~1 día y audit log fuera de la DB: el volumen histórico depende de Resend | revisar el mismo día; Resend retiene ≥ 13 días (el pricing publica 30) |
| 10 | Los links de Auth dependen de que nadie active tracking | regla de §C |

---

## M. Acciones manuales

**Realizadas por el owner (2026-09-28), las únicas escrituras en producción de 2C:**

1. Resend: alta de la key `TechRepair Pro — Supabase Auth SMTP` (*Sending access* +
   `techrepairpro.app`, 13:06:57 UTC).
2. Supabase → SMTP Settings: reemplazo sólo de la *Password* (GoTrue recargó a las 13:07:55 UTC).
3. Alta de 1 cuenta QA en Gmail por `www.techrepairpro.app` (13:13:10 UTC), confirmada por su link
   (13:13:32 UTC). Queda en onboarding sin negocio, como estaba previsto.
4. Resend: revocación de la key `Onboarding`.

**Del agente:** sólo lectura.

- SQL de sólo lectura con agregados sobre `auth.users`, `auth.identities`, `auth.audit_log_entries` y
  `auth.one_time_tokens`.
- Consultas a logs.
- DNS público.
- Panel de Resend en pestañas de Chrome del owner, cerradas al terminar.
- La pantalla del asistente de tracking se abrió **sin enviar**. En el navegador integrado de la app
  quedó una pestaña en el login de Resend, sin sesión y sin datos.

**Pendiente (no bloqueante):** conseguir una cuenta QA de otro proveedor (Outlook/Hotmail, Yahoo o
iCloud) y repetir §G.2 para cerrar la expansión de entregabilidad.

## N. Rollback

- **Repo:** sólo documentación → revertir el commit.
- **Rotación de la key (ya hecha):** `Onboarding` está revocada y su token no se recupera, así que no hay
  vuelta a la key vieja. Si la key nueva fallara o se comprometiera: crear otra key *Sending access* +
  `techrepairpro.app`, reemplazar sólo la *Password* del SMTP en Supabase, verificar con un envío y
  recién después revocar la anterior (§D.3).
- **Tracking:** nunca se tocó. Si alguien lo activara por error, desactivar open/click y borrar el
  subdominio de tracking.

## O. Gates — CONFIRMADO POR TEST (2026-09-28, corrida final sobre esta rama, con la evidencia del owner ya incorporada)

Cambio sólo de documentación → sin TypeScript, ESLint, build ni suites grandes: no hay código que
verificar. CI corre igual su pipeline completo sobre el PR.

| Gate | Resultado |
|---|---|
| `guard:no-hardcoded-credentials` + self-test (22 casos + control negativo por CLI) | OK / OK |
| `guard:auth-redirect` + self-test | OK / OK |
| `guard:onboarding-canonical` + self-test | OK / OK (12/12) |
| `guard:no-real-data` + self-test, **con el informe ya versionado** (el guard sólo escanea archivos trackeados) | OK (1694 archivos, 0 coincidencias) / OK (28/28) |
| Barrido del diff: tokens con forma de key de Resend (`re_…`) | 0 |
| Barrido del diff: direcciones de email | sólo el sender público `no-reply@techrepairpro.app` y el literal de código `soporte@techrepairpro.com` (§E); ningún destinatario |
| Formato | LF, sin mojibake; las referencias `archivo:línea` citadas se verificaron contra `bc7cb25` |
