# Reglas para el agente de codificación de Batuta

## Qué es este proyecto

Batuta es un orquestador de agentes de IA. `docs/diseno.md` es el diseño del proyecto. Está en la Fase 1 (MVP) y se construye por hitos (sección 19 del diseño). Se trabaja **un hito a la vez**, con su brief en `docs/briefs/`.

## Reparto de roles

- Claude planifica el proyecto y tiene la autoridad sobre su diseño mientras se construye Batuta: mantiene `docs/diseno.md`, la hoja de ruta, los hitos y sus criterios de aceptación. Puede darte pautas, consejos y órdenes concretas sobre el código (estructura, interfaces, nombres, patrones). Cuando el usuario te las traslade, cúmplelas.
- Tú implementas: escribes el código, las pruebas y la documentación técnica, y decides todo lo que el diseño y las pautas no especifican.
- Esto aplica solo a la construcción de Batuta. Cuando Batuta esté terminado y trabaje en otros proyectos, sus agentes tomarán sus propias decisiones de diseño.

## Tus límites

1. Lo que fija el diseño, las pautas del planificador y las decisiones del usuario (sección 20 del diseño) es obligatorio.
2. Cumple siempre los criterios de aceptación del hito.
3. Anota cada decisión técnica que tomes en `docs/decisiones/NNN-titulo.md`: contexto, opciones, decisión y consecuencias, en pocas líneas.
4. Si discrepas de una pauta, o crees que el diseño tiene un error o que hay una opción mejor, dilo en el informe (sección "Propuestas de cambio al diseño"). Mientras no se actualice el diseño, sigue lo que dice. No edites `docs/diseno.md`: el usuario se lo trasladará a Claude.
5. Trabaja dentro del alcance del hito. Lo demás va a la sección "Pendiente" del informe.

## Cómo trabajar

- Antes de codificar, lee el brief y las secciones del diseño que cite. Si te ayuda, escribe una spec corta del hito en `docs/specs/`.
- Trabaja en la rama `hito/NN-nombre`, con commits pequeños y Conventional Commits.
- No hagas push ni merge salvo que el usuario lo pida.
- Puedes agregar dependencias si las justificas en el registro de decisiones. Prefiere pocas y bien mantenidas.

## Pautas técnicas iniciales

Se aplican mientras no se actualice el diseño.

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
