import React from 'react';
import type { DashAbr } from '../types';
import { lang, t } from '../lib/i18n';

// Explicación, en la propia página, de cómo elige calidad y cómo persigue la latencia el reproductor LL-DASH con las
// opciones elegidas. Resume PROTOCOLOS 3.5 y 3.6, README 5 y 6 y lo leído del código de dash.js 5.2.1
// (AbrController, ABRRulesCollection, sus reglas y CatchupController): si cambia alguno de ellos, hay que cambiar
// también este texto.

interface Props {
  abr: DashAbr;
  /** Calidad fijada a mano (altura) o 'auto'. */
  quality: number | 'auto';
  targetLatency: number;
  maxDrift: number;
  /** Búfer mínimo de la corrección LoL+ (liveCatchup.playbackBufferMin). */
  playbackBufferMin: number;
}

/** Búfer a partir del cual las reglas de fábrica cambian la de caudal por BOLA (abr.hybridSwitchBufferTime). */
const BOLA_ON_S = 12;

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="space-y-1">
    <div className="text-slate-300 font-semibold">{title}</div>
    <ul className="list-disc pl-4 space-y-1">{children}</ul>
  </div>
);

/** Elige entre la versión en español y la inglesa de un trozo de JSX. */
const L = (es: React.ReactNode, en: React.ReactNode): React.ReactNode => (lang === 'en' ? en : es);
const dec = (v: string) => (lang === 'en' ? v : v.replace('.', ','));

const s = (sec: number) => `${dec(sec.toFixed(2))} s`;

const WHEN = (
  <li>
    {L(
      <>
        <b>Cuándo decide:</b> antes de pedir cada segmento (2 s con la configuración habitual). La calidad nueva entra con
        el segmento siguiente; lo que ya está en el búfer no se reemplaza.
      </>,
      <>
        <b>When it decides:</b> before requesting each segment (2 s with the usual configuration). The new rendition
        starts with the next segment; what is already in the buffer is not replaced.
      </>,
    )}
  </li>
);

const THROUGHPUT = (
  <li>
    {L(
      <>
        <b>Caudal estimado:</b> dash.js mide cada fragmento CMAF desde su <code>moof</code> hasta el final de su{' '}
        <code>mdat</code> y promedia con medias exponenciales. Sin límite de red sale unas dos veces el bitrate que
        descarga, no la capacidad (README 6); con 4 Mbit/s de bajada se midió ~4,45 Mbit/s en el servidor, un 11 % por
        encima del enlace.
      </>,
      <>
        <b>Throughput estimate:</b> dash.js measures each CMAF fragment from its <code>moof</code> to the end of its{' '}
        <code>mdat</code> and averages with exponential moving averages. Without a bandwidth limit it comes out at about
        twice the downloaded bitrate, not the capacity (README 6); with a 4 Mbit/s downlink ~4.45 Mbit/s was measured on
        the server, 11 % above the link.
      </>,
    )}
  </li>
);

/** Velocidad que pone la corrección LoL+ con el búfer por debajo del mínimo (CatchupController, playbackRate ±0,5). */
const lolpRate = (buffer: number, min: number) => 0.5 + 1 / (1 + Math.exp(-5 * (buffer - min)));
const x = (rate: number) => `${dec(rate.toFixed(2))}×`;

