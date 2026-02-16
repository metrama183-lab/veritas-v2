# MEGA FIX PLAN — Deploy stabile API AI (Veritas)

## Obiettivo
Rendere **affidabile in produzione** la pipeline `/api/analyze` su host serverless (Vercel / Netlify / Cloudflare), senza regressioni UI, con gestione robusta di:
- trascrizione YouTube
- Groq (LLM + Whisper)
- Tavily (web verification)
- timeout, limiti, environment variables, observability

---

## Stato attuale (diagnosi sintetica)

### Bloccanti principali osservati nel codice
1. **Node version mismatch su Netlify**
   - `next@16.1.6` richiede Node >= 20.9 (docs Next.js).
   - Config attuale: `NODE_VERSION = "18"` (`netlify.toml`).

2. **Dipendenza runtime da `child_process` + binario `yt-dlp`**
   - Uso `exec` in `src/lib/audio-transcription.ts`.
   - Uso binario locale in `node_modules/youtube-dl-exec/bin/yt-dlp`.
   - Rischio bundling/perms/exec su serverless.

3. **Assunzioni filesystem non cross-platform**
   - `TEMP_DIR` usa `/tmp` solo quando `process.env.VERCEL` è presente.
   - Su altri ambienti serverless, `process.cwd()` può essere read-only.
   - Scrittura `debug_error.log` su project root (potenzialmente non scrivibile).

4. **Possibili timeout function**
   - Strategie transcript cumulative + fallback lenti.
   - In alcuni piani, route può essere terminata prima del completamento.

5. **Cloudflare incompatibilità architetturale (attuale)**
   - Workers/Pages non è compatibile con `child_process`/exec binari come su Node serverless classico.

6. **Config/env non sempre in scope runtime**
   - Necessaria verifica chiavi in scope corretto (Functions runtime, non solo build scope).

---

## Fonti usate (research)
- Next.js installation/system requirements (Node min 20.9)
- Next.js output file tracing (`outputFileTracingIncludes` / `Excludes`)
- Next.js Edge vs Node runtime
- Vercel docs: files in functions, duration/maxDuration
- Netlify docs: Next.js adapter, env vars for functions
- Cloudflare docs: bindings/secrets + Node compatibility
- Groq docs: rate limits, 429, `retry-after`
- Tavily docs: rate limits dev/prod, key scope

---

## Strategia generale (in ordine di priorità)

## FASE 0 — Baseline e criteri di successo (prima di toccare codice)
**Obiettivo:** definire quando il fix è “done”.

### KPI target
- p95 `/api/analyze` < 25s (video demo) e < 45s (video lungo)
- error rate < 2% su 20 test consecutivi
- 0 errori “No AI API key configured” quando env sono presenti
- 0 errori filesystem permission denied
- transcript strategy success >= 90% su set test (10 video)

### Test set minimo
- 1 video demo (EJfyAcfE5HM)
- 3 video con captions manuali
- 3 video con auto-captions
- 3 video senza captions (audio fallback)

---

## FASE 1 — Hardening deploy target primario: VERCEL
**Obiettivo:** un deploy affidabile per hackathon/demo.

### 1. Runtime esplicito Node per route AI
- Impostare route handler in Node runtime (no Edge) dove usi `fs`/`child_process`.

### 2. Timeout function coerenti
- Definire `maxDuration` per route analyze.
- Ridurre lavoro sincrono dove possibile.

### 3. Tracing/bundling binari necessari
- Usare `outputFileTracingIncludes` per includere asset/binari richiesti dalla route.
- Verificare dimensione bundle function.

### 4. Filesystem serverless-safe
- Standardizzare path temporanei su `/tmp` quando disponibile.
- Eliminare scritture su root progetto in produzione.

### 5. Env vars checklist deploy
- Verificare presenza e naming esatto:
  - `GROQ_API_KEY`
  - `TAVILY_API_KEY`
  - `OPENAI_API_KEY` (se usato)
  - `GOOGLE_GENERATIVE_AI_API_KEY` (se usato)
- Confermare scope runtime e redeploy dopo modifica.

### Exit criteria Fase 1
- Deploy Vercel stabile su 10/10 invocazioni demo
- No crash di transcript pipeline
- Risposta valida sempre (anche con fallback)

---

## FASE 2 — Netlify compatibility completa
**Obiettivo:** rendere Netlify una seconda opzione reale.

### 1. Node version allineata a Next 16
- Portare runtime a Node >= 20.9.

### 2. Env scope Functions
- Spostare chiavi su scope Functions runtime (non solo build).
- Forzare rebuild+redeploy dopo cambi env.

### 3. Temp storage e permessi
- Assicurare uso `/tmp` in runtime Netlify Functions.
- Evitare write su cartelle read-only.

