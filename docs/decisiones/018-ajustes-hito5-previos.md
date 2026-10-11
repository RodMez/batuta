# ADR 018: Ajustes previos del hito 5 (prompt, permisos y captura)

## Contexto
La revisión del hito 5 deja tres ajustes previos al motor (hito 6): un flag
variádico (`--tools`/`--allowed-tools`) consume el posicional que lo sigue
(comprobado con CLI 2.1.282); sin comandos permitidos un rol con escritura no
recibía `--allowed-tools` y `Bash` aparecía siempre en `--tools`; y
`scripts/capturar-claude.js` usaba la forma antigua `{ lectura, escritura }`
en vez de `PermisosRol` (`soloLectura`), con modelo fijo antiguo.

## Opciones consideradas
1. **Separador `--` siempre + `--allowed-tools` derivado de la misma fuente
   + captura tipada con `BATUTA_MODELO`**: El prompt va siempre tras `--`
   (evita que un texto con guiones se lea como flag); en escritura
   `--allowed-tools` siempre se pasa y `Bash` solo aparece en `--tools` si hay
   comandos; la captura expone constructores puros en `src/captura.ts`,
   lee `BATUTA_MODELO` (defecto `claude-haiku-5-5`) y reenvía
   `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL` para proxy local.
2. **Separador solo cuando el prompt empieza por `-`**: Ahorra un argumento
   pero deja el caso variádico sin prompt de sistema/esquema sin cubrir.
3. **Mantener el script sin probar**: La forma incorrecta de permisos
   trataría al `architect` como escritura sin que ninguna prueba lo detecte.

## Decisión
Opción 1, con pruebas para prompt sin sistema/esquema, prompt que empieza por
`--`, los tres casos de permisos (lectura, escritura sin comandos, escritura
con comandos) y humo de captura con un `claude` falso. README documenta la
captura con y sin proxy.

## Consecuencias
- **Positivas**: Invocación robusta ante prompts arbitrarios; permisos
  coherentes y testeados; captura reproducible sin red en `verify`.
- **Negativas**: Ninguna; la captura real sigue siendo manual con credenciales.
