# Mudae Timer

Temporizador de los comandos de Mudae que se ven con `$tu` (`$timersup`). Es 100% manual:
no se conecta a tu cuenta de Discord ni ejecuta comandos, asi que no es un self-bot y no
vulnera los terminos de Discord ni las reglas de Mudae.

- **PC**: abre la web (local o desplegada) en cualquier navegador.
- **Movil**: instala la PWA ("Anadir a pantalla de inicio") para recibir avisos con la app cerrada.

## Archivos

| Archivo | Tamano | Que es |
| --- | --- | --- |
| `public/index.html` | ~8 KB | Aplicacion (UI en espanol, sin frameworks) |
| `public/app.js` | ~9 KB | Logica del frontend (contadores, modos, push) |
| `public/parse.js` | ~6 KB | Parser del texto de `$tu` (probado con tests) |
| `public/sw.js` | ~1 KB | Service worker (push + click de notificacion) |
| `public/manifest.webmanifest` + `icon.svg` | ~1 KB | Config PWA + icono |
| `worker/index.js` | ~9 KB | Backend (inmutable): VAPID, push cifrado (aes128gcm), cron |
| `wrangler.toml` | config | Solo legado/rollback (Cloudflare) |
| `src/main.ts` | entrada | Deno Deploy: cron + serve de `public/` + API `/api/*` |
| `src/kvAdapter.ts` | ~2 KB | Adaptador Deno KV (misma interfaz que CF KV) |
| `src/static.ts` | ~1 KB | Servir `public/` en Deno Deploy |
| `tools/export-cf-kv.mjs` | util | Volcar Cloudflare KV a `export/kv.json` |
| `tools/import-kv.ts` | util | Importar `export/kv.json` a la Deno KV |
| `test/` | tests | `node --test test/parse.test.js test/worker.test.cjs test/app.smoke.test.cjs test/sync.test.cjs` |
| `src/kvAdapter.test.ts` | test Deno | `deno test --allow-all --unstable-kv src/kvAdapter.test.ts` |

Total fuente: menor a 40 KB. Sin `node_modules`, sin build, sin dependencias.

## Probar en PC (local, sin push)

```bash
npx serve public
```

Abre `http://localhost:3000`. Funciona la UI, el pegado de `$tu` y los avisos con sonido
mientras el navegador este abierto. Para avisos con la app cerrada necesitas desplegar
(el push requiere HTTPS + backend).

## Desplegar en Deno Deploy (plan gratis) — despliegue actual

Sustituye a Cloudflare: sin limites practicos de escritura en KV (1M requests/mes,
1M lecturas + 500K escrituras/mes en KV, 1 GiB de KV, 20 GiB de salida; gratuito,
sin tarjeta, sin auto-cobro).

1. Crea un token de acceso en la consola: **https://console.deno.com/account/access-tokens**
   (boton "New access token"; el valor empieza por `ddo_`). Apunta tambien el
   **nombre de la organizacion**: se ve en la URL de la consola
   (`https://console.deno.com/<org>`).

2. Crear la aplicacion (solo la primera vez):

   ```bash
   $env:DENO_DEPLOY_TOKEN = "ddo_xxx"
   deno run --allow-all jsr:@deno/deploy create --json --non-interactive --org <org> --app mudae-timer --source local --runtime-mode dynamic --entrypoint src/main.ts --region global
   ```

   > Se usa `deno run --allow-all jsr:@deno/deploy` (el modulo CLI del propio Deno
   > Deploy) porque el subcomando integrado `deno deploy` del CLI tiene un bug en
   > algunas versiones: `Option "--prod" can only occur once, but was found several
   > times`. `deno.json` define `deploy.runtime.entrypoint = "./src/main.ts"`.

3. Desplegar (desde la raiz, cada cambio):

   ```bash
   deno run --allow-all jsr:@deno/deploy --json --non-interactive --org <org> --app mudae-timer --prod
   ```

   Sube toda la carpeta (backend + `public/`). El cron queda registrado por
   `Deno.cron` en `src/main.ts`; en la consola de la app puedes ver logs y el cron.

