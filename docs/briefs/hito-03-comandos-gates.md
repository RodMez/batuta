# Hito 3: ejecutor de comandos y gates

Rama: `hito/03-comandos-gates` (créala desde `main` actualizada)

## Contexto

Lee `AGENTS.md`, las secciones 3.5, 8, 14 y 19 de `docs/diseno.md` (en especial la configuración del piloto de la sección 18) y los registros de decisiones 008 a 011. Este hito da a Batuta la capacidad de ejecutar comandos de verificación de forma segura y de evaluar los cambios de un agente, sin Git ni agentes todavía.

## Objetivo

En `@batuta/core`: un ejecutor de comandos con límites (timeout, salida y entorno), un ejecutor de gates que produce un informe estructurado y una política de diff como función pura.

## Ajustes previos del hito 2 (primer commit de la rama)

1. **Bloqueo obsoleto.** El `.lock` del registro hoy guarda solo el PID y exige borrarlo a mano, lo que choca con el objetivo de reanudar tras matar el proceso. Haz que guarde PID, equipo y hora. Al fallar la adquisición, si el bloqueo es del mismo equipo y el proceso ya no existe (usa una comprobación portable a Windows y Linux), se considera obsoleto: se recupera y se deja constancia en el registro. Si el proceso sigue vivo o el bloqueo es de otro equipo, falla con un mensaje claro. Prueba ambos casos.
2. **Limpieza menor.** En `leerTextoRegistro` la condición `completo ? ... : ...` devuelve lo mismo en las dos ramas. Simplifícala.
3. Registra la decisión.

## Qué debe existir

1. **Ejecutor de comandos**, detrás de una interfaz inyectable para que el motor lo simule en sus pruebas. Debe:
   - Ejecutar un comando en un directorio de trabajo dado y devolver código de salida, salida estándar, salida de error, duración y si venció el timeout.
   - Aplicar un **timeout** y, al vencer, terminar **todo el árbol de procesos**, no solo el proceso principal.
   - **Limitar la salida capturada** (límite configurable, con un valor por defecto razonable), conservando el principio y el final e indicando cuántos bytes se descartaron, para que la memoria no crezca sin control.
   - Lanzar el proceso con un **entorno limpio**: una lista de variables permitidas más las variables extra que se le pasen (`entorno_gates` de la configuración). Nada más del entorno del usuario debe llegar al comando.
   - Devolver un resultado claro, sin lanzar excepciones, cuando el comando o el directorio no existen.
2. **Ejecutor de gates**: dada una lista de gates de la configuración (nombre, comando y timeout) y un directorio, los ejecuta en orden y devuelve un **informe JSON** validado con un esquema Zod: por gate, nombre, comando, resultado, código de salida, duración, si venció el timeout y las colas de salida (truncadas). Por defecto se detiene en el primer fallo; que se pueda continuar tras un fallo debe ser una opción. Tipa también el payload del evento correspondiente al resultado de un gate.
3. **Política de diff** como función pura. Recibe los cambios (por archivo: ruta, líneas añadidas y eliminadas y el texto de las líneas añadidas) y una política (rutas prohibidas, archivos permitidos opcionales, máximo de líneas de diff y detección de secretos) y devuelve la lista de violaciones. Debe:
   - Aplicar las rutas prohibidas de la sección 18 con una semántica documentada (por ejemplo, una barra final indica un directorio y `*` es un comodín).
   - Normalizar las rutas de Windows (con `\`) antes de compararlas.
   - Detectar secretos con un conjunto pequeño de patrones (claves privadas, tokens con formato conocido, asignaciones de claves a valores literales). Es una heurística: documenta sus límites y cómo se evitan los falsos positivos.

## Restricciones

- Solo cambia `@batuta/core`. No hay Git real, motor, agentes ni CLI.
- Todo debe funcionar en Windows y en Linux.
- Los comandos de los gates los escribe el usuario en su configuración, así que son de confianza. Los comandos que genere un agente nunca se ejecutarán por este camino.
- La política de diff es pura: no lee disco ni Git.

## Pautas del planificador

- En versiones recientes de Node, lanzar un archivo `.cmd` (como `npm` en Windows) sin shell falla. Compruébalo y resuelve el caso (por ejemplo, con la librería que elijas o con un shell controlado solo para los gates de la configuración). Registra la decisión y por qué es segura.
- Terminar el árbol de procesos es distinto en Windows y en Linux. Elige un mecanismo para cada sistema y pruébalo con un proceso nieto que seguiría vivo si solo se matara al padre.
- Usa comandos de prueba escritos con `node -e` para que las pruebas no dependan del sistema operativo.
- Las pruebas de procesos reales deben ser rápidas (timeouts cortos) y no dejar procesos huérfanos.
- Puedes usar una librería para ejecutar procesos o para comparar rutas si la justificas en el registro de decisiones.

## Criterios de aceptación

| # | Criterio | Verificación |
|---|---|---|
| CA-1 | El ejecutor devuelve código de salida, salida estándar, salida de error y duración, tanto en éxito como en fallo | Pruebas |
| CA-2 | Un comando que supera el timeout se termina, se informa como vencido y no queda ningún proceso del árbol (incluido un nieto) | Pruebas, en ambos sistemas |
| CA-3 | Una salida mayor que el límite se trunca conservando principio y final, con el número de bytes descartados, sin que la memoria crezca sin control | Pruebas |
| CA-4 | Una variable de entorno fuera de la lista permitida no llega al comando, y las permitidas y las extras sí | Pruebas |
| CA-5 | Un comando inexistente o un directorio inexistente producen un resultado de error claro, sin excepción | Pruebas |
| CA-6 | Se puede ejecutar `npm --version` en Linux y en Windows | Prueba |
| CA-7 | El ejecutor de gates respeta el orden, se detiene en el primer fallo por defecto, y su informe valida contra el esquema Zod | Pruebas |
| CA-8 | La política de diff detecta una ruta prohibida del piloto, un archivo fuera de los permitidos, un diff demasiado grande y un secreto, y deja pasar un cambio válido. Funciona con rutas de Windows | Pruebas |
| CA-9 | El bloqueo obsoleto se recupera solo cuando el proceso ya no existe, y falla cuando sigue vivo | Pruebas |
| CA-10 | `npm run verify` pasa desde un clon limpio y el CI pasa en Linux y Windows | `npm run verify` y CI |
| CA-11 | El registro de decisiones está al día | Revisión |

## Fuera de alcance

Git y worktrees, agentes, motor de flujo, clasificación de riesgo de los comandos de los agentes, CLI y avisos.

## Entrega

Informe en el formato de `AGENTS.md`.
