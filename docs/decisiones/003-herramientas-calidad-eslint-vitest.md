# ADR 003: Herramientas de calidad (ESLint Flat Config y Vitest)

## Contexto
El proyecto exige validación estricta de estilo y tipos sin `any` explícito (`AGENTS.md`) y ejecución rápida de pruebas que no dependan de la red ni del reloj real en Windows y Linux.

## Opciones consideradas
1. **ESLint 9 con Flat Config (`typescript-eslint`) + Vitest**: Formato estándar actual de ESLint, configuración limpia y ejecución de pruebas en milisegundos con soporte nativo de módulos ES.
2. **Jest + ESLint legacy (.eslintrc)**: Jest requiere transformadores complejos (`ts-jest` o `babel`) para ESM y su soporte en Windows presenta lentitud comparado con Vitest.

## Decisión
Implementar **ESLint 9 Flat Config** con `typescript-eslint` prohibiendo `@typescript-eslint/no-explicit-any`, y **Vitest** como corredor de pruebas global para todos los paquetes.

## Consecuencias
- **Positivas**: Ejecución de la suite completa de pruebas en menos de 1 segundo; detección estricta de `any` no controlado; compatibilidad total con módulos ES.
- **Negativas**: Las pruebas deben redactarse respetando ESM nativo (importaciones con extensiones explícitas `.js` cuando se compila).