4. Abre la URL resultante: **https://mudae-timer.deno.dev** (o la que elijas en
   Settings de la app).

5. Despues del despliegue, en cada dispositivo: abre la nueva URL, vuelve a
   **Activar notificaciones** (el permiso se concede por URL) y, si usabas
   sincronizacion, vuelve a introducir el syncCode en **Sincronizar > Unirme**.

### KV y migracion

El deploy crea una base KV del proyecto que `src/main.ts` usa automaticamente
(`Deno.openKv()`).

Hoy el KV de Cloudflare esta **vacio**: los temporizadores viven en el localStorage
de cada dispositivo, asi que no hay datos que migrar (solo hay que re-parejar cada
dispositivo con la nueva URL). Si algun dia el KV de CF volviera a tener datos:

```bash
node tools/export-cf-kv.mjs          # vuelca CF KV -> export/kv.json (+ syncCodes)
# En la consola de la app: Settings de la aplicacion > "Generate access token" y
# su "Database URL". Pasalos por entorno:
#   $env:KV_URL = "https://api.deno.com/databases/<id>"     (o DENO_KV_URL a secas)
#   $env:DENO_DEPLOY_TOKEN = "ddo_xxx"
deno run --allow-all --unstable-kv tools/import-kv.ts  # no hace nada si export/kv.json esta vacio
```

### Rollback

El despliegue en Cloudflare (`npx wrangler deploy`) sigue intacto por si quieres
volver atras: URL **https://mudae-timer.mudae-timer.workers.dev**. Para volver,
solo abre esa URL en los dispositivos (los datos locales se conservan; el poll de
sync actual es de 60 segundos).

## Desplegar en Cloudflare Workers (legado / rollback)

1. Crear cuenta gratuita en https://dash.cloudflare.com
2. En este proyecto:

```bash
npm i -g wrangler            # (o usa npx wrangler)
npx wrangler login
npx wrangler kv namespace create TIMERS   # copia el ID
```

3. Pega el ID en `wrangler.toml` (campos `id` y `preview_id`).
4. Desplegar:

```bash
npx wrangler deploy
```

5. Abre la URL que imprime (`https://mudae-timer.<tu-subdominio>.workers.dev`).

## Activar notificaciones

1. Abre la app (desplegada, siempre HTTPS).
2. Pulsa **Activar notificaciones** y acepta el permiso del navegador.
3. En Android: menu del navegador > "Instalar app" (Chrome/Edge). En iOS (16.4+):
   Safari > Compartir > "Anadir a pantalla de inicio", abrir la app instalada y repetir el paso 2.

Los avisos se programan en el backend cuando anades o reinicias un temporizador. El cron
(minuto a minuto) envia el push aunque la app este cerrada.

Cada vez que un temporizador llega a 0 (una vez **o** en ciclo), la app avisa siempre: suena un
pitido y sale un aviso en pantalla aunque el navegador tenga el permiso del sistema denegado
(ej. Edge en modo silencioso). Si el permiso esta concedido, ademas aparece la notificacion del
sistema (y via push con la app cerrada).

## Uso diario

1. Recomendado configurar tu `$tu` con las categorias que usa la app:
   `$ta claim daily keys kakerareact dk vote rt`
   (la app incluye el boton para copiarlo).
2. En Discord ejecuta `$tu` (o `$tus` para recibirlo por DM), copia el texto y pegalo en
   "Pegar $tu". Revisa la deteccion, marca lo que quieras y anade.
