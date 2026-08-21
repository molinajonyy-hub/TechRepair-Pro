/**
 * Contacto público de TechRepair Pro.
 *
 * Vive en el código y no en una variable de entorno a propósito: la política de
 * privacidad es un documento legal y su casilla de contacto no puede
 * desaparecer porque alguien no configuró una env en el deploy. El pie de la
 * landing sí puede seguir leyendo el entorno para poder pisarlo sin tocar
 * código, pero cae acá cuando no está seteado.
 *
 * Es también el email del publisher de la extensión en el Chrome Web Store, que
 * lo exige verificado y lo muestra públicamente en la ficha. Los tres usos —la
 * política, el pie, y la ficha del Store— tienen que decir lo mismo.
 */
export const CONTACTO_SOPORTE = 'techrepairpro.soporte@gmail.com'