/** Cómo persigue la latencia objetivo; igual con calidad automática o fija. */
function latencySection({ targetLatency, maxDrift, playbackBufferMin }: Props): React.ReactNode {
  const min = playbackBufferMin;
  return (
    <Section title={t('Latencia', 'Latency')}>
      <li>
        {L(
          <>
            <b>Objetivo fijo</b> ({s(targetLatency)}, el slider): dash.js se coloca a esa distancia del directo y no la
            cambia por su cuenta, ni con la red lenta ni tras una parada (README 5). Todo lo que hay entre la reproducción
            y el directo es búfer, así que la latencia nunca es menor que el búfer.
          </>,
          <>
            <b>Fixed target</b> ({s(targetLatency)}, the slider): dash.js places itself at that distance from the live
            edge and does not change it on its own, neither with a slow network nor after a stall (README 5). Everything
            between the playhead and the live edge is buffer, so latency is never lower than the buffer.
          </>,
        )}
      </li>
      {min > 0 ? (
        <li>
          {L(
            <>
              <b>Corrección (modo LoL+), búfer por debajo del mínimo</b> ({s(min)}, el slider): frena para rellenarlo, más
              cuanto menos búfer ({x(lolpRate(min / 2, min))} con {s(min / 2)}; {x(lolpRate(0, min))} vacío), y no
              persigue el objetivo hasta superarlo.
            </>,
            <>
              <b>Correction (LoL+ mode), buffer below the minimum</b> ({s(min)}, the slider): slows down to refill it,
              more the less buffer there is ({x(lolpRate(min / 2, min))} at {s(min / 2)}; {x(lolpRate(0, min))} when
              empty), and does not chase the target until it is exceeded again.
            </>,
          )}
          {targetLatency < min && (
            <>
              {' '}
              <span className="text-amber-300">
                {L(
                  <>
                    Con el objetivo ({s(targetLatency)}) por debajo del mínimo, el búfer no llega a él: frena casi siempre
                    y la latencia queda por encima del objetivo, en torno al mínimo más lo que tarda en llegar cada
                    fragmento (deducción del código, sin medir).
                  </>,
                  <>
                    With the target ({s(targetLatency)}) below the minimum, the buffer never reaches it: it slows down
                    almost all the time and latency stays above the target, around the minimum plus the time each fragment
                    takes to arrive (deduced from the code, not measured).
                  </>,
                )}
              </span>
            </>
          )}
        </li>
      ) : (
        <li>
          {L(
            <>
              <b>Corrección (modo LoL+), búfer mínimo en 0:</b> no frena nunca por búfer; solo corrige la latencia, aunque
              el búfer esté a punto de vaciarse.
            </>,
            <>
              <b>Correction (LoL+ mode), minimum buffer at 0:</b> never slows down for the buffer; it only corrects
              latency, even if the buffer is about to run dry.
            </>,
          )}
        </li>
      )}
      <li>
        {L(
          <>
            <b>Corrección, búfer por encima del mínimo:</b> si la latencia se aparta más de un 2 % del objetivo, acelera o
            frena entre 0,5× y 1,5× según lo lejos que esté; si no, reproduce a 1×.
          </>,
          <>
            <b>Correction, buffer above the minimum:</b> if latency deviates more than 2 % from the target, it speeds up or
            slows down between 0.5× and 1.5× depending on how far off it is; otherwise it plays at 1×.
          </>,
        )}
      </li>
      <li>
        <b>{t('Salto al directo:', 'Seek to live:')}</b>{' '}
        {maxDrift > 0 ? (
          L(
            <>
              si va más de {s(maxDrift)} por detrás del objetivo, deja de corregir con la velocidad y salta al directo,
              abortando las descargas en curso.
            </>,
            <>
              if it falls more than {s(maxDrift)} behind the target, it stops correcting with the playback rate and seeks
              to the live edge, aborting in-flight downloads.
            </>,
          )
        ) : (
          <>
            {t(
              'desactivado: solo corrige con la velocidad, por lejos que quede.',
              'disabled: it only corrects with the playback rate, however far behind it falls.',
            )}
          </>
        )}
      </li>
      <li>
        {t(
          'El vídeo se congela solo cuando el navegador se queda sin datos; ninguna regla de dash.js lo detiene antes.',
          'The video freezes only when the browser runs out of data; no dash.js rule stops it earlier.',
        )}
      </li>
    </Section>
  );
}

