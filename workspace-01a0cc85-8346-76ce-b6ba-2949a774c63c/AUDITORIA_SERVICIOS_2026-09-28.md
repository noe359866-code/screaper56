# Auditoría de servicios, index y ejecución — 2026-09-28

## Alcance

`src/services/supabase.ts`, `src/index.ts`, `src/config/env.ts`, tipos compartidos,
`scripts/diagnose.mjs` y `.github/workflows/main.yml`. Se conservaron los cambios
de la auditoría anterior de crawlers. No se consultó ni modificó Supabase real.

## Fallos corregidos

### Persistencia en Supabase

- **Éxito parcial silencioso:** el servicio devolvía un número menor al esperado
  sin lanzar un error. Ahora `BatchPersistenceError` incluye las escrituras
  confirmadas por respuestas exitosas, cantidad de candidatos válidos y rechazos.
  El orquestador conserva el conteo parcial y marca la fuente como fallida.
- **Fallback no idempotente:** se eliminó el INSERT automático ante `42P10`.
  Sin UNIQUE(info_hash), cada ejecución podía insertar los mismos registros otra
  vez. Ahora el error explica el requisito de esquema sin modificarlo.
- **Rescate falso:** el fallback anterior contaba un UPDATE sin error como una
  escritura aunque el filtro no encontrara filas. Ya no se usa ese mecanismo.
- **Pérdida de datos en lotes heterogéneos:** PostgREST usa la unión de las claves
  de un array de registros. Quitar `undefined` de cada objeto no basta. Ahora se
  agrupan los registros por conjunto de columnas y se usa `defaultToNull:false`.
  Los metadatos ausentes, arrays vacíos y calidad `Unknown` no se envían como
  actualizaciones destructivas; un contador conocido igual a cero sí se envía.
- **Lotes grandes:** división recursiva conservando UPSERT, no INSERT. Los errores
  de datos/integridad se aíslan por filas para salvar las demás. Un fallo de
  permisos o esquema detiene los lotes posteriores de esa llamada.
- **Validación:** batchSize entero entre 1 y 10000; solo conflicto por info_hash;
  rechazo del hash nulo, enteros inseguros/fraccionarios, títulos con NUL e IMDb
  malformado. Los registros rechazados ya no desaparecen silenciosamente.
- **Duplicados en memoria:** se fusionan metadatos complementarios antes del
  envío, en vez de conservar únicamente el último objeto.
- **Red:** timeout por petición con AbortSignal, máximo de tres intentos para
  fallos transitorios y backoff. Incluye fallos transitorios del pool PostgREST.
  En el CLI el timeout procede de REQUEST_TIMEOUT_MS.
- **Logs:** los errores de persistencia muestran código/estado/cantidad, no el
  mensaje libre del servidor que podría contener datos de filas o secretos.

### Orquestador / index

- Importar `index` no inicia crawlers ni modifica el código de salida. `main`
  acepta dependencias para pruebas y devuelve un resumen; `runCli` gestiona
  código de salida y cierre del navegador compartido.
- La concurrencia sigue acotada. Fallos de factoría, crawl o cierre de una fuente
  no impiden completar las demás. Se capturan también errores síncronos de close.
- Se conserva el mirror resuelto incluso si la fuente falla después de cambiarlo.
- Si todos los hashes quedan descartados al deduplicar, la fuente falla en vez de
  aparecer como ejecución válida vacía.
- `totalUpserted` solo cuenta escrituras reales. En dry-run se usa
  `totalWouldUpsert` y `wouldUpsert` por fuente.
- Errores de guardado tienen categoría `persistence`, no un diagnóstico engañoso
  de layout o conectividad de la web. Un repositorio que devuelve un conteo
  incompleto también produce un fallo.

### Configuración

- Corregidas las invariantes del Proxy: Object.keys, spread y JSON.stringify ya
  no fallan al exponer descriptores no configurables de otro objeto congelado.
- Se rechazan booleanos desconocidos. Un typo como DRY_RUN=tru ya no puede
  convertir una ejecución pretendidamente simulada en escritura real.
