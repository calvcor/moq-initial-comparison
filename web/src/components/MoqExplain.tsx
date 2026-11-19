import React from 'react';
import type { MoqAbr, MoqSwitching } from '../types';
import { lang, t } from '../lib/i18n';

// Explicación, en la propia página, de cómo sube y baja de calidad el reproductor MoQ con las opciones elegidas.
// Resume README 6, 6.1 y 6.3 y lo leído del código de @moq/watch (git@bc64b9c) y de web/src/lib/moqProbe.ts: si
// cambia alguno de ellos, hay que cambiar también este texto.

interface Props {
  abr: MoqAbr;
  switching: MoqSwitching;
  /** Calidad fijada a mano (altura) o 'auto'. */
  quality: number | 'auto';
  /** La versión de @moq/watch trae el parche con la opción de cambio. */
  switchingSupported: boolean | null;
}

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="space-y-1">
    <div className="text-slate-300 font-semibold">{title}</div>
    <ul className="list-disc pl-4 space-y-1">{children}</ul>
  </div>
);

/** Elige entre la versión en español y la inglesa de un trozo de JSX. */
const L = (es: React.ReactNode, en: React.ReactNode): React.ReactNode => (lang === 'en' ? en : es);

/** Cómo se hace el relevo al bajar, según la opción Cambio. */
function downHandover(switching: MoqSwitching, supported: boolean | null): React.ReactNode {
  if (supported === false)
    return (
      <li>
        {L(
          <>
            <b>Relevo (versión sin el parche):</b> el de @moq/watch, sin corte: sigue descargando la calidad anterior, con
            la misma prioridad, hasta que la nueva la alcanza. Con el enlace lleno puede no completarse nunca.
          </>,
          <>
            <b>Handover (version without the patch):</b> the @moq/watch one, seamless: it keeps downloading the previous
            rendition, with the same priority, until the new one catches up. With a full link it may never complete.
          </>,
        )}
      </li>
    );
  switch (switching) {
    case 'cancel':
      return (
        <li>
          {L(
            <>
              <b>Relevo (Cambio = Cancelar):</b> la calidad anterior deja de descargarse al momento y su última imagen se
              queda en pantalla hasta que la nueva la alcanza. Libera el enlace enseguida, a cambio de un instante de
              imagen congelada. Si la selección cambia otra vez antes, o la nueva falla, la anterior vuelve a descargarse.
            </>,
            <>
              <b>Handover (Switching = Cancel):</b> the previous rendition stops downloading at once and its last frame
              stays on screen until the new one catches up. It frees the link immediately, at the cost of a brief frozen
              image. If the selection changes again before that, or the new one fails, the previous one is downloaded
              again.
            </>,
          )}
        </li>
      );
    case 'priority':
      return (
        <li>
          {L(
            <>
              <b>Relevo (Cambio = Prioridad):</b> la nueva calidad se pide con prioridad 61 frente a los 60 de la anterior,
              así que el relay la envía primero. La anterior sigue pintándose, con lo que sobre del enlace, hasta que la
              nueva la alcanza; entonces la nueva vuelve a prioridad 60 y la anterior se suelta.
            </>,
            <>
              <b>Handover (Switching = Priority):</b> the new rendition is requested with priority 61 against the 60 of the
              previous one, so the relay sends it first. The previous one keeps being rendered, with whatever is left of
              the link, until the new one catches up; then the new one goes back to priority 60 and the previous one is
              dropped.
            </>,
          )}
        </li>
      );
    default:
      return (
        <li>
          {L(
            <>
              <b>Relevo (Cambio = Sin corte, el original):</b> se suscribe a la nueva calidad y sigue descargando la
              anterior, con la misma prioridad, hasta que la nueva alcanza la imagen en pantalla. Con el enlace lleno, la
              nueva puede no alcanzarla nunca: se sigue viendo la anterior, con congelados (README 6.1).
            </>,
            <>
              <b>Handover (Switching = Seamless, the original):</b> it subscribes to the new rendition and keeps
              downloading the previous one, with the same priority, until the new one catches up with the frame on
              screen. With a full link, the new one may never catch up: the previous one keeps showing, with freezes
              (README 6.1).
            </>,
          )}
        </li>
      );
  }
}

const UP_HANDOVER = (
  <li>
    {L(
      <>
        <b>Relevo al subir</b> (siempre sin corte, sea cual sea Cambio): @moq/watch abre la suscripción a la calidad nueva,
        con prioridad 60, y sigue pintando la anterior hasta que la nueva la alcanza; puede verse un paso atrás de hasta
        100 ms. Mientras dura, se descargan las dos con la misma prioridad.
      </>,
      <>
        <b>Handover when switching up</b> (always seamless, whatever Switching says): @moq/watch opens the subscription to
        the new rendition, with priority 60, and keeps rendering the previous one until the new one catches up; a step
        back of up to 100 ms may be visible. Meanwhile both are downloaded with the same priority.
      </>,
    )}
  </li>
);

