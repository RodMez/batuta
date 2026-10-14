# SPEC real-01: función de saludo

## Objetivo
Probar Batuta de extremo a extremo con un agente real sobre una tarea trivial.

## Requisitos
- R-1: crear `saludo.js` (CommonJS) que exporte la función `saludo(nombre)`, que devuelve la cadena `Hola, <nombre>!`.
- R-2: crear `saludo.test.js` con pruebas de `node:test` para `saludo`.

## Archivos permitidos
- `saludo.js`
- `saludo.test.js`

## Criterios de aceptación
- CA-1: las pruebas pasan | verificación: gate `pruebas` (`node --test`)

## Fuera de alcance
Cualquier otro archivo, dependencias o configuración.
