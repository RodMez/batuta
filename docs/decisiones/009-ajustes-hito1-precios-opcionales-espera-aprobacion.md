# ADR 009: Ajustes del hito 1 (precios opcionales y espera de aprobación)

## Contexto
La revisión del hito 1 (diseño v0.12) pide dos ajustes antes del hito 2: los alias por defecto no deben llevar precios inventados y el estado necesita `AWAITING_APPROVAL` con su puerta pendiente.

## Opciones consideradas
1. **`entrada`/`salida` opcionales sin valores por defecto + `AWAITING_APPROVAL` con `puerta_pendiente` coherente**: Sin precios no hay costo calculable (el preflight lo advertirá en otro hito); la puerta pendiente solo existe en espera de aprobación y es `null` en el resto, validado con errores que indican la ruta.
2. **Precios a cero por defecto**: Confunde "gratis" con "desconocido" y falsea el informe de costo por rol.
3. **Puerta pendiente como texto libre**: Acepta erratas (`H9`) y estados incoherentes (puerta retenida fuera de la espera).

## Decisión
`entrada` y `salida` pasan a opcionales y los alias por defecto solo llevan `modelo` y `ventana`; se añade el estado `AWAITING_APPROVAL` y el campo `puerta_pendiente` (`H0|H1|H2|H3|null`, `null` por defecto), con refinamiento que exige puerta en la espera y `null` fuera de ella.

## Consecuencias
- **Positivas**: Ningún costo se calcula con datos inventados; el reductor del hito 2 puede representar la espera H0–H3 de la sección 4.
- **Negativas**: El cálculo de costo debe tolerar precios ausentes (pendiente del preflight).