export const MoqExplain: React.FC<Props> = ({ abr, switching, quality, switchingSupported }) => {
  if (quality !== 'auto') {
    return (
      <div className="space-y-2">
        <Section title={t(`Calidad fijada (${quality}p)`, `Fixed rendition (${quality}p)`)}>
          <li>
            {t(
              'No hay adaptación: se pide siempre esa calidad, por nombre, a @moq/watch, aunque no quepa en el enlace.',
              'No adaptation: that rendition is always requested from @moq/watch by name, even if it does not fit in the link.',
            )}
          </li>
          <li>
            {t(
              'Al cambiarla a mano, el relevo hacia una calidad mayor es sin corte; hacia una menor, el de la opción Cambio.',
              'When changed by hand, the handover to a higher rendition is seamless; to a lower one, the one set by the Switching option.',
            )}
          </li>
          {downHandover(switching, switchingSupported)}
        </Section>
      </div>
    );
  }

  if (abr === 'probe' || abr === 'probe2') {
    const v2 = abr === 'probe2';
    return (
      <div className="space-y-2">
        <p>
          <b className="text-amber-300">
            {t(
              'Experimento (README 6.3), no el comportamiento de @moq/watch.',
              'Experiment (README 6.3), not the @moq/watch behaviour.',
            )}
          </b>{' '}
          {t(
            'Decide un controlador del banco, que pide la calidad a @moq/watch por nombre; la regla de la librería y la estimación del relay no intervienen (la estimación solo se muestra). Arranca en la calidad más baja.',
            'A testbed controller decides, requesting the rendition from @moq/watch by name; the library rule and the relay estimate play no part (the estimate is only displayed). It starts at the lowest rendition.',
          )}
          {v2 &&
            t(
              ' Versión corregida del sondeo: la primera se quedaba en la calidad más baja con enlaces de 4-10 Mbit/s.',
              ' Fixed version of the probing: the first one stayed at the lowest rendition with 4-10 Mbit/s links.',
            )}
        </p>
        <Section title={t('Subir de calidad', 'Switching up')}>
          <li>
            {L(
              <>
                Tras cada cambio espera a que se pinte la calidad pedida (de 3 a 10 s). Después, cada cierto tiempo (6 s al
                principio; el doble, hasta 32 s, tras un sondeo fallido o una bajada) abre un <b>sondeo de 4 s</b>: se
                suscribe a la calidad siguiente con <b>prioridad 0</b>, sin decodificarla. La actual sigue a 60, así que el
                relay solo le da al sondeo lo que sobra del enlace.
              </>,
              <>
                After each switch it waits for the requested rendition to be rendered (3 to 10 s). Then, every so often (6 s
                at first; twice that, up to 32 s, after a failed probe or a switch down) it opens a <b>4 s probe</b>: it
                subscribes to the next rendition with <b>priority 0</b>, without decoding it. The current one stays at 60,
                so the relay only gives the probe what is left of the link.
              </>,
            )}
          </li>
          <li>
            {v2
              ? L(
                  <>
                    La suscripción de sondeo tolera <b>2 s</b> de retraso: al abrirse llega como mucho el grupo en curso y
                    el anterior.
                  </>,
                  <>
                    The probe subscription tolerates <b>2 s</b> of delay: when it opens, at most the current group and the
                    previous one arrive.
                  </>,
                )
              : L(
                  <>
                    La suscripción de sondeo tolera <b>10 s</b> de retraso, y al abrirse pide todo ese atraso: llega de
                    golpe y, con límite de caudal, puede hundir a la calidad actual en la cola del router.
                  </>,
                  <>
                    The probe subscription tolerates <b>10 s</b> of delay, and when it opens it requests that whole
                    backlog: it arrives in a burst and, with a bandwidth limit, can sink the current rendition in the router
                    queue.
                  </>,
                )}
          </li>
          <li>
            {L(
              <>
                <b>Capacidad</b> = lo que reciben la actual y la de sondeo en los 2 últimos segundos. <b>Bitrate real</b> de
                la siguiente = bytes por frame × cadencia, con al menos dos grupos completos (no el del catálogo, que es el
                pico).
              </>,
              <>
                <b>Capacity</b> = what the current and the probe rendition receive in the last 2 seconds. <b>Actual
                bitrate</b> of the next one = bytes per frame × frame rate, with at least two complete groups (not the
                catalog one, which is the peak).
              </>,
            )}
          </li>
          <li>
            {v2
              ? L(
                  <>
                    Sube si la siguiente <b>llega a su cadencia</b> (90 % de sus frames por segundo: va al día, así que
                    cabe) o si <b>0,8 × capacidad ≥ bitrate real</b> (cuando va por detrás, lo que recibe es lo que sobra
                    del enlace); si no, espera el doble hasta el siguiente sondeo, salvo si se cortó en sus 2 primeros
                    segundos.
                  </>,
                  <>
                    It switches up if the next one <b>keeps up with its frame rate</b> (90 % of its frames per second: it
                    is up to date, so it fits) or if <b>0.8 × capacity ≥ actual bitrate</b> (when it lags, what it
                    receives is what is left of the link); otherwise it waits twice as long until the next probe, unless
                    the probe was cut in its first 2 seconds.
                  </>,
                )
              : L(
                  <>
                    Sube si <b>0,8 × capacidad ≥ bitrate real</b>; si no, espera el doble hasta el siguiente sondeo.
                  </>,
                  <>
                    It switches up if <b>0.8 × capacity ≥ actual bitrate</b>; otherwise it waits twice as long until the
                    next probe.
                  </>,
                )}{' '}
            {t(
              'Tras subir, sondea la siguiente a los 5 s. Los datos del sondeo no se reutilizan: la librería abre su propia suscripción.',
              'After switching up, it probes the next one 5 s later. The probe data are not reused: the library opens its own subscription.',
            )}
          </li>
          {UP_HANDOVER}
        </Section>
        <Section title={t('Bajar de calidad', 'Switching down')}>
          <li>
            {L(
              <>
                Si la actual recibe menos del <b>90 % de su cadencia</b> en frames por segundo durante 2 s, baja{' '}
                <b>un escalón</b>. Si eso pasa durante un sondeo, corta el sondeo en vez de bajar
                {v2
                  ? ' (no antes de 2,5 s de sondeo), y al terminarlo la medida de la actual empieza de cero: si perdió ritmo, fue por el sondeo'
                  : ''}
                . La medida de capacidad no se usa para bajar.
              </>,
              <>
                If the current one receives less than <b>90 % of its frame rate</b> in frames per second for 2 s, it
                switches down <b>one step</b>. If that happens during a probe, it cuts the probe instead of switching down
                {v2
                  ? ' (not before 2.5 s of probing), and when it ends the measurement of the current one restarts from zero: if it lost pace, it was because of the probe'
                  : ''}
                . The capacity measurement is not used to switch down.
              </>,
            )}
          </li>
          {downHandover(switching, switchingSupported)}
        </Section>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p>
        {L(
          <>
            <b>Comportamiento de @moq/watch</b> (lo que mide el banco). La estimación de ancho de banda la hace el relay y
            la envía en los mensajes PROBE: es su ventana de congestión entre el RTT, que con RTT pequeños sale muy por
            encima del enlace (README 6, PROTOCOLOS 4.10).
          </>,
          <>
            <b>@moq/watch behaviour</b> (what the testbed measures). The bandwidth estimate is made by the relay and sent
            in PROBE messages: it is its congestion window divided by the RTT, which with small RTTs comes out far above
            the link (README 6, PROTOCOLOS 4.10).
          </>,
        )}
      </p>
      <Section title={t('Elección (subir y bajar con la misma regla)', 'Selection (up and down with the same rule)')}>
        <li>
          {L(
            <>
              Elige la calidad <b>más alta cuyo bitrate de catálogo quepa en el 80 % de la estimación</b>; si no cabe
              ninguna, la más baja. El bitrate del catálogo es el pico retenido de ventanas de 1 s (unas 1,85 veces el
              nominal).
            </>,
            <>
              It picks the <b>highest rendition whose catalog bitrate fits in 80 % of the estimate</b>; if none fits, the
              lowest. The catalog bitrate is the peak held over 1 s windows (about 1.85 times the nominal one).
            </>,
          )}
        </li>
        <li>
          {t(
            'Sin histéresis ni temporizadores: se recalcula cada vez que cambia la estimación, y puede oscilar.',
            'No hysteresis or timers: it is recomputed every time the estimate changes, and can oscillate.',
          )}
        </li>
      </Section>
      <Section title={t('Subir de calidad', 'Switching up')}>{UP_HANDOVER}</Section>
      <Section title={t('Bajar de calidad', 'Switching down')}>{downHandover(switching, switchingSupported)}</Section>
    </div>
  );
};