export const DashExplain: React.FC<Props> = (props) => {
  const { abr, quality, targetLatency } = props;

  if (quality !== 'auto') {
    return (
      <div className="space-y-2">
        <Section title={t(`Calidad fijada (${quality}p)`, `Fixed rendition (${quality}p)`)}>
          <li>
            {t(
              'No hay adaptación: se pide siempre esa Representation, aunque no quepa en el enlace.',
              'No adaptation: that Representation is always requested, even if it does not fit in the link.',
            )}
          </li>
          <li>
            {t(
              'Al cambiarla a mano, la nueva entra con el segmento siguiente.',
              'When changed by hand, the new one starts with the next segment.',
            )}
          </li>
        </Section>
        {latencySection(props)}
      </div>
    );
  }

  if (abr === 'l2a' || abr === 'l2afix') {
    const fixed = abr === 'l2afix';
    return (
      <div className="space-y-2">
        <p>
          {L(
            <>
              <b>Regla L2A de dash.js</b> (<i>Learn2Adapt</i>), en solitario: las de fábrica, incluida la de abandono,
              quedan apagadas. Cambiar el selector recrea el reproductor, porque la regla guarda estado desde el arranque.
            </>,
            <>
              <b>dash.js L2A rule</b> (<i>Learn2Adapt</i>), on its own: the stock rules, abandonment included, are turned
              off. Changing the selector recreates the player, because the rule keeps state from startup.
            </>,
          )}
          {fixed && (
            <>
              {' '}
              <b className="text-amber-300">{t('Experimento:', 'Experiment:')}</b>{' '}
              {t(
                'una copia de dash.js con el fallo de unidades de L2A corregido (README 6); no es dash.js tal como viene.',
                'a copy of dash.js with the L2A units bug fixed (README 6); not stock dash.js.',
              )}
            </>
          )}
        </p>
        <Section title={t('Elección (subir y bajar con la misma regla)', 'Selection (up and down with the same rule)')}>
          {WHEN}
          <li>
            {L(
              <>
                <b>Arranque:</b> hasta que el búfer llega a 1,5 s elige como la regla de caudal, la calidad más alta que
                quepa en el 90 % del caudal estimado
                {targetLatency < 1.5 && (
                  <>: con el objetivo en {s(targetLatency)} no suele salir de aquí, salvo que los parones suban el búfer</>
                )}
                .
              </>,
              <>
                <b>Startup:</b> until the buffer reaches 1.5 s it chooses like the throughput rule, the highest rendition
                that fits in 90 % of the throughput estimate
                {targetLatency < 1.5 && (
                  <>: with the target at {s(targetLatency)} it rarely leaves this phase, unless stalls raise the buffer</>
                )}
                .
              </>,
            )}
          </li>
          <li>
            {L(
              <>
                <b>Fase estable:</b> aprendizaje en línea, una distribución de probabilidad sobre las calidades que se
                corrige en cada segmento comparando <b>velocidad × bitrate nominal</b> con la{' '}
                <b>última muestra de caudal, sin margen</b>.
              </>,
              <>
                <b>Steady phase:</b> online learning, a probability distribution over the renditions that is corrected at
                each segment by comparing <b>playback rate × nominal bitrate</b> with the{' '}
                <b>last throughput sample, without margin</b>.
              </>,
            )}
            {fixed ? (
              <>
                {' '}
                {t(
                  'Con las unidades corregidas, como en dash.js 4.x, la distribución acumula lo que ve y sube de un escalón en un escalón.',
                  'With the units fixed, as in dash.js 4.x, the distribution accumulates what it sees and climbs one step at a time.',
                )}
              </>
            ) : (
              <>
                {' '}
                {t(
                  'En dash.js 5 dos de sus cuentas mezclan bit/s y kbit/s, la distribución salta entera en cada segmento y queda una regla sin memoria: la calidad más alta que quepa en esa muestra (README 6).',
                  'In dash.js 5 two of its computations mix bit/s and kbit/s, the whole distribution jumps at every segment and what remains is a memoryless rule: the highest rendition that fits in that sample (README 6).',
                )}
              </>
            )}
          </li>
          {THROUGHPUT}
        </Section>
        {latencySection(props)}
      </div>
    );
  }

  if (abr === 'lolp') {
    return (
      <div className="space-y-2">
        <p>
          {L(
            <>
              <b>Regla LoL+ de dash.js</b> (<i>Low-on-Latency+</i>), en solitario: las de fábrica, incluida la de
              abandono, quedan apagadas. Cambiar el selector recrea el reproductor, porque la regla guarda estado desde el
              arranque.
            </>,
            <>
              <b>dash.js LoL+ rule</b> (<i>Low-on-Latency+</i>), on its own: the stock rules, abandonment included, are
              turned off. Changing the selector recreates the player, because the rule keeps state from startup.
            </>,
          )}
        </p>
        <Section title={t('Elección (subir y bajar con la misma regla)', 'Selection (up and down with the same rule)')}>
          {WHEN}
          <li>
            {L(
              <>
                Antes de nada, <b>baja si búfer − tiempo de descarga estimado &lt; 0,3 s</b>, a la más alta de las
                inferiores que quepa en el caudal; en la mínima se queda. El tiempo de descarga lo estima para un segmento
                entero de la calidad actual (bitrate × duración / caudal). Con segmentos de 2 s necesita unos 0,6 s de
                búfer para poder subir
                {targetLatency < 0.6 && <>: con el objetivo en {s(targetLatency)} no sale de la calidad mínima</>}.
              </>,
              <>
                First of all, <b>it switches down if buffer − estimated download time &lt; 0.3 s</b>, to the highest lower
                rendition that fits in the throughput; at the lowest it stays. The download time is estimated for a whole
                segment of the current rendition (bitrate × duration / throughput). With 2 s segments it needs about 0.6 s
                of buffer to be able to switch up
                {targetLatency < 0.6 && <>: with the target at {s(targetLatency)} it never leaves the lowest rendition</>}.
              </>,
            )}
          </li>
          <li>
            {t(
              'Si pasa ese filtro, un mapa autoorganizado pondera calidad, latencia, búfer y cambios para elegir.',
              'If it passes that filter, a self-organising map weighs quality, latency, buffer and switches to choose.',
            )}
          </li>
          {THROUGHPUT}
          <li>
            {t(
              'Con el búfer lleno hasta el objetivo, cada segmento se descarga al ritmo del codificador y la estimación acaba siguiendo al bitrate que descarga: tras un rato en la mínima puede no subir aunque se alargue la latencia (README 6).',
              'With the buffer filled up to the target, each segment downloads at the encoder pace and the estimate ends up following the downloaded bitrate: after a while at the lowest rendition it may not switch up even if latency grows (README 6).',
            )}
          </li>
        </Section>
        {latencySection(props)}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p>
        {L(
          <>
            <b>Reglas de fábrica de dash.js</b> (lo que mide el banco). Cada regla propone una calidad y gana la más baja
            de las propuestas.
          </>,
          <>
            <b>Stock dash.js rules</b> (what the testbed measures). Each rule proposes a rendition and the lowest proposal
            wins.
          </>,
        )}
      </p>
      <Section title={t('Elección', 'Selection')}>
        {WHEN}
        <li>
          {L(
            <>
              <b>Regla de caudal</b>, la que decide en la práctica: la calidad más alta cuyo <b>bitrate nominal</b> (el del
              MPD) no pase de <b>0,9 × el caudal estimado</b>. Sin histéresis: se recalcula en cada segmento y puede
              oscilar.
            </>,
            <>
              <b>Throughput rule</b>, the one that decides in practice: the highest rendition whose{' '}
              <b>nominal bitrate</b> (the MPD one) does not exceed <b>0.9 × the throughput estimate</b>. No hysteresis: it
              is recomputed at every segment and can oscillate.
            </>,
          )}
        </li>
        {THROUGHPUT}
        <li>
          {L(
            <>
              <b>Con un enlace justo oscila:</b> con 4 Mbit/s y la escalera 1080p@4000 / 720p@2000, en 720p el enlace va
              holgado, la estimación (×0,9) llega a ~4000 y sube a 1080p, que no cabe; ahí baja de 4000 y vuelve a 720p.
              Medido en el servidor: 13-28 cambios por minuto y, con 0,3 s de objetivo, 12-30 congelados por minuto.
            </>,
            <>
              <b>With a tight link it oscillates:</b> with 4 Mbit/s and the 1080p@4000 / 720p@2000 ladder, at 720p the link
              has headroom, the estimate (×0.9) reaches ~4000 and it switches up to 1080p, which does not fit; there it
              drops below 4000 and goes back to 720p. Measured on the server: 13-28 switches per minute and, with a 0.3 s
              target, 12-30 freezes per minute.
            </>,
          )}
        </li>
        <li>
          {L(
            <>
              <b>BOLA</b> (por búfer) solo releva a la de caudal con {BOLA_ON_S} s de búfer o más (vuelve a la de caudal
              por debajo de {BOLA_ON_S / 2}): con el objetivo en {s(targetLatency)}, no entra.
            </>,
            <>
              <b>BOLA</b> (buffer-based) only takes over from the throughput rule with {BOLA_ON_S} s of buffer or more
              (it returns to the throughput rule below {BOLA_ON_S / 2}): with the target at {s(targetLatency)}, it never
              kicks in.
            </>,
          )}
        </li>
        <li>
          {L(
            <>
              <b>Búfer insuficiente:</b> no actúa. El MPD declara <code>availabilityTimeComplete=&quot;false&quot;</code>,
              así que dash.js va en modo de baja latencia, y en ese modo se la salta.
            </>,
            <>
              <b>Insufficient buffer:</b> inactive. The MPD declares{' '}
              <code>availabilityTimeComplete=&quot;false&quot;</code>, so dash.js runs in low-latency mode, and in that
              mode it skips this rule.
            </>,
          )}
        </li>
        <li>
          {L(
            <>
              <b>Historial de cambios:</b> si desde una calidad se ha bajado más de un 7,5 % de las veces (con al menos 8
              decisiones), la limita a la de debajo. En las medidas no evitó la oscilación.
            </>,
            <>
              <b>Switch history:</b> if a rendition has been switched down from more than 7.5 % of the times (with at
              least 8 decisions), it caps it at the one below. In the measurements it did not prevent the oscillation.
            </>,
          )}
        </li>
        <li>
          {L(
            <>
              <b>Abandono:</b> corta una descarga si va a tardar más de 1,8 veces la duración del segmento. En baja
              latencia cada segmento se descarga al ritmo del codificador, así que rara vez actúa.
            </>,
            <>
              <b>Abandonment:</b> cuts a download if it will take more than 1.8 times the segment duration. In low latency
              each segment downloads at the encoder pace, so it rarely acts.
            </>,
          )}
        </li>
      </Section>
      {latencySection(props)}
    </div>
  );
};