3. Alternativa: "Anadir tiempo" con la categoria y un tiempo libre (ej: 2h 30m). Cada temporizador
   puede repetirse en ciclo (ej. claim cada 2h) o ser de una sola vez, y puede avisar unos
   minutos antes. Cada tarjeta tiene un boton **Ciclo**/**Una vez** para cambiar ese modo sobre
   la marcha (un ciclo al terminar se repite solo)

La lista de temporizadores se organiza en dos carpetas plegables que se reparten solas:
**Disponibles** (comandos que ya se pueden usar, contador a 0) y **En espera** (los que siguen
contando). Cuando un temporizador llega a 0:00 pasa solo a Disponibles, tambien cuando el cambio
llega por sincronizacion desde otro dispositivo.

Cuando termina un temporizador de `$rolls y $mk`, `Kakera`, `$daily`, `$rt` o `$vote` no se
detiene: pasa solo a repetirse con su ciclo propio (`$rolls y $mk` cada hora, `Kakera` cada
110.08 min (110 min 5 s), `$daily` cada 24 h, `$rt` cada 30 h, `$vote` cada 12 h). La duracion
del primer ciclo es la que venia del `$tu` o la que se anadio a mano. Al elegir la categoria
`Kakera` en "Anadir tiempo" el campo se rellena solo con 110.08m.

Los temporizadores viejos de `$mk` y `$Rolls` se funden automaticamente en uno solo
(`$rolls y $mk`) la primera vez que se abre la app tras esta actualizacion.

Los datos se guardan solo en tu dispositivo (localStorage). Los perfiles sirven para jugar
en varios servidores con timers distintos.

## Sincronizar varios dispositivos

Con la sincronizacion, todos tus dispositivos comparten los mismos temporizadores y entre todos
reparten los avisos (fan-out): basta que uno este abierto o reciba el push para que llegue a todos.

1. En tu dispositivo principal: **Sincronizar > Crear cuenta**. Se genera un codigo tipo `MT-XXXX-XXXX`.
2. En cada dispositivo extra: **Sincronizar > (codigo) > Unirme**. Se copian los temporizadores al instante.
3. La app se sincroniza sola cada ~60 segundos, al abrirla y al volver a primer plano. Tambien
   puedes crear el codigo en otro dispositivo y unirte desde el primero.

> La sincronizacion **no requiere** activar notificaciones: puedes crear la cuenta o unirte
> aunque el push este bloqueado en ese navegador. El push es opcional en cada dispositivo:
> sin el, la app recibe los cambios por polling mientras esta abierta; con el, ademas le
> llegan los avisos con la app cerrada. Cada dispositivo tiene una identidad persistente que
> se guarda en su navegador (localStorage).

Reglas:

- Cualquier cambio (anadir, reiniciar, listo, eliminar) se propaga a los demas dispositivos.
- Si dos dispositivos cambian lo mismo a la vez, gana el cambio mas reciente (last-write-wins).
- Los avisos de una cuenta sincronizada los programa el backend (el cron avisa a todos).
- Salir de la sincronizacion mantiene los timers locales actuales, pero deja de compartirlos.

## Bajo consumo en segundo plano

En el movil la app apenas gasta bateria cuando no la estas mirando:

- En segundo plano (tab/pantalla oculta o app en segundo plano) se **abortan las llamadas de red**:
  no hay polling, asi que el navegador puede congelar la pagina y apagar la radio. Los avisos
  de los temporizadores siguen llegando por push (los manda el backend, no el telefono).
- Los cambios que hagas en otro dispositivo se recogen solo al **volver a abrir la app**
  (la app se sincroniza al ponerla en primer plano, ademas de su revision periodica en pantalla).
- En segundo plano el contador no se repinta en el DOM: solo se evalúa la logica del motor
  (avisar, marcar listo, reprogramar) y se guarda el estado si algo cambió.

## Nota legal

Este proyecto es un recordatorio que usa informacion que TU copias de tu propio mensaje de
Discord. No automatiza ninguna accion en tu cuenta (no hay self-bot, macros ni lectura de
mensajes por API). Todo lo demas (reclamar, tirar, etc.) lo haces tu manualmente en Discord.

## Tests

```bash
node --test test/parse.test.js test/worker.test.cjs test/app.smoke.test.cjs test/sync.test.cjs
```

Adaptador Deno KV (requiere Deno):

```bash
deno test --allow-all --unstable-kv src/kvAdapter.test.ts
```