### 4. Budget tempo e cold start
- Tarare timeout/strategie per evitare kill della function.

### Exit criteria Fase 2
- Netlify: 10 richieste demo consecutive senza errori runtime
- Pipeline transcript almeno fino a strategy 2.5 funzionante

---

## FASE 3 — Cloudflare path (decisione architetturale)
**Obiettivo:** decidere supporto serio o no-go dichiarato.

### Opzione A (consigliata): “Cloudflare frontend + backend esterno Node”
- Tenere frontend su Cloudflare Pages.
- Spostare `/api/analyze` su backend Node (Vercel/Netlify/Render/Fly).
- Frontend chiama backend esterno con CORS controllato.

### Opzione B: “Porting completo Cloudflare-native” (costo alto)
- Rimuovere `child_process`/yt-dlp locale.
- Sostituire transcript con provider HTTP-only compatibile Workers.
- Riprogettare I/O, caching e limiti runtime Workers.

### Exit criteria Fase 3
- Decisione esplicita documentata: A o B.
- Se A: integrazione E2E funzionante.

---

## FASE 4 — Resilienza API provider (Groq/Tavily)
**Obiettivo:** ridurre errori da quota/rate-limit.

### 1. Groq robust rate-limit handling
- Leggere e usare `retry-after` quando presente.
- Backoff con jitter per 429.
- Distinguere limiti RPM/TPM/TPD/ASH.

### 2. Tavily degradazione controllata
- Se quota esaurita: fallback model-only + tagging esplicito qualità verifica.
- Non considerare questo stato come “errore fatale”.

### 3. Guardrail token/costi
- Limitare transcript inviato al modello in base al provider/plan.
- Evitare overrun su claim extraction.

### Exit criteria Fase 4
- Nessun hard-fail per 429 su provider esterni
- Fallback sempre coerente e spiegato nella risposta

---

## FASE 5 — Observability e debugging produzione
**Obiettivo:** capire subito perché fallisce una request.

### Logging minimo strutturato (server)
- `request_id`, `video_id`, strategia transcript usata, durata totale, step duration, provider scelto.
- error class: env, quota, timeout, fs, subprocess, parse.

### Health endpoints / smoke tests
- Endpoint diagnostico (senza segreti) per verificare:
  - env presence (boolean)
  - runtime mode
  - writable tmp test
  - availability provider ping (optional)

### Exit criteria Fase 5
- Tempo medio diagnosi < 10 minuti per incidente

---

## Matrice priorità (impatto x effort)

### Altissimo impatto / basso effort
1. Allineare Node runtime (Netlify) a >= 20.9
2. Verifica env vars runtime scope su ogni provider
3. Evitare write su root progetto
4. Runtime Node esplicito per route analyze

### Alto impatto / medio effort
5. Uniformare temp dir serverless (`/tmp` strategy)
6. maxDuration + timeout tuning route
7. outputFileTracingIncludes per binari/asset necessari

### Medio impatto / alto effort
8. Supporto Cloudflare full-native (senza child_process)

---

## Checklist operativa pronta all’esecuzione

### Pre-deploy
- [ ] Inventario variabili ambiente per provider
- [ ] Definizione deploy target primario (Vercel consigliato)
- [ ] Conferma piano fallback se Tavily quota finita

### Deploy hardening
- [ ] Runtime Node route
- [ ] Timeout e maxDuration
- [ ] Temp dir e fs safe writes
- [ ] Binary/file tracing
- [ ] Log strutturati minimi

### Validation
- [ ] Smoke test demo URL
- [ ] 10 test consecutivi senza errori
- [ ] Probe multi-video (>=10) con metriche
- [ ] Verifica output JSON schema invariato

### Rollback
- [ ] Feature flags per nuove strategie transcript
- [ ] Possibilità disattivare strategy 2.5/3 da env
- [ ] fallback metadata sempre disponibile

---

## Rischi residui (da accettare o mitigare)
- Quota provider esterni (Groq/Tavily) può comunque limitare qualità/throughput.
- YouTube può cambiare behavior anti-bot/captions senza preavviso.
- Cold starts serverless influenzano latenza su traffico intermittente.

---

## Piano esecuzione consigliato (48h)

### Giorno 1 (stabilità)
1. Fase 1 completa (Vercel)
2. Fase 4 parziale (rate-limit handling)
3. Fase 5 base (logs)

### Giorno 2 (portabilità)
4. Fase 2 (Netlify)
5. Decisione Fase 3 (Cloudflare A/B)
6. Test finali + documento runbook

---

## Decisione proposta (pragmatica hackathon)
- **Primary deploy:** Vercel (Node runtime)
- **Secondary deploy:** Netlify dopo hardening
- **Cloudflare:** frontend-only + backend esterno (Opzione A)

Questo massimizza probabilità di demo stabile nel minor tempo.
