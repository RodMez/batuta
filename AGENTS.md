# Reglas para el agente de codificación de Batuta

## Qué es este proyecto

Batuta es un orquestador de agentes de IA. `docs/diseno.md` es el diseño del proyecto. Está en la Fase 1 (MVP) y se construye por hitos (sección 19 del diseño). Se trabaja **un hito a la vez**, con su brief en `docs/briefs/`.

## Reparto de roles

- Claude planifica el proyecto: mantiene `docs/diseno.md`, la hoja de ruta, los hitos y sus criterios de aceptación.
- Tú decides cómo se implementa: estructura del código, patrones, librerías y detalles técnicos. Escribes el código, las pruebas y la documentación técnica.

## Tus límites

1. Las decisiones ya tomadas por el usuario (sección 20 del diseño) son restricciones. No las cambies sin consultarlo.
2. Cumple siempre los criterios de aceptación del hito.
3. Anota cada decisión técnica relevante en `docs/decisiones/NNN-titulo.md`: contexto, opciones, decisión y consecuencias, en pocas líneas.
4. Si crees que el diseño tiene un error o que hay una opción mejor, propónlo en el informe (sección "Propuestas de cambio al diseño"). Puedes seguir tu propuesta si no contradice una decisión tomada ni un criterio de aceptación, y la dejas registrada. No edites `docs/diseno.md`: el usuario se lo trasladará a Claude.
5. Trabaja dentro del alcance del hito. Lo demás va a la sección "Pendiente" del informe.

## Cómo trabajar

- Antes de codificar, lee el brief y las secciones del diseño que cite. Si te ayuda, escribe una spec corta del hito en `docs/specs/`.
- Trabaja en la rama `hito/NN-nombre`, con commits pequeños y Conventional Commits.
- No hagas push ni merge salvo que el usuario lo pida.
- Puedes agregar dependencias si las justificas en el registro de decisiones. Prefiere pocas y bien mantenidas.

## Recomendaciones técnicas iniciales

Puedes cambiarlas si lo justificas en el registro de decisiones.

- TypeScript estricto, módulos ES, Node 22 o superior y `npm workspaces`.
- Vitest para las pruebas y ESLint para el lint, sin `any` explícito.
- Los efectos (procesos, Git, archivos, reloj) detrás de interfaces para poder simularlos, y la lógica de estado como funciones puras.
- Rutas con `node:path`, comandos sin shell y finales de línea LF. Todo debe funcionar en Windows y en Linux.
- Las pruebas no usan la red, no dependen del reloj real ni de rutas absolutas, y pasan en ambos sistemas.

## Verificación

El proyecto debe tener siempre un comando único (`npm run verify`) que ejecute lint, tipos, pruebas y build. Un hito solo está terminado si ese comando pasa desde un clon limpio.

## Seguridad

- Nunca registres variables de entorno ni secretos. No leas ni imprimas archivos `.env`.
- No ejecutes comandos destructivos fuera del repositorio ni instales paquetes globales.

## Informe final

Entrega siempre un informe con estas secciones:

1. **Lo hecho por commit.**
2. **Resultados de verificación:** comando, resultado y tiempo.
3. **Decisiones que tomaste** y por qué.
4. **Propuestas de cambio al diseño y preguntas.**
5. **Pendiente o no verificado** (por ejemplo, el CI en Windows).
