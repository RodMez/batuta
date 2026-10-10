# Hito 4: Git y worktrees

Rama: `hito/04-git-worktrees` (créala desde `main` actualizada)

## Contexto

Lee `AGENTS.md`, las secciones 3.2, 3.5, 14 y 19 de `docs/diseno.md` y los registros de decisiones 012 a 015. Este hito da a Batuta el aislamiento de cada ejecución en su propio worktree de Git y la capacidad de volver a un punto bueno o descartarlo todo sin dejar rastro.

## Objetivo

En `@batuta/core`: un módulo de Git detrás de una interfaz inyectable, con una implementación real que usa el ejecutable `git`, para crear worktrees por ejecución, confirmar el trabajo por subtarea, listar los cambios en el formato que consume la política de diff, volver a un commit anterior y eliminar el worktree y su rama.

## Qué debe existir

1. **Comprobaciones previas.** Saber si un directorio es un repositorio Git, cuál es la rama actual, si el árbol de trabajo está limpio, si existe una referencia base y si la versión de Git es suficiente (documenta la versión mínima).
2. **Crear el worktree de una ejecución.** Rama `batuta/<run_id>` a partir de una referencia base indicada (por defecto, el `HEAD` actual; para el piloto hará falta partir de un commit concreto). Devuelve la ruta, la rama y el commit base. Por defecto el worktree se crea fuera del árbol del repositorio, en un directorio hermano, y la ubicación es configurable con `directorio_worktrees` en la configuración. Crear dos veces el mismo `run_id` falla con un mensaje claro.
3. **Confirmar una subtarea.** Prepara todos los cambios (incluidos los archivos nuevos) y crea un commit con una identidad propia de Batuta, sin modificar la configuración de Git del usuario. Devuelve el hash. Si no hay cambios, lo informa y no crea un commit vacío.
4. **Listar los cambios** respecto a un commit (o al commit base), en el formato que consume la política de diff del hito 3: ruta, líneas añadidas, líneas eliminadas y texto de las líneas añadidas. Debe cubrir archivos modificados, nuevos sin seguimiento, eliminados, renombrados, binarios, y rutas con espacios o acentos.
5. **Volver a un punto bueno.** Restaura el worktree a un commit dado: descarta las modificaciones y los archivos nuevos sin confirmar, pero conserva los archivos ignorados por Git (por ejemplo `node_modules` o `data/`).
6. **Eliminar el worktree y su rama**, de forma idempotente (una segunda llamada no falla).
7. **Listar los worktrees de Batuta**, y detectar los huérfanos (worktrees o ramas `batuta/*` sin ejecución asociada).

## Restricciones

- Solo cambia `@batuta/core`. No hay motor, agentes, CLI ni empuje al remoto (`push`) ni llamadas a la API de GitHub.
- Se usa el ejecutable `git` mediante el ejecutor de comandos del hito 3, sin librerías de Git.
- Las operaciones destructivas (volver a un commit, eliminar) **solo se ejecutan sobre un worktree creado por Batuta**. Si se apuntan al directorio del repositorio principal o a cualquier otro, se niegan.
- Nunca se modifica la rama principal ni su árbol de trabajo, ni la configuración global ni local de Git del usuario.
- Todo debe funcionar en Windows y en Linux.

## Pautas del planificador

- Indica siempre el directorio de trabajo de forma explícita; no dependas del directorio actual del proceso.
- Interpreta salidas pensadas para máquinas (formatos `porcelain` o terminados en nulo), nunca texto para humanos. Evita cualquier petición interactiva de Git.
- Pasa la identidad de los commits y cualquier otra opción con parámetros de la propia invocación, no con la configuración del usuario. No saltes los hooks de commit por defecto: si un hook falla, devuélvelo como fallo del commit.
- En Windows, eliminar un worktree puede fallar por archivos en uso. Reintenta con una espera breve y, si hace falta, recurre a borrar el directorio y limpiar los registros de worktrees.
- Las pruebas crean repositorios temporales con su propia identidad, la rama inicial indicada de forma explícita y la conversión de finales de línea desactivada, y no dejan residuos.
- Documenta el motivo de la ubicación por defecto del worktree: evita que las herramientas del proyecto (lint, pruebas) recorran copias duplicadas del código.

## Criterios de aceptación

| # | Criterio | Verificación |
|---|---|---|
| CA-1 | Las comprobaciones previas detectan un directorio que no es un repositorio, un árbol sucio y una referencia base inexistente, con resultados claros | Pruebas |
| CA-2 | Se crea el worktree desde una referencia base dada, con la ruta, la rama y el commit base correctos. Repetir el mismo `run_id` falla con un mensaje claro | Pruebas |
| CA-3 | Confirmar una subtarea crea un commit con la identidad de Batuta sin tocar la configuración de Git del usuario, y sin cambios no crea un commit | Pruebas |
| CA-4 | La lista de cambios cubre modificados, nuevos sin seguimiento, eliminados, renombrados, binarios y rutas con espacios o acentos, y alimenta a la política de diff en una prueba de extremo a extremo | Pruebas |
| CA-5 | Volver a un commit elimina modificaciones y archivos nuevos, pero conserva los archivos ignorados | Pruebas |
| CA-6 | Volver a un commit o eliminar sobre el repositorio principal, o sobre una ruta que no es un worktree de Batuta, se rechaza | Pruebas |
| CA-7 | Tras un fallo y tras un aborto, la rama principal queda idéntica: mismo `HEAD`, árbol limpio y sin ramas ni worktrees sobrantes. Eliminar es idempotente | Pruebas |
| CA-8 | Se listan los worktrees de Batuta y se detectan los huérfanos | Pruebas |
| CA-9 | `npm run verify` pasa desde un clon limpio y el CI pasa en Linux y en Windows | `npm run verify` y CI |
| CA-10 | El registro de decisiones está al día | Revisión |

## Fuera de alcance

Empuje al remoto, creación de PR, ejecución de los comandos de `preparacion`, motor de flujo, agentes, CLI y Docker.

## Entrega

Informe en el formato de `AGENTS.md`.