- Se rechazan enteros malformados, menores al mínimo y mayores al límite de los
  temporizadores. Ya no se convierten silenciosamente en otros valores.
- TARGET_CRAWLERS vacío/blanco/comas no produce un job exitoso sin fuentes.
- Una recarga inválida no conserva una configuración anterior en caché.
- SUPABASE_URL rechaza credenciales embebidas, query y fragmento; el mensaje no
  reproduce el valor potencialmente sensible.

### Diagnóstico y CI

- Los workers de diagnose cierran adaptador y navegador antes de enviar el
  resultado y salir; el timeout del padre continúa siendo el límite externo.
- Nombres heredados como `toString` no se aceptan como crawlers. Se deduplican
  argumentos y se valida el rango de DIAGNOSE_TIMEOUT_MS.
- Actions usa `defaults.run.working-directory` en vez de mover todo a la raíz.
  Las claves de caché apuntan al lockfile correcto, se añaden t0rrenta y
  estrenostorrent a las opciones manuales y permisos de checkout de solo lectura.
- El comentario del presupuesto de crawling se corrigió: es cooperativo, no
  cancela automáticamente todas las peticiones en curso. No se añadió una falsa
  promesa de timeout duro por fuente al orquestador.

## Validación

- **315 pruebas pasando** (283 anteriores + 32 nuevas).
- Nuevas suites: `tests/services.test.js`, `tests/orchestrator.test.js` y
  `tests/config-runtime.test.js`.
- El servicio se prueba con el SDK real supabase-js y un fetch simulado: se
  verifica el cuerpo HTTP, ON CONFLICT, Prefer, fragmentación y abortado sin red.
- Pruebas de proceso para comprobar el código de salida del CLI ante configuración
  inválida y el rechazo de nombres inválidos en diagnose.
- `npm run lint`, `npm run build`, `npm test` y `git diff --check` correctos.
- No se ejecutó el workflow en GitHub ni una integración con PostgreSQL real.

## Requisitos y límites que deben comprobarse en producción

1. **UNIQUE(info_hash) es obligatorio.** Antes de crear el índice, inspeccionar
   duplicados y resolverlos según el modelo de datos. No eliminarlos a ciegas.
   Consulta de solo lectura sugerida:

   ```sql
   SELECT info_hash, COUNT(*)
   FROM public.torrents
   GROUP BY info_hash
   HAVING COUNT(*) > 1;
   ```

   Si la clave lógica real incluye archivo/episodio además del hash, adaptar
   primero el modelo y la deduplicación: el contrato actual es un registro por hash.

2. Las columnas omitidas necesitan defaults o admitir NULL en INSERT. Comprobar
   especialmente arrays y calidad en el esquema desplegado. El repositorio no
   contiene una migración canónica de la tabla; por eso no se inventaron defaults
   ni se aplicaron cambios DDL automáticamente.

3. Se conserva el contrato histórico de columnas persistidas: no se añadieron
   `magnet_url`, `torrent_file_url`, `source_url` ni un nuevo enum `documentary` a
   Supabase sin conocer su esquema. Los enlaces siguen disponibles en los
   registros extraídos; el servicio mantiene la lista de columnas anterior y
   la compatibilidad de documental como movie. Ampliarlo requiere verificar DDL.

4. El conteo corresponde a filas de solicitudes reconocidas como exitosas por
   Supabase; no distingue INSERT de UPDATE. Una desconexión posterior al commit
   puede dejar escrituras no confirmadas: el error no implica rollback. UPSERT
   permite reintentar sin insertar duplicados por info_hash.

5. La fusión en memoria es por llamada de upsertBatch; no se implementó una
   fusión transaccional de todos los metadatos de diferentes fuentes en la base.
   Datos conocidos distintos pueden seguir reemplazándose entre fuentes.

6. Los fallos de un lote no deshacen lotes ya guardados. El CLI devuelve estado
   fallido aunque parte de los registros haya quedado persistida.
