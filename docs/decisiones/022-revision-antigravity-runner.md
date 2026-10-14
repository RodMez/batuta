# ADR 022: Revisión de AntigravityRunner (fail-closed, prompts acotados y avisos)

## Contexto
La revisión independiente (code, arquitectura, seguridad) del hito 8 encontró 2 bloqueantes (opencode silencioso, exclude gitdir relativo), 3 altas (traversal por task_id, escritura sin confinar, exclude sin confinar) y varios mayores (prompt sin cota, cuota 1/2 silenciosa, parser models frágil, raíz relativa contra cwd).

## Opciones consideradas
1. **Cuota permisiva (seguir con 1/2):** mantiene disponibilidad ante renombres de Google, pero reintroduce pérdida silenciosa del control (bug original #5) y gasto de ~13k-25k tokens a ciegas.
2. **Cuota estricta 2/2 + escape manual:** para ante catálogo incompleto con mensaje accionable; desbloqueo solo explícito. Protege el caso frecuente (config vieja) a costa de bloquear ante renombre raro.
3. **Model-check como aviso:** no bloquea alias remotos, pero deja pasar erratas a runtime con reintentos y gasto.
4. **Model-check fatal + --skip-model-check:** frena erratas antes de gastar; el caso especial se permite a propósito. Catálogo vacío/ilegible degrada a aviso.
5. **Notificaciones ahora vs Fase 2:** Telegram llega en Fase 2, pero sin avisos ahora los bloqueos estrictos quedan mudos.

## Decisión
- Cuota estricta 2/2 (opción 2) con error `Catálogo de cuota incompleto...` y `resetTime null` documentado para reanudar sin hora exacta.
- Model-check fatal por defecto + `--skip-model-check` (opción 4); catálogo vacío → aviso.
- Prompt corto con tope (20 archivos, título 200 chars, localizar id en plan) + falla rápido en motor si supera 4000 sin reintentos.
- Confinamiento: `esWorktreeValido` por segmentos + case-insensitive Win, `gitdir` resuelto contra worktree, comparación de exclude por líneas exactas, validación antes de escribir, solo escribir contexto en antigravity con limpieza de obsoletos, `task_id` sanitizado (hash si no allowlist), entorno extra con allowlist (bloquea PATH/NODE_OPTIONS), sandbox EOF case-insensitive, esquema temporal modo 0600.
- Avisos: nuevos tipos `pausa_cuota` y `config_invalida`; el motor emite evento `advertencia` + `notificar(pausa_cuota)` con comando `batuta resume`; `fallarEjecucion` sigue notificando `fallo`. Pantalla + `events.jsonl` ahora, Telegram después sin recodificar.
- `opencode` explícito: `crearRunner` lanza y preflight devuelve error (no silencioso a Claude/simulado).
- `directorio_worktrees` relativo se resuelve contra el repo (igual que `git.ts`).
- `vitest testTimeout 15s` (30s en spawn pesado) para Windows.

## Consecuencias
Positivas: sin ejecuciones a ciegas, sin gasto por erratas, bloqueos con mensaje y reanudación clara, superficie de path-traversal cerrada.
Negativas: renombre de buckets/modelos bloquea hasta actualizar config o usar escape; requiere documentar ToS y pin de `agy` (pendiente humano + CI Linux).
