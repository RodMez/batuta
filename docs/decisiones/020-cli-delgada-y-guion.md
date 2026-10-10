# ADR 020: CLI delgada y formato del guion simulado

## Contexto
El hito 7 pone terminal sobre el motor del hito 6 (`run`, `status`,
`approve`, `answer`, `resume`, `abort`, `doctor`) con agentes simulados por
archivo (`--simulado <guion.json>`) o `ClaudeCodeRunner`. La CLI debe ser
delgada (sin lógica de flujo), funcionar en Windows y Linux, probar sus
manejadores con dependencias inyectadas y el binario real de extremo a
extremo, y no dejar procesos ni worktrees huérfanos.

## Opciones consideradas
1. **Manejadores que devuelven `{ texto, codigo }` + `EntornoCLI` inyectable**:
   Cada comando (`src/comandos/*.ts`) recibe argumentos y un entorno
   (fs, reloj, ejecutor, git, notificador) y devuelve texto y código, sin
   imprimir ni salir; el cableado de commander solo imprime y fija
   `process.exitCode`. Los manejadores se prueban con repositorios Git
   temporales reales y guiones en archivo.
2. **Lógica en las acciones de commander**: Acoplaría parseo, efectos y
   salida, imposible de probar sin lanzar procesos.
3. **Guion indexado por posición con desplazamiento persistido**: Cada llamada
   del motor consume la entrada N del guion; como cada comando corre en un
   proceso distinto, la CLI calcula el desplazamiento sumando las llamadas ya
   registradas en `motor.json` (`usoPorRol`). Una llamada interrumpida (que
   lanzó excepción) no quedó registrada y se repite, igual que en el motor.
4. **Guion indexado por subtarea e intento**: Más legible pero frágil ante
   continuaciones y reintentos del `debugger`, que multiplican las llamadas
   dentro de un mismo intento.

## Decisión
Opción 1 y 3, con este formato de guion (`GuionSimuladoSchema` en
`@batuta/core`, también fuente para validar):

```json
{
  "llamadas": [
    {
      "esperaMs": 0,
      "output": { "status": "SUCCESS", "summary": "...", "files_modified": [], "reported_checks": [], "continuation_notes": "", "blocking_question": "" },
      "fallo": "timeout",
      "uso": { "tokensEntrada": 100, "tokensSalida": 50, "turnos": 1 },
      "archivos": { "a.txt": "contenido\n" }
    }
  ]
}
```

- `output` y `fallo` son excluyentes (`fallo` gana si aparecen los dos);
  sin `output` se sintetiza un SUCCESS con los archivos como modificados.
- `archivos` se escribe en el worktree rechazando rutas que escapen de él;
  `esperaMs` duerme dentro de la llamada y permite matar el proceso a mitad
  en las pruebas de reanudación.
- Si el guion se agota, el runner falla con mensaje claro (no se repite la
  última llamada para no enmascarar guiones cortos).
- Códigos: 0 terminada o abortada, 10 pausa por aprobación, 11 pausa por
  respuesta, 1 fallida, 2 uso o configuración. Sin pilas salvo `--debug`;
  nunca se imprimen valores de entorno (solo nombres). Ayuda en español con
  subclase de `Help` (`styleTitle`) y de `Command` (`createCommand`, para que
  los subcomandos hereden la ayuda). `abort` en terminales DONE/FAILED limpia
  sin emitir evento (el reductor lo rechazaría). `status --json` se valida con
  esquema Zod antes de imprimir (nueva dependencia `zod` en `@batuta/cli`,
  la misma versión que el núcleo).

## Consecuencias
- **Positivas**: Flujo completo recorrible a mano y en pruebas con el binario
  real; `examples/demo/` probada por el propio e2e; matar a mitad
  (`taskkill /T` en Windows, grupo en Linux) + `resume` deja el mismo final
  sin huérfanos; `.batuta/` excluida vía `.git/info/exclude` no ensucia el
  árbol.
- **Negativas**: El e2e compila el CLI si falta `dist/` (los `dist/` están
  ignorados y `npm test` corre antes que `npm run build`); `proyecto` del
  YAML lo fija la CLI al `--repo` efectivo; `run brief.md` queda reservado
  como posicional con error claro hasta el hito 8.
