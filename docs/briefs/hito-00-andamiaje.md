# Hito 0: andamiaje del monorepo

Rama: `hito/00-andamiaje`

## Contexto

Lee `AGENTS.md` y las secciones 16 y 19 de `docs/diseno.md`.

## Objetivo

Dejar la base técnica del proyecto: un monorepo TypeScript con un paquete de núcleo (`core`) y uno de CLI (`cli`), herramientas de calidad y CI en Linux y Windows, listo para que los siguientes hitos agreguen código sin rehacer la configuración.

## Restricciones

- TypeScript, con el núcleo y la CLI separados (la CLI es una capa delgada sobre el núcleo).
- Debe funcionar en Windows y en Linux.
- Los finales de línea del repositorio son LF, también al clonar en Windows.
- Todavía no hay lógica de Batuta. La CLI solo necesita mostrar su versión.

## Criterios de aceptación

| # | Criterio | Verificación |
|---|---|---|
| CA-1 | La instalación desde un clon limpio termina sin errores | `npm ci` (o el instalador que elijas, documentado en el README) |
| CA-2 | Existe un comando único que ejecuta lint, tipos, pruebas y build, y pasa | `npm run verify` |
| CA-3 | El binario compilado de la CLI muestra la versión | `node packages/cli/dist/index.js --version` (o la ruta equivalente que documentes) |
| CA-4 | Cada paquete tiene al menos una prueba y todas pasan | `npm test` |
| CA-5 | No hay finales de línea CRLF en el índice de Git | `git ls-files --eol` (ningún archivo con `i/crlf`) |
| CA-6 | El CI ejecuta los mismos pasos que CA-1 a CA-4 en Linux y en Windows | Lo comprueba el usuario al subir la rama. Indica en el informe que no pudiste verificarlo |
| CA-7 | Hay un README breve en español y un registro de decisiones con tus elecciones de herramientas y librerías | Revisión |

## Fuera de alcance

Cualquier lógica de Batuta (esquemas, configuración, eventos, Git, ejecución de comandos), Docker y publicación de paquetes.

## Entrega

Informe en el formato de `AGENTS.md`.